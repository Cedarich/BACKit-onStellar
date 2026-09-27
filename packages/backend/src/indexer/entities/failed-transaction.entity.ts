import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import type { TransactionDiagnosticReport } from '../diagnostic-parser.service';

/**
 * A failed Soroban transaction plus its parsed diagnostics (BE-004).
 * Indexed so users can be notified with a human-readable reason and
 * operators can debug failures after the RPC's retention window expires.
 */
@Entity('failed_transactions')
export class FailedTransaction {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 64, unique: true })
  txHash: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index()
  contractId: string | null;

  /** Stellar account the failure should be reported to (tx source). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index()
  userAddress: string | null;

  @Column({ type: 'bigint', nullable: true })
  ledger: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  resultCode: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  operationResultCode: string | null;

  /** DiagnosticErrorCategory of the primary error. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  @Index()
  errorCategory: string | null;

  /** e.g. `CallRegistryError::CallEnded`. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  errorName: string | null;

  @Column({ type: 'integer', nullable: true })
  errorCode: number | null;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'jsonb' })
  diagnostics: TransactionDiagnosticReport;

  @Column({ type: 'boolean', default: false })
  notified: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
