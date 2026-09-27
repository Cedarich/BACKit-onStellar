import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  DiagnosticErrorCategory,
  DiagnosticParserService,
} from './diagnostic-parser.service';
import { CONTRACT_ERROR_REGISTRY } from './contract-errors.generated';

const CALL_REGISTRY_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const OUTCOME_MANAGER_ID = StrKey.encodeContract(Buffer.alloc(32, 2));
const UNKNOWN_ID = StrKey.encodeContract(Buffer.alloc(32, 9));

// ─── XDR builders ───────────────────────────────────────────────────────────

function diagnosticEvent(opts: {
  contractId?: string | null;
  topics: xdr.ScVal[];
  data?: xdr.ScVal;
  inSuccessfulContractCall?: boolean;
}): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: opts.inSuccessfulContractCall ?? false,
    event: new xdr.ContractEvent({
      ext: new (xdr.ExtensionPoint as any)(0),
      contractId: opts.contractId
        ? (StrKey.decodeContract(opts.contractId) as any)
        : null,
      type: xdr.ContractEventType.diagnostic(),
      body: new (xdr.ContractEventBody as any)(
        0,
        new xdr.ContractEventV0({
          topics: opts.topics,
          data: opts.data ?? xdr.ScVal.scvVoid(),
        }),
      ),
    }),
  });
}

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const str = (s: string) => xdr.ScVal.scvString(s);
const contractErr = (code: number) =>
  xdr.ScVal.scvError(xdr.ScError.sceContract(code));
const hostErr = (type: string, code: string) =>
  xdr.ScVal.scvError(
    (xdr.ScError as any)[`sce${type}`](
      (xdr.ScErrorCode as any)[`scec${code}`](),
    ),
  );

function errorEvent(
  contractId: string | null,
  err: xdr.ScVal,
  data: xdr.ScVal = str('escalating error'),
) {
  return diagnosticEvent({ contractId, topics: [sym('error'), err], data });
}

function fnCallEvent(contractId: string, fn: string) {
  return diagnosticEvent({
    contractId: null,
    topics: [
      sym('fn_call'),
      xdr.ScVal.scvBytes(StrKey.decodeContract(contractId) as any),
      sym(fn),
    ],
    data: xdr.ScVal.scvVoid(),
  });
}

function txResult(
  opResult: xdr.InvokeHostFunctionResult,
  code: 'txFailed' | 'txSuccess' = 'txFailed',
): xdr.TransactionResult {
  const ops = [
    new (xdr.OperationResult as any).opInner(
      xdr.OperationResultTr.invokeHostFunction(opResult),
    ),
  ];
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('100'),
    result: (xdr.TransactionResultResult as any)[code](ops),
    ext: new (xdr.TransactionResultExt as any)(0),
  });
}

describe('DiagnosticParserService', () => {
  let service: DiagnosticParserService;
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
    delete process.env.SOROBAN_CONTRACT_ID;
    delete process.env.OUTCOME_MANAGER_CONTRACT_ADDRESS;
    delete process.env.SOROBAN_CONTRACT_ERROR_MAP;
    delete process.env.SOROBAN_CONTRACT_KIND;
    service = new DiagnosticParserService();
    service.registerContract(CALL_REGISTRY_ID, 'call_registry');
    service.registerContract(OUTCOME_MANAGER_ID, 'outcome_manager');
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    jest.spyOn((service as any).logger, 'debug').mockImplementation(() => {});
  });

  afterAll(() => {
    process.env = envBackup;
  });

  // ─── Registry coverage ────────────────────────────────────────────────────

  describe('contract error registry', () => {
    const entries = Object.values(CONTRACT_ERROR_REGISTRY).flatMap((r) =>
      Object.values(r.errors).map((e) => [r.contract, r.enumName, e] as const),
    );

    it('covers every contract crate with a #[contracterror] enum', () => {
      expect(
        Object.keys(CONTRACT_ERROR_REGISTRY).length,
      ).toBeGreaterThanOrEqual(20);
      expect(entries.length).toBeGreaterThan(250);
    });

    it.each(
      entries.map(([c, en, e]) => [`${en}::${e.name} (#${e.code})`, c, e]),
    )('translates %s to a clear message', (_label, contract, def) => {
      const t = service.translateContractError(def.code, null, contract);
      expect(t.name).toBe(def.name);
      expect(t.contract).toBe(contract);
      expect(t.message).toBe(def.message);
      expect(t.message.length).toBeGreaterThan(5);
      expect(t.message).toMatch(/[.!?]$/);
    });

    const contractsRoot = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'contracts',
    );
    const contractsAvailable = fs.existsSync(contractsRoot);
    (contractsAvailable ? it : it.skip)(
      'is in sync with packages/contracts/*/src/errors.rs',
      () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const gen = require('../../scripts/generate-contract-errors.js') as {
          collectRegistry: () => Array<{
            crate: string;
            enumName: string;
            variants: Array<{ code: number; name: string; message: string }>;
          }>;
        };
        // Compare data, not text, so formatting of the generated file is free.
        const expected = Object.fromEntries(
          gen.collectRegistry().map((r) => [
            r.crate,
            {
              contract: r.crate,
              enumName: r.enumName,
              errors: Object.fromEntries(r.variants.map((v) => [v.code, v])),
            },
          ]),
        );
        expect(CONTRACT_ERROR_REGISTRY).toEqual(expected);
      },
    );

    (contractsAvailable ? it : it.skip)(
      'maps every numeric variant declared in the Rust sources',
      () => {
        // Independent check with a deliberately simple regex, so a generator
        // parsing bug cannot hide a missing code.
        for (const [crate, reg] of Object.entries(CONTRACT_ERROR_REGISTRY)) {
          const dir = path.join(contractsRoot, crate, 'src');
          const file = ['errors.rs', 'lib.rs']
            .map((f) => path.join(dir, f))
            .find((f) => fs.existsSync(f))!;
          const src = fs.readFileSync(file, 'utf8');
          const body = src.split(`pub enum ${reg.enumName}`)[1].split('\n}')[0];
          const rustCodes = [...body.matchAll(/^\s*(\w+)\s*=\s*(\d+)/gm)].map(
            (m) => [m[1], Number(m[2])] as const,
          );
          expect(rustCodes.length).toBe(Object.keys(reg.errors).length);
          for (const [name, code] of rustCodes) {
            expect(reg.errors[code]?.name).toBe(name);
          }
        }
      },
    );
  });

  // ─── translateContractError ───────────────────────────────────────────────

  describe('translateContractError', () => {
    it('resolves the contract from its registered contract ID', () => {
      const t = service.translateContractError(6, CALL_REGISTRY_ID);
      expect(t).toMatchObject({
        contract: 'call_registry',
        enumName: 'CallRegistryError',
        name: 'CallEnded',
      });
      expect(t.message).toContain('staking is no longer allowed');
    });

    it('uses the same code differently per contract', () => {
      expect(service.translateContractError(6, OUTCOME_MANAGER_ID).name).toBe(
        'InvalidOutcome',
      );
    });

    it('lists candidates when the contract is unknown and the code is ambiguous', () => {
      const t = service.translateContractError(6, UNKNOWN_ID);
      expect(t.name).toBeNull();
      expect(t.candidates).toEqual(
        expect.arrayContaining(['call_registry', 'outcome_manager']),
      );
      expect(t.message).toContain('CallRegistryError::CallEnded');
      expect(t.message).toContain(UNKNOWN_ID);
    });

    it('reports unrecognised codes for a known contract', () => {
      const t = service.translateContractError(999, CALL_REGISTRY_ID);
      expect(t.name).toBeNull();
      expect(t.message).toContain('#999');
    });

    it('reports codes no contract defines', () => {
      const t = service.translateContractError(4242, UNKNOWN_ID);
      expect(t.candidates).toEqual([]);
      expect(t.message).toContain('#4242');
    });

    it('seeds contract mappings from the environment', () => {
      process.env.SOROBAN_CONTRACT_ID = UNKNOWN_ID;
      process.env.SOROBAN_CONTRACT_ERROR_MAP = `${OUTCOME_MANAGER_ID}:outcome_manager, bad-entry ,X:not_a_crate`;
      const fromEnv = new DiagnosticParserService();
      jest.spyOn((fromEnv as any).logger, 'warn').mockImplementation(() => {});
      expect(fromEnv.translateContractError(6, UNKNOWN_ID).name).toBe(
        'CallEnded',
      );
      expect(fromEnv.translateContractError(6, OUTCOME_MANAGER_ID).name).toBe(
        'InvalidOutcome',
      );
    });

    it('honours SOROBAN_CONTRACT_KIND for the indexed contract', () => {
      process.env.SOROBAN_CONTRACT_ID = UNKNOWN_ID;
      process.env.SOROBAN_CONTRACT_KIND = 'prediction_market';
      const fromEnv = new DiagnosticParserService();
      expect(fromEnv.translateContractError(27, UNKNOWN_ID).name).toBe(
        'RolloverInsufficientAmount',
      );
    });

    it('ignores mappings to unknown crates', () => {
      service.registerContract(UNKNOWN_ID, 'nope');
      expect(service.translateContractError(6, UNKNOWN_ID).name).toBeNull();
    });
  });

  // ─── parseDiagnosticEvent ─────────────────────────────────────────────────

  describe('parseDiagnosticEvent', () => {
    it('decodes a contract error event from base64 XDR', () => {
      const b64 = errorEvent(CALL_REGISTRY_ID, contractErr(6)).toXDR('base64');
      const decoded = service.parseDiagnosticEvent(b64)!;
      expect(decoded.contractId).toBe(CALL_REGISTRY_ID);
      expect(decoded.eventType).toBe('diagnostic');
      expect(decoded.topics).toEqual(['error', 'Error(Contract, #6)']);
      expect(decoded.error).toMatchObject({
        category: DiagnosticErrorCategory.CONTRACT,
        code: 6,
        enumName: 'CallRegistryError',
        errorName: 'CallEnded',
        hostMessage: 'escalating error',
      });
    });

    it('accepts xdr instances and raw buffers', () => {
      const ev = errorEvent(OUTCOME_MANAGER_ID, contractErr(8));
      expect(service.parseDiagnosticEvent(ev)!.error!.errorName).toBe(
        'AlreadyClaimed',
      );
      expect(service.parseDiagnosticEvent(ev.toXDR())!.error!.errorName).toBe(
        'AlreadyClaimed',
      );
    });

    it('extracts host message and args from a vec payload', () => {
      const ev = errorEvent(
        CALL_REGISTRY_ID,
        contractErr(3),
        xdr.ScVal.scvVec([
          str('stake amount must be positive'),
          xdr.ScVal.scvI128(
            new xdr.Int128Parts({
              hi: xdr.Int64.fromString('0'),
              lo: xdr.Uint64.fromString('0'),
            }),
          ),
          xdr.ScVal.scvBytes(Buffer.from([0xde, 0xad])),
        ]),
      );
      const { error } = service.parseDiagnosticEvent(ev)!;
      expect(error!.hostMessage).toBe('stake amount must be positive');
      expect(error!.args).toEqual(['0', 'dead']);
    });

    it('finds an error carried in the data field', () => {
      const ev = diagnosticEvent({
        contractId: CALL_REGISTRY_ID,
        topics: [sym('log')],
        data: contractErr(9),
      });
      expect(service.parseDiagnosticEvent(ev)!.error!.errorName).toBe(
        'Unauthorized',
      );
    });

    it('records fn_call targets', () => {
      const decoded = service.parseDiagnosticEvent(
        fnCallEvent(CALL_REGISTRY_ID, 'stake_on_call'),
      )!;
      expect(decoded.fnCall).toBe('stake_on_call');
      expect(decoded.error).toBeNull();
    });

    it.each([
      ['empty string', ''],
      ['whitespace', '   '],
      ['non-base64 garbage', '%%%not-xdr%%%'],
      ['truncated xdr', 'AAAA'],
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['boolean', true],
      ['plain object', { foo: 'bar' }],
      [
        'object whose accessors throw',
        {
          event: () => {
            throw new Error('x');
          },
        },
      ],
      ['empty buffer', Buffer.alloc(0)],
    ])('returns null for %s', (_label, input) => {
      expect(() => service.parseDiagnosticEvent(input)).not.toThrow();
      expect(service.parseDiagnosticEvent(input)).toBeNull();
    });

    it('never throws on random bytes (fuzz)', () => {
      for (let i = 0; i < 500; i++) {
        const buf = randomBytes(1 + (i % 256));
        expect(() => service.parseDiagnosticEvent(buf)).not.toThrow();
        expect(() =>
          service.parseDiagnosticEvent(buf.toString('base64')),
        ).not.toThrow();
      }
    });

    it('never throws on corrupted valid events (fuzz)', () => {
      const valid = errorEvent(CALL_REGISTRY_ID, contractErr(6)).toXDR();
      for (let i = 0; i < 500; i++) {
        const buf = Buffer.from(valid);
        buf[i % buf.length] ^= 0xff;
        const cut = buf.subarray(0, buf.length - (i % 7));
        expect(() => service.parseDiagnosticEvent(cut)).not.toThrow();
      }
    });
  });

  // ─── Host error categories ────────────────────────────────────────────────

  describe('host errors', () => {
    const analyze = (err: xdr.ScVal, msg = 'x') =>
      service.analyzeTransaction({
        txHash: 'tx',
        diagnosticEvents: [errorEvent(CALL_REGISTRY_ID, err, str(msg))],
      });

    it('flags authorization failures', () => {
      const r = analyze(
        hostErr('Auth', 'InvalidAction'),
        'Unauthorized function call for address',
      );
      expect(r.authFailure).toBe(true);
      expect(r.primaryError).toMatchObject({
        category: DiagnosticErrorCategory.AUTH,
        codeName: 'InvalidAction',
        hostMessage: 'Unauthorized function call for address',
      });
      expect(r.summary).toMatch(/^Authorization failed/);
    });

    it('treats contract Unauthorized variants as auth failures', () => {
      expect(analyze(contractErr(9)).authFailure).toBe(true);
    });

    it('flags footprint exhaustion (Storage/ExceededLimit)', () => {
      const r = analyze(
        hostErr('Storage', 'ExceededLimit'),
        'trying to access contract storage key outside of the footprint',
      );
      expect(r.footprintExhausted).toBe(true);
      expect(r.resourceLimitExceeded).toBe(true);
      expect(r.primaryError!.category).toBe(DiagnosticErrorCategory.FOOTPRINT);
      expect(r.summary).toMatch(/^Footprint exhausted/);
    });

    it('flags footprint exhaustion from the host message alone', () => {
      const r = analyze(
        hostErr('Storage', 'InvalidAction'),
        'key is outside of the declared footprint',
      );
      expect(r.footprintExhausted).toBe(true);
    });

    it('flags budget exhaustion', () => {
      const r = analyze(hostErr('Budget', 'ExceededLimit'));
      expect(r.budgetExhausted).toBe(true);
      expect(r.resourceLimitExceeded).toBe(true);
      expect(r.summary).toMatch(/budget exceeded/i);
    });

    it.each([
      ['Budget', 'InternalError', /Resource budget error/],
      ['Storage', 'MissingValue', /ledger entry was not found/],
      ['Storage', 'ExistingValue', /Storage error: a value already exists/],
      ['WasmVm', 'InvalidAction', /Host WasmVm error: an invalid action/],
      ['Value', 'UnexpectedType', /unexpected type/],
      ['Crypto', 'InvalidInput', /Host Crypto error/],
    ])('describes %s/%s', (type, code, expected) => {
      expect(analyze(hostErr(type, code)).primaryError!.message).toMatch(
        expected,
      );
    });
  });

  // ─── analyzeTransaction ───────────────────────────────────────────────────

  describe('analyzeTransaction', () => {
    it('prefers the contract error over escalated host errors and dedupes', () => {
      const r = service.analyzeTransaction({
        txHash: 'abc',
        diagnosticEvents: [
          fnCallEvent(CALL_REGISTRY_ID, 'stake_on_call'),
          errorEvent(CALL_REGISTRY_ID, contractErr(6), xdr.ScVal.scvVoid()),
          errorEvent(CALL_REGISTRY_ID, contractErr(6), str('call ended')),
          errorEvent(null, hostErr('WasmVm', 'InvalidAction')),
          errorEvent(CALL_REGISTRY_ID, contractErr(6)),
        ],
        resultXdr: txResult(
          xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
        ).toXDR('base64'),
      });

      expect(r.failed).toBe(true);
      expect(r.contractId).toBe(CALL_REGISTRY_ID);
      expect(r.callStack).toEqual(['stake_on_call']);
      expect(r.errors).toHaveLength(2);
      expect(r.contractError).toMatchObject({
        errorName: 'CallEnded',
        hostMessage: 'call ended',
      });
      expect(r.primaryError).toBe(r.contractError);
      expect(r.resultCode).toBe('txFailed');
      expect(r.operationResultCode).toBe('invokeHostFunctionTrapped');
      expect(r.summary).toBe(
        "The call's end_ts has already passed; staking is no longer allowed. [CallRegistryError::CallEnded]",
      );
    });

    it('counts malformed events without failing the rest', () => {
      const r = service.analyzeTransaction({
        diagnosticEvents: [
          'garbage',
          null,
          errorEvent(OUTCOME_MANAGER_ID, contractErr(9)).toXDR('base64'),
          { nope: true },
        ],
      });
      expect(r.eventCount).toBe(4);
      expect(r.malformedEventCount).toBe(3);
      expect(r.contractError!.errorName).toBe('NothingToClaim');
    });

    it('tolerates non-array diagnostics and garbage everywhere', () => {
      for (const junk of [
        null,
        undefined,
        'x',
        1,
        {},
        [],
        [[]],
        { length: 3 },
      ]) {
        expect(() =>
          service.analyzeTransaction({
            txHash: 'junk',
            diagnosticEvents: junk,
            resultXdr: junk,
            resultMetaXdr: junk,
            errorMessage: junk,
          }),
        ).not.toThrow();
      }
    });

    it('reports success when nothing failed', () => {
      const r = service.analyzeTransaction({
        diagnosticEvents: [fnCallEvent(CALL_REGISTRY_ID, 'get_call')],
        resultXdr: txResult(
          xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(
            Buffer.alloc(32),
          ),
          'txSuccess',
        ),
      });
      expect(r.failed).toBe(false);
      expect(r.summary).toBe('Transaction succeeded.');
    });

    it('falls back to result codes when there are no diagnostic events', () => {
      const archived = service.analyzeTransaction({
        resultXdr: txResult(
          xdr.InvokeHostFunctionResult.invokeHostFunctionEntryArchived(),
        ),
      });
      expect(archived.failed).toBe(true);
      expect(archived.entryArchived).toBe(true);
      expect(archived.summary).toMatch(/archived/);

      const limit = service.analyzeTransaction({
        resultXdr: txResult(
          xdr.InvokeHostFunctionResult.invokeHostFunctionResourceLimitExceeded(),
        ),
      });
      expect(limit.resourceLimitExceeded).toBe(true);
      expect(limit.summary).toMatch(/resource limits/);

      const trapped = service.analyzeTransaction({
        resultXdr: txResult(
          xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
        ),
      });
      expect(trapped.summary).toBe(
        'Transaction failed (invokeHostFunctionTrapped).',
      );
    });

    it('reads diagnostic events from TransactionMeta when not provided directly', () => {
      const meta = new (xdr.TransactionMeta as any)(
        3,
        new xdr.TransactionMetaV3({
          ext: new (xdr.ExtensionPoint as any)(0),
          txChangesBefore: [],
          operations: [],
          txChangesAfter: [],
          sorobanMeta: new xdr.SorobanTransactionMeta({
            ext: new (xdr.SorobanTransactionMetaExt as any)(0),
            events: [],
            returnValue: xdr.ScVal.scvVoid(),
            diagnosticEvents: [errorEvent(CALL_REGISTRY_ID, contractErr(15))],
          }),
        }),
      );
      const r = service.analyzeTransaction({
        resultMetaXdr: meta.toXDR('base64'),
      });
      expect(r.contractError!.errorName).toBe('StakingCutoffActive');
    });
  });

  // ─── Error strings ────────────────────────────────────────────────────────

  describe('parseErrorString / analyzeSimulationResponse', () => {
    const simError =
      'HostError: Error(Contract, #6)\n\nEvent log (newest first):\n' +
      `   0: [Diagnostic Event] contract:${CALL_REGISTRY_ID}, topics:[error, Error(Contract, #6)], data:"escalating"\n` +
      '   1: [Diagnostic Event] topics:[error, Error(WasmVm, InvalidAction)]';

    it('parses contract and host errors from a simulation error', () => {
      const errors = service.parseErrorString(simError);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatchObject({
        contractId: CALL_REGISTRY_ID,
        errorName: 'CallEnded',
      });
      expect(errors[1]).toMatchObject({
        category: DiagnosticErrorCategory.WASM_VM,
        codeName: 'InvalidAction',
      });
    });

    it('analyzes a failed simulation response', () => {
      const r = service.analyzeSimulationResponse({
        error: simError,
        events: [],
      });
      expect(r.contractError!.errorName).toBe('CallEnded');
    });

    it('handles numeric non-contract codes and junk', () => {
      expect(service.parseErrorString('Error(Budget, #3)')[0]).toMatchObject({
        category: DiagnosticErrorCategory.BUDGET,
        codeName: '3',
      });
      expect(service.parseErrorString(undefined)).toEqual([]);
      expect(service.parseErrorString(12 as any)).toEqual([]);
      expect(service.parseErrorString('no errors here')).toEqual([]);
    });

    it('uses a contract hint when no ID is available', () => {
      const [e] = service.parseErrorString(
        'Error(Contract, #27)',
        null,
        'prediction_market',
      );
      expect(e.errorName).toBe('RolloverInsufficientAmount');
    });
  });

  // ─── RPC response adapters ────────────────────────────────────────────────

  describe('RPC response adapters', () => {
    it('analyzes a sendTransaction ERROR response', () => {
      const r = service.analyzeSendTransactionResponse({
        status: 'ERROR',
        hash: 'deadbeef',
        errorResult: txResult(
          xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
        ),
        diagnosticEvents: [errorEvent(CALL_REGISTRY_ID, contractErr(7))],
      });
      expect(r.txHash).toBe('deadbeef');
      expect(r.contractError!.errorName).toBe('CallSettled');
    });

    it('analyzes a getTransaction FAILED response with raw XDR strings', () => {
      const r = service.analyzeGetTransactionResponse('h1', {
        status: 'FAILED',
        resultXdr: txResult(
          xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
        ).toXDR('base64'),
        diagnosticEventsXdr: [
          errorEvent(OUTCOME_MANAGER_ID, contractErr(26)).toXDR('base64'),
        ],
      });
      expect(r.txHash).toBe('h1');
      expect(r.contractError!.errorName).toBe('DisputeWindowExpired');
    });

    it('survives null responses', () => {
      expect(service.analyzeGetTransactionResponse('h', null).failed).toBe(
        false,
      );
      expect(
        service.analyzeSendTransactionResponse(undefined).txHash,
      ).toBeNull();
      expect(service.analyzeSimulationResponse(null).failed).toBe(false);
    });
  });

  // ─── parseTransactionResult ───────────────────────────────────────────────

  describe('parseTransactionResult', () => {
    it('unwraps fee-bump inner results', () => {
      const inner = txResult(
        xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
      );
      const feeBump = new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString('200'),
        result: (xdr.TransactionResultResult as any).txFeeBumpInnerFailed(
          new xdr.InnerTransactionResultPair({
            transactionHash: Buffer.alloc(32),
            result: new xdr.InnerTransactionResult({
              feeCharged: xdr.Int64.fromString('100'),
              result: (xdr.InnerTransactionResultResult as any).txFailed(
                inner.result().results(),
              ),
              ext: new (xdr.InnerTransactionResultExt as any)(0),
            }),
          }),
        ),
        ext: new (xdr.TransactionResultExt as any)(0),
      });
      expect(service.parseTransactionResult(feeBump.toXDR('base64'))).toEqual({
        resultCode: 'txFailed',
        operationResultCode: 'invokeHostFunctionTrapped',
      });
    });

    it('reports tx-level failures without operation results', () => {
      const r = new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString('100'),
        result: (xdr.TransactionResultResult as any).txBadSeq(),
        ext: new (xdr.TransactionResultExt as any)(0),
      });
      expect(service.parseTransactionResult(r)).toEqual({
        resultCode: 'txBadSeq',
        operationResultCode: null,
      });
    });

    it('returns nulls for malformed input', () => {
      for (const junk of ['AAAA', 'zzz', {}, 5, null]) {
        expect(service.parseTransactionResult(junk)).toEqual({
          resultCode: null,
          operationResultCode: null,
        });
      }
    });
  });

  // ─── extractSourceAccount ─────────────────────────────────────────────────

  describe('extractSourceAccount', () => {
    const user = Keypair.random();
    const sponsor = Keypair.random();
    const inner = new TransactionBuilder(new Account(user.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '5' }))
      .setTimeout(0)
      .build();

    it('reads the source of a v1 envelope (xdr or base64)', () => {
      expect(service.extractSourceAccount(inner.toEnvelope())).toBe(
        user.publicKey(),
      );
      expect(service.extractSourceAccount(inner.toXDR())).toBe(
        user.publicKey(),
      );
    });

    it('reads the inner (user) source of a fee-bump envelope', () => {
      inner.sign(user);
      const fb = TransactionBuilder.buildFeeBumpTransaction(
        sponsor,
        '200',
        inner,
        Networks.TESTNET,
      );
      expect(service.extractSourceAccount(fb.toEnvelope())).toBe(
        user.publicKey(),
      );
    });

    it('returns null for malformed envelopes', () => {
      for (const junk of ['', 'AAAA', null, {}, 3]) {
        expect(service.extractSourceAccount(junk)).toBeNull();
      }
    });
  });

  // ─── logReport ────────────────────────────────────────────────────────────

  describe('logReport', () => {
    it('emits a structured warning for failed transactions', () => {
      const warn = jest.spyOn((service as any).logger, 'warn');
      const debug = jest.spyOn((service as any).logger, 'debug');
      const report = service.analyzeTransaction({
        txHash: 'tx9',
        diagnosticEvents: [
          errorEvent(CALL_REGISTRY_ID, contractErr(6)),
          errorEvent(null, hostErr('WasmVm', 'InvalidAction')),
        ],
      });
      service.logReport(report, { userAddress: 'GUSER' });

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'Soroban transaction failed',
          txHash: 'tx9',
          userAddress: 'GUSER',
          contractId: CALL_REGISTRY_ID,
          primaryError: expect.objectContaining({ errorName: 'CallEnded' }),
        }),
      );
      expect(debug).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'Soroban transaction diagnostic errors',
        }),
      );
    });

    it('stays silent for successful transactions', () => {
      const warn = jest.spyOn((service as any).logger, 'warn');
      service.logReport(service.analyzeTransaction({}));
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
