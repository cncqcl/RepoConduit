import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { SessionStateStore } from '../../application/session-control.js';
import type { ObservedConversationMessage, SessionState } from '../../core/collaboration/session-control.js';
import { operationPolicy, type Permit } from '../../core/policy/authorize.js';
import type { IdempotencyScope } from './sqlite.js';

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new TypeError('Undefined idempotency input');
      return `${JSON.stringify(key)}:${canonical(record[key])}`;
    }).join(',')}}`;
  }
  throw new TypeError('Unsupported idempotency input');
}

export interface ConversationCommand {
  readonly commandId: string;
  readonly bindingId: string;
  readonly workspaceId: string;
  readonly collaborationId: string;
  readonly expectedRevision: number;
  readonly expectedEpoch: number;
  readonly status: 'prepared' | 'sending' | 'reconcile_required' | 'completed';
  readonly outcome: 'submitted' | 'unknown' | 'rejected' | null;
}

export interface CommandInput {
  readonly commandId: string;
  readonly scope: IdempotencyScope;
  readonly payload: unknown;
  readonly permit: Permit;
  readonly bindingId: string;
  readonly expectedRevision: number;
  readonly expectedEpoch: number;
}

export interface SyncCommitInput extends CommandInput {
  readonly nextState: SessionState;
  readonly messages: readonly ObservedConversationMessage[];
  readonly receipt: unknown;
  /** Only supplied after the adapter proves both native messages for this send. */
  readonly completesCommandId?: string;
  readonly completedSend?: { readonly sendIntentId: string; readonly nativeUserMessageId: string; readonly nativeReplyMessageId: string };
  /** Explicit host acceptance of a previously unknown send after observing complete native history. */
  readonly acceptedUnknownSendIntentId?: string;
}

export interface SuccessorInput {
  readonly predecessorBindingId: string;
  readonly expectedEpoch: number;
  readonly expectedRevision: number;
  readonly observed: { readonly providerId: string; readonly accountId: string;
    readonly nativeSessionId: string; readonly cursor: string };
  readonly contextRevisionId: string;
  readonly newBindingId: string;
  readonly scope: IdempotencyScope;
  readonly permit: Permit;
}

interface CommandRow {
  command_id: string; binding_id: string; workspace_id: string; collaboration_id: string;
  operation: string;
  expected_revision: number; expected_epoch: number;
  status: ConversationCommand['status']; outcome: ConversationCommand['outcome'];
  payload_hash: string; result_json: string | null;
  send_text: string | null;
}

function commandFromRow(row: CommandRow): ConversationCommand {
  return { commandId: row.command_id, bindingId: row.binding_id, workspaceId: row.workspace_id,
    collaborationId: row.collaboration_id, expectedRevision: row.expected_revision,
    expectedEpoch: row.expected_epoch, status: row.status, outcome: row.outcome };
}

/** Durable SessionStateStore for the same database used by SqliteStore. */
export class SessionControlSqlite implements SessionStateStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_control (
        binding_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        collaboration_id TEXT NOT NULL REFERENCES collaborations(id),
        provider_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        epoch INTEGER NOT NULL CHECK (epoch >= 0),
        state_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_control_collaboration
        ON session_control(workspace_id, collaboration_id);
    `);
      const columns = this.db.prepare('PRAGMA table_info(session_control)').all() as { name: string }[];
      if (!columns.some((column) => column.name === 'provider_id')) {
        throw new Error('RECONCILE_REQUIRED: existing session bindings lack explicit provider identity');
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!columns.some((column) => column.name === 'lifecycle')) {
          this.db.exec("ALTER TABLE session_control ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'current' CHECK(lifecycle IN ('current','superseded'))");
        }
        if (!columns.some((column) => column.name === 'parent_binding_id')) {
          this.db.exec('ALTER TABLE session_control ADD COLUMN parent_binding_id TEXT REFERENCES session_control(binding_id)');
        }
        if (!columns.some((column) => column.name === 'context_revision_id')) {
          this.db.exec('ALTER TABLE session_control ADD COLUMN context_revision_id TEXT');
        }
        this.db.exec('DROP INDEX IF EXISTS session_control_current_participant');
        const duplicates = this.db.prepare(`SELECT 1 FROM session_control WHERE lifecycle='current'
          GROUP BY workspace_id,collaboration_id,provider_id,account_id
          HAVING COUNT(*) > 1 LIMIT 1`).get();
        if (duplicates) throw new Error('RECONCILE_REQUIRED: multiple current bindings need explicit successor migration');
        this.db.exec(`CREATE UNIQUE INDEX session_control_current_participant
          ON session_control(workspace_id,collaboration_id,provider_id,account_id)
          WHERE lifecycle='current'`);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS session_control_native_chat
        ON session_control(provider_id,account_id,native_session_id)`);
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_commands (
        command_id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        audience TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        collaboration_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        send_text TEXT,
        binding_id TEXT NOT NULL REFERENCES session_control(binding_id),
        grant_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        expected_revision INTEGER NOT NULL,
        expected_epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('prepared','sending','reconcile_required','completed')),
        outcome TEXT CHECK(outcome IN ('submitted','unknown','rejected')),
        result_json TEXT,
        UNIQUE(principal,audience,workspace_id,operation,idempotency_key)
      );
      DROP INDEX IF EXISTS conversation_command_active_binding;
      CREATE UNIQUE INDEX conversation_command_active_binding
        ON conversation_commands(binding_id)
        WHERE status IN ('sending','reconcile_required') AND operation='conversation.send';
      CREATE TABLE IF NOT EXISTS conversation_messages (
        binding_id TEXT NOT NULL REFERENCES session_control(binding_id),
        native_message_id TEXT NOT NULL,
        version TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY(binding_id,native_message_id,version)
      );
      `);
    } catch (error) {
      try { this.db.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], 'SQLite constructor cleanup uncertain',
        { cause: closeError }); }
      throw error;
    }
  }

  create(state: SessionState): void {
    if (!state.bindingId || !state.providerId || !state.accountId || !state.nativeSessionId ||
        (state.lifecycle !== undefined && state.lifecycle !== 'current') ||
        state.parentBindingId !== undefined || state.contextRevisionId !== undefined ||
        !Number.isSafeInteger(state.revision) || state.revision !== 0 ||
        !Number.isSafeInteger(state.epoch) || state.epoch < 0) {
      throw new TypeError('Invalid initial session state');
    }
    const result = this.db.prepare(`INSERT INTO session_control
      (binding_id,workspace_id,collaboration_id,provider_id,account_id,native_session_id,revision,epoch,state_json,lifecycle)
      SELECT ?,?,?,?,?,?,?,?,?, 'current' WHERE EXISTS (
        SELECT 1 FROM collaborations WHERE id=? AND workspace_id=?
      )`).run(state.bindingId, state.workspaceId, state.collaborationId, state.providerId, state.accountId,
      state.nativeSessionId, state.revision, state.epoch, JSON.stringify({ ...state, lifecycle: 'current' }),
      state.collaborationId, state.workspaceId);
    if (result.changes === 0) throw new Error('NOT_AVAILABLE');
  }

  get(bindingId: string): SessionState | null {
    const row = this.db.prepare('SELECT state_json,lifecycle,parent_binding_id,context_revision_id FROM session_control WHERE binding_id=?')
      .get(bindingId) as { state_json: string; lifecycle: 'current' | 'superseded';
        parent_binding_id: string | null; context_revision_id: string | null } | undefined;
    return row ? { ...JSON.parse(row.state_json) as SessionState, lifecycle: row.lifecycle,
      ...(row.parent_binding_id ? { parentBindingId: row.parent_binding_id } : {}),
      ...(row.context_revision_id ? { contextRevisionId: row.context_revision_id } : {}) } : null;
  }

  isCurrent(bindingId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM session_control WHERE binding_id=? AND lifecycle='current'").get(bindingId));
  }

  currentForScope(workspaceId: string, collaborationId: string): SessionState | null {
    const rows = this.db.prepare(`SELECT binding_id,length(CAST(state_json AS BLOB)) AS bytes
      FROM session_control WHERE workspace_id=? AND collaboration_id=? AND lifecycle='current' LIMIT 2`)
      .all(workspaceId, collaborationId) as { binding_id: string; bytes: number }[];
    if (rows.length > 1) throw new Error('RECONCILE_REQUIRED');
    const row = rows[0];
    if (!row) return null;
    if (row.bytes > 1_048_576) throw new Error('RECONCILE_REQUIRED');
    const state = this.get(row.binding_id);
    if (!state || state.workspaceId !== workspaceId || state.collaborationId !== collaborationId ||
        state.bindingId !== row.binding_id || state.lifecycle !== 'current') throw new Error('RECONCILE_REQUIRED');
    return state;
  }

  compareAndSwap(expectedRevision: number, next: SessionState): boolean {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        next.revision !== expectedRevision + 1 || !Number.isSafeInteger(next.epoch) || next.epoch < 0 ||
        (next.lifecycle !== undefined && next.lifecycle !== 'current')) {
      throw new TypeError('Invalid session control revision or epoch');
    }
    const changed = this.db.prepare(`UPDATE session_control SET revision=?,epoch=?,state_json=?
      WHERE binding_id=? AND workspace_id=? AND collaboration_id=?
        AND provider_id=? AND account_id=? AND native_session_id=? AND revision=? AND epoch<=?
        AND lifecycle='current' AND COALESCE(parent_binding_id,'')=? AND COALESCE(context_revision_id,'')=?`)
      .run(next.revision, next.epoch, JSON.stringify({ ...next, lifecycle: 'current' }), next.bindingId, next.workspaceId,
        next.collaborationId, next.providerId, next.accountId, next.nativeSessionId, expectedRevision, next.epoch,
        next.parentBindingId ?? '', next.contextRevisionId ?? '').changes;
    if (changed !== 0) return true;
    const row = this.db.prepare('SELECT workspace_id,collaboration_id,provider_id,account_id,native_session_id FROM session_control WHERE binding_id=?')
      .get(next.bindingId) as { workspace_id: string; collaboration_id: string; provider_id: string; account_id: string; native_session_id: string } | undefined;
    if (row && (row.workspace_id !== next.workspaceId || row.collaboration_id !== next.collaborationId ||
        row.provider_id !== next.providerId || row.account_id !== next.accountId || row.native_session_id !== next.nativeSessionId)) {
      throw new Error('CONFLICT');
    }
    return false;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (result && typeof result === 'object' && 'then' in result) throw new TypeError('Transaction must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private assertGrant(scope: IdempotencyScope, permit: Permit): void {
    const policy = operationPolicy(scope.operation);
    if (permit.operation !== scope.operation || permit.effect !== policy.effect ||
        permit.principal !== scope.principal || permit.scope.workspaceId !== scope.workspaceId ||
        !permit.scope.collaborationId || !permit.recipient) throw new Error('NOT_AVAILABLE');
    const grant = this.db.prepare(`SELECT principal,audience,workspace_id,collaboration_id,
      recipient,permissions_json,expires_at,revoked_at FROM grants WHERE id=?`).get(permit.grantId) as {
        principal: string; audience: string; workspace_id: string; collaboration_id: string | null;
        recipient: string | null; permissions_json: string; expires_at: string | null; revoked_at: string | null;
      } | undefined;
    if (!grant || grant.principal !== scope.principal || grant.audience !== scope.audience ||
        grant.workspace_id !== scope.workspaceId ||
        (grant.collaboration_id !== null && grant.collaboration_id !== permit.scope.collaborationId) ||
        (grant.recipient !== null && grant.recipient !== permit.recipient) || grant.revoked_at !== null ||
        (grant.expires_at !== null && !(Date.parse(grant.expires_at) > Date.now())) ||
        !(JSON.parse(grant.permissions_json) as string[]).includes(policy.requiredGrant)) throw new Error('NOT_AVAILABLE');
  }

  /** One durable lifecycle transition; native identity must already be observed by the trusted adapter. */
  successor(input: SuccessorInput): SessionState {
    if (!input.predecessorBindingId || !input.newBindingId || !input.contextRevisionId ||
        !input.scope.idempotencyKey || !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0 ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        ![input.observed.providerId, input.observed.accountId, input.observed.nativeSessionId,
          input.observed.cursor].every((part) => typeof part === 'string' && part.trim().length > 0)) {
      throw new TypeError('Invalid successor input');
    }
    return this.transaction(() => {
      if (input.scope.operation !== 'conversation.successor') throw new Error('NOT_AVAILABLE');
      this.assertGrant(input.scope, input.permit);
      const hash = createHash('sha256').update(canonical({
        scope: { workspaceId: input.scope.workspaceId,
          collaborationId: input.permit.scope.collaborationId },
        payload: { predecessorBindingId: input.predecessorBindingId,
          expectedEpoch: input.expectedEpoch, expectedRevision: input.expectedRevision,
          contextRevisionId: input.contextRevisionId },
      })).digest('hex');
      const prior = this.db.prepare(`SELECT payload_hash,result_json FROM idempotency_records
        WHERE principal=? AND audience=? AND workspace_id=? AND operation=? AND idempotency_key=?`)
        .get(input.scope.principal, input.scope.audience, input.scope.workspaceId,
          input.scope.operation, input.scope.idempotencyKey) as
          { payload_hash: string; result_json: string } | undefined;
      if (prior) {
        if (prior.payload_hash !== hash) throw new Error('CONFLICT');
        return JSON.parse(prior.result_json) as SessionState;
      }
      const predecessor = this.db.prepare(`SELECT * FROM session_control WHERE binding_id=?`)
        .get(input.predecessorBindingId) as { workspace_id: string; collaboration_id: string;
          provider_id: string; account_id: string; native_session_id: string;
          revision: number; epoch: number; lifecycle: string; state_json: string } | undefined;
      if (!predecessor || predecessor.workspace_id !== input.scope.workspaceId ||
          predecessor.collaboration_id !== input.permit.scope.collaborationId ||
          predecessor.lifecycle !== 'current') throw new Error('NOT_AVAILABLE');
      const old = JSON.parse(predecessor.state_json) as SessionState;
      if (predecessor.revision !== input.expectedRevision || predecessor.epoch !== input.expectedEpoch ||
          old.sendIntent || old.pendingSyncReceipt ||
          predecessor.provider_id !== input.observed.providerId ||
          predecessor.account_id !== input.observed.accountId ||
          predecessor.native_session_id === input.observed.nativeSessionId ||
          input.newBindingId === input.predecessorBindingId) throw new Error('CONFLICT');
      if (this.db.prepare(`SELECT 1 FROM conversation_commands WHERE binding_id=?
          AND status IN ('sending','reconcile_required') LIMIT 1`).get(input.predecessorBindingId)) {
        throw new Error('CONFLICT');
      }
      if (!this.db.prepare(`SELECT 1 FROM context_revisions WHERE id=? AND workspace_id=? AND collaboration_id=?`)
        .get(input.contextRevisionId, input.scope.workspaceId, predecessor.collaboration_id)) {
        throw new Error('NOT_AVAILABLE');
      }
      const successor: SessionState = { bindingId: input.newBindingId,
        workspaceId: predecessor.workspace_id, collaborationId: predecessor.collaboration_id,
        providerId: predecessor.provider_id, accountId: predecessor.account_id,
        nativeSessionId: input.observed.nativeSessionId, cursor: input.observed.cursor,
        control: 'human_controlled', epoch: 0, revision: 0, lifecycle: 'current',
        parentBindingId: input.predecessorBindingId, contextRevisionId: input.contextRevisionId };
      const superseded: SessionState = { ...old, lifecycle: 'superseded',
        epoch: old.epoch + 1, revision: old.revision + 1 };
      const moved = this.db.prepare(`UPDATE session_control SET lifecycle='superseded',revision=?,epoch=?,state_json=?
        WHERE binding_id=? AND lifecycle='current' AND revision=? AND epoch=?`)
        .run(superseded.revision, superseded.epoch, JSON.stringify(superseded),
          input.predecessorBindingId, input.expectedRevision, input.expectedEpoch).changes;
      if (moved !== 1) throw new Error('CONFLICT');
      const prepared = this.db.prepare(`SELECT command_id FROM conversation_commands
        WHERE binding_id=? AND operation='conversation.send' AND status='prepared'`)
        .all(input.predecessorBindingId) as { command_id: string }[];
      for (const row of prepared) {
        this.db.prepare(`UPDATE conversation_commands SET status='completed',outcome='rejected',result_json=?
          WHERE command_id=? AND status='prepared'`).run(canonical({ commandId: row.command_id,
            bindingId: input.predecessorBindingId, sendIntentId: row.command_id, status: 'rejected' }), row.command_id);
      }
      this.db.prepare(`INSERT INTO session_control
        (binding_id,workspace_id,collaboration_id,provider_id,account_id,native_session_id,
         revision,epoch,state_json,lifecycle,parent_binding_id,context_revision_id)
        VALUES (?,?,?,?,?,?,?,?,?,'current',?,?)`).run(successor.bindingId, successor.workspaceId,
        successor.collaborationId, successor.providerId, successor.accountId, successor.nativeSessionId,
        0, 0, JSON.stringify(successor), input.predecessorBindingId, input.contextRevisionId);
      this.db.prepare(`INSERT INTO idempotency_records
        (principal,audience,workspace_id,operation,idempotency_key,payload_hash,result_json)
        VALUES (?,?,?,?,?,?,?)`).run(input.scope.principal, input.scope.audience,
        input.scope.workspaceId, input.scope.operation, input.scope.idempotencyKey,
        hash, canonical(successor));
      return successor;
    });
  }

  private bindingFor(input: Pick<CommandInput, 'bindingId' | 'scope' | 'permit'>): SessionState {
    const state = this.get(input.bindingId);
    if (!state || state.workspaceId !== input.scope.workspaceId ||
        state.collaborationId !== input.permit.scope.collaborationId ||
        !this.isCurrent(input.bindingId)) throw new Error('NOT_AVAILABLE');
    return state;
  }

  private hashCommand(input: CommandInput): string {
    return createHash('sha256').update(canonical({ bindingId: input.bindingId,
      workspaceId: input.scope.workspaceId, collaborationId: input.permit.scope.collaborationId,
      payload: input.payload })).digest('hex');
  }

  private commandByScope(scope: IdempotencyScope): CommandRow | undefined {
    return this.db.prepare(`SELECT * FROM conversation_commands WHERE
      principal=? AND audience=? AND workspace_id=? AND operation=? AND idempotency_key=?`)
      .get(scope.principal, scope.audience, scope.workspaceId, scope.operation, scope.idempotencyKey) as CommandRow | undefined;
  }

  getCommand(commandId: string): ConversationCommand | null {
    const row = this.db.prepare('SELECT * FROM conversation_commands WHERE command_id=?').get(commandId) as CommandRow | undefined;
    return row ? commandFromRow(row) : null;
  }

  getCommandResult(commandId: string): unknown | null {
    const row = this.db.prepare(`SELECT result_json FROM conversation_commands WHERE command_id=?`)
      .get(commandId) as { result_json: string | null } | undefined;
    return row?.result_json ? JSON.parse(row.result_json) as unknown : null;
  }

  lookupCommandResult(scope: IdempotencyScope, payload: unknown, permit: Permit,
    bindingId: string, expectedEpoch: number): unknown | null {
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0 || !scope.idempotencyKey) {
      throw new TypeError('Invalid command lookup');
    }
    return this.transaction(() => {
      if (scope.operation !== 'conversation.send' && scope.operation !== 'conversation.sync' &&
          scope.operation !== 'conversation.resume') {
        throw new Error('NOT_AVAILABLE');
      }
      this.assertGrant(scope, permit);
      const state = this.get(bindingId);
      if (!state || state.workspaceId !== scope.workspaceId ||
          state.collaborationId !== permit.scope.collaborationId) throw new Error('NOT_AVAILABLE');
      const row = this.commandByScope(scope);
      if (!row) return null;
      const hash = this.hashCommand({ commandId: row.command_id, scope, payload, permit,
        bindingId, expectedRevision: 0, expectedEpoch });
      if (row.payload_hash !== hash || row.binding_id !== bindingId ||
          row.collaboration_id !== state.collaborationId) throw new Error('CONFLICT');
      if (row.status !== 'completed' || row.result_json === null) return null;
      return JSON.parse(row.result_json) as unknown;
    });
  }

  claimCommand(input: CommandInput): { disposition: 'claimed' | 'replay_pending' | 'replay_completed'; command: ConversationCommand } {
    if (!input.commandId || !input.scope.idempotencyKey || !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 || !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0) {
      throw new TypeError('Invalid command input');
    }
    return this.transaction(() => {
      this.assertGrant(input.scope, input.permit);
      const state = this.bindingFor(input);
      const hash = this.hashCommand(input);
      const prior = this.commandByScope(input.scope);
      if (prior) {
        if (prior.payload_hash !== hash || prior.binding_id !== input.bindingId ||
            prior.collaboration_id !== state.collaborationId) throw new Error('CONFLICT');
        return { disposition: prior.status === 'completed' ? 'replay_completed' : 'replay_pending',
          command: commandFromRow(prior) };
      }
      if (state.revision !== input.expectedRevision || state.epoch !== input.expectedEpoch ||
          state.pendingSyncReceipt) throw new Error('CONFLICT');
      const isSend = input.scope.operation === 'conversation.send';
      const isSync = input.scope.operation === 'conversation.sync' || input.scope.operation === 'conversation.resume';
      if (!isSend && !isSync) throw new Error('NOT_AVAILABLE');
      if (isSend && (state.control !== 'host_controlled' || state.sendIntent)) throw new Error('CONFLICT');
      const active = this.db.prepare(`SELECT * FROM conversation_commands WHERE binding_id=?
        AND status IN ('sending','reconcile_required')`)
        .all(input.bindingId) as unknown as CommandRow[];
      if (active.length && (isSend || active.some((row) => row.operation !== 'conversation.send' ||
          row.status !== 'reconcile_required'))) throw new Error('CONFLICT');
      const sendText = isSend && input.payload && typeof input.payload === 'object' &&
        'text' in input.payload ? (input.payload as { text: unknown }).text : null;
      if (isSend && (typeof sendText !== 'string' || !sendText)) throw new TypeError('Invalid send text');
      const normalizedText = typeof sendText === 'string' ? sendText : null;
      this.db.prepare(`INSERT INTO conversation_commands
        (command_id,principal,audience,workspace_id,collaboration_id,operation,idempotency_key,payload_hash,send_text,
         binding_id,grant_id,recipient,expected_revision,expected_epoch,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared')`).run(input.commandId, input.scope.principal,
        input.scope.audience, input.scope.workspaceId, state.collaborationId, input.scope.operation,
        input.scope.idempotencyKey, hash, normalizedText, input.bindingId, input.permit.grantId, input.permit.recipient,
        input.expectedRevision, input.expectedEpoch);
      return { disposition: 'claimed', command: this.getCommand(input.commandId)! };
    });
  }

  markSending(commandId: string, permit: Permit, expectedRevision: number, expectedEpoch: number): ConversationCommand {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM conversation_commands WHERE command_id=?').get(commandId) as CommandRow | undefined;
      if (!row || row.status !== 'prepared' || row.expected_revision !== expectedRevision || row.expected_epoch !== expectedEpoch) {
        throw new Error('CONFLICT');
      }
      if (this.db.prepare(`SELECT 1 FROM conversation_commands WHERE binding_id=? AND command_id!=?
          AND status IN ('sending','reconcile_required')`).get(row.binding_id, commandId)) throw new Error('CONFLICT');
      const scope = this.db.prepare(`SELECT principal,audience,workspace_id,operation,idempotency_key,grant_id,recipient
        FROM conversation_commands WHERE command_id=?`).get(commandId) as {
          principal: string; audience: string; workspace_id: string; operation: string;
          idempotency_key: string; grant_id: string; recipient: string;
        };
      if (scope.operation !== 'conversation.send' || permit.grantId !== scope.grant_id ||
          permit.recipient !== scope.recipient || permit.scope.collaborationId !== row.collaboration_id) throw new Error('NOT_AVAILABLE');
      this.assertGrant({ principal: scope.principal, audience: scope.audience, workspaceId: scope.workspace_id,
        operation: scope.operation, idempotencyKey: scope.idempotency_key }, permit);
      const state = this.get(row.binding_id);
      if (!state || state.workspaceId !== row.workspace_id || state.collaborationId !== row.collaboration_id ||
          !this.isCurrent(row.binding_id) ||
          state.revision !== expectedRevision || state.epoch !== expectedEpoch || state.control !== 'host_controlled' ||
          state.sendIntent || state.pendingSyncReceipt) throw new Error('CONFLICT');
      if (!row.send_text) throw new Error('CONFLICT');
      // BEGIN IMMEDIATE serializes reservations across connections. Uncertain sends keep
      // their account slot until a trusted rejection or correlated sync completes them.
      const active = this.db.prepare(`SELECT COUNT(*) AS count FROM conversation_commands c
        JOIN session_control s ON s.binding_id=c.binding_id
        WHERE s.provider_id=? AND s.account_id=? AND c.operation='conversation.send'
          AND c.status IN ('sending','reconcile_required')`).get(state.providerId,state.accountId) as
        {count:number};
      if (active.count>=2) throw new Error('CONFLICT');
      const next: SessionState = { ...state, revision: state.revision + 1,
        sendIntent: { id: commandId, text: row.send_text, status: 'sending' } };
      if (!this.compareAndSwap(expectedRevision, next)) throw new Error('CONFLICT');
      this.db.prepare(`UPDATE conversation_commands SET status='sending' WHERE command_id=?`).run(commandId);
      return this.getCommand(commandId)!;
    });
  }

  finishSend(commandId: string, expectedRevision: number, expectedEpoch: number,
    outcome: 'submitted' | 'unknown' | 'rejected', nextState?: SessionState): ConversationCommand {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM conversation_commands WHERE command_id=?').get(commandId) as CommandRow | undefined;
      if (!row || row.expected_revision + 1 !== expectedRevision ||
          row.expected_epoch !== expectedEpoch || !this.isCurrent(row.binding_id)) throw new Error('CONFLICT');
      // A trusted sync can prove and complete a send while its provider call is still returning.
      // A later definitive rejection contradicts that proof and must not rewrite the receipt.
      if (row.status === 'completed' && row.outcome === 'unknown' && row.result_json &&
          outcome !== 'rejected') return commandFromRow(row);
      if (row.status !== 'sending') throw new Error('CONFLICT');
      const state = this.get(row.binding_id);
      if (!state || state.workspaceId !== row.workspace_id || state.collaborationId !== row.collaboration_id ||
          state.sendIntent?.id !== commandId) {
        throw new Error('CONFLICT');
      }
      if (state.revision === expectedRevision && state.epoch === expectedEpoch && state.control === 'host_controlled') {
        const derived: SessionState = { ...state, revision: state.revision + 1,
          control: outcome === 'unknown' ? 'reconcile_required' : state.control,
          sendIntent: outcome === 'rejected' ? undefined :
            { ...state.sendIntent, status: outcome === 'submitted' ? 'awaiting_result' : 'unknown' } };
        const proposed = nextState ?? derived;
        if (proposed.bindingId !== row.binding_id || proposed.workspaceId !== row.workspace_id ||
            proposed.collaborationId !== row.collaboration_id || proposed.providerId !== state.providerId ||
            proposed.accountId !== state.accountId || proposed.nativeSessionId !== state.nativeSessionId ||
            proposed.revision !== state.revision + 1 || proposed.epoch !== state.epoch ||
            proposed.control !== derived.control ||
            proposed.sendIntent?.status !== derived.sendIntent?.status ||
            proposed.sendIntent?.id !== derived.sendIntent?.id) throw new Error('CONFLICT');
        if (!this.compareAndSwap(expectedRevision, proposed)) throw new Error('CONFLICT');
      } else if (state.epoch !== expectedEpoch || state.revision !== expectedRevision) {
        // A human handoff raced the provider call. Record the fact without restoring host control.
        const handoffOnly = state.epoch === expectedEpoch + 1 && state.revision === expectedRevision + 1 &&
          state.control === 'reconcile_required' && state.sendIntent.status === 'sending' &&
          !state.pendingSyncReceipt;
        const guarded: SessionState = outcome === 'rejected'
          ? { ...state, revision: state.revision + 1, sendIntent: undefined,
            control: handoffOnly ? 'human_controlled' : state.control }
          : { ...state, revision: state.revision + 1,
            control: 'reconcile_required', sendIntent: { ...state.sendIntent, status: 'unknown' } };
        if (!this.compareAndSwap(state.revision, guarded)) throw new Error('CONFLICT');
      }
      this.db.prepare('UPDATE conversation_commands SET status=?,outcome=?,result_json=? WHERE command_id=?')
        .run(outcome === 'rejected' ? 'completed' : 'reconcile_required', outcome,
          canonical({ commandId, bindingId: row.binding_id, sendIntentId: commandId, status: outcome }), commandId);
      return this.getCommand(commandId)!;
    });
  }

  commitSync(input: SyncCommitInput): unknown {
    if (!input.commandId || !input.scope.idempotencyKey) throw new TypeError('Invalid sync input');
    const hasPayloadAccepted = Boolean(input.payload && typeof input.payload === 'object' &&
      !Array.isArray(input.payload) && Object.hasOwn(input.payload, 'acceptUnknownSendIntentId'));
    const payloadAccepted = hasPayloadAccepted
      ? (input.payload as { acceptUnknownSendIntentId: unknown }).acceptUnknownSendIntentId : undefined;
    const hasAcceptedInput = input.acceptedUnknownSendIntentId !== undefined;
    const hasReceiptDisposition = Boolean(input.receipt && typeof input.receipt === 'object' &&
      !Array.isArray(input.receipt) && Object.hasOwn(input.receipt, 'unknownSendDisposition'));
    if (hasPayloadAccepted !== hasAcceptedInput || hasReceiptDisposition !== hasAcceptedInput ||
        payloadAccepted !== input.acceptedUnknownSendIntentId ||
        (input.acceptedUnknownSendIntentId !== undefined &&
          (typeof input.acceptedUnknownSendIntentId !== 'string' || !input.acceptedUnknownSendIntentId ||
            input.scope.operation !== 'conversation.resume' || input.completesCommandId !== undefined ||
            input.completedSend !== undefined))) throw new Error('CONFLICT');
    return this.transaction(() => {
      this.assertGrant(input.scope, input.permit);
      if (input.scope.operation !== 'conversation.sync' && input.scope.operation !== 'conversation.resume') {
        throw new Error('NOT_AVAILABLE');
      }
      const state = this.bindingFor(input);
      const hash = this.hashCommand(input);
      const prior = this.commandByScope(input.scope);
      if (prior) {
        if (prior.payload_hash !== hash || prior.binding_id !== input.bindingId ||
            prior.collaboration_id !== state.collaborationId) throw new Error('CONFLICT');
        if (prior.status === 'completed') return JSON.parse(prior.result_json!);
        if (prior.command_id !== input.commandId || prior.status !== 'prepared') throw new Error('CONFLICT');
      }
      if (state.revision !== input.expectedRevision || state.epoch !== input.expectedEpoch ||
          input.nextState.revision !== state.revision + 1 || input.nextState.epoch < state.epoch ||
          input.nextState.bindingId !== state.bindingId || input.nextState.workspaceId !== state.workspaceId ||
          input.nextState.collaborationId !== state.collaborationId || input.nextState.providerId !== state.providerId ||
          input.nextState.accountId !== state.accountId || input.nextState.nativeSessionId !== state.nativeSessionId) {
        throw new Error('CONFLICT');
      }
      const active = this.db.prepare(`SELECT * FROM conversation_commands WHERE binding_id=?
        AND status IN ('sending','reconcile_required')`)
        .all(input.bindingId) as unknown as CommandRow[];
      const unrelated = active.filter((row) => row.command_id !== prior?.command_id);
      if (unrelated.length) {
        const send = unrelated.length === 1 ? unrelated[0] : undefined;
        const proof = input.completedSend;
        if (input.acceptedUnknownSendIntentId !== undefined) {
          const originalReceipt = send?.result_json ? JSON.parse(send.result_json) as unknown : null;
          const expectedOriginalReceipt = send ? { commandId: send.command_id, bindingId: send.binding_id,
            sendIntentId: send.command_id, status: 'unknown' } : null;
          const disposition = { kind: 'accepted_observed_history', sendIntent: state.sendIntent,
            fromCursor: state.cursor, nextCursor: input.nextState.cursor,
            nativeMessageIds: input.messages.map((message) => message.nativeMessageId) };
          const expectedReceipt = { commandId: input.commandId, bindingId: input.bindingId,
            state: input.nextState, messages: input.messages, complete: true,
            unknownSendDisposition: disposition };
          const receiptDisposition = input.receipt && typeof input.receipt === 'object' &&
            !Array.isArray(input.receipt) ?
            (input.receipt as { unknownSendDisposition?: unknown }).unknownSendDisposition : undefined;
          const ids = new Set<string>();
          if (!send || unrelated.length !== 1 || send.command_id !== input.acceptedUnknownSendIntentId ||
              send.operation !== 'conversation.send' || send.status !== 'reconcile_required' ||
              send.outcome !== 'unknown' || !send.result_json || !send.send_text ||
              canonical(originalReceipt) !== canonical(expectedOriginalReceipt) ||
              state.control !== 'reconcile_required' || state.pendingSyncReceipt !== undefined ||
              state.sendIntent?.status !== 'unknown' ||
              state.sendIntent.id !== send.command_id || state.sendIntent.text !== send.send_text ||
              input.messages.length < 2 || input.messages.some((message) => {
                if (typeof message.nativeMessageId !== 'string' || !message.nativeMessageId.trim() ||
                    typeof message.version !== 'string' || !message.version.trim() ||
                    ids.has(message.nativeMessageId)) return true;
                ids.add(message.nativeMessageId);
                return false;
              }) ||
              !input.nextState.cursor || input.nextState.cursor === state.cursor ||
              input.nextState.control !== 'host_controlled' || input.nextState.epoch !== state.epoch + 1 ||
              input.nextState.sendIntent !== undefined || input.nextState.pendingSyncReceipt !== undefined ||
              receiptDisposition === undefined || canonical(receiptDisposition) !== canonical(disposition) ||
              canonical(input.receipt) !== canonical(expectedReceipt)) {
            throw new Error('CONFLICT');
          }
          // Preserve the unknown send's original outcome and receipt bytes. The resume command
          // separately records that the host accepted observed history; it does not rewrite the send.
          if (this.db.prepare(`UPDATE conversation_commands SET status='completed'
            WHERE command_id=? AND status='reconcile_required' AND outcome='unknown'`).run(send.command_id).changes !== 1) {
            throw new Error('CONFLICT');
          }
        } else if (!send || !input.completesCommandId || !proof || send.command_id !== input.completesCommandId ||
            (send.status !== 'sending' && send.status !== 'reconcile_required') ||
            send.operation !== 'conversation.send' ||
            state.sendIntent?.id !== send.command_id || proof.sendIntentId !== send.command_id ||
            state.sendIntent.text !== send.send_text ||
            !proof.nativeUserMessageId || !proof.nativeReplyMessageId ||
            proof.nativeUserMessageId === proof.nativeReplyMessageId ||
            !input.messages.some((message) => message.nativeMessageId === proof.nativeUserMessageId &&
              message.text === send.send_text) ||
            !input.messages.some((message) => message.nativeMessageId === proof.nativeReplyMessageId) ||
            input.nextState.sendIntent !== undefined) throw new Error('CONFLICT');
        else {
          if (send.status === 'sending') {
            this.db.prepare(`UPDATE conversation_commands SET status='completed',outcome='unknown',result_json=?
              WHERE command_id=?`).run(canonical({ commandId: send.command_id, bindingId: send.binding_id,
                sendIntentId: send.command_id, status: 'unknown' }), send.command_id);
          } else {
            this.db.prepare(`UPDATE conversation_commands SET status='completed' WHERE command_id=?`)
              .run(send.command_id);
          }
        }
      } else if (input.completesCommandId || input.completedSend ||
          input.acceptedUnknownSendIntentId !== undefined) throw new Error('CONFLICT');
      const insert = this.db.prepare(`INSERT OR IGNORE INTO conversation_messages
        (binding_id,native_message_id,version,text) VALUES (?,?,?,?)`);
      for (const message of input.messages) {
        if (!message.nativeMessageId || !message.version || typeof message.text !== 'string') throw new TypeError('Invalid message');
        insert.run(input.bindingId, message.nativeMessageId, message.version, message.text);
        const stored = this.db.prepare(`SELECT text FROM conversation_messages
          WHERE binding_id=? AND native_message_id=? AND version=?`).get(input.bindingId,
            message.nativeMessageId, message.version) as { text: string };
        if (stored.text !== message.text) throw new Error('CONFLICT');
      }
      if (!this.compareAndSwap(input.expectedRevision, input.nextState)) throw new Error('CONFLICT');
      if (prior) {
        this.db.prepare(`UPDATE conversation_commands SET status='completed',result_json=? WHERE command_id=?`)
          .run(canonical(input.receipt), input.commandId);
      } else {
        this.db.prepare(`INSERT INTO conversation_commands
          (command_id,principal,audience,workspace_id,collaboration_id,operation,idempotency_key,payload_hash,
           binding_id,grant_id,recipient,expected_revision,expected_epoch,status,result_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'completed',?)`).run(input.commandId, input.scope.principal,
          input.scope.audience, input.scope.workspaceId, state.collaborationId, input.scope.operation,
          input.scope.idempotencyKey, hash, input.bindingId, input.permit.grantId, input.permit.recipient,
          input.expectedRevision, input.expectedEpoch, canonical(input.receipt));
      }
      return input.receipt;
    });
  }

  listMessages(bindingId: string): ObservedConversationMessage[] {
    const rows = this.db.prepare(`SELECT native_message_id,version,text FROM conversation_messages
      WHERE binding_id=? ORDER BY rowid`).all(bindingId) as
      { native_message_id: string; version: string; text: string }[];
    return rows.map((row) => ({ nativeMessageId: row.native_message_id, version: row.version, text: row.text }));
  }

  lookupIdempotent<T>(scope: IdempotencyScope, payload: unknown): T | null {
    const hash = createHash('sha256').update(canonical(payload)).digest('hex');
    const row = this.db.prepare(`SELECT payload_hash,result_json FROM idempotency_records
      WHERE principal=? AND audience=? AND workspace_id=? AND operation=? AND idempotency_key=?`)
      .get(scope.principal, scope.audience, scope.workspaceId, scope.operation, scope.idempotencyKey) as
      { payload_hash: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.payload_hash !== hash) throw new Error('CONFLICT');
    return JSON.parse(row.result_json) as T;
  }

  runIdempotent<T>(scope: IdempotencyScope, payload: unknown, permit: Permit, mutation: () => T): T {
    if (mutation.constructor.name === 'AsyncFunction') throw new TypeError('Idempotent mutation must be synchronous');
    const hash = createHash('sha256').update(canonical(payload)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (permit.operation !== scope.operation || permit.principal !== scope.principal ||
          permit.scope.workspaceId !== scope.workspaceId || !permit.scope.collaborationId ||
          !permit.recipient || permit.effect !== 'state_write') throw new Error('NOT_AVAILABLE');
      const grant = this.db.prepare(`SELECT principal,audience,workspace_id,collaboration_id,
        recipient,permissions_json,expires_at,revoked_at FROM grants WHERE id=?`).get(permit.grantId) as {
          principal: string; audience: string; workspace_id: string; collaboration_id: string | null;
          recipient: string | null; permissions_json: string; expires_at: string | null;
          revoked_at: string | null;
        } | undefined;
      if (!grant || grant.principal !== scope.principal || grant.audience !== scope.audience ||
          grant.workspace_id !== scope.workspaceId ||
          (grant.collaboration_id !== null && grant.collaboration_id !== permit.scope.collaborationId) ||
          (grant.recipient !== null && grant.recipient !== permit.recipient) ||
          grant.revoked_at !== null ||
          (grant.expires_at !== null && !(Date.parse(grant.expires_at) > Date.now())) ||
          !(JSON.parse(grant.permissions_json) as string[]).includes(operationPolicy(scope.operation).requiredGrant)) {
        throw new Error('NOT_AVAILABLE');
      }
      const prior = this.lookupIdempotent<T>(scope, payload);
      if (prior !== null) { this.db.exec('COMMIT'); return prior; }
      const result = mutation();
      if (result && typeof result === 'object' && 'then' in result) throw new TypeError('Idempotent mutation must be synchronous');
      this.db.prepare(`INSERT INTO idempotency_records
        (principal,audience,workspace_id,operation,idempotency_key,payload_hash,result_json)
        VALUES (?,?,?,?,?,?,?)`).run(scope.principal, scope.audience, scope.workspaceId,
        scope.operation, scope.idempotencyKey, hash, canonical(result));
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close(): void { this.db.close(); }
}
