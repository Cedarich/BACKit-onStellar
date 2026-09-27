import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Failed Soroban transaction index (BE-004).
 *
 * One row per failed transaction hash with the parsed diagnostic report
 * (contract error variant, auth / footprint flags, host messages) so users
 * can be notified with a human-readable reason and operators can debug
 * failures after the RPC's short retention window has expired.
 */
export class CreateFailedTransactionsTable1760000060000 implements MigrationInterface {
  name = 'CreateFailedTransactionsTable1760000060000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "failed_transactions" (
        "id"                  SERIAL NOT NULL,
        "txHash"              character varying(64) NOT NULL,
        "contractId"          character varying(64),
        "userAddress"         character varying(64),
        "ledger"              bigint,
        "resultCode"          character varying(64),
        "operationResultCode" character varying(64),
        "errorCategory"       character varying(32),
        "errorName"           character varying(128),
        "errorCode"           integer,
        "message"             text NOT NULL,
        "diagnostics"         jsonb NOT NULL,
        "notified"            boolean NOT NULL DEFAULT false,
        "createdAt"           TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"           TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_failed_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_failed_transactions_txHash" UNIQUE ("txHash")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_failed_transactions_contractId"
        ON "failed_transactions" ("contractId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_failed_transactions_userAddress"
        ON "failed_transactions" ("userAddress")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_failed_transactions_errorCategory"
        ON "failed_transactions" ("errorCategory")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_failed_transactions_errorCategory"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_failed_transactions_userAddress"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_failed_transactions_contractId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "failed_transactions"`);
  }
}
