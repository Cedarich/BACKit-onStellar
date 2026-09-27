import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Range-partitions the raw `event_logs` table by ledger sequence (BE-003).
 *
 * Layout
 *   event_logs                 PARTITION BY RANGE ("ledger")
 *   ├─ event_logs_p0000000     ledgers [0, 100000)
 *   ├─ event_logs_p0000001     ledgers [100000, 200000)
 *   ├─ ...                     one partition per 100,000 ledgers
 *   └─ event_logs_default      safety net — catches rows no partition covers
 *                              yet, so an insert can never fail
 *
 * Range scans on (contractId, topic0, ledger) prune to the partitions that
 * overlap the requested ledger window and then use the composite B-Tree
 * index inside each one, instead of walking one ever-growing table.
 *
 * Partition maintenance
 *   Postgres cannot create a partition from a trigger on the table being
 *   inserted into ("cannot CREATE TABLE .. PARTITION OF because it is being
 *   used by active queries"), so maintenance is a plpgsql function —
 *   event_logs_maintain_partitions() — that:
 *     1. rescues rows stranded in event_logs_default into proper partitions,
 *     2. pre-creates partitions ahead of the highest indexed ledger.
 *   It is invoked automatically by EventLogPartitionService (NestJS cron,
 *   on boot and every 10 minutes) and, when the pg_cron extension is
 *   installed, also scheduled inside the database.
 *
 * Zero data loss
 *   An existing unpartitioned event_logs (created by `synchronize`) is
 *   renamed, copied into the partitioned table and row-count verified before
 *   it is dropped. Any mismatch raises, rolling the whole migration back.
 */

const PARTITION_SIZE = 100_000;
const LOOKAHEAD_PARTITIONS = 2;

export class PartitionEventStore1760000070000 implements MigrationInterface {
  name = 'PartitionEventStore1760000070000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ kind }] = (await queryRunner.query(`
      SELECT (SELECT c.relkind::text FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = current_schema() AND c.relname = 'event_logs') AS kind
    `)) as Array<{ kind: string | null }>;

    if (kind === 'p') return; // already partitioned

    const hasLegacy = kind === 'r';
    if (hasLegacy) {
      await queryRunner.query(
        `ALTER TABLE "event_logs" RENAME TO "event_logs_legacy"`,
      );
      // RENAME TABLE keeps index/constraint names, which would collide with
      // the partitioned table's PK_event_logs / IDX_event_logs_* below.
      await queryRunner.query(`
        DO $$
        DECLARE idx record;
        BEGIN
          FOR idx IN
            SELECT ic.relname AS name FROM pg_index i
              JOIN pg_class ic ON ic.oid = i.indexrelid
             WHERE i.indrelid = 'event_logs_legacy'::regclass
          LOOP
            EXECUTE format('ALTER INDEX %I RENAME TO %I',
              idx.name, left(idx.name, 48) || '_legacy');
          END LOOP;
        END $$
      `);
      // Keep the id sequence alive when the legacy table is dropped.
      await queryRunner.query(`
        DO $$
        DECLARE seq text := pg_get_serial_sequence('event_logs_legacy', 'id');
        BEGIN
          IF seq IS NOT NULL THEN
            EXECUTE format('ALTER SEQUENCE %s OWNED BY NONE', seq);
            IF seq <> 'public.event_logs_id_seq' AND to_regclass('public.event_logs_id_seq') IS NULL THEN
              EXECUTE format('ALTER SEQUENCE %s RENAME TO event_logs_id_seq', seq);
            END IF;
          END IF;
        END $$
      `);
    }

    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS "event_logs_id_seq" AS integer`,
    );

    await queryRunner.query(`
      CREATE TABLE "event_logs" (
        "id"          integer NOT NULL DEFAULT nextval('event_logs_id_seq'),
        "eventId"     character varying NOT NULL,
        "pagingToken" character varying NOT NULL,
        "contractId"  character varying(64) NOT NULL,
        "topic0"      character varying(64),
        "eventType"   character varying(50) NOT NULL,
        "ledger"      bigint NOT NULL,
        "txHash"      character varying(64) NOT NULL,
        "txOrder"     integer NOT NULL,
        "eventData"   jsonb NOT NULL,
        "timestamp"   TIMESTAMP NOT NULL,
        "createdAt"   TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_logs" PRIMARY KEY ("id", "ledger")
      ) PARTITION BY RANGE ("ledger")
    `);
    await queryRunner.query(
      `ALTER SEQUENCE "event_logs_id_seq" OWNED BY "event_logs"."id"`,
    );

    await queryRunner.query(
      `CREATE TABLE "event_logs_default" PARTITION OF "event_logs" DEFAULT`,
    );

    // Indexes on the parent cascade to every existing and future partition.
    await queryRunner.query(`
      CREATE INDEX "IDX_event_logs_contract_topic0_ledger"
        ON "event_logs" ("contractId", "topic0", "ledger")
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_logs_ledger" ON "event_logs" ("ledger")`,
    );
    await queryRunner.query(`
      CREATE INDEX "IDX_event_logs_eventType_ledger"
        ON "event_logs" ("eventType", "ledger")
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_logs_txHash" ON "event_logs" ("txHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_logs_eventId" ON "event_logs" ("eventId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_logs_timestamp" ON "event_logs" ("timestamp")`,
    );

    await this.createMaintenanceFunctions(queryRunner);

    if (hasLegacy) {
      await this.copyLegacyRows(queryRunner);
    }

    await queryRunner.query(
      `SELECT event_logs_maintain_partitions(${LOOKAHEAD_PARTITIONS})`,
    );

    await this.schedulePgCron(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ kind }] = (await queryRunner.query(`
      SELECT (SELECT c.relkind::text FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = current_schema() AND c.relname = 'event_logs') AS kind
    `)) as Array<{ kind: string | null }>;
    if (kind !== 'p') return;

    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
          PERFORM cron.unschedule(jobid) FROM cron.job
           WHERE jobname = 'event_logs_maintain_partitions';
        END IF;
      END $$
    `);

    // Rebuild a plain table and copy everything back — no data loss on revert.
    await queryRunner.query(`
      CREATE TABLE "event_logs_unpartitioned" (
        "id"          integer NOT NULL DEFAULT nextval('event_logs_id_seq'),
        "eventId"     character varying NOT NULL,
        "pagingToken" character varying NOT NULL,
        "contractId"  character varying(64) NOT NULL,
        "topic0"      character varying(64),
        "eventType"   character varying(50) NOT NULL,
        "ledger"      bigint NOT NULL,
        "txHash"      character varying(64) NOT NULL,
        "txOrder"     integer NOT NULL,
        "eventData"   jsonb NOT NULL,
        "timestamp"   TIMESTAMP NOT NULL,
        "createdAt"   TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_logs_unpartitioned" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      INSERT INTO "event_logs_unpartitioned"
        ("id", "eventId", "pagingToken", "contractId", "topic0", "eventType",
         "ledger", "txHash", "txOrder", "eventData", "timestamp", "createdAt")
      SELECT "id", "eventId", "pagingToken", "contractId", "topic0", "eventType",
             "ledger", "txHash", "txOrder", "eventData", "timestamp", "createdAt"
        FROM "event_logs"
    `);
    await this.assertSameRowCount(
      queryRunner,
      'event_logs',
      'event_logs_unpartitioned',
    );

    await queryRunner.query(`ALTER SEQUENCE "event_logs_id_seq" OWNED BY NONE`);
    await queryRunner.query(`DROP TABLE "event_logs" CASCADE`);
    await this.dropMaintenanceFunctions(queryRunner);
    await queryRunner.query(
      `ALTER TABLE "event_logs_unpartitioned" RENAME TO "event_logs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_logs" RENAME CONSTRAINT "PK_event_logs_unpartitioned" TO "PK_event_logs"`,
    );
    await queryRunner.query(
      `ALTER SEQUENCE "event_logs_id_seq" OWNED BY "event_logs"."id"`,
    );

    for (const col of [
      'eventId',
      'contractId',
      'eventType',
      'ledger',
      'txHash',
      'timestamp',
    ]) {
      await queryRunner.query(
        `CREATE INDEX "IDX_event_logs_${col}" ON "event_logs" ("${col}")`,
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async createMaintenanceFunctions(
    queryRunner: QueryRunner,
  ): Promise<void> {
    /**
     * Create (idempotently) the partition covering [p_start, p_start + size).
     * Rows already sitting in the default partition for that range are moved
     * into the new table *before* it is attached, because ATTACH PARTITION
     * refuses to proceed while the default partition holds matching rows.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION event_logs_create_partition(p_start bigint)
      RETURNS boolean AS $$
      DECLARE
        v_size  constant bigint := ${PARTITION_SIZE};
        v_start bigint := (p_start / v_size) * v_size;
        v_end   bigint := v_start + v_size;
        v_name  text   := format('event_logs_p%s', lpad((v_start / v_size)::text, 7, '0'));
        v_moved bigint;
      BEGIN
        IF v_start < 0 THEN
          RETURN false;
        END IF;
        IF to_regclass(format('%I.%I', current_schema(), v_name)) IS NOT NULL THEN
          RETURN false;
        END IF;

        EXECUTE format(
          'CREATE TABLE %I (LIKE event_logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
          v_name);

        EXECUTE format(
          'WITH moved AS (DELETE FROM event_logs_default
                           WHERE "ledger" >= %s AND "ledger" < %s RETURNING *)
           INSERT INTO %I SELECT * FROM moved', v_start, v_end, v_name);
        GET DIAGNOSTICS v_moved = ROW_COUNT;

        -- A matching CHECK constraint lets ATTACH skip its validation scan.
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I CHECK ("ledger" >= %s AND "ledger" < %s)',
          v_name, v_name || '_range', v_start, v_end);
        EXECUTE format(
          'ALTER TABLE event_logs ATTACH PARTITION %I FOR VALUES FROM (%s) TO (%s)',
          v_name, v_start, v_end);
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', v_name, v_name || '_range');

        RAISE NOTICE 'event_logs: created partition % [%, %) moved % row(s) from default',
          v_name, v_start, v_end, v_moved;
        RETURN true;
      END;
      $$ LANGUAGE plpgsql
    `);

    /**
     * Rescue stranded rows from the default partition, then make sure the
     * partition holding the highest known ledger (the max indexed ledger, or
     * p_current_ledger if the caller knows the chain tip) and the next
     * p_lookahead partitions exist. Returns the number of partitions created.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION event_logs_maintain_partitions(
        p_lookahead integer DEFAULT ${LOOKAHEAD_PARTITIONS},
        p_current_ledger bigint DEFAULT NULL
      )
      RETURNS integer AS $$
      DECLARE
        v_size    constant bigint := ${PARTITION_SIZE};
        v_created integer := 0;
        v_head    bigint;
        r         record;
      BEGIN
        -- Serialise concurrent maintainers (cron + app instances).
        PERFORM pg_advisory_xact_lock(hashtext('event_logs_maintain_partitions'));

        FOR r IN
          SELECT DISTINCT ("ledger" / v_size) * v_size AS start
            FROM event_logs_default
        LOOP
          IF event_logs_create_partition(r.start) THEN
            v_created := v_created + 1;
          END IF;
        END LOOP;

        SELECT GREATEST(COALESCE(MAX("ledger"), 0), COALESCE(p_current_ledger, 0))
          INTO v_head FROM event_logs;

        FOR i IN 0..GREATEST(p_lookahead, 0) LOOP
          IF event_logs_create_partition(((v_head / v_size) + i) * v_size) THEN
            v_created := v_created + 1;
          END IF;
        END LOOP;

        RETURN v_created;
      END;
      $$ LANGUAGE plpgsql
    `);

    /**
     * Highest indexed ledger, probing partitions newest-first. A plain
     * `ORDER BY ledger DESC LIMIT 1` on the parent has to plan a Merge Append
     * over every partition (~10ms at 200 partitions); this touches the
     * default partition plus the first non-empty named partition (~0.5ms).
     * Partition names are zero-padded, so name order == range order.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION event_logs_max_ledger()
      RETURNS bigint AS $$
      DECLARE
        r         record;
        v_default bigint;
        v         bigint;
      BEGIN
        SELECT MAX("ledger") INTO v_default FROM event_logs_default;
        FOR r IN
          SELECT c.relname FROM pg_inherits i
            JOIN pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'event_logs'::regclass
             AND c.relname <> 'event_logs_default'
           ORDER BY c.relname DESC
        LOOP
          EXECUTE format('SELECT MAX("ledger") FROM %I', r.relname) INTO v;
          IF v IS NOT NULL THEN
            RETURN GREATEST(v, v_default);
          END IF;
        END LOOP;
        RETURN v_default;
      END;
      $$ LANGUAGE plpgsql STABLE
    `);
  }

  private async dropMaintenanceFunctions(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS event_logs_max_ledger()`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS event_logs_maintain_partitions(integer, bigint)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS event_logs_create_partition(bigint)`,
    );
  }

  private async copyLegacyRows(queryRunner: QueryRunner): Promise<void> {
    // Create every partition the legacy data needs up-front so rows route
    // straight into their final partition instead of via the default one.
    await queryRunner.query(`
      SELECT event_logs_create_partition(s.start)
        FROM (SELECT DISTINCT ("ledger" / ${PARTITION_SIZE}) * ${PARTITION_SIZE} AS start
                FROM "event_logs_legacy") s
    `);

    // Rows written before topic0 existed get the best available
    // discriminator (their eventType); a table produced by down() still has
    // topic0 and keeps it. New rows carry the raw topic symbol.
    const [{ hasTopic0 }] = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'event_logs_legacy' AND column_name = 'topic0'
      ) AS "hasTopic0"
    `)) as Array<{ hasTopic0: boolean }>;
    const derivedTopic0 = `CASE "eventType"
               WHEN 'admin_params_changed' THEN 'AdminParamsChanged'
               ELSE "eventType"
             END`;

    await queryRunner.query(`
      INSERT INTO "event_logs"
        ("id", "eventId", "pagingToken", "contractId", "topic0", "eventType",
         "ledger", "txHash", "txOrder", "eventData", "timestamp", "createdAt")
      SELECT "id", "eventId", "pagingToken", "contractId",
             ${hasTopic0 ? `COALESCE("topic0", ${derivedTopic0})` : derivedTopic0},
             "eventType", "ledger", "txHash", "txOrder", "eventData",
             "timestamp", "createdAt"
        FROM "event_logs_legacy"
    `);

    await this.assertSameRowCount(
      queryRunner,
      'event_logs_legacy',
      'event_logs',
    );

    await queryRunner.query(`
      SELECT setval('event_logs_id_seq',
                    GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "event_logs"), 1),
                    (SELECT COUNT(*) > 0 FROM "event_logs"))
    `);

    await queryRunner.query(`DROP TABLE "event_logs_legacy"`);
  }

  private async assertSameRowCount(
    queryRunner: QueryRunner,
    source: string,
    target: string,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE src bigint; dst bigint;
      BEGIN
        SELECT COUNT(*) INTO src FROM "${source}";
        SELECT COUNT(*) INTO dst FROM "${target}";
        IF src <> dst THEN
          RAISE EXCEPTION 'event_logs partition migration row count mismatch: % (%) vs % (%)',
            '${source}', src, '${target}', dst;
        END IF;
      END $$
    `);
  }

  private async schedulePgCron(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
          PERFORM cron.schedule(
            'event_logs_maintain_partitions',
            '*/10 * * * *',
            'SELECT event_logs_maintain_partitions()'
          );
        END IF;
      END $$
    `);
  }
}
