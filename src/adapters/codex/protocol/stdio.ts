import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isPromise } from 'node:util/types';
import { INVESTIGATION_RESULT_OUTPUT_SCHEMA } from '../../../core/investigation/result-schema.js';
import { REPO_READ_DYNAMIC_TOOL, validFixedDynamicToolResponse, validRepoReadArguments } from './repo-read-tool.js';
import type { CodexRepoReadCapability, CodexRepoReadCall, FixedDynamicToolResponse } from './repo-read-tool.js';

export type CodexProtocolTarget = 'wsl-codex-0.157.1' |
  'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1' |
  'windows-desktop-26.930.3930.0-codex-0.160.0' |
  'windows-desktop-26.930.4958.0-codex-0.160.0' |
  'windows-desktop-26.930.7945.0-codex-0.160.1' |
  'windows-desktop-26.1002.7124.0-codex-0.162.0-alpha.2' |
  'windows-desktop-26.1007.2314.0-codex-0.162.0-alpha.17.2' |
  'windows-desktop-26.1013.3656.0-codex-0.163.0-alpha.10.2' |
  'windows-desktop-26.1013.4894.0-codex-0.163.0-alpha.10.2' |
  'windows-desktop-codex-0.163.0-alpha.11';
const isWindows160Family = (target: CodexProtocolTarget): boolean =>
  target === 'windows-desktop-26.930.3930.0-codex-0.160.0' ||
  target === 'windows-desktop-26.930.4958.0-codex-0.160.0' ||
  target === 'windows-desktop-26.930.7945.0-codex-0.160.1' ||
  target === 'windows-desktop-26.1002.7124.0-codex-0.162.0-alpha.2' ||
  target === 'windows-desktop-26.1007.2314.0-codex-0.162.0-alpha.17.2' ||
  target === 'windows-desktop-26.1013.3656.0-codex-0.163.0-alpha.10.2' ||
  target === 'windows-desktop-26.1013.4894.0-codex-0.163.0-alpha.10.2' ||
  target === 'windows-desktop-codex-0.163.0-alpha.11';
const isWindows163 = (target: CodexProtocolTarget): boolean =>
  target === 'windows-desktop-26.1013.3656.0-codex-0.163.0-alpha.10.2' ||
  target === 'windows-desktop-26.1013.4894.0-codex-0.163.0-alpha.10.2' ||
  target === 'windows-desktop-codex-0.163.0-alpha.11';
/** Exact targets sharing the reviewed empty-environment and notification schema. */
const isWindows162Or163 = (target: CodexProtocolTarget): boolean =>
  target === 'windows-desktop-26.1007.2314.0-codex-0.162.0-alpha.17.2' ||
  isWindows163(target);
const isWindowsTarget = (target: CodexProtocolTarget): boolean =>
  target === 'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1' ||
  isWindows160Family(target);
export interface BoundTurnOutcome {
  threadId: string; turnId: string; status: 'completed' | 'interrupted' | 'failed';
  candidate: { itemId: string; text: string } | null;
}

export interface StdioConnection {
  input: Writable;
  output: Readable;
  errors: Readable;
  exited: EventEmitter;
  terminate(): void;
}

export interface ProtocolLimits {
  maxFrameBytes: number;
  maxTotalBytes: number;
  maxNotifications: number;
  requestTimeoutMs: number;
}

export interface NativeNotification {
  method: string;
  params: unknown;
}
type ServerRequestId = string | number;
interface RepoReadJob { id: ServerRequestId; call: CodexRepoReadCall; timer: NodeJS.Timeout }
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  sendConfirmed: boolean;
  earlyResponse?: { success: boolean; value: unknown };
}
export type CodexControlSend =
  | {kind:'rpc';method:string;params:Readonly<object>}
  | {kind:'initialized'}
  | {kind:'repo-read-failure';threadId:string;turnId:string};
/** The selected writer must synchronously accept the complete frame exactly once. */
export type CodexSynchronousSend = (line: string, control?: CodexControlSend) => unknown;

function frozenControl(line: string, control: CodexControlSend): CodexControlSend {
  if (control.kind !== 'rpc') return Object.freeze({ ...control });
  // Derive the callback's immutable metadata from the already encoded frame.
  const frame = JSON.parse(line) as { method: string; params: object };
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freeze(child as object);
    Object.freeze(value);
  };
  freeze(frame.params);
  return Object.freeze({ kind: 'rpc', method: frame.method, params: frame.params });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Fixed 0.157.1 notification schema; warning text stays data, never authority. */
function validConfigWarning(value: unknown): boolean {
  if (!record(value) || typeof value.summary !== 'string' ||
      Object.keys(value).some(key => !['summary', 'details', 'path', 'range'].includes(key))) return false;
  for (const key of ['details', 'path']) {
    if (key in value && value[key] !== null && typeof value[key] !== 'string') return false;
  }
  if (!('range' in value) || value.range === null) return true;
  const position = (input: unknown): boolean => record(input) && Object.keys(input).length === 2 &&
    ['line', 'column'].every(key => Number.isSafeInteger(input[key]) && (input[key] as number) >= 0);
  return record(value.range) && Object.keys(value.range).length === 2 &&
    position(value.range.start) && position(value.range.end);
}

/** Exact bounded bare warning shapes shared by the reviewed Windows 0.162/0.163 schemas. */
function validDeprecationNotice(value: unknown): boolean {
  return record(value) && typeof value.summary === 'string' &&
    Object.keys(value).every(key => ['summary','details'].includes(key)) &&
    (!('details' in value) || value.details === null || typeof value.details === 'string');
}
function validWarning(value: unknown): boolean {
  return record(value) && typeof value.message === 'string' &&
    Object.keys(value).every(key => ['message','threadId'].includes(key)) &&
    (!('threadId' in value) || value.threadId === null || typeof value.threadId === 'string');
}
function validGuardianWarning(value: unknown): boolean {
  return record(value) && typeof value.message === 'string' &&
    typeof value.threadId === 'string' &&
    Object.keys(value).every(key => ['message','threadId'].includes(key));
}

/** Classify only finite alpha17.2 error variants; never use provider text as a code. */
function nativeErrorCode(params: unknown): string {
  if (!record(params) || !record(params.error)) return 'PROTOCOL_NATIVE_ERROR';
  const info = params.error.codexErrorInfo;
  if (typeof info === 'string') {
    switch (info) {
      case 'unauthorized': return 'PROTOCOL_NATIVE_UNAUTHORIZED';
      case 'badRequest': return 'PROTOCOL_NATIVE_BAD_REQUEST';
      case 'rateLimitExceeded': return 'PROTOCOL_NATIVE_RATE_LIMIT';
      case 'usageLimitExceeded': return 'PROTOCOL_NATIVE_USAGE_LIMIT';
      case 'contextWindowExceeded': return 'PROTOCOL_NATIVE_CONTEXT_LIMIT';
      case 'sessionBudgetExceeded': return 'PROTOCOL_NATIVE_BUDGET_LIMIT';
      case 'flexUnavailable': case 'serverOverloaded': case 'internalServerError':
        return 'PROTOCOL_NATIVE_SERVER';
      case 'cyberPolicy': case 'misalignmentPolicyViolation': case 'tooManyDenials':
        return 'PROTOCOL_NATIVE_POLICY';
      case 'threadRollbackFailed': return 'PROTOCOL_NATIVE_INTERNAL';
      case 'sandboxError': return 'PROTOCOL_NATIVE_SANDBOX';
      default: return 'PROTOCOL_NATIVE_ERROR';
    }
  }
  if (!record(info) || Object.keys(info).length !== 1) return 'PROTOCOL_NATIVE_ERROR';
  const [variant] = Object.keys(info);
  const value = info[variant!];
  if (variant === 'activeTurnNotSteerable') {
    return record(value) && Object.keys(value).length === 1 &&
      ['review','compact'].includes(value.turnKind as string) ?
      'PROTOCOL_NATIVE_TURN_NOT_STEERABLE' : 'PROTOCOL_NATIVE_ERROR';
  }
  if (!['httpConnectionFailed','responseStreamConnectionFailed',
    'responseStreamDisconnected','responseTooManyFailedAttempts'].includes(variant!))
    return 'PROTOCOL_NATIVE_ERROR';
  if (!record(value) || Object.keys(value).some(key => key !== 'httpStatusCode'))
    return 'PROTOCOL_NATIVE_ERROR';
  const status = value.httpStatusCode;
  if (status !== undefined && status !== null &&
    (!Number.isInteger(status) || (status as number) < 0 || (status as number) > 65535))
    return 'PROTOCOL_NATIVE_ERROR';
  if (status === 401) return 'PROTOCOL_NATIVE_UNAUTHORIZED';
  if (status === 403) return 'PROTOCOL_NATIVE_FORBIDDEN';
  if (status === 429) return 'PROTOCOL_NATIVE_RATE_LIMIT';
  if (typeof status === 'number' && status >= 500 && status <= 599) return 'PROTOCOL_NATIVE_SERVER';
  if (status !== undefined && status !== null) return 'PROTOCOL_NATIVE_ERROR';
  switch (variant) {
    case 'httpConnectionFailed': return 'PROTOCOL_NATIVE_CONNECTION';
    case 'responseStreamConnectionFailed': return 'PROTOCOL_NATIVE_STREAM_CONNECTION';
    case 'responseStreamDisconnected': return 'PROTOCOL_NATIVE_STREAM_DISCONNECTED';
    default: return 'PROTOCOL_NATIVE_STREAM_RETRY_LIMIT';
  }
}

/** Pinned alpha17.2 StreamError is an intermediate state inside the original turn. */
function validRecoverableNativeError(value: unknown): value is Record<string, unknown> &
    {threadId:string;turnId:string} {
  if (!record(value) || Object.keys(value).some(key => !['threadId','turnId','willRetry','error'].includes(key)) ||
      typeof value.threadId !== 'string' || typeof value.turnId !== 'string' || value.willRetry !== true ||
      !record(value.error) || typeof value.error.message !== 'string' ||
      Object.keys(value.error).some(key => !['message','additionalDetails','codexErrorInfo','misalignment'].includes(key)) ||
      value.error.misalignment !== undefined && value.error.misalignment !== null ||
      value.error.additionalDetails !== undefined && value.error.additionalDetails !== null &&
        typeof value.error.additionalDetails !== 'string') return false;
  const info = value.error.codexErrorInfo;
  if (!record(info) || Object.keys(info).length !== 1 ||
      !['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected'].includes(Object.keys(info)[0]!))
    return false;
  return ['PROTOCOL_NATIVE_CONNECTION','PROTOCOL_NATIVE_STREAM_CONNECTION',
    'PROTOCOL_NATIVE_STREAM_DISCONNECTED','PROTOCOL_NATIVE_SERVER'].includes(nativeErrorCode(value));
}

function validWindowsCwd(cwd: string): boolean {
  if (!/^[A-Z]:\\/.test(cwd) || cwd.includes('/') || win32.normalize(cwd) !== cwd ||
      !win32.isAbsolute(cwd) || cwd.length <= 3) return false;
  const parts = cwd.slice(3).split('\\');
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..' &&
    ![...part].some(char => char.charCodeAt(0) < 32) && !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part) &&
    !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part));
}

/** A bounded JSON-lines transport for the explicitly selected Codex App Server target.
 * Native events are retained as protocol data. Model-authored text is never a tool receipt.
 */
export class CodexJsonlTransport {
  private readonly limits: ProtocolLimits;
  private readonly connection: StdioConnection;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events: NativeNotification[] = [];
  private nextId = 1;
  private partial = Buffer.alloc(0);
  private totalBytes = 0;
  private closed = false;
  private closedCode = 'PROTOCOL_CLOSED';
  private initializing = false;
  private initialized = false;
  private readonly boundThreads = new Map<string, { profileId: string; cwd: string }>();
  private readonly boundTurns = new Map<string, Set<string>>();
  private readonly waiters = new Set<() => void>();
  private readonly waitRejectors = new Set<(error: Error) => void>();
  private readonly target: CodexProtocolTarget;
  private repoReadCapability: CodexRepoReadCapability | null = null;
  private pendingTurnStartThreadId: string | null = null;
  private readonly repoReadQueue: RepoReadJob[] = [];
  private readonly repoReadInFlight = new Map<string, RepoReadJob>();
  private readonly seenServerIds = new Set<string>();
  private readonly seenCallIds = new Set<string>();
  private readonly blockedReadTurns = new Set<string>();
  private totalRepoReadCalls = 0;

  constructor(connection: StdioConnection, limits: ProtocolLimits,
    target: CodexProtocolTarget = 'wsl-codex-0.157.1',
    private readonly beforeControlSend?: (frame:CodexControlSend)=>void,
    private readonly sendNow?: CodexSynchronousSend) {
    if (!Number.isInteger(limits.maxFrameBytes) || limits.maxFrameBytes < 64 || limits.maxFrameBytes > 1024 * 1024 ||
        !Number.isInteger(limits.maxTotalBytes) || limits.maxTotalBytes < limits.maxFrameBytes || limits.maxTotalBytes > 16 * 1024 * 1024 ||
        !Number.isInteger(limits.maxNotifications) || limits.maxNotifications < 1 || limits.maxNotifications > 10_000 ||
        !Number.isInteger(limits.requestTimeoutMs) || limits.requestTimeoutMs < 10 || limits.requestTimeoutMs > 60_000) throw new Error('INVALID_ARGUMENT');
    if (target !== 'wsl-codex-0.157.1' &&
        target !== 'windows-desktop-26.930.2377.0-codex-0.159.0-alpha.12.1' &&
        !isWindowsTarget(target)) throw new Error('INVALID_ARGUMENT');
    this.target = target;
    this.connection = connection;
    this.limits = limits;
    connection.output.on('data', (chunk: Buffer) => this.ingest(chunk));
    connection.output.on('end', () => {
      // Every received frame must end in LF, including the final drained bytes.
      if (!this.closed && this.partial.length !== 0) this.fail('PROTOCOL_REJECTED');
    });
    connection.input.on('error', () => this.fail('PROTOCOL_CLOSED'));
    connection.output.on('error', () => this.fail('PROTOCOL_CLOSED'));
    connection.errors.on('error', () => this.fail('PROTOCOL_CLOSED'));
    connection.errors.on('data', (chunk: Buffer) => {
      // Never record stderr: it can contain paths, model text or credential-bearing diagnostics.
      this.totalBytes += chunk.length;
      if (this.totalBytes > this.limits.maxTotalBytes) this.fail('PROTOCOL_LIMIT_TOTAL');
    });
    connection.exited.on('close', () => this.fail('PROTOCOL_CLOSED'));
    connection.exited.on('error', () => this.fail('PROTOCOL_CLOSED'));
  }

  notifications(): readonly NativeNotification[] { return this.events.slice(); }
  /** Called after the original owner drained output, before deliberate transport disposal. */
  assertDrainedProtocol():void {
    if(this.closed||this.partial.length||this.repoReadInFlight.size||this.pending.size)throw new Error('PROTOCOL_REJECTED');
  }

  installRepoReadCapability(capability: CodexRepoReadCapability): void {
    if (!isWindowsTarget(this.target) ||
        this.initializing || this.initialized || this.closed || this.repoReadCapability ||
        !capability || typeof capability.read !== 'function') throw new Error('PROTOCOL_REJECTED');
    this.repoReadCapability = capability;
  }

  async initialize(): Promise<unknown> {
    if (this.initialized || this.initializing) throw new Error('PROTOCOL_REJECTED');
    this.initializing = true;
    try {
      const result = await this.call('initialize', {
        clientInfo: { name: 'repo-conduit', version: '0.1.0' },
        capabilities: { experimentalApi: this.repoReadCapability !== null,
          ...(isWindows160Family(this.target) ? { requestAttestation: false } : {}) },
      });
      if (this.closed) throw new Error('PROTOCOL_CLOSED');
      if (!record(result)) {
        this.fail('PROTOCOL_REJECTED');
        throw new Error('PROTOCOL_REJECTED');
      }
      this.initialized = true;
      this.writeNow('{"method":"initialized"}\n',{kind:'initialized'});
      return result;
    } finally { this.initializing = false; }
  }

  async readThread(threadId: string): Promise<unknown> {
    this.requireThreadId(threadId);
    return this.call('thread/read', { threadId, includeTurns: false });
  }

  async listTurns(threadId: string, limit = 20, cursor?: string): Promise<unknown> {
    this.requireThreadId(threadId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (cursor !== undefined && (cursor.length > 2048 || cursor.includes('\0')))) throw new Error('INVALID_ARGUMENT');
    return this.call('thread/turns/list', { threadId, limit, itemsView: 'summary', ...(cursor === undefined ? {} : { cursor }) });
  }

  /** Native response identifies the thread and requested profile; it does not prove effective sandbox enforcement. */
  async startRestrictedThread(input: { cwd: string; profileId: string; model: string },
    onObservedNativeId?: (threadId: string) => Promise<void> | void): Promise<string> {
    if (!this.initialized || typeof input.cwd !== 'string' ||
        (this.target === 'wsl-codex-0.157.1' ?
          (!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(input.cwd) ||
            input.cwd.startsWith('/mnt/') || input.cwd.split('/').some(part => part === '..')) :
          !validWindowsCwd(input.cwd)) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(input.profileId) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.model)) throw new Error('INVALID_ARGUMENT');
    // 0.162 reports roots from selected environments. No environments means no
    // workspace roots; source evidence remains available through scoped repo.read.
    const result = await this.call('thread/start', {
      cwd: input.cwd, permissions: input.profileId, model: input.model,
      allowProviderModelFallback: false, approvalPolicy: 'never',
      dynamicTools: this.repoReadCapability ? [REPO_READ_DYNAMIC_TOOL] : [],
      environments: [], runtimeWorkspaceRoots: isWindows162Or163(this.target) ? [] : [input.cwd], ephemeral: false,
    });
    if (!record(result) || !record(result.thread) ||
        typeof result.thread.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(result.thread.id)) {
      this.fail('PROTOCOL_REJECTED');
      throw new Error('PROTOCOL_REJECTED');
    }
    // The native thread already exists. Persist its identity before checking whether
    // the returned permissions are acceptable, so recovery can identify the orphan.
    try { await onObservedNativeId?.(result.thread.id); }
    catch (error) { this.fail('PROTOCOL_CLOSED'); throw error; }
    // Only fixed check names leave this boundary; never include native response values.
    const rejectedCheck =
        result.thread.cwd !== input.cwd || result.cwd !== input.cwd ? 'CWD' :
        result.model !== input.model ? 'MODEL' :
        result.approvalPolicy !== 'never' ? 'POLICY' :
        !Array.isArray(result.runtimeWorkspaceRoots) ||
          (isWindows162Or163(this.target) ?
            result.runtimeWorkspaceRoots.length !== 0 :
            result.runtimeWorkspaceRoots.length !== 1 || result.runtimeWorkspaceRoots[0] !== input.cwd) ? 'ROOTS' :
        typeof result.modelProvider !== 'string' || !result.modelProvider ? 'PROVIDER' :
        !['user', 'auto_review', 'guardian_subagent'].includes(result.approvalsReviewer as string) ? 'REVIEWER' :
        !record(result.sandbox) || (this.target === 'wsl-codex-0.157.1' ?
          !['readOnly', 'workspaceWrite', 'externalSandbox'].includes(result.sandbox.type as string) :
          (result.sandbox.type !== 'readOnly' || result.sandbox.networkAccess === true ||
            (result.sandbox.networkAccess !== undefined && result.sandbox.networkAccess !== false))) ? 'SANDBOX' :
        !record(result.activePermissionProfile) || result.activePermissionProfile.id !== input.profileId ? 'PROFILE' :
        this.boundThreads.has(result.thread.id) ? 'DUPLICATE' : null;
    if (rejectedCheck) {
      this.fail('PROTOCOL_REJECTED');
      throw new Error(`PROTOCOL_REJECTED_THREAD_${rejectedCheck}`);
    }
    this.boundThreads.set(result.thread.id, { profileId: input.profileId, cwd: input.cwd });
    this.boundTurns.set(result.thread.id, new Set());
    return result.thread.id;
  }

  /** Repeats the named profile for every model turn; only a thread started on this connection is accepted. */
  async startRestrictedTurn(input: { threadId: string; profileId: string; text: string },
    onObservedNativeId?: (turnId: string) => Promise<void> | void): Promise<string> {
    this.requireThreadId(input.threadId);
    const binding = this.boundThreads.get(input.threadId);
    if (!binding || binding.profileId !== input.profileId ||
        (this.repoReadCapability && this.pendingTurnStartThreadId !== null) ||
        typeof input.text !== 'string' || input.text.length < 1 || Buffer.byteLength(input.text, 'utf8') > 16_384 ||
        !input.text.trim() || input.text.includes('\0')) throw new Error('PROTOCOL_REJECTED');
    if (this.repoReadCapability) this.pendingTurnStartThreadId = input.threadId;
    try {
    const result = await this.call('turn/start', {
      threadId: input.threadId, permissions: input.profileId, approvalPolicy: 'never',
      environments: [], runtimeWorkspaceRoots: isWindows162Or163(this.target) ? [] : [binding.cwd],
      ...(this.target === 'wsl-codex-0.157.1' ? {} : { cwd: binding.cwd,
        outputSchema: INVESTIGATION_RESULT_OUTPUT_SCHEMA }),
      input: [{ type: 'text', text: input.text,
        ...(isWindows160Family(this.target) ? { text_elements: [] } : {}) }],
    });
    if (!record(result) || !record(result.turn)) {
      this.fail('PROTOCOL_REJECTED_TURN_STRUCTURE');
      throw new Error('PROTOCOL_REJECTED_TURN_STRUCTURE');
    }
    if (typeof result.turn.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(result.turn.id)) {
      this.fail('PROTOCOL_REJECTED_TURN_ID');
      throw new Error('PROTOCOL_REJECTED_TURN_ID');
    }
    // As with thread/start, a malformed response can still identify a real turn.
    try { await onObservedNativeId?.(result.turn.id); }
    catch (error) { this.fail('PROTOCOL_CLOSED'); throw error; }
    const turnCheck = !['inProgress', 'completed'].includes(result.turn.status as string) ? 'STATUS' :
      !Array.isArray(result.turn.items) ? 'ITEMS' :
        this.boundTurns.get(input.threadId)?.has(result.turn.id) ? 'DUPLICATE' : null;
    if (turnCheck) {
      const code = `PROTOCOL_REJECTED_TURN_${turnCheck}`;
      this.fail(code);
      throw new Error(code);
    }
    this.boundTurns.get(input.threadId)!.add(result.turn.id);
    try { this.boundOutcome(input.threadId, result.turn.id); }
    catch { this.fail('PROTOCOL_REJECTED_TURN_OUTCOME'); throw new Error('PROTOCOL_REJECTED_TURN_OUTCOME'); }
    if (this.repoReadCapability && result.turn.status === 'completed') {
      this.blockedReadTurns.add(`${input.threadId}:${result.turn.id}`);
      if (this.repoReadQueue.length) this.fail('PROTOCOL_REJECTED');
    }
    this.pendingTurnStartThreadId = null;
    this.drainRepoReadQueue();
    if (this.closed) throw new Error(this.closedCode);
    return result.turn.id;
    } finally {
      if (this.pendingTurnStartThreadId === input.threadId) {
        this.pendingTurnStartThreadId = null;
        if (this.repoReadQueue.length) this.fail('PROTOCOL_REJECTED');
      }
    }
  }

  /** An empty RPC response only acknowledges the interrupt request. It is not a terminal receipt. */
  async interruptBoundTurn(threadId: string, turnId: string): Promise<{ acknowledged: true }> {
    this.requireThreadId(threadId);
    if (typeof turnId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(turnId) ||
        !this.boundTurns.get(threadId)?.has(turnId)) throw new Error('PROTOCOL_REJECTED');
    this.blockedReadTurns.add(`${threadId}:${turnId}`);
    this.dropQueuedRepoReads(threadId, turnId);
    const result = await this.call('turn/interrupt', { threadId, turnId });
    if (!record(result) || Object.keys(result).length !== 0) {
      this.fail('PROTOCOL_REJECTED');
      throw new Error('PROTOCOL_REJECTED');
    }
    return { acknowledged: true };
  }

  /** Only a native turn/completed notification for this bound pair is terminal evidence. */
  observedBoundTurnTerminal(threadId: string, turnId: string):
    { status: 'completed' | 'interrupted' | 'failed' } | null {
    this.requireThreadId(threadId);
    if (!this.boundTurns.get(threadId)?.has(turnId)) throw new Error('PROTOCOL_REJECTED');
    let status: 'completed' | 'interrupted' | 'failed' | null = null;
    for (const event of this.events) {
      if (event.method !== 'turn/completed' || !record(event.params) ||
          event.params.threadId !== threadId || !record(event.params.turn) ||
          event.params.turn.id !== turnId) continue;
      const turn = event.params.turn;
      if (!Array.isArray(turn.items) ||
          !['completed', 'interrupted', 'failed'].includes(turn.status as string) ||
          (status !== null && status !== turn.status)) {
        this.fail('PROTOCOL_REJECTED');
        throw new Error('PROTOCOL_REJECTED');
      }
      status = turn.status as 'completed' | 'interrupted' | 'failed';
    }
    return status ? { status } : null;
  }

  missingBoundFinalCode(threadId: string, turnId: string):
    'PROTOCOL_NO_FINAL_ITEM' | 'PROTOCOL_NO_FINAL_INCOMPLETE_VIEW' | 'PROTOCOL_NO_FINAL_NONFINAL_ONLY' {
    this.requireThreadId(threadId);
    if (!this.boundTurns.get(threadId)?.has(turnId)) throw new Error('PROTOCOL_REJECTED');
    const completed = this.events.filter(event => event.method === 'item/completed' && record(event.params) &&
      event.params.threadId === threadId && event.params.turnId === turnId && record(event.params.item));
    const terminal = this.events.find(event => event.method === 'turn/completed' && record(event.params) &&
      event.params.threadId === threadId && record(event.params.turn) && event.params.turn.id === turnId);
    const turn = terminal && record(terminal.params) && record(terminal.params.turn) ? terminal.params.turn : null;
    if (turn && ['summary','notLoaded'].includes(turn.itemsView as string) && completed.length === 0)
      return 'PROTOCOL_NO_FINAL_INCOMPLETE_VIEW';
    return completed.length > 0 ? 'PROTOCOL_NO_FINAL_NONFINAL_ONLY' : 'PROTOCOL_NO_FINAL_ITEM';
  }

  /** A successful terminal and a complete native message for this pair are required. */
  waitForBoundTurn(input: { threadId: string; turnId: string; timeoutMs: number; signal?: AbortSignal }):
    Promise<BoundTurnOutcome> {
    this.requireThreadId(input.threadId);
    if (!this.boundTurns.get(input.threadId)?.has(input.turnId) ||
        !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000)
      return Promise.reject(new Error('INVALID_ARGUMENT'));
    if (this.closed) return Promise.reject(new Error(this.closedCode));
    if (input.signal?.aborted) return Promise.reject(new Error('PROTOCOL_ABORTED'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let checkScheduled = false;
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(check); this.waitRejectors.delete(failWait);
        input.signal?.removeEventListener('abort', abort); };
      const finish = (error?: Error, outcome?: BoundTurnOutcome) => {
        if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(outcome!);
      };
      const abort = () => finish(new Error('PROTOCOL_ABORTED'));
      const failWait = (error: Error) => finish(error);
      const check = () => {
        if (settled || checkScheduled) return;
        checkScheduled = true;
        // Process every frame in the current synchronous output chunk before delivering a candidate.
        queueMicrotask(() => {
          checkScheduled = false;
          if (settled) return;
          if (this.closed) return finish(new Error(this.closedCode));
          try { const outcome = this.boundOutcome(input.threadId, input.turnId); if (outcome) finish(undefined, outcome); }
          catch { this.fail('PROTOCOL_REJECTED'); }
        });
      };
      const timer = setTimeout(() => finish(new Error('PROTOCOL_TIMEOUT')), input.timeoutMs);
      this.waiters.add(check); this.waitRejectors.add(failWait);
      input.signal?.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  private boundOutcome(threadId: string, turnId: string): BoundTurnOutcome | null {
    let outcome: BoundTurnOutcome | null = null;
    let terminal: Record<string, unknown> | null = null;
    for (const event of this.events) {
      if (event.method !== 'turn/completed' || !record(event.params) ||
          event.params.threadId !== threadId || !record(event.params.turn) ||
          event.params.turn.id !== turnId) continue;
      const turn = event.params.turn;
      if (terminal && !isDeepStrictEqual(terminal, turn)) throw new Error('PROTOCOL_REJECTED');
      terminal = turn;
      if (!['completed', 'interrupted', 'failed'].includes(turn.status as string) ||
          !Array.isArray(turn.items) ||
          (turn.itemsView !== undefined && !['full', 'summary', 'notLoaded'].includes(turn.itemsView as string)) ||
          (turn.itemsView === 'notLoaded' && turn.items.length !== 0))
        throw new Error('PROTOCOL_REJECTED');
      let candidate: BoundTurnOutcome['candidate'] = null;
      const ids = new Set<string>();
      for (const item of turn.items) {
        if (!record(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id))
          throw new Error('PROTOCOL_REJECTED');
        ids.add(item.id);
      }
      const fullView = turn.itemsView === undefined || turn.itemsView === 'full';
      const currentWindows = isWindows162Or163(this.target);
      if (turn.status === 'completed' && (fullView || currentWindows)) {
        const items = new Map<string, Record<string, unknown>>();
        // Summary/notLoaded payloads never supply candidate contents. A separate
        // full item/completed event can do so after this exact turn succeeds.
        if (fullView) for (const item of turn.items) items.set(item.id, item);
        if (currentWindows) {
          let afterTerminal = false;
          for (const completed of this.events) {
            if (completed === event) { afterTerminal = true; continue; }
            if (completed.method !== 'item/completed' || !record(completed.params) ||
                completed.params.threadId !== threadId || completed.params.turnId !== turnId) continue;
            const item = completed.params.item;
            if (!Number.isSafeInteger(completed.params.completedAtMs) || !record(item) ||
                typeof item.id !== 'string' || !item.id) throw new Error('PROTOCOL_REJECTED');
            const previous = items.get(item.id);
            if (previous && !isDeepStrictEqual(previous, item)) throw new Error('PROTOCOL_REJECTED');
            if (!fullView && turn.items.some(summary => summary.id === item.id && summary.type !== item.type))
              throw new Error('PROTOCOL_REJECTED');
            if (afterTerminal && !previous) throw new Error('PROTOCOL_REJECTED');
            items.set(item.id, item);
          }
        }
        for (const item of items.values()) {
          if (!record(item)) throw new Error('PROTOCOL_REJECTED');
          if (item.type !== 'agentMessage') continue;
          const phases = isWindows163(this.target) ?
            ['commentary', 'partial_answer', 'final_answer'] : ['commentary', 'final_answer'];
          if (item.phase !== undefined && item.phase !== null &&
              !phases.includes(item.phase as string))
            throw new Error('PROTOCOL_REJECTED');
          if (item.phase !== undefined && item.phase !== null && item.phase !== 'final_answer') continue;
          if (item.delivery !== undefined && item.delivery !== null && item.delivery !== 'async')
            throw new Error('PROTOCOL_REJECTED');
          if (item.delivery === 'async') continue;
          if (item.questions !== undefined && item.questions !== null && !Array.isArray(item.questions))
            throw new Error('PROTOCOL_REJECTED');
          if (Array.isArray(item.questions) && item.questions.length > 0) continue;
          if (typeof item.text !== 'string' || Buffer.byteLength(item.text, 'utf8') > 256 * 1024 || candidate)
            throw new Error('PROTOCOL_REJECTED');
          candidate = { itemId: item.id as string, text: item.text };
        }
      }
      const current: BoundTurnOutcome = { threadId, turnId,
        status: turn.status as BoundTurnOutcome['status'], candidate };
      if (outcome && JSON.stringify(outcome) !== JSON.stringify(current)) throw new Error('PROTOCOL_REJECTED');
      outcome = current;
    }
    return outcome;
  }

  private handleRepoReadRequest(message: Record<string, unknown>): void {
    if (!this.repoReadCapability ||
        !isWindowsTarget(this.target) ||
        !this.initialized || message.method !== 'item/tool/call' || !record(message.params) ||
        Object.keys(message).length !== 3)
      throw new Error('PROTOCOL_REJECTED');
    const id = message.id;
    if (!((typeof id === 'number' && Number.isSafeInteger(id)) ||
        (typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\r\n\0]/.test(id))))
      throw new Error('PROTOCOL_REJECTED');
    const idKey = `${typeof id}:${id}`;
    const params = message.params;
    if (this.seenServerIds.has(idKey) || Object.keys(params).length !== 6 ||
        !['arguments', 'callId', 'namespace', 'threadId', 'tool', 'turnId'].every(key => Object.hasOwn(params, key)) ||
        params.namespace !== 'repo' || params.tool !== 'read' ||
        typeof params.threadId !== 'string' || !this.boundThreads.has(params.threadId) ||
        typeof params.turnId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(params.turnId) ||
        typeof params.callId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(params.callId) ||
        this.seenCallIds.has(params.callId) ||
        this.totalRepoReadCalls >= 40 || this.repoReadQueue.length + this.repoReadInFlight.size >= 8)
      throw new Error('PROTOCOL_REJECTED');
    const pair = `${params.threadId}:${params.turnId}`;
    const bound = this.boundTurns.get(params.threadId)?.has(params.turnId) === true;
    if ((!bound && this.pendingTurnStartThreadId !== params.threadId) ||
        this.blockedReadTurns.has(pair) || (bound && this.boundOutcome(params.threadId, params.turnId)))
      throw new Error('PROTOCOL_REJECTED');
    this.seenServerIds.add(idKey);
    this.seenCallIds.add(params.callId);
    this.totalRepoReadCalls++;
    const job: RepoReadJob = { id: id as ServerRequestId,
      call: { threadId: params.threadId, turnId: params.turnId,
        callId: params.callId, arguments: params.arguments },
      timer: setTimeout(() => this.fail('PROTOCOL_TIMEOUT'), this.limits.requestTimeoutMs) };
    this.repoReadQueue.push(job);
    this.drainRepoReadQueue();
  }

  private dropQueuedRepoReads(threadId: string, turnId: string): void {
    for (let i = this.repoReadQueue.length - 1; i >= 0; i--) {
      const job = this.repoReadQueue[i]!;
      if (job.call.threadId === threadId && job.call.turnId === turnId) {
        clearTimeout(job.timer);
        this.repoReadQueue.splice(i, 1);
      }
    }
  }

  private drainRepoReadQueue(): void {
    if (this.closed || !this.repoReadCapability) return;
    for (let i = 0; i < this.repoReadQueue.length;) {
      const job = this.repoReadQueue[i]!;
      const pair = `${job.call.threadId}:${job.call.turnId}`;
      if (this.blockedReadTurns.has(pair)) {
        clearTimeout(job.timer); this.repoReadQueue.splice(i, 1); continue;
      }
      if (!this.boundTurns.get(job.call.threadId)?.has(job.call.turnId)) {
        if (this.pendingTurnStartThreadId === job.call.threadId) { i++; continue; }
        this.fail('PROTOCOL_REJECTED'); return;
      }
      this.repoReadQueue.splice(i, 1);
      this.repoReadInFlight.set(job.call.callId, job);
      queueMicrotask(() => { void this.executeRepoRead(job); });
    }
  }

  private repoReadLive(job: RepoReadJob): boolean {
    if (this.closed || this.blockedReadTurns.has(`${job.call.threadId}:${job.call.turnId}`) ||
        !this.repoReadInFlight.has(job.call.callId) ||
        !this.boundTurns.get(job.call.threadId)?.has(job.call.turnId)) return false;
    try { return this.boundOutcome(job.call.threadId, job.call.turnId) === null; }
    catch { this.fail('PROTOCOL_REJECTED'); return false; }
  }

  private sendRepoReadResponse(job: RepoReadJob, response: FixedDynamicToolResponse,
    automaticFailure = false): void {
    if (!this.repoReadLive(job)) return;
    if (!validFixedDynamicToolResponse(response)) return this.fail('PROTOCOL_REJECTED');
    const line = `${JSON.stringify({ id: job.id, result: response })}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > Math.min(this.limits.maxFrameBytes, 64 * 1024) || this.totalBytes + bytes > this.limits.maxTotalBytes)
      return this.fail('PROTOCOL_LIMIT');
    this.totalBytes += bytes;
    try { this.writeNow(line,automaticFailure?{kind:'repo-read-failure',
      threadId:job.call.threadId,turnId:job.call.turnId}:undefined); }
    catch { this.fail('PROTOCOL_CLOSED'); }
  }

  private async executeRepoRead(job: RepoReadJob): Promise<void> {
    if (!this.repoReadLive(job) || !this.repoReadCapability) return;
    let emitted = false;
    const emit = (response: FixedDynamicToolResponse) => {
      if (emitted) { this.fail('PROTOCOL_REJECTED'); return; }
      emitted = true;
      this.sendRepoReadResponse(job, response);
    };
    try {
      // Bad model arguments are a tool error, not a broken RPC session. Keep
      // the same bound-turn queue and guarded failure writer; never clamp or read.
      if (!validRepoReadArguments(job.call.arguments)) throw new Error('PROTOCOL_REJECTED');
      await this.repoReadCapability.read(job.call, emit);
      if (!emitted) { emitted = true; this.sendRepoReadResponse(job, { success: false,
        contentItems: [{ type: 'inputText', text: 'repo.read failed' }] },true); }
    } catch {
      if (!emitted) { emitted = true; this.sendRepoReadResponse(job, { success: false,
        contentItems: [{ type: 'inputText', text: 'repo.read failed' }] },true); }
    } finally {
      clearTimeout(job.timer);
      this.repoReadInFlight.delete(job.call.callId);
    }
  }

  close(options: { terminate?: boolean } = {}): void { this.fail('PROTOCOL_CLOSED', options.terminate !== false); }

  private requireThreadId(threadId: string): void {
    if (typeof threadId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(threadId)) throw new Error('INVALID_ARGUMENT');
    if (!this.initialized) throw new Error('PROTOCOL_REJECTED');
  }

  /** No application queue: authority and enqueue remain in one synchronous stack.
   * Successful repo.read emit is already inside its final disclosure transaction.
   * Bytes accepted by the native/OS pipe cannot subsequently be recalled. */
  private writeNow(line:string,control?:CodexControlSend):void {
    if (this.sendNow) {
      if (this.closed) throw new Error('PROTOCOL_CLOSED');
      if (!line.endsWith('\n') || line.indexOf('\n') !== line.length - 1 ||
          Buffer.byteLength(line, 'utf8') > Math.min(this.limits.maxFrameBytes, 65_536)) {
        this.fail('PROTOCOL_LIMIT');
        throw new Error('PROTOCOL_LIMIT');
      }
      try {
        if(control)this.beforeControlSend?.(frozenControl(line,control));
        if(this.closed)throw new Error('PROTOCOL_CLOSED');
        const accepted = this.sendNow(line, control ? frozenControl(line, control) : undefined);
        if (accepted !== true) {
          // A native Promise cannot certify synchronous acceptance. Consume a
          // rejection without ever awaiting it or attempting another send.
          if (isPromise(accepted)) void Promise.prototype.then.call(accepted, undefined, () => {});
          throw new Error('PROTOCOL_CLOSED');
        }
        if (this.closed) throw new Error('PROTOCOL_CLOSED');
      } catch {
        this.fail('PROTOCOL_CLOSED');
        throw new Error('PROTOCOL_CLOSED');
      }
      return;
    }
    const input=this.connection.input;
    const usable=()=>!this.closed&&input.writable&&!input.destroyed&&
      !input.errored&&!input.writableEnded&&!input.writableFinished&&
      input.writableCorked===0&&input.writableLength===0&&!input.writableNeedDrain;
    if(!usable()) throw new Error('PROTOCOL_CLOSED');
    if(control) this.beforeControlSend?.(control);
    if(!usable()) throw new Error('PROTOCOL_CLOSED');
    try {
      const accepted=input.write(line,error=>{
        if(error) this.fail('PROTOCOL_CLOSED');
      });
      if(!accepted) this.fail('PROTOCOL_CLOSED');
    } catch(error) {this.fail('PROTOCOL_CLOSED');throw error;}
  }

  private call(method: string, params: object): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('PROTOCOL_CLOSED'));
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(line) > this.limits.maxFrameBytes) return Promise.reject(new Error('PROTOCOL_LIMIT'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('PROTOCOL_TIMEOUT'), this.limits.requestTimeoutMs);
      const request: PendingRequest = { resolve, reject, timer, sendConfirmed: false };
      this.pending.set(id, request);
      try {
        this.writeNow(`${line}\n`,{kind:'rpc',method,params});
        if (this.closed) return;
        request.sendConfirmed = true;
        if (request.earlyResponse) this.settleResponse(id, request, request.earlyResponse);
      }
      catch { this.fail('PROTOCOL_CLOSED'); }
    });
  }

  private settleResponse(id: number, request: PendingRequest,
    response: { success: boolean; value: unknown }): void {
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (response.success) request.resolve(response.value);
    else request.reject(new Error('PROTOCOL_REMOTE_ERROR'));
  }

  private ingest(chunk: Buffer): void {
    if (this.closed) return;
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.limits.maxTotalBytes) return this.fail('PROTOCOL_LIMIT_TOTAL');
    this.partial = Buffer.concat([this.partial, chunk]);
    if (this.partial.length > this.limits.maxFrameBytes && !this.partial.includes(10)) return this.fail('PROTOCOL_LIMIT_FRAME');
    while (true) {
      const newline = this.partial.indexOf(10);
      if (newline < 0) break;
      if (newline > this.limits.maxFrameBytes) return this.fail('PROTOCOL_LIMIT_FRAME');
      const line = this.partial.subarray(0, newline);
      this.partial = this.partial.subarray(newline + 1);
      if (line.length < 1) return this.fail('PROTOCOL_REJECTED_INGEST_JSON');
      let message: unknown;
      try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
      catch { return this.fail('PROTOCOL_REJECTED_INGEST_JSON'); }
      if (!record(message)) return this.fail('PROTOCOL_REJECTED_INGEST_ENVELOPE');
      if (typeof message.method === 'string') {
        if ('id' in message) {
          try { this.handleRepoReadRequest(message); }
          catch { return this.fail('PROTOCOL_REJECTED_INGEST_SERVER_REQUEST'); }
          continue;
        }
        if (message.method === 'error') {
          const params = message.params;
          const recoverable = isWindows162Or163(this.target) &&
            validRecoverableNativeError(params) && this.boundTurns.get(params.threadId)?.has(params.turnId) === true &&
            !this.events.some(event => event.method === 'turn/completed' && record(event.params) &&
              event.params.threadId === params.threadId && record(event.params.turn) && event.params.turn.id === params.turnId);
          if (!recoverable) return this.fail(nativeErrorCode(params));
          if (this.events.length >= this.limits.maxNotifications) return this.fail('PROTOCOL_LIMIT_NOTIFICATIONS');
          // Count the hint without retaining provider text or altering deadlines, reads or RPC state.
          this.events.push({method:'error',params:{threadId:params.threadId,turnId:params.turnId,willRetry:true}});
          continue;
        }
        if (this.events.length >= this.limits.maxNotifications) return this.fail('PROTOCOL_LIMIT_NOTIFICATIONS');
        const currentWindows = isWindows162Or163(this.target);
        const knownBare = message.method === 'configWarning' &&
            (this.target === 'wsl-codex-0.157.1' || currentWindows) ? validConfigWarning(message.params) :
          currentWindows && message.method === 'deprecationNotice' ? validDeprecationNotice(message.params) :
          currentWindows && message.method === 'warning' ? validWarning(message.params) :
          currentWindows && message.method === 'guardianWarning' ? validGuardianWarning(message.params) : null;
        if (knownBare === false) return this.fail('PROTOCOL_REJECTED_INGEST_NOTIFICATION_INVALID');
        if (!message.method.includes('/') && knownBare !== true) {
          return this.fail('PROTOCOL_REJECTED_INGEST_NOTIFICATION_UNKNOWN');
        }
        const terminalParams = message.params;
        if (message.method === 'turn/completed' && record(terminalParams) &&
            typeof terminalParams.threadId === 'string' && record(terminalParams.turn) &&
            typeof terminalParams.turn.id === 'string') {
          const activePair = (job: RepoReadJob) => job.call.threadId === terminalParams.threadId &&
            job.call.turnId === (terminalParams.turn as Record<string, unknown>).id;
          if (this.repoReadQueue.some(activePair) || [...this.repoReadInFlight.values()].some(activePair))
            return this.fail('PROTOCOL_REJECTED');
        }
        this.events.push({ method: message.method, params: message.params });
        const notificationTurnId = message.method === 'turn/completed' && record(message.params) &&
          record(message.params.turn) ? message.params.turn.id :
          message.method === 'item/completed' &&
          isWindows162Or163(this.target) &&
          record(message.params) ? message.params.turnId : null;
        if (record(message.params) && typeof message.params.threadId === 'string' &&
            typeof notificationTurnId === 'string' &&
            this.boundTurns.get(message.params.threadId)?.has(notificationTurnId)) {
          try { this.boundOutcome(message.params.threadId, notificationTurnId); }
          catch { return this.fail('PROTOCOL_REJECTED'); }
        }
        for (const check of [...this.waiters]) check();
        continue;
      }
      if (typeof message.id !== 'number' || !Number.isInteger(message.id) ||
          (!('result' in message) && !('error' in message)) || ('result' in message && 'error' in message)) {
        return this.fail('PROTOCOL_REJECTED_INGEST_ENVELOPE');
      }
      const pending = this.pending.get(message.id);
      if (!pending) return this.fail('PROTOCOL_REJECTED_INGEST_ENVELOPE');
      const response = { success: 'result' in message,
        value: 'result' in message ? message.result : message.error };
      if (!pending.sendConfirmed) {
        if (pending.earlyResponse) return this.fail('PROTOCOL_REJECTED_INGEST_ENVELOPE');
        pending.earlyResponse = response;
      } else this.settleResponse(message.id, pending, response);
    }
    if (this.partial.length > this.limits.maxFrameBytes) this.fail('PROTOCOL_LIMIT_FRAME');
  }

  private fail(code: string, terminate = true): void {
    if (this.closed) return;
    this.closed = true;
    this.closedCode = code;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(code));
    }
    this.pending.clear();
    for (const job of this.repoReadQueue) clearTimeout(job.timer);
    for (const job of this.repoReadInFlight.values()) clearTimeout(job.timer);
    this.repoReadQueue.length = 0;
    this.repoReadInFlight.clear();
    for (const reject of [...this.waitRejectors]) reject(new Error(code));
    if (terminate) try { this.connection.terminate(); }
    catch { /* The transport stays closed; this does not prove process termination. */ }
  }
}
