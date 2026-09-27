import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  PrimaryColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum EventType {
  CALL_CREATED = 'call_created',
  STAKE_ADDED = 'stake_added',
  CALL_RESOLVED = 'call_resolved',
  CALL_SETTLED = 'call_settled',
  ADMIN_CHANGED = 'admin_changed',
  ADMIN_PARAMS_CHANGED = 'admin_params_changed',
  OUTCOME_MANAGER_CHANGED = 'outcome_manager_changed',
  OUTCOME_FINALIZED = 'outcome_finalized',
  INITIALIZED = 'initialized',
}

/** Ledgers per `event_logs` range partition (see PartitionEventStore migration). */
export const EVENT_LOG_PARTITION_SIZE = 100_000;

/**
 * Raw contract event log, range-partitioned by ledger sequence into
 * 100,000-ledger partitions (BE-003).
 *
 * The PartitionEventStore migration owns the partitioned layout. This entity
 * mirrors it exactly (column types, (id, ledger) primary key, index names), so
 * dev-mode `synchronize` is a no-op against the partitioned table, and on an
 * empty database it creates a plain table the migration later converts.
 * The primary key is (id, ledger) because Postgres requires the partition key
 * in every unique constraint on a partitioned table.
 */
@Entity('event_logs')
@Index('IDX_event_logs_contract_topic0_ledger', [
  'contractId',
  'topic0',
  'ledger',
])
@Index('IDX_event_logs_eventType_ledger', ['eventType', 'ledger'])
export class EventLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index('IDX_event_logs_eventId')
  eventId: string;

  @Column()
  pagingToken: string;

  @Column({ type: 'varchar', length: 64 })
  contractId: string;

  /** First event topic symbol as emitted by the contract, e.g. `AdminParamsChanged`. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  topic0?: string | null;

  @Column({ type: 'varchar', length: 50 })
  eventType: EventType;

  /** Ledger sequence — the partition key. */
  @PrimaryColumn({ type: 'bigint' })
  @Index('IDX_event_logs_ledger')
  ledger: number;

  @Column({ type: 'varchar', length: 64 })
  @Index('IDX_event_logs_txHash')
  txHash: string;

  @Column({ type: 'integer' })
  txOrder: number;

  @Column({ type: 'jsonb' })
  eventData: any;

  @Column({ type: 'timestamp' })
  @Index('IDX_event_logs_timestamp')
  timestamp: Date;

  @CreateDateColumn()
  createdAt: Date;
}
