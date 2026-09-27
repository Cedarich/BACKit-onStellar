import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { EVENT_LOG_PARTITION_SIZE } from '../indexer/event-log.entity';

export interface PartitionMaintenanceResult {
  created: number;
  partitions: number;
  defaultPartitionRows: number;
}

/**
 * Automated maintenance for the ledger-range partitioned `event_logs`
 * table (BE-003).
 *
 * Calls the `event_logs_maintain_partitions()` plpgsql function installed by
 * the PartitionEventStore migration on boot and every 10 minutes. The
 * function pre-creates the next partitions ahead of the highest indexed
 * ledger and rescues any rows that landed in `event_logs_default`, so the
 * default partition stays empty and range scans keep pruning.
 *
 * Lookahead: 2 partitions × 100,000 ledgers ≈ 11.5 days at ~5s/ledger, so
 * a maintenance outage of days still never forces inserts into the default
 * partition — and even then they are only parked, never rejected.
 */
@Injectable()
export class EventLogPartitionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventLogPartitionService.name);
  private readonly lookahead = Number(
    process.env.EVENT_LOG_PARTITION_LOOKAHEAD ?? 2,
  );
  private running = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.maintainPartitions();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledMaintenance(): Promise<void> {
    await this.maintainPartitions();
  }

  /**
   * Run partition maintenance. Pass the chain's latest ledger when known so
   * partitions exist before the indexer reaches them even on an empty table.
   * Never throws — failures are logged and reported as null.
   */
  async maintainPartitions(
    currentLedger?: number,
  ): Promise<PartitionMaintenanceResult | null> {
    if (this.dataSource.options.type !== 'postgres') return null;
    if (this.running) return null;
    this.running = true;

    const startedAt = Date.now();
    try {
      if (!(await this.isPartitioned())) {
        this.logger.warn({
          msg: 'event_logs is not partitioned — run migrations (PartitionEventStore1760000070000)',
        });
        return null;
      }

      const [{ created }] = await this.dataSource.query<
        Array<{ created: number }>
      >(`SELECT event_logs_maintain_partitions($1, $2) AS created`, [
        this.lookahead,
        currentLedger ?? null,
      ]);

      const [{ partitions, defaultRows }] = await this.dataSource.query<
        Array<{ partitions: number; defaultRows: number }>
      >(`
        SELECT
          (SELECT COUNT(*)::int FROM pg_inherits i
             JOIN pg_class p ON p.oid = i.inhparent
            WHERE p.relname = 'event_logs') AS partitions,
          (SELECT COUNT(*)::int FROM event_logs_default) AS "defaultRows"
      `);

      const result: PartitionMaintenanceResult = {
        created: Number(created),
        partitions: Number(partitions),
        defaultPartitionRows: Number(defaultRows),
      };

      const log = {
        msg: 'event_logs partition maintenance complete',
        ...result,
        lookahead: this.lookahead,
        partitionSize: EVENT_LOG_PARTITION_SIZE,
        durationMs: Date.now() - startedAt,
      };
      if (result.created > 0) this.logger.log(log);
      else this.logger.debug(log);

      if (result.defaultPartitionRows > 0) {
        this.logger.warn({
          msg: 'event_logs_default still holds rows after maintenance',
          defaultPartitionRows: result.defaultPartitionRows,
        });
      }
      return result;
    } catch (err) {
      this.logger.error({
        msg: 'event_logs partition maintenance failed',
        error: (err as Error).message,
        durationMs: Date.now() - startedAt,
      });
      return null;
    } finally {
      this.running = false;
    }
  }

  private async isPartitioned(): Promise<boolean> {
    const rows = await this.dataSource.query<unknown[]>(`
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND c.relname = 'event_logs'
         AND c.relkind = 'p'
    `);
    return rows.length > 0;
  }
}
