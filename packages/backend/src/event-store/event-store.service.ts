import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import {
  AggregateType,
  DomainEventType,
  EventMetadata,
  EventStoreEntry,
} from './entities/event-store-entry.entity';
import { AggregateSnapshot } from './entities/aggregate-snapshot.entity';
import { correlationStorage } from '../common/middleware/correlation-id.middleware';
import { EventLog } from '../indexer/event-log.entity';

export interface LedgerRangeFilter {
  contractId: string;
  /** First topic symbol, e.g. `PayoutClaimed`. Omit to scan every topic. */
  topic0?: string;
  /** Inclusive lower ledger bound. */
  fromLedger: number;
  /** Inclusive upper ledger bound. */
  toLedger: number;
  limit?: number;
  /**
   * Keyset cursor from the previous page: `{ ledger, id }` of its last row.
   * Keeps deep pages O(limit) instead of O(offset).
   */
  after?: { ledger: number; id: number };
}

/** Hard cap so a single range scan can never pull an unbounded result set. */
const MAX_RANGE_SCAN_LIMIT = 1000;

export interface AggregateState {
  aggregateType: AggregateType;
  aggregateId: string;
  /** Number of events folded into this state, from the beginning of the stream. */
  version: number;
  /** `sequence` of the last event folded in — the replay's high-water mark. */
  lastSequence: string | null;
  lastEventType: DomainEventType | null;
  lastEventAt: Date | null;
  /**
   * Generic fold of every event's payload applied in order (later events
   * override earlier keys on conflict). Aggregate-specific read models can
   * layer their own reducers on top of getEvents()/getEventsSince() — this
   * is intentionally the lowest-common-denominator projection.
   */
  state: Record<string, unknown>;
}

@Injectable()
export class EventStoreService {
  private readonly logger = new Logger(EventStoreService.name);

  /** Take a compaction snapshot every N events appended to an aggregate. */
  private readonly snapshotInterval = 20;

  constructor(
    @InjectRepository(EventStoreEntry)
    private readonly eventRepo: Repository<EventStoreEntry>,
    @InjectRepository(AggregateSnapshot)
    private readonly snapshotRepo: Repository<AggregateSnapshot>,
    @InjectRepository(EventLog)
    private readonly eventLogRepo: Repository<EventLog>,
  ) {}

  /**
   * Range scan over the raw, ledger-partitioned `event_logs` table (BE-003).
   *
   * The predicate shape — equality on contractId/topic0 plus a bounded
   * ledger range, ordered by ledger — is deliberate: the ledger bounds let
   * Postgres prune to the partitions overlapping [fromLedger, toLedger], and
   * inside each one the (contractId, topic0, ledger) composite index serves
   * both the filter and the ORDER BY without a sort.
   */
  async getRawEventsByLedgerRange(
    filter: LedgerRangeFilter,
  ): Promise<EventLog[]> {
    const { contractId, topic0, fromLedger, toLedger, after } = filter;
    const limit = Math.min(
      Math.max(filter.limit ?? 100, 1),
      MAX_RANGE_SCAN_LIMIT,
    );

    if (toLedger < fromLedger) return [];

    const qb = this.eventLogRepo
      .createQueryBuilder('log')
      .where('log.contractId = :contractId', { contractId })
      .andWhere('log.ledger >= :fromLedger', { fromLedger })
      .andWhere('log.ledger <= :toLedger', { toLedger })
      .orderBy('log.ledger', 'ASC')
      .addOrderBy('log.id', 'ASC')
      .limit(limit);

    if (topic0) qb.andWhere('log.topic0 = :topic0', { topic0 });
    if (after) {
      qb.andWhere('(log.ledger, log.id) > (:afterLedger, :afterId)', {
        afterLedger: after.ledger,
        afterId: after.id,
      });
    }

    const rows = await qb.getMany();
    this.logger.debug({
      msg: 'event_logs range scan',
      contractId,
      topic0: topic0 ?? null,
      fromLedger,
      toLedger,
      limit,
      returned: rows.length,
    });
    return rows;
  }

  /**
   * Atomically append a single immutable event to the store. A single
   * INSERT is already atomic in Postgres; there is deliberately no
   * multi-statement transaction here since nothing else needs to commit
   * alongside it. Never mutates or removes prior rows.
   */
  async append(
    aggregateType: AggregateType,
    aggregateId: string,
    eventType: DomainEventType,
    payload: Record<string, unknown>,
    metadata?: Partial<EventMetadata>,
    ledgerSequence?: string | number | null,
  ): Promise<EventStoreEntry> {
    const correlationId =
      metadata?.correlationId ?? correlationStorage.getStore()?.correlationId;

    const entry = this.eventRepo.create({
      aggregateType,
      aggregateId,
      eventType,
      payload,
      metadata: {
        ...metadata,
        correlationId: correlationId ?? 'unknown',
      },
      ledgerSequence:
        ledgerSequence === undefined || ledgerSequence === null
          ? null
          : String(ledgerSequence),
    });

    const saved = await this.eventRepo.save(entry);

    // Best-effort compaction — a failure here must never fail the append itself.
    try {
      await this.maybeSnapshot(aggregateType, aggregateId);
    } catch (err) {
      this.logger.warn(
        `Snapshot check failed for ${aggregateType}:${aggregateId}: ${(err as Error).message}`,
      );
    }

    return saved;
  }

  /** Full event stream for a single aggregate, oldest first. */
  async getEvents(
    aggregateType: AggregateType,
    aggregateId: string,
  ): Promise<EventStoreEntry[]> {
    return this.eventRepo.find({
      where: { aggregateType, aggregateId },
      order: { sequence: 'ASC' },
    });
  }

  /** All events across every aggregate created at or after `since`, oldest first. */
  async getEventsSince(since: Date): Promise<EventStoreEntry[]> {
    return this.eventRepo.find({
      where: { createdAt: MoreThanOrEqual(since) },
      order: { sequence: 'ASC' },
    });
  }

  /** Filtered, paginated listing backing GET /admin/events. */
  async queryEvents(filter: {
    aggregateType?: AggregateType;
    aggregateId?: string;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }): Promise<{ data: EventStoreEntry[]; total: number }> {
    const {
      aggregateType,
      aggregateId,
      from,
      to,
      page = 1,
      limit = 50,
    } = filter;

    const qb = this.eventRepo
      .createQueryBuilder('event')
      .orderBy('event.sequence', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (aggregateType)
      qb.andWhere('event.aggregateType = :aggregateType', { aggregateType });
    if (aggregateId)
      qb.andWhere('event.aggregateId = :aggregateId', { aggregateId });
    if (from) qb.andWhere('event.createdAt >= :from', { from });
    if (to) qb.andWhere('event.createdAt <= :to', { to });

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  /**
   * Rebuild an aggregate's current state by replaying its event stream.
   * Starts from the latest snapshot (if one exists) instead of the
   * beginning of history, then folds in any events appended since.
   */
  async replayAggregate(
    aggregateType: AggregateType,
    aggregateId: string,
  ): Promise<AggregateState> {
    const snapshot = await this.findLatestSnapshot(aggregateType, aggregateId);

    const events = await this.eventRepo.find({
      where: {
        aggregateType,
        aggregateId,
        ...(snapshot
          ? {
              sequence: MoreThanOrEqual(String(BigInt(snapshot.sequence) + 1n)),
            }
          : {}),
      },
      order: { sequence: 'ASC' },
    });

    const state: AggregateState = snapshot
      ? {
          aggregateType,
          aggregateId,
          version: snapshot.version,
          lastSequence: snapshot.sequence,
          lastEventType: null,
          lastEventAt: null,
          state: { ...snapshot.state },
        }
      : {
          aggregateType,
          aggregateId,
          version: 0,
          lastSequence: null,
          lastEventType: null,
          lastEventAt: null,
          state: {},
        };

    for (const event of events) {
      state.state = { ...state.state, ...event.payload };
      state.lastSequence = event.sequence;
      state.lastEventType = event.eventType;
      state.lastEventAt = event.createdAt;
      state.version += 1;
    }

    return state;
  }

  private async findLatestSnapshot(
    aggregateType: AggregateType,
    aggregateId: string,
  ): Promise<AggregateSnapshot | null> {
    return this.snapshotRepo.findOne({
      where: { aggregateType, aggregateId },
      order: { sequence: 'DESC' },
    });
  }

  /**
   * If more than `snapshotInterval` events have accumulated since the last
   * snapshot for this aggregate, replay and persist a fresh one.
   */
  private async maybeSnapshot(
    aggregateType: AggregateType,
    aggregateId: string,
  ): Promise<void> {
    const snapshot = await this.findLatestSnapshot(aggregateType, aggregateId);

    const unsnapshotted = await this.eventRepo.count({
      where: {
        aggregateType,
        aggregateId,
        ...(snapshot
          ? {
              sequence: MoreThanOrEqual(String(BigInt(snapshot.sequence) + 1n)),
            }
          : {}),
      },
    });

    if (unsnapshotted < this.snapshotInterval) return;

    const replayed = await this.replayAggregate(aggregateType, aggregateId);
    if (!replayed.lastSequence) return;

    await this.snapshotRepo.save(
      this.snapshotRepo.create({
        aggregateType,
        aggregateId,
        sequence: replayed.lastSequence,
        version: replayed.version,
        state: replayed.state,
      }),
    );

    this.logger.debug(
      `Snapshotted ${aggregateType}:${aggregateId} @ sequence ${replayed.lastSequence}`,
    );
  }
}
