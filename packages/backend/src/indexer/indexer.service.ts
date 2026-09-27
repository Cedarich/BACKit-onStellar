import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SorobanRpc, xdr } from '@stellar/stellar-sdk';
import { EventLog, EventType } from './event-log.entity';
import { PlatformSettings } from './entities/platform-settings.entity';
import { retryWithBackoff } from '../utils/retry';
import { Retryable } from '../common/decorators/retryable.decorator';
import { ConfigService } from '../config/config.service';
import { parseAdminParamsChanged } from './parsers/admin-params.parser';
import { PayoutsService } from '../payouts/payouts.service';
import { TreasuryService } from '../treasury/treasury.service';
import { FailedTransaction } from './entities/failed-transaction.entity';
import {
  DiagnosticParserService,
  TransactionDiagnosticReport,
} from './diagnostic-parser.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/notification-type.enum';

/** notifications.message is varchar(255). */
const MAX_NOTIFICATION_LENGTH = 255;

@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);
  private readonly contractId = process.env.SOROBAN_CONTRACT_ID ?? '';
  /** Whether event_logs_max_ledger() (PartitionEventStore migration) exists. */
  private maxLedgerHelperAvailable = true;

  constructor(
    private readonly rpcServer: SorobanRpc.Server,
    @InjectRepository(EventLog)
    private readonly eventLogRepository: Repository<EventLog>,
    @InjectRepository(PlatformSettings)
    private readonly platformSettingsRepository: Repository<PlatformSettings>,
    private readonly configService: ConfigService,
    private readonly payoutsService: PayoutsService,
    private readonly treasuryService: TreasuryService,
    @InjectRepository(FailedTransaction)
    private readonly failedTxRepository: Repository<FailedTransaction>,
    private readonly diagnosticParser: DiagnosticParserService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ─── Status ───────────────────────────────────────────────────────────────

  async getStatus() {
    const isRunning = true;
    const totalEventsIndexed = await this.eventLogRepository.count();
    const latestEvent = await this.findLatestEvent();

    return {
      isRunning,
      lastProcessedLedger: latestEvent?.ledger ?? null,
      totalEventsIndexed,
      latestEventLedger: latestEvent?.ledger ?? null,
      latestEventTimestamp: latestEvent?.timestamp ?? null,
    };
  }

  async getEventsByType(
    eventType: EventType,
    arg2?: any,
    arg3?: any,
    limit: number = 50,
  ) {
    return this.eventLogRepository.find({
      where: { eventType },
      order: { ledger: 'DESC' },
      take: limit,
    });
  }

  // ─── Main Entry Point ─────────────────────────────────────────────────────

  async processNewEvents(): Promise<void> {
    if (!this.contractId) {
      this.logger.warn('SOROBAN_CONTRACT_ID not set — skipping indexer tick');
      return;
    }

    try {
      const startLedger = await this.resolveStartLedger();
      const response = await this.fetchContractEvents(
        this.contractId,
        startLedger,
      );

      for (const event of response.events) {
        await this.dispatchEvent(event);
      }
    } catch (err: any) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      this.logger.error(`Indexer tick failed: ${err.message}`);
    }
  }

  // ─── Event Dispatcher ─────────────────────────────────────────────────────

  private async dispatchEvent(
    event: SorobanRpc.Api.EventResponse,
  ): Promise<void> {
    const topics = event.topic;
    const data = event.value;
    const txHash = event.txHash;
    const ledger = event.ledger;

    if (topics.length === 0) return;

    const firstTopic = topics[0];
    if (firstTopic.switch() !== xdr.ScValType.scvSymbol()) return;

    const eventName = firstTopic.sym().toString();

    switch (eventName) {
      case 'AdminParamsChanged':
        await this.handleAdminParamsChanged(topics, data, txHash, ledger);
        break;
      case 'PayoutClaimed':
        await this.handlePayoutClaimed(topics, txHash, ledger);
        break;

      // ── extend here as you add more contract events ───────────────────
      // case 'MarketCreated':  await this.handleMarketCreated(...); break;
      // case 'BetPlaced':      await this.handleBetPlaced(...);     break;

      default:
        this.logger.debug(`Unhandled event type: ${eventName}`);
        break;
    }
  }

  // ─── AdminParamsChanged ───────────────────────────────────────────────────

  private async handleAdminParamsChanged(
    topics: xdr.ScVal[],
    data: xdr.ScVal,
    txHash: string,
    ledger: number,
  ): Promise<void> {
    const parsed = parseAdminParamsChanged(topics, data, txHash, ledger);
    if (!parsed) return;

    await this.configService.applyAdminParamsChanged(parsed);

    this.logger.log(
      `AdminParamsChanged applied — feePercent: ${parsed.feePercent}% ` +
        `ledger: ${ledger} tx: ${txHash}`,
    );

    await this.eventLogRepository.save(
      this.eventLogRepository.create({
        eventId: `${txHash}-admin-params`,
        pagingToken: `${ledger}-${txHash}`,
        contractId: this.contractId,
        topic0: 'AdminParamsChanged',
        eventType: EventType.ADMIN_PARAMS_CHANGED,
        ledger,
        txHash,
        txOrder: 0,
        eventData: parsed,
        timestamp: new Date(),
      }),
    );
  }

  private async handlePayoutClaimed(
    topics: xdr.ScVal[],
    txHash: string,
    ledger: number,
  ): Promise<void> {
    try {
      const asString = (val?: xdr.ScVal): string | null => {
        if (!val) return null;
        const t = val.switch();
        if (t === xdr.ScValType.scvString()) return val.str().toString();
        if (t === xdr.ScValType.scvSymbol()) return val.sym().toString();
        return null;
      };

      const asU64 = (val?: xdr.ScVal): string | null => {
        if (!val) return null;
        if (val.switch() === xdr.ScValType.scvU64())
          return val.u64().toString();
        return null;
      };

      const asI128Lo = (val?: xdr.ScVal): string | null => {
        if (!val) return null;
        if (val.switch() === xdr.ScValType.scvI128()) {
          return val.i128().lo().toString();
        }
        return null;
      };

      // Support both legacy topic layouts and tuple payloads.
      const callId = asString(topics[1]) ?? asU64(topics[1]) ?? '';
      const stakerAddress = asString(topics[2]) ?? '';
      const amount = asI128Lo(topics[3]) ?? asU64(topics[3]) ?? '0';
      if (!callId || !stakerAddress) return;

      await this.payoutsService.markClaimed(
        callId,
        stakerAddress,
        txHash,
        new Date(),
      );

      // Record a treasury fee entry for this claim.
      // If your event emits an explicit fee amount or token address, wire it here.
      await this.treasuryService.recordFeeFromPayoutClaimed({
        callId,
        claimedAmount: String(amount ?? '0'),
        collectedAt: new Date(),
      });
      this.logger.log(
        `PayoutClaimed synced: call=${callId} staker=${stakerAddress}`,
      );
    } catch (err: any) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      this.logger.warn(`Failed to parse PayoutClaimed event: ${err.message}`);
    }
  }

  // ─── Platform Settings ────────────────────────────────────────────────────

  async getPlatformSettings(): Promise<PlatformSettings> {
    let settings = await this.platformSettingsRepository.findOne({
      where: { id: 1 },
    });

    if (!settings) {
      settings = this.platformSettingsRepository.create({
        id: 1,
        feePercent: 0,
      });
      await this.platformSettingsRepository.save(settings);
    }

    return settings;
  }

  async updatePlatformSettings(
    paramName: string,
    newValue: number,
    txHash: string,
    ledger: number,
  ): Promise<PlatformSettings> {
    const settings = await this.getPlatformSettings();

    if (paramName === 'fee_percent' || paramName === 'feePercent') {
      settings.feePercent = newValue;
    }

    settings.lastUpdatedByTxHash = txHash;
    settings.lastUpdatedAtLedger = ledger;

    return await this.platformSettingsRepository.save(settings);
  }

  // ─── Fetch Contract Events ────────────────────────────────────────────────

  async fetchContractEvents(
    contractId: string,
    startLedger: number,
  ): Promise<SorobanRpc.Api.GetEventsResponse> {
    return retryWithBackoff(
      () =>
        this.rpcServer.getEvents({
          startLedger,
          filters: [{ type: 'contract', contractIds: [contractId] }],
        }),
      4,
      1000,
      `fetchContractEvents(${contractId})`,
    );
  }

  // ─── Read Contract State ──────────────────────────────────────────────────

  async readContractData(
    contractId: string,
    key: xdr.LedgerKey,
  ): Promise<SorobanRpc.Api.GetLedgerEntriesResponse> {
    return retryWithBackoff(
      () => this.rpcServer.getLedgerEntries(key),
      4,
      1000,
      `readContractData(${contractId})`,
    );
  }

  // ─── Get Latest Ledger ────────────────────────────────────────────────────

  @Retryable(3, 1000)
  async getLatestLedger(): Promise<SorobanRpc.Api.GetLatestLedgerResponse> {
    return retryWithBackoff(
      () => this.rpcServer.getLatestLedger(),
      4,
      1000,
      'getLatestLedger',
    );
  }

  // ─── Submit Transaction ───────────────────────────────────────────────────

  async submitTransaction(
    tx: Parameters<SorobanRpc.Server['sendTransaction']>[0],
  ): Promise<SorobanRpc.Api.SendTransactionResponse> {
    const response = await retryWithBackoff(
      () => this.rpcServer.sendTransaction(tx),
      4,
      1000,
      'submitTransaction',
    );

    if (response?.status === 'ERROR') {
      const report =
        this.diagnosticParser.analyzeSendTransactionResponse(response);
      const source = tx as {
        source?: string;
        innerTransaction?: { source?: string };
      };
      await this.recordFailedTransaction(report, {
        userAddress: source.innerTransaction?.source ?? source.source ?? null,
        ledger: response.latestLedger ?? null,
      });
    }

    return response;
  }

  // ─── Failed Transactions (BE-004) ─────────────────────────────────────────

  /**
   * Fetch a transaction by hash and, if it failed on-chain, parse its
   * diagnostics, persist them to `failed_transactions` and notify the
   * submitting user. Returns the report, or null if the transaction did not
   * fail (or could not be fetched). Never throws.
   */
  async indexFailedTransaction(
    txHash: string,
    userAddress?: string | null,
  ): Promise<TransactionDiagnosticReport | null> {
    try {
      const response = await retryWithBackoff(
        () => this.rpcServer.getTransaction(txHash),
        4,
        1000,
        `getTransaction(${txHash})`,
      );
      if (response.status !== SorobanRpc.Api.GetTransactionStatus.FAILED) {
        return null;
      }

      const report = this.diagnosticParser.analyzeGetTransactionResponse(
        txHash,
        response,
      );
      await this.recordFailedTransaction(report, {
        userAddress:
          userAddress ??
          this.diagnosticParser.extractSourceAccount(response.envelopeXdr),
        ledger: response.ledger ?? null,
      });
      return report;
    } catch (err) {
      this.logger.warn(
        `indexFailedTransaction(${txHash}) failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async recordFailedTransaction(
    report: TransactionDiagnosticReport,
    ctx: { userAddress: string | null; ledger: number | null },
  ): Promise<void> {
    this.diagnosticParser.logReport(report, { userAddress: ctx.userAddress });
    if (!report.failed || !report.txHash) return;

    try {
      const primary = report.primaryError;
      const existing = await this.failedTxRepository.findOne({
        where: { txHash: report.txHash },
      });

      const row = await this.failedTxRepository.save(
        this.failedTxRepository.create({
          ...(existing ?? {}),
          txHash: report.txHash,
          contractId: report.contractId ?? existing?.contractId ?? null,
          userAddress: ctx.userAddress ?? existing?.userAddress ?? null,
          ledger: ctx.ledger ?? existing?.ledger ?? null,
          resultCode: report.resultCode,
          operationResultCode: report.operationResultCode,
          errorCategory: primary?.category ?? null,
          errorName:
            primary?.enumName && primary.errorName
              ? `${primary.enumName}::${primary.errorName}`
              : (primary?.codeName ?? null),
          errorCode: primary?.code ?? null,
          message: report.summary,
          diagnostics: report,
          notified: existing?.notified ?? false,
        }),
      );

      if (row.userAddress && !row.notified) {
        await this.notificationsService.notify(
          row.userAddress,
          NotificationType.TRANSACTION_FAILED,
          this.truncate(`Transaction failed: ${report.summary}`),
          report.txHash,
        );
        row.notified = true;
        await this.failedTxRepository.save(row);
      }
    } catch (err) {
      // Diagnostics are best-effort: never let them break the caller.
      this.logger.warn({
        msg: 'Failed to persist failed transaction diagnostics',
        txHash: report.txHash,
        error: (err as Error).message,
      });
    }
  }

  private truncate(message: string): string {
    return message.length <= MAX_NOTIFICATION_LENGTH
      ? message
      : `${message.slice(0, MAX_NOTIFICATION_LENGTH - 1)}…`;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private async resolveStartLedger(): Promise<number> {
    const latestEvent = await this.findLatestEvent();

    if (latestEvent?.ledger) {
      // bigint columns come back from pg as strings.
      return Number(latestEvent.ledger) + 1;
    }

    const latest = await this.getLatestLedger();
    return Math.max(latest.sequence - 5, 1);
  }

  /**
   * Latest indexed event. On the partitioned table a bare
   * `ORDER BY ledger DESC LIMIT 1` plans a Merge Append over every
   * partition, so resolve the max ledger via event_logs_max_ledger() (probes
   * newest partitions first) and then do a single-partition point lookup.
   * Falls back to the plain query where the helper is absent (unmigrated
   * databases, tests).
   */
  private async findLatestEvent(): Promise<EventLog | null> {
    if (this.maxLedgerHelperAvailable) {
      try {
        const rows = await this.eventLogRepository.query<
          Array<{ ledger: string | number | null }>
        >('SELECT event_logs_max_ledger() AS ledger');
        const ledger = rows?.[0]?.ledger;
        if (ledger === null || ledger === undefined) return null;
        return await this.eventLogRepository.findOne({
          where: { ledger: Number(ledger) },
          order: { id: 'DESC' },
        });
      } catch {
        this.maxLedgerHelperAvailable = false;
        this.logger.debug(
          'event_logs_max_ledger() unavailable — using unpartitioned latest-event query',
        );
      }
    }

    return this.eventLogRepository.findOne({
      where: {},
      order: { ledger: 'DESC' },
    });
  }
}
