import { Injectable, Logger } from '@nestjs/common';
import {
  StrKey,
  encodeMuxedAccountToAddress,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  CONTRACT_ERROR_REGISTRY,
  ContractErrorEnum,
} from './contract-errors.generated';

/**
 * Soroban RPC diagnostic event & XDR error code parser (BE-004).
 *
 * Turns the raw `diagnosticEvents` / `resultXdr` / simulation error strings
 * returned by Soroban RPC for a failed transaction into a structured
 * {@link TransactionDiagnosticReport}: which contract failed, the
 * `#[contracterror]` variant it raised (translated via the registry generated
 * from packages/contracts/*\/src/errors.rs), and whether the failure was an
 * authorization failure, a footprint/storage exhaustion or a budget overrun.
 *
 * Every entry point is total: malformed XDR, unexpected shapes or unknown
 * codes degrade to `UNKNOWN` entries and counters — they never throw.
 */

export enum DiagnosticErrorCategory {
  CONTRACT = 'contract',
  AUTH = 'auth',
  FOOTPRINT = 'footprint',
  STORAGE = 'storage',
  BUDGET = 'budget',
  WASM_VM = 'wasm_vm',
  CONTEXT = 'context',
  OBJECT = 'object',
  CRYPTO = 'crypto',
  EVENTS = 'events',
  VALUE = 'value',
  UNKNOWN = 'unknown',
}

export interface ContractErrorTranslation {
  /** Crate name under packages/contracts, when the contract is known. */
  contract: string | null;
  enumName: string | null;
  /** Rust variant name, e.g. `CallEnded`. */
  name: string | null;
  message: string;
  /**
   * When the emitting contract could not be identified, every registered
   * contract that defines this code — useful for debugging mis-configured
   * contract ID mappings.
   */
  candidates: string[];
}

export interface HostErrorDetail {
  category: DiagnosticErrorCategory;
  /** ScErrorType without the `sce` prefix: `Contract`, `Auth`, `Storage`... */
  errorType: string;
  /** Numeric code for contract errors. */
  code: number | null;
  /** ScErrorCode without the `scec` prefix for host errors, e.g. `ExceededLimit`. */
  codeName: string | null;
  contractId: string | null;
  contract: string | null;
  enumName: string | null;
  /** Rust variant name for contract errors, e.g. `CallEnded`. */
  errorName: string | null;
  /** Human-readable, user-facing explanation. */
  message: string;
  /** Raw diagnostic message emitted by the host, if any. */
  hostMessage: string | null;
  /** JSON-safe diagnostic arguments emitted alongside the error. */
  args: unknown[];
}

export interface DecodedDiagnosticEvent {
  inSuccessfulContractCall: boolean;
  contractId: string | null;
  eventType: string;
  topics: unknown[];
  data: unknown;
  error: HostErrorDetail | null;
  /** Function name when this is a `fn_call` diagnostic event. */
  fnCall: string | null;
}

export interface TransactionDiagnosticReport {
  txHash: string | null;
  contractId: string | null;
  failed: boolean;
  /** TransactionResultCode, e.g. `txFailed`. */
  resultCode: string | null;
  /** InvokeHostFunctionResultCode, e.g. `invokeHostFunctionTrapped`. */
  operationResultCode: string | null;
  errors: HostErrorDetail[];
  primaryError: HostErrorDetail | null;
  contractError: HostErrorDetail | null;
  authFailure: boolean;
  footprintExhausted: boolean;
  budgetExhausted: boolean;
  resourceLimitExceeded: boolean;
  entryArchived: boolean;
  /** Contract function names invoked, outermost first. */
  callStack: string[];
  eventCount: number;
  malformedEventCount: number;
  summary: string;
}

export interface AnalyzeTransactionInput {
  txHash?: string | null;
  contractId?: string | null;
  /** xdr.DiagnosticEvent instances, base64 strings or raw buffers. */
  diagnosticEvents?: unknown;
  /** xdr.TransactionResult or base64 string. */
  resultXdr?: unknown;
  /** xdr.TransactionMeta or base64 — diagnostic events fallback. */
  resultMetaXdr?: unknown;
  /** Simulation / host error string, e.g. `HostError: Error(Contract, #6)`. */
  errorMessage?: unknown;
  /** Force a contract crate for code translation (skips contract ID lookup). */
  contractHint?: string | null;
}

const ERROR_TYPE_CATEGORY: Record<string, DiagnosticErrorCategory> = {
  Contract: DiagnosticErrorCategory.CONTRACT,
  WasmVm: DiagnosticErrorCategory.WASM_VM,
  Context: DiagnosticErrorCategory.CONTEXT,
  Storage: DiagnosticErrorCategory.STORAGE,
  Object: DiagnosticErrorCategory.OBJECT,
  Crypto: DiagnosticErrorCategory.CRYPTO,
  Events: DiagnosticErrorCategory.EVENTS,
  Budget: DiagnosticErrorCategory.BUDGET,
  Value: DiagnosticErrorCategory.VALUE,
  Auth: DiagnosticErrorCategory.AUTH,
};

const HOST_CODE_MESSAGES: Record<string, string> = {
  ArithDomain: 'an arithmetic operation was out of domain',
  IndexBounds: 'an index was out of bounds',
  InvalidInput: 'invalid input was supplied',
  MissingValue: 'a required value was missing',
  ExistingValue: 'a value already exists',
  ExceededLimit: 'a limit was exceeded',
  InvalidAction: 'an invalid action was attempted',
  InternalError: 'an internal host error occurred',
  UnexpectedType: 'a value had an unexpected type',
  UnexpectedSize: 'a value had an unexpected size',
};

/** Lower number = more specific root cause; drives primaryError selection. */
const CATEGORY_PRIORITY: Record<DiagnosticErrorCategory, number> = {
  [DiagnosticErrorCategory.CONTRACT]: 0,
  [DiagnosticErrorCategory.AUTH]: 1,
  [DiagnosticErrorCategory.FOOTPRINT]: 2,
  [DiagnosticErrorCategory.BUDGET]: 3,
  [DiagnosticErrorCategory.STORAGE]: 4,
  [DiagnosticErrorCategory.VALUE]: 5,
  [DiagnosticErrorCategory.OBJECT]: 6,
  [DiagnosticErrorCategory.CRYPTO]: 7,
  [DiagnosticErrorCategory.CONTEXT]: 8,
  [DiagnosticErrorCategory.EVENTS]: 9,
  [DiagnosticErrorCategory.WASM_VM]: 10,
  [DiagnosticErrorCategory.UNKNOWN]: 11,
};

const CONTRACT_ID_RE = /\bC[A-Z2-7]{55}\b/;
const HOST_ERROR_RE = /Error\(\s*(\w+)\s*,\s*(#?\w+)\s*\)/g;

@Injectable()
export class DiagnosticParserService {
  private readonly logger = new Logger(DiagnosticParserService.name);

  /** contractId (C...) -> crate name in CONTRACT_ERROR_REGISTRY. */
  private readonly contractKinds = new Map<string, string>();

  constructor() {
    this.loadContractKindsFromEnv();
  }

  // ─── Contract ID → contract crate mapping ─────────────────────────────────

  /** Register which contract crate a deployed contract ID runs. */
  registerContract(contractId: string, contract: string): void {
    if (!contractId || !CONTRACT_ERROR_REGISTRY[contract]) {
      this.logger.warn({
        msg: 'Ignoring contract mapping for unknown contract crate',
        contractId,
        contract,
      });
      return;
    }
    this.contractKinds.set(contractId, contract);
  }

  /**
   * Seeds mappings from the environment:
   *  - SOROBAN_CONTRACT_ERROR_MAP="CID1:call_registry,CID2:outcome_manager"
   *  - SOROBAN_CONTRACT_ID (the indexed contract) as SOROBAN_CONTRACT_KIND,
   *    defaulting to call_registry
   *  - OUTCOME_MANAGER_CONTRACT_ADDRESS as outcome_manager
   */
  private loadContractKindsFromEnv(): void {
    const pairs: Array<[string | undefined, string]> = [
      [
        process.env.SOROBAN_CONTRACT_ID,
        process.env.SOROBAN_CONTRACT_KIND ?? 'call_registry',
      ],
      [process.env.OUTCOME_MANAGER_CONTRACT_ADDRESS, 'outcome_manager'],
    ];

    for (const entry of (process.env.SOROBAN_CONTRACT_ERROR_MAP ?? '').split(
      ',',
    )) {
      const [id, kind] = entry.split(':').map((s) => s.trim());
      if (id && kind) pairs.push([id, kind]);
    }

    for (const [id, kind] of pairs) {
      if (id) this.registerContract(id, kind);
    }
  }

  // ─── Contract error translation ───────────────────────────────────────────

  /**
   * Translate a numeric `Error(Contract, #code)` into the contract's
   * `#[contracterror]` variant and message.
   */
  translateContractError(
    code: number,
    contractId?: string | null,
    contractHint?: string | null,
  ): ContractErrorTranslation {
    const kind =
      (contractHint && CONTRACT_ERROR_REGISTRY[contractHint]
        ? contractHint
        : null) ?? (contractId ? this.contractKinds.get(contractId) : null);

    if (kind) {
      const registry: ContractErrorEnum = CONTRACT_ERROR_REGISTRY[kind];
      const def = registry.errors[code];
      if (def) {
        return {
          contract: kind,
          enumName: registry.enumName,
          name: def.name,
          message: def.message,
          candidates: [kind],
        };
      }
      return {
        contract: kind,
        enumName: registry.enumName,
        name: null,
        message: `Contract ${kind} failed with unrecognised error code #${code}.`,
        candidates: [kind],
      };
    }

    // Unknown contract: search every registry for this code.
    const matches = Object.values(CONTRACT_ERROR_REGISTRY).filter(
      (r) => r.errors[code],
    );
    const names = new Set(matches.map((r) => r.errors[code].name));
    if (matches.length > 0 && names.size === 1) {
      // Unambiguous by name (e.g. AlreadyInitialized = 1 everywhere).
      const def = matches[0].errors[code];
      return {
        contract: matches.length === 1 ? matches[0].contract : null,
        enumName: matches.length === 1 ? matches[0].enumName : null,
        name: def.name,
        message: def.message,
        candidates: matches.map((r) => r.contract),
      };
    }

    return {
      contract: null,
      enumName: null,
      name: null,
      message:
        `Contract${contractId ? ` ${contractId}` : ''} failed with error code #${code}` +
        (matches.length > 0
          ? ` (possible: ${matches
              .map((r) => `${r.enumName}::${r.errors[code].name}`)
              .join(', ')}).`
          : '.'),
      candidates: matches.map((r) => r.contract),
    };
  }

  // ─── Single diagnostic event ──────────────────────────────────────────────

  /**
   * Decode one diagnostic event. Accepts an `xdr.DiagnosticEvent`, a base64
   * XDR string or a raw buffer. Returns null for anything undecodable.
   */
  parseDiagnosticEvent(
    input: unknown,
    contractHint?: string | null,
  ): DecodedDiagnosticEvent | null {
    const event = this.toDiagnosticEvent(input);
    if (!event) return null;

    try {
      const contractEvent = event.event();
      const contractId = this.safe(() => {
        const raw = contractEvent.contractId();
        return raw ? StrKey.encodeContract(Buffer.from(raw)) : null;
      }, null);
      const eventType = this.safe(() => contractEvent.type().name, 'unknown');
      const body = contractEvent.body().v0();
      const rawTopics = body.topics();
      const rawData = body.data();

      const topics = rawTopics.map((t) => this.scValToJson(t));
      const data = this.scValToJson(rawData);

      let error: HostErrorDetail | null = null;
      const errorVal =
        rawTopics.find((t) => this.isScvError(t)) ??
        (this.isScvError(rawData) ? rawData : undefined);
      if (errorVal) {
        const { hostMessage, args } = this.extractHostMessage(
          rawData,
          errorVal === rawData,
        );
        error = this.parseScError(
          errorVal.error(),
          contractId,
          hostMessage,
          args,
          contractHint,
        );
      }

      const fnCall =
        topics[0] === 'fn_call' && typeof topics[2] === 'string'
          ? topics[2]
          : null;

      return {
        inSuccessfulContractCall: this.safe(
          () => event.inSuccessfulContractCall(),
          false,
        ),
        contractId,
        eventType,
        topics,
        data,
        error,
        fnCall,
      };
    } catch (err) {
      this.logger.debug({
        msg: 'Failed to decode diagnostic event body',
        error: (err as Error).message,
      });
      return null;
    }
  }

  // ─── Error strings (simulation / HostError) ───────────────────────────────

  /**
   * Parse host error strings such as the `error` field of a failed
   * simulation: `HostError: Error(Contract, #6) ... contract:C...`.
   */
  parseErrorString(
    message: unknown,
    contractId?: string | null,
    contractHint?: string | null,
  ): HostErrorDetail[] {
    if (typeof message !== 'string' || !message) return [];

    const inferredContract =
      contractId ?? message.match(CONTRACT_ID_RE)?.[0] ?? null;
    const seen = new Set<string>();
    const out: HostErrorDetail[] = [];

    for (const m of message.matchAll(HOST_ERROR_RE)) {
      const [, errorType, rawCode] = m;
      const key = `${errorType}:${rawCode}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (rawCode.startsWith('#') || /^\d+$/.test(rawCode)) {
        const code = Number(rawCode.replace('#', ''));
        if (errorType === 'Contract') {
          out.push(
            this.buildContractError(
              code,
              inferredContract,
              null,
              [],
              contractHint,
            ),
          );
          continue;
        }
      }
      out.push(
        this.buildHostError(
          errorType,
          rawCode.replace(/^#/, ''),
          inferredContract,
          null,
          [],
        ),
      );
    }

    return out;
  }

  // ─── XDR results ──────────────────────────────────────────────────────────

  /** Extract result codes from an `xdr.TransactionResult` (or base64). */
  parseTransactionResult(input: unknown): {
    resultCode: string | null;
    operationResultCode: string | null;
  } {
    const empty = { resultCode: null, operationResultCode: null };
    const result = this.decode(input, (s) =>
      xdr.TransactionResult.fromXDR(s, 'base64'),
    );
    if (!result) return empty;

    try {
      const outer = result.result();
      const outerCode = outer.switch().name;

      // Fee-bump wrappers carry the real result one level down.
      const inner:
        | xdr.TransactionResultResult
        | xdr.InnerTransactionResultResult =
        outerCode === 'txFeeBumpInnerFailed' ||
        outerCode === 'txFeeBumpInnerSuccess'
          ? outer.innerResultPair().result().result()
          : outer;

      const opResults = this.safe<xdr.OperationResult[]>(
        () => inner.results(),
        [],
      );
      let operationResultCode: string | null = null;
      for (const op of opResults) {
        const code = this.safe<string | null>(() => {
          if (op.switch().name !== 'opInner') return op.switch().name;
          const tr = op.tr();
          if (tr.switch().name === 'invokeHostFunction') {
            return tr.invokeHostFunctionResult().switch().name;
          }
          return null;
        }, null);
        if (code && !/Success$/.test(code)) {
          operationResultCode = code;
          break;
        }
        operationResultCode ??= code;
      }

      return { resultCode: inner.switch().name, operationResultCode };
    } catch {
      return empty;
    }
  }

  // ─── Whole-transaction analysis ───────────────────────────────────────────

  analyzeTransaction(
    input: AnalyzeTransactionInput,
  ): TransactionDiagnosticReport {
    const txHash = input.txHash ?? null;
    const contractHint = input.contractHint ?? null;

    let rawEvents: unknown[] = Array.isArray(input.diagnosticEvents)
      ? input.diagnosticEvents
      : [];
    if (rawEvents.length === 0 && input.resultMetaXdr) {
      rawEvents = this.diagnosticEventsFromMeta(input.resultMetaXdr);
    }

    const errors: HostErrorDetail[] = [];
    const callStack: string[] = [];
    let malformedEventCount = 0;
    let contractId = input.contractId ?? null;

    for (const raw of rawEvents) {
      const decoded = this.parseDiagnosticEvent(raw, contractHint);
      if (!decoded) {
        malformedEventCount++;
        continue;
      }
      contractId ??= decoded.contractId;
      if (decoded.fnCall) callStack.push(decoded.fnCall);
      if (decoded.error) errors.push(decoded.error);
    }

    errors.push(
      ...this.parseErrorString(input.errorMessage, contractId, contractHint),
    );

    const { resultCode, operationResultCode } = this.parseTransactionResult(
      input.resultXdr,
    );

    const deduped = this.dedupe(errors);
    const primaryError = this.pickPrimary(deduped);
    const contractError =
      deduped.find((e) => e.category === DiagnosticErrorCategory.CONTRACT) ??
      null;

    const authFailure = deduped.some(
      (e) =>
        e.category === DiagnosticErrorCategory.AUTH ||
        (e.category === DiagnosticErrorCategory.CONTRACT &&
          /^(Unauthori[sz]ed|NotAuthori[sz]ed)/.test(e.errorName ?? '')),
    );
    const footprintExhausted = deduped.some(
      (e) => e.category === DiagnosticErrorCategory.FOOTPRINT,
    );
    const budgetExhausted = deduped.some(
      (e) => e.category === DiagnosticErrorCategory.BUDGET,
    );
    const resourceLimitExceeded =
      operationResultCode === 'invokeHostFunctionResourceLimitExceeded' ||
      footprintExhausted ||
      budgetExhausted;
    const entryArchived =
      operationResultCode === 'invokeHostFunctionEntryArchived';

    const failed =
      deduped.length > 0 ||
      (resultCode !== null && !/Success$/.test(resultCode)) ||
      (operationResultCode !== null && !/Success$/.test(operationResultCode));

    const report: TransactionDiagnosticReport = {
      txHash,
      contractId,
      failed,
      resultCode,
      operationResultCode,
      errors: deduped,
      primaryError,
      contractError,
      authFailure,
      footprintExhausted,
      budgetExhausted,
      resourceLimitExceeded,
      entryArchived,
      callStack,
      eventCount: rawEvents.length,
      malformedEventCount,
      summary: '',
    };
    report.summary = this.summarize(report);
    return report;
  }

  /** Analyze a `getTransaction` response (any status). */
  analyzeGetTransactionResponse(
    txHash: string,
    response: unknown,
    contractHint?: string | null,
  ): TransactionDiagnosticReport {
    const r = (response ?? {}) as Record<string, unknown>;
    return this.analyzeTransaction({
      txHash,
      diagnosticEvents: r.diagnosticEventsXdr,
      resultXdr: r.resultXdr,
      resultMetaXdr: r.resultMetaXdr,
      contractHint,
    });
  }

  /** Analyze a `sendTransaction` response whose status is ERROR. */
  analyzeSendTransactionResponse(
    response: unknown,
    contractHint?: string | null,
  ): TransactionDiagnosticReport {
    const r = (response ?? {}) as Record<string, unknown>;
    return this.analyzeTransaction({
      txHash: typeof r.hash === 'string' ? r.hash : null,
      diagnosticEvents: r.diagnosticEvents ?? r.diagnosticEventsXdr,
      resultXdr: r.errorResult ?? r.errorResultXdr,
      contractHint,
    });
  }

  /** Analyze a failed `simulateTransaction` response. */
  analyzeSimulationResponse(
    response: unknown,
    contractHint?: string | null,
  ): TransactionDiagnosticReport {
    const r = (response ?? {}) as Record<string, unknown>;
    return this.analyzeTransaction({
      diagnosticEvents: r.events,
      errorMessage: r.error,
      contractHint,
    });
  }

  /**
   * Source account (G... / M...) of an `xdr.TransactionEnvelope` (or
   * base64). For fee-bumps this is the inner transaction's source — the user
   * who signed the invocation, not the fee sponsor.
   */
  extractSourceAccount(envelopeInput: unknown): string | null {
    const envelope = this.decode(envelopeInput, (s) =>
      xdr.TransactionEnvelope.fromXDR(s, 'base64'),
    );
    if (!envelope) return null;
    return this.safe<string | null>(() => {
      switch (envelope.switch().name) {
        case 'envelopeTypeTx':
          return encodeMuxedAccountToAddress(
            envelope.v1().tx().sourceAccount(),
            true,
          );
        case 'envelopeTypeTxFeeBump':
          return encodeMuxedAccountToAddress(
            envelope.feeBump().tx().innerTx().v1().tx().sourceAccount(),
            true,
          );
        case 'envelopeTypeTxV0':
          return StrKey.encodeEd25519PublicKey(
            Buffer.from(envelope.v0().tx().sourceAccountEd25519()),
          );
        default:
          return null;
      }
    }, null);
  }

  /** Structured log of a failed transaction's diagnostics for debugging. */
  logReport(
    report: TransactionDiagnosticReport,
    context: Record<string, unknown> = {},
  ): void {
    if (!report.failed) return;
    this.logger.warn({
      msg: 'Soroban transaction failed',
      ...context,
      txHash: report.txHash,
      contractId: report.contractId,
      resultCode: report.resultCode,
      operationResultCode: report.operationResultCode,
      summary: report.summary,
      primaryError: report.primaryError,
      authFailure: report.authFailure,
      footprintExhausted: report.footprintExhausted,
      budgetExhausted: report.budgetExhausted,
      resourceLimitExceeded: report.resourceLimitExceeded,
      entryArchived: report.entryArchived,
      callStack: report.callStack,
      errorCount: report.errors.length,
      eventCount: report.eventCount,
      malformedEventCount: report.malformedEventCount,
    });
    if (report.errors.length > 1) {
      this.logger.debug({
        msg: 'Soroban transaction diagnostic errors',
        txHash: report.txHash,
        errors: report.errors,
      });
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private parseScError(
    scError: xdr.ScError,
    contractId: string | null,
    hostMessage: string | null,
    args: unknown[],
    contractHint?: string | null,
  ): HostErrorDetail {
    const typeName = this.safe(() => scError.switch().name, 'sceUnknown');
    const errorType = typeName.replace(/^sce/, '');

    if (errorType === 'Contract') {
      const code = this.safe(() => Number(scError.contractCode()), NaN);
      if (Number.isFinite(code)) {
        return this.buildContractError(
          code,
          contractId,
          hostMessage,
          args,
          contractHint,
        );
      }
    }

    const codeName = this.safe<string | null>(
      () => scError.code().name.replace(/^scec/, ''),
      null,
    );
    return this.buildHostError(
      errorType,
      codeName,
      contractId,
      hostMessage,
      args,
    );
  }

  private buildContractError(
    code: number,
    contractId: string | null,
    hostMessage: string | null,
    args: unknown[],
    contractHint?: string | null,
  ): HostErrorDetail {
    const t = this.translateContractError(code, contractId, contractHint);
    return {
      category: DiagnosticErrorCategory.CONTRACT,
      errorType: 'Contract',
      code,
      codeName: null,
      contractId,
      contract: t.contract,
      enumName: t.enumName,
      errorName: t.name,
      message: t.message,
      hostMessage,
      args,
    };
  }

  private buildHostError(
    errorType: string,
    codeName: string | null,
    contractId: string | null,
    hostMessage: string | null,
    args: unknown[],
  ): HostErrorDetail {
    let category =
      ERROR_TYPE_CATEGORY[errorType] ?? DiagnosticErrorCategory.UNKNOWN;
    if (
      category === DiagnosticErrorCategory.STORAGE &&
      (codeName === 'ExceededLimit' || /footprint/i.test(hostMessage ?? ''))
    ) {
      category = DiagnosticErrorCategory.FOOTPRINT;
    }

    return {
      category,
      errorType,
      code: null,
      codeName,
      contractId,
      contract: contractId
        ? (this.contractKinds.get(contractId) ?? null)
        : null,
      enumName: null,
      errorName: null,
      message: this.hostErrorMessage(category, errorType, codeName),
      hostMessage,
      args,
    };
  }

  private hostErrorMessage(
    category: DiagnosticErrorCategory,
    errorType: string,
    codeName: string | null,
  ): string {
    switch (category) {
      case DiagnosticErrorCategory.AUTH:
        return 'Authorization failed: a required signature is missing or the signed authorization does not match this invocation.';
      case DiagnosticErrorCategory.FOOTPRINT:
        return 'Footprint exhausted: the transaction touched a ledger entry outside its declared footprint or exceeded its storage limits. Re-simulate and resubmit.';
      case DiagnosticErrorCategory.BUDGET:
        return codeName === 'ExceededLimit'
          ? 'Resource budget exceeded: the transaction ran out of CPU instructions or memory.'
          : `Resource budget error: ${HOST_CODE_MESSAGES[codeName ?? ''] ?? 'unknown budget failure'}.`;
      case DiagnosticErrorCategory.STORAGE:
        return codeName === 'MissingValue'
          ? 'A required ledger entry was not found (it may be archived or was never created).'
          : `Storage error: ${HOST_CODE_MESSAGES[codeName ?? ''] ?? 'unknown storage failure'}.`;
      default: {
        const detail = HOST_CODE_MESSAGES[codeName ?? ''];
        return detail
          ? `Host ${errorType} error: ${detail}.`
          : `Host ${errorType} error${codeName ? ` (${codeName})` : ''}.`;
      }
    }
  }

  /**
   * Host error events carry `data` as either a message string or a vec of
   * `[message, ...args]`.
   */
  private extractHostMessage(
    data: xdr.ScVal,
    dataIsError: boolean,
  ): { hostMessage: string | null; args: unknown[] } {
    if (dataIsError) return { hostMessage: null, args: [] };
    const native = this.scValToJson(data);
    if (typeof native === 'string') return { hostMessage: native, args: [] };
    if (Array.isArray(native) && typeof native[0] === 'string') {
      return { hostMessage: native[0], args: native.slice(1) };
    }
    return {
      hostMessage: null,
      args: native === null || native === undefined ? [] : [native],
    };
  }

  private diagnosticEventsFromMeta(input: unknown): unknown[] {
    const meta = this.decode(input, (s) =>
      xdr.TransactionMeta.fromXDR(s, 'base64'),
    );
    if (!meta) return [];
    // Only TransactionMeta v3 carries Soroban diagnostics in this SDK.
    return this.safe<unknown[]>(
      () =>
        meta.switch() === 3
          ? (meta.v3().sorobanMeta()?.diagnosticEvents() ?? [])
          : [],
      [],
    );
  }

  private toDiagnosticEvent(input: unknown): xdr.DiagnosticEvent | null {
    const decoded = this.decode(input, (s) =>
      xdr.DiagnosticEvent.fromXDR(s, 'base64'),
    );
    if (!decoded) return null;
    // Duck-type check: a DiagnosticEvent must expose event().body().
    return typeof (decoded as { event?: unknown }).event === 'function'
      ? decoded
      : null;
  }

  /**
   * Normalise XDR input: passes XDR instances through, decodes base64 strings
   * and raw buffers. Returns null for anything that fails to decode.
   */
  private decode<T>(input: unknown, fromBase64: (s: string) => T): T | null {
    if (input === null || input === undefined) return null;
    try {
      if (typeof input === 'string') {
        if (!input.trim()) return null;
        return fromBase64(input.trim());
      }
      if (input instanceof Uint8Array) {
        return fromBase64(Buffer.from(input).toString('base64'));
      }
      if (typeof input === 'object') return input as T;
      return null;
    } catch (err) {
      this.logger.debug({
        msg: 'Malformed XDR input',
        error: (err as Error).message,
      });
      return null;
    }
  }

  private isScvError(val: unknown): val is xdr.ScVal {
    return this.safe(
      () => (val as xdr.ScVal).switch() === xdr.ScValType.scvError(),
      false,
    );
  }

  /** scValToNative, made JSON-safe (bigint → string, bytes → hex). */
  private scValToJson(val: xdr.ScVal): unknown {
    const native = this.safe<unknown>(() => {
      if (this.isScvError(val)) {
        const e = val.error();
        const type = e.switch().name.replace(/^sce/, '');
        return type === 'Contract'
          ? `Error(Contract, #${e.contractCode()})`
          : `Error(${type}, ${e.code().name.replace(/^scec/, '')})`;
      }
      return scValToNative(val);
    }, null);
    return this.jsonSafe(native, 0);
  }

  private jsonSafe(value: unknown, depth: number): unknown {
    if (depth > 8) return '[depth-limit]';
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
    if (Array.isArray(value))
      return value.map((v) => this.jsonSafe(v, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.jsonSafe(v, depth + 1)]),
      );
    }
    return value;
  }

  private dedupe(errors: HostErrorDetail[]): HostErrorDetail[] {
    // Soroban re-emits the same error as it escalates up the call stack;
    // keep the first (innermost) occurrence, preferring ones with a message.
    const byKey = new Map<string, HostErrorDetail>();
    for (const e of errors) {
      const key = `${e.errorType}:${e.code ?? e.codeName}:${e.contractId ?? ''}`;
      const existing = byKey.get(key);
      if (!existing) byKey.set(key, e);
      else if (!existing.hostMessage && e.hostMessage) {
        byKey.set(key, {
          ...existing,
          hostMessage: e.hostMessage,
          args: e.args,
        });
      }
    }
    return [...byKey.values()];
  }

  private pickPrimary(errors: HostErrorDetail[]): HostErrorDetail | null {
    let best: HostErrorDetail | null = null;
    for (const e of errors) {
      if (
        !best ||
        CATEGORY_PRIORITY[e.category] < CATEGORY_PRIORITY[best.category]
      ) {
        best = e;
      }
    }
    return best;
  }

  private summarize(report: TransactionDiagnosticReport): string {
    if (!report.failed) return 'Transaction succeeded.';
    const p = report.primaryError;
    if (p?.category === DiagnosticErrorCategory.CONTRACT) {
      const label =
        p.enumName && p.errorName
          ? `${p.enumName}::${p.errorName}`
          : `#${p.code}`;
      return `${p.message} [${label}]`;
    }
    if (p) return p.message;
    if (report.entryArchived) {
      return 'A ledger entry required by the transaction is archived and must be restored first.';
    }
    if (report.resourceLimitExceeded) {
      return 'The transaction exceeded its declared resource limits. Re-simulate and resubmit.';
    }
    const code = report.operationResultCode ?? report.resultCode;
    return `Transaction failed${code ? ` (${code})` : ''}.`;
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }
}
