import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository, DataSource, EntityManager } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SorobanRpc, xdr } from '@stellar/stellar-sdk';
import {
  ReconciliationRun,
  ReconciliationRunStatus,
} from './entities/reconciliation-run.entity';
import {
  ReconciliationDiscrepancy,
  DiscrepancyType,
  DiscrepancyStatus,
} from './entities/reconciliation-discrepancy.entity';
import { Call, CallStatus } from '../calls/entities/call.entity';
import { Stake } from '../stakes/entities/stake.entity';
import {
  PayoutClaim,
  PayoutClaimStatus,
} from '../payouts/entities/payout-claim.entity';
import { EventLog, EventType } from '../indexer/event-log.entity';
import { StartReconciliationDto } from './dto/start-reconciliation.dto';
import { QueryReconciliationRunsDto } from './dto/query-reconciliation-runs.dto';
import { QueryDiscrepanciesDto } from './dto/query-discrepancies.dto';
import { QUEUE_RECONCILIATION } from '../common/queues/queues.constants';
import { ReconciliationJobData } from './reconciliation.processor';

export interface ParsedOnChainEvent {
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  stableIdentity: string;
  eventName: string;
  data: Record<string, any>;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly defaultContractId = process.env.SOROBAN_CONTRACT_ID ?? '';

  constructor(
    @InjectRepository(ReconciliationRun)
    private readonly runRepo: Repository<ReconciliationRun>,
    @InjectRepository(ReconciliationDiscrepancy)
    private readonly discrepancyRepo: Repository<ReconciliationDiscrepancy>,
    @InjectRepository(Call)
    private readonly callRepo: Repository<Call>,
    @InjectRepository(Stake)
    private readonly stakeRepo: Repository<Stake>,
    @InjectRepository(PayoutClaim)
    private readonly payoutClaimRepo: Repository<PayoutClaim>,
    @InjectRepository(EventLog)
    private readonly eventLogRepo: Repository<EventLog>,
    private readonly dataSource: DataSource,
    private readonly rpcServer: SorobanRpc.Server,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
    @InjectQueue(QUEUE_RECONCILIATION)
    private readonly queue: Queue<ReconciliationJobData>,
  ) {}

  // ─── Start Reconciliation Run ─────────────────────────────────────────────

  async startRun(dto: StartReconciliationDto): Promise<ReconciliationRun> {
    const {
      network = 'testnet',
      contractIds,
      fromLedger,
      toLedger,
      isDryRun = true,
    } = dto;

    if (fromLedger > toLedger) {
      throw new BadRequestException(
        `fromLedger (${fromLedger}) cannot be greater than toLedger (${toLedger})`,
      );
    }

    const lockKey = `reconciliation_lock:${network}`;
    const activeLock = await this.cacheManager.get<string>(lockKey);
    if (activeLock) {
      throw new ConflictException(
        `A reconciliation run for network "${network}" is currently in progress. Lock key: ${lockKey}`,
      );
    }

    // Acquire lock for 15 minutes
    await this.cacheManager.set(lockKey, 'locked', 900000);

    const resolvedContracts =
      contractIds && contractIds.length > 0
        ? contractIds
        : [this.defaultContractId].filter(Boolean);

    const run = this.runRepo.create({
      network,
      contractIds: resolvedContracts,
      fromLedger,
      toLedger,
      isDryRun,
      status: ReconciliationRunStatus.PENDING,
      scannedEventsCount: 0,
      discrepancyCount: 0,
      repairedCount: 0,
      quarantinedCount: 0,
    });

    const savedRun = await this.runRepo.save(run);

    // Queue job for background processing
    try {
      await this.queue.add('reconcile', { runId: savedRun.id });
    } catch (err: any) {
      // If queue is unavailable (e.g. Redis missing in test mode), execute inline asynchronously
      this.logger.warn(
        `BullMQ queue add failed (${err.message}). Executing run inline asynchronously.`,
      );
      setImmediate(() => {
        void this.executeRun(savedRun.id);
      });
    }

    return savedRun;
  }

  // ─── Execute Reconciliation Run ───────────────────────────────────────────

  async executeRun(runId: string): Promise<ReconciliationRun> {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException(
        `ReconciliationRun with ID ${runId} not found`,
      );
    }

    run.status = ReconciliationRunStatus.RUNNING;
    await this.runRepo.save(run);

    const startTime = Date.now();
    const lockKey = `reconciliation_lock:${run.network}`;

    try {
      // Fetch on-chain events across contractIds and ledger range
      const events = await this.fetchEventsForRange(
        run.contractIds,
        run.fromLedger,
        run.toLedger,
      );

      run.scannedEventsCount = events.length;

      const breakdown: Record<string, number> = {
        [DiscrepancyType.MISSING_OFFCHAIN]: 0,
        [DiscrepancyType.DUPLICATE_OFFCHAIN]: 0,
        [DiscrepancyType.VALUE_MISMATCH]: 0,
        [DiscrepancyType.UNKNOWN_CONTRACT]: 0,
        [DiscrepancyType.UNRECOVERABLE]: 0,
      };

      let totalDiscrepancies = 0;
      let totalRepaired = 0;
      let totalQuarantined = 0;

      for (const event of events) {
        // Check if contract is known
        if (
          run.contractIds.length > 0 &&
          !run.contractIds.includes(event.contractId)
        ) {
          totalDiscrepancies++;
          breakdown[DiscrepancyType.UNKNOWN_CONTRACT]++;
          await this.recordDiscrepancy(
            run.id,
            event,
            DiscrepancyType.UNKNOWN_CONTRACT,
            DiscrepancyStatus.QUARANTINED,
            { reason: `Contract ${event.contractId} not in configured set` },
            run.isDryRun,
          );
          totalQuarantined++;
          continue;
        }

        // Compare event with Postgres records
        const discrepancyResult = await this.reconcileEvent(
          event,
          run.isDryRun,
        );

        if (discrepancyResult) {
          totalDiscrepancies++;
          breakdown[discrepancyResult.type]++;

          if (discrepancyResult.status === DiscrepancyStatus.REPAIRED) {
            totalRepaired++;
          } else if (
            discrepancyResult.status === DiscrepancyStatus.QUARANTINED
          ) {
            totalQuarantined++;
          }

          await this.recordDiscrepancy(
            run.id,
            event,
            discrepancyResult.type,
            discrepancyResult.status,
            discrepancyResult.details,
            run.isDryRun,
            discrepancyResult.notes,
          );
        }
      }

      run.durationMs = Date.now() - startTime;
      run.discrepancyCount = totalDiscrepancies;
      run.repairedCount = totalRepaired;
      run.quarantinedCount = totalQuarantined;
      run.discrepancyBreakdown = breakdown;
      run.status = ReconciliationRunStatus.COMPLETED;

      this.logger.log(
        `Reconciliation completed for runId=${runId} in ${run.durationMs}ms: ` +
          `scanned=${run.scannedEventsCount}, discrepancies=${totalDiscrepancies}, ` +
          `repaired=${totalRepaired}, quarantined=${totalQuarantined}`,
      );

      return await this.runRepo.save(run);
    } catch (err: any) {
      run.status = ReconciliationRunStatus.FAILED;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      run.failureReason = err.message ?? 'Unknown reconciliation failure';
      run.durationMs = Date.now() - startTime;
      this.logger.error(
        `Reconciliation run ${runId} failed: ${run.failureReason}`,
      );
      return await this.runRepo.save(run);
    } finally {
      await this.cacheManager.del(lockKey);
    }
  }

  // ─── Event Reconciliation & Repair ────────────────────────────────────────

  private async reconcileEvent(
    event: ParsedOnChainEvent,
    isDryRun: boolean,
  ): Promise<{
    type: DiscrepancyType;
    status: DiscrepancyStatus;
    details: Record<string, unknown>;
    notes?: string;
  } | null> {
    switch (event.eventName) {
      case 'MarketCreated':
      case 'call_created': {
        return this.reconcileCallCreated(event, isDryRun);
      }
      case 'BetPlaced':
      case 'stake_added': {
        return this.reconcileStakeAdded(event, isDryRun);
      }
      case 'OutcomeFinalized':
      case 'call_resolved':
      case 'call_settled': {
        return this.reconcileCallResolved(event, isDryRun);
      }
      case 'PayoutClaimed': {
        return this.reconcilePayoutClaimed(event, isDryRun);
      }
      default: {
        return null;
      }
    }
  }

  // ─── 1. Call Created Event ────────────────────────────────────────────────

  private async reconcileCallCreated(
    event: ParsedOnChainEvent,
    isDryRun: boolean,
  ): Promise<{
    type: DiscrepancyType;
    status: DiscrepancyStatus;
    details: Record<string, unknown>;
    notes?: string;
  } | null> {
    const callId = String(
      event.data.callId ?? event.data.marketId ?? event.txHash,
    );
    const title = event.data.title ?? `Call ${callId.slice(0, 8)}`;
    const creatorAddress =
      event.data.creatorAddress ?? event.data.creator ?? 'SYSTEM';

    const existingCalls = await this.callRepo.find({ where: { id: callId } });

    if (existingCalls.length === 0) {
      if (isDryRun) {
        return {
          type: DiscrepancyType.MISSING_OFFCHAIN,
          status: DiscrepancyStatus.DETECTED,
          details: { eventData: event.data, expectedCallId: callId },
        };
      }

      // Repair Mode: Upsert Call transactionally
      await this.dataSource.transaction(async (manager: EntityManager) => {
        const newCall = manager.create(Call, {
          id: callId,
          title,
          description: event.data.description ?? null,
          creatorAddress,
          status: CallStatus.OPEN,
          totalYesStake: '0',
          totalNoStake: '0',
        });
        await manager.save(newCall);
      });

      return {
        type: DiscrepancyType.MISSING_OFFCHAIN,
        status: DiscrepancyStatus.REPAIRED,
        details: { eventData: event.data, repairedCallId: callId },
        notes: 'Upserted missing Call record in Postgres',
      };
    }

    if (existingCalls.length > 1) {
      return {
        type: DiscrepancyType.DUPLICATE_OFFCHAIN,
        status: isDryRun
          ? DiscrepancyStatus.DETECTED
          : DiscrepancyStatus.QUARANTINED,
        details: { duplicateCount: existingCalls.length, callId },
        notes: 'Multiple Call records found with same ID',
      };
    }

    // Compare fields
    const call = existingCalls[0];
    if (creatorAddress !== 'SYSTEM' && call.creatorAddress !== creatorAddress) {
      return {
        type: DiscrepancyType.VALUE_MISMATCH,
        status: isDryRun
          ? DiscrepancyStatus.DETECTED
          : DiscrepancyStatus.QUARANTINED,
        details: {
          offchainCreator: call.creatorAddress,
          onchainCreator: creatorAddress,
        },
        notes: 'Creator address value mismatch',
      };
    }

    return null;
  }

  // ─── 2. Stake Added Event ─────────────────────────────────────────────────

  private async reconcileStakeAdded(
    event: ParsedOnChainEvent,
    isDryRun: boolean,
  ): Promise<{
    type: DiscrepancyType;
    status: DiscrepancyStatus;
    details: Record<string, unknown>;
    notes?: string;
  } | null> {
    const callId = String(event.data.callId ?? event.data.marketId ?? '');
    const userAddress = String(
      event.data.userAddress ?? event.data.staker ?? '',
    );
    const amount = Number(event.data.amount ?? 0);

    if (!callId || !userAddress) {
      return {
        type: DiscrepancyType.UNRECOVERABLE,
        status: DiscrepancyStatus.QUARANTINED,
        details: {
          eventData: event.data,
          reason: 'Missing callId or userAddress in event payload',
        },
      };
    }

    const existingStakes = await this.stakeRepo.find({
      where: { callId, userAddress },
    });

    if (existingStakes.length === 0) {
      if (isDryRun) {
        return {
          type: DiscrepancyType.MISSING_OFFCHAIN,
          status: DiscrepancyStatus.DETECTED,
          details: { callId, userAddress, amount },
        };
      }

      // Repair Mode: Create Stake record transactionally
      await this.dataSource.transaction(async (manager: EntityManager) => {
        const newStake = manager.create(Stake, {
          callId,
          userAddress,
          amount,
        });
        await manager.save(newStake);
      });

      return {
        type: DiscrepancyType.MISSING_OFFCHAIN,
        status: DiscrepancyStatus.REPAIRED,
        details: { callId, userAddress, amount },
        notes: 'Upserted missing Stake record in Postgres',
      };
    }

    return null;
  }

  // ─── 3. Call Resolved Event ───────────────────────────────────────────────

  private async reconcileCallResolved(
    event: ParsedOnChainEvent,
    isDryRun: boolean,
  ): Promise<{
    type: DiscrepancyType;
    status: DiscrepancyStatus;
    details: Record<string, unknown>;
    notes?: string;
  } | null> {
    const callId = String(event.data.callId ?? event.data.marketId ?? '');
    const outcome = String(
      event.data.outcome ?? event.data.result ?? '',
    ).toUpperCase();

    if (!callId) return null;

    const call = await this.callRepo.findOne({ where: { id: callId } });

    if (!call) {
      return {
        type: DiscrepancyType.MISSING_OFFCHAIN,
        status: isDryRun
          ? DiscrepancyStatus.DETECTED
          : DiscrepancyStatus.QUARANTINED,
        details: {
          callId,
          outcome,
          reason: 'Call record missing for resolution event',
        },
      };
    }

    const expectedStatus =
      outcome === 'YES' || outcome === '1' || outcome === 'TRUE'
        ? CallStatus.RESOLVED_YES
        : CallStatus.RESOLVED_NO;

    if (call.status !== expectedStatus) {
      if (isDryRun) {
        return {
          type: DiscrepancyType.VALUE_MISMATCH,
          status: DiscrepancyStatus.DETECTED,
          details: { callId, currentStatus: call.status, expectedStatus },
        };
      }

      // Repair Mode: Update call status
      call.status = expectedStatus;
      call.resolvedAt = new Date();
      await this.callRepo.save(call);

      return {
        type: DiscrepancyType.VALUE_MISMATCH,
        status: DiscrepancyStatus.REPAIRED,
        details: { callId, updatedStatus: expectedStatus },
        notes: 'Updated Call resolution status in Postgres',
      };
    }

    return null;
  }

  // ─── 4. Payout Claimed Event ──────────────────────────────────────────────

  private async reconcilePayoutClaimed(
    event: ParsedOnChainEvent,
    isDryRun: boolean,
  ): Promise<{
    type: DiscrepancyType;
    status: DiscrepancyStatus;
    details: Record<string, unknown>;
    notes?: string;
  } | null> {
    const callId = String(event.data.callId ?? '');
    const stakerAddress = String(
      event.data.stakerAddress ?? event.data.staker ?? '',
    );
    const amount = String(event.data.amount ?? '0');

    if (!callId || !stakerAddress) return null;

    const claim = await this.payoutClaimRepo.findOne({
      where: { callId, stakerAddress },
    });

    if (!claim) {
      if (isDryRun) {
        return {
          type: DiscrepancyType.MISSING_OFFCHAIN,
          status: DiscrepancyStatus.DETECTED,
          details: { callId, stakerAddress, amount, txHash: event.txHash },
        };
      }

      // Repair Mode: Upsert claimed PayoutClaim transactionally
      await this.dataSource.transaction(async (manager: EntityManager) => {
        const newClaim = manager.create(PayoutClaim, {
          callId,
          stakerAddress,
          amount,
          txHash: event.txHash,
          claimedAt: new Date(),
          status: PayoutClaimStatus.CLAIMED,
        });
        await manager.save(newClaim);
      });

      return {
        type: DiscrepancyType.MISSING_OFFCHAIN,
        status: DiscrepancyStatus.REPAIRED,
        details: { callId, stakerAddress, amount, txHash: event.txHash },
        notes: 'Upserted missing PayoutClaim record as CLAIMED',
      };
    }

    if (claim.status !== PayoutClaimStatus.CLAIMED) {
      if (isDryRun) {
        return {
          type: DiscrepancyType.VALUE_MISMATCH,
          status: DiscrepancyStatus.DETECTED,
          details: {
            callId,
            stakerAddress,
            currentStatus: claim.status,
            expectedStatus: PayoutClaimStatus.CLAIMED,
          },
        };
      }

      claim.status = PayoutClaimStatus.CLAIMED;
      claim.txHash = event.txHash;
      claim.claimedAt = new Date();
      await this.payoutClaimRepo.save(claim);

      return {
        type: DiscrepancyType.VALUE_MISMATCH,
        status: DiscrepancyStatus.REPAIRED,
        details: {
          callId,
          stakerAddress,
          updatedStatus: PayoutClaimStatus.CLAIMED,
        },
        notes: 'Marked PayoutClaim as CLAIMED in Postgres',
      };
    }

    return null;
  }

  // ─── Query Endpoints for Admin ────────────────────────────────────────────

  async getRuns(query: QueryReconciliationRunsDto) {
    const { page = 1, limit = 20, network, status, isDryRun } = query;
    const where: any = {};
    if (network) where.network = network;
    if (status) where.status = status;
    if (isDryRun !== undefined) where.isDryRun = isDryRun;

    const [items, total] = await this.runRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      data: items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getRunById(id: string): Promise<ReconciliationRun> {
    const run = await this.runRepo.findOne({ where: { id } });
    if (!run) {
      throw new NotFoundException(`ReconciliationRun ${id} not found`);
    }
    return run;
  }

  async getDiscrepancies(query: QueryDiscrepanciesDto) {
    const { page = 1, limit = 20, runId, type, status } = query;
    const where: any = {};
    if (runId) where.runId = runId;
    if (type) where.discrepancyType = type;
    if (status) where.status = status;

    const [items, total] = await this.discrepancyRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      data: items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─── Helpers: Fetch & Record ──────────────────────────────────────────────

  public async fetchEventsForRange(
    contractIds: string[],
    fromLedger: number,
    toLedger: number,
  ): Promise<ParsedOnChainEvent[]> {
    const parsedEvents: ParsedOnChainEvent[] = [];

    // Query event logs stored locally in eventLogRepo or Soroban RPC
    for (const contractId of contractIds) {
      try {
        // First check locally indexed EventLog for the ledger range. The
        // range is pushed into SQL so Postgres prunes event_logs partitions
        // instead of loading the contract's whole history into memory.
        const filtered = await this.eventLogRepo.find({
          where: { contractId, ledger: Between(fromLedger, toLedger) },
          order: { ledger: 'ASC', txOrder: 'ASC' },
        });

        if (filtered.length > 0) {
          filtered.forEach((log, index) => {
            parsedEvents.push({
              contractId: log.contractId,
              ledger: Number(log.ledger),
              txHash: log.txHash,
              eventIndex: index,
              stableIdentity: `${log.contractId}:${log.ledger}:${log.txHash}:${index}`,
              eventName: log.eventType,
              data: log.eventData || {},
            });
          });
        } else if (this.rpcServer) {
          // Fall back to RPC query with pagination safely
          const res = await this.rpcServer.getEvents({
            startLedger: fromLedger,
            filters: [{ type: 'contract', contractIds: [contractId] }],
          });

          if (res && res.events) {
            res.events.forEach((ev, idx) => {
              if (ev.ledger >= fromLedger && ev.ledger <= toLedger) {
                const topicName =
                  ev.topic && ev.topic.length > 0
                    ? (ev.topic[0].sym?.()?.toString() ?? 'Unknown')
                    : 'Unknown';

                parsedEvents.push({
                  contractId,
                  ledger: ev.ledger,
                  txHash: ev.txHash,
                  eventIndex: idx,
                  stableIdentity: `${contractId}:${ev.ledger}:${ev.txHash}:${idx}`,
                  eventName: topicName,
                  data: { raw: ev.value },
                });
              }
            });
          }
        }
      } catch (err: any) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this.logger.warn(
          `Failed fetching events for contract ${contractId}: ${err.message}`,
        );
      }
    }

    return parsedEvents;
  }

  private async recordDiscrepancy(
    runId: string,
    event: ParsedOnChainEvent,
    type: DiscrepancyType,
    status: DiscrepancyStatus,
    details: Record<string, unknown>,
    isDryRun: boolean,
    notes?: string,
  ): Promise<ReconciliationDiscrepancy> {
    const discrepancy = this.discrepancyRepo.create({
      runId,
      contractId: event.contractId,
      ledger: event.ledger,
      txHash: event.txHash,
      eventIndex: event.eventIndex,
      stableIdentity: event.stableIdentity,
      eventType: event.eventName,
      discrepancyType: type,
      status: isDryRun ? DiscrepancyStatus.DETECTED : status,
      details,
      repairNotes: notes ?? null,
    });

    return await this.discrepancyRepo.save(discrepancy);
  }
}
