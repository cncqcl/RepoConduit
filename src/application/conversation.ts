import { randomUUID } from 'node:crypto';
import { SessionControlSqlite } from '../adapters/storage/session-control-sqlite.js';
import { assertHostControl, changedState, SessionControlError, type SessionState,
  type ObservedConversationMessage, type SendIntent } from '../core/collaboration/session-control.js';
import { PolicyError, type Permit, type RequestContext } from '../core/policy/authorize.js';
import { confirmsSend, validDeltaForState, type ConversationPort } from './session-control.js';

interface ConversationRequest {
  context: RequestContext;
  workspaceId: string;
  collaborationId: string;
  bindingId: string;
  expectedEpoch: number;
  idempotencyKey: string;
}

export interface SendReceipt {
  commandId: string;
  bindingId: string;
  sendIntentId: string;
  status: 'submitted' | 'unknown' | 'rejected';
}

export interface ConversationSyncReceipt {
  commandId: string;
  bindingId: string;
  state: SessionState;
  messages: readonly ObservedConversationMessage[];
  complete: boolean;
  /** Explicit local disposition, not proof that the original send succeeded. */
  unknownSendDisposition?: {
    kind: 'accepted_observed_history';
    sendIntent: SendIntent;
    fromCursor: string;
    nextCursor: string;
    nativeMessageIds: string[];
  };
}

/** Coordinates external calls outside short, fenced SQLite transactions. */
export class ConversationApplication {
  constructor(private readonly store: SessionControlSqlite,
    private readonly authorize: (request: { context: RequestContext; operation: string;
      workspaceId: string; collaborationId: string }) => Promise<Permit>,
    private readonly port?: ConversationPort) {}

  private binding(request: ConversationRequest): SessionState {
    const state = this.store.get(request.bindingId);
    if (!state || state.workspaceId !== request.workspaceId ||
        state.collaborationId !== request.collaborationId || !this.store.isCurrent(request.bindingId)) throw new PolicyError();
    return state;
  }

  private async permit(request: ConversationRequest, operation: string): Promise<Permit> {
    const permit = await this.authorize({ context: request.context, operation,
      workspaceId: request.workspaceId, collaborationId: request.collaborationId });
    if (!permit || permit.operation !== operation || permit.principal !== request.context.principal ||
        permit.recipient !== request.context.recipient || permit.scope.workspaceId !== request.workspaceId ||
        permit.scope.collaborationId !== request.collaborationId) throw new PolicyError();
    return permit;
  }

  /** Persist a narrower control mode only if the observation's starting state is still current. */
  private quarantineIfUnchanged(request: ConversationRequest, starting: SessionState): void {
    const current = this.store.get(request.bindingId);
    if (!current || !this.store.isCurrent(request.bindingId) ||
        current.workspaceId !== request.workspaceId || current.collaborationId !== request.collaborationId ||
        current.revision !== starting.revision || current.epoch !== starting.epoch) {
      throw new SessionControlError('CONFLICT', 'Control changed during native observation');
    }
    if (current.control === 'reconcile_required') return;
    if (!this.store.compareAndSwap(current.revision,
      changedState(current, { control: 'reconcile_required' }))) {
      throw new SessionControlError('CONFLICT', 'Control changed during native observation');
    }
  }

  async send(request: ConversationRequest & { text: string }): Promise<SendReceipt> {
    if (!request.text.trim()) throw new TypeError('Message required');
    const operation = 'conversation.send';
    const scope = { principal: request.context.principal, audience: request.context.audience,
      workspaceId: request.workspaceId, operation, idempotencyKey: request.idempotencyKey };
    const payload = { bindingId: request.bindingId, expectedEpoch: request.expectedEpoch, text: request.text };
    const permit = await this.permit(request, operation);
    const replay = this.store.lookupCommandResult(scope, payload, permit, request.bindingId, request.expectedEpoch);
    if (replay) return replay as SendReceipt;
    if (!this.port?.send) throw new SessionControlError('NOT_AVAILABLE', 'Send capability unavailable');
    const state = this.binding(request);
    const claim = this.store.claimCommand({ commandId: `conversation_${randomUUID()}`, scope, payload, permit,
      bindingId: request.bindingId, expectedRevision: state.revision, expectedEpoch: request.expectedEpoch });
    if (claim.disposition !== 'claimed' && claim.command.status !== 'prepared') {
      const receipt = this.store.getCommandResult(claim.command.commandId) as SendReceipt | null;
      if (receipt) return receipt;
      throw new SessionControlError('RECONCILE_REQUIRED', 'Prior send must be reconciled');
    }
    const starting = assertHostControl(state, request.expectedEpoch);
    let delta;
    try { delta = await this.port.syncDelta(starting); }
    catch {
      this.quarantineIfUnchanged(request, starting);
      throw new SessionControlError('RECONCILE_REQUIRED', 'Conversation pre-send sync failed');
    }
    const current = assertHostControl(this.binding(request), request.expectedEpoch);
    if (current.revision !== starting.revision) {
      throw new SessionControlError('CONFLICT', 'Control changed before send');
    }
    let unchanged = false;
    try {
      unchanged = validDeltaForState(current, delta) &&
        delta.nextCursor === current.cursor && delta.messages.length === 0;
    } catch { /* A malformed resolved observation is invalid, not a safe send preflight. */ }
    if (!unchanged) {
      this.quarantineIfUnchanged(request, starting);
      throw new SessionControlError('RECONCILE_REQUIRED', 'Conversation changed before send');
    }
    const freshPermit = await this.permit(request, operation);
    this.store.markSending(claim.command.commandId, freshPermit, current.revision, current.epoch);
    const sending = this.binding(request);
    // Authorization and control are checked again immediately before the external side effect.
    try {
      await this.permit(request, operation);
      if (this.binding(request).revision !== sending.revision ||
          this.binding(request).epoch !== sending.epoch) throw new PolicyError();
    } catch (error) {
      this.store.finishSend(claim.command.commandId, sending.revision, sending.epoch, 'rejected');
      throw error;
    }
    let outcome: SendReceipt['status'];
    let checkpointUsed = false;
    const onBeforeSubmit = async (): Promise<void> => {
      if (checkpointUsed) throw new SessionControlError('CONFLICT', 'Submit checkpoint already used');
      checkpointUsed = true;
      const checkpointPermit = await this.permit(request, operation);
      const checkpointState = this.binding(request);
      const command = this.store.getCommand(claim.command.commandId);
      if (checkpointPermit.grantId !== freshPermit.grantId ||
          checkpointState.revision !== sending.revision || checkpointState.epoch !== sending.epoch ||
          checkpointState.control !== 'host_controlled' || checkpointState.sendIntent?.id !== claim.command.commandId ||
          checkpointState.sendIntent.status !== 'sending' || checkpointState.sendIntent.text !== request.text ||
          command?.status !== 'sending') throw new PolicyError();
    };
    try {
      const result = await this.port.send(sending, request.text, { onBeforeSubmit });
      outcome = result.status === 'submitted' || result.status === 'rejected' ? result.status : 'unknown';
    } catch { outcome = 'unknown'; }
    this.store.finishSend(claim.command.commandId, sending.revision, sending.epoch, outcome);
    return this.store.getCommandResult(claim.command.commandId) as SendReceipt;
  }

  sync(request: ConversationRequest): Promise<ConversationSyncReceipt> {
    return this.synchronize(request, false);
  }

  resume(request: ConversationRequest & { acceptUnknownSendIntentId?: string }): Promise<ConversationSyncReceipt> {
    return this.synchronize(request, true);
  }

  private async synchronize(request: ConversationRequest & { acceptUnknownSendIntentId?: string }, resume: boolean): Promise<ConversationSyncReceipt> {
    const operation = resume ? 'conversation.resume' : 'conversation.sync';
    const acceptedId = request.acceptUnknownSendIntentId;
    if (acceptedId !== undefined && (!resume || !acceptedId.trim() ||
        (request.context.surface !== 'local_host' && request.context.surface !== 'local_cli'))) {
      throw new PolicyError();
    }
    const scope = { principal: request.context.principal, audience: request.context.audience,
      workspaceId: request.workspaceId, operation, idempotencyKey: request.idempotencyKey };
    const payload = { bindingId: request.bindingId, expectedEpoch: request.expectedEpoch,
      ...(acceptedId !== undefined ? { acceptUnknownSendIntentId: acceptedId } : {}) };
    const permit = await this.permit(request, operation);
    const replay = this.store.lookupCommandResult(scope, payload, permit, request.bindingId, request.expectedEpoch);
    if (replay) return replay as ConversationSyncReceipt;
    const state = this.binding(request);
    if (acceptedId !== undefined && (state.control !== 'reconcile_required' ||
        state.sendIntent?.id !== acceptedId || state.sendIntent.status !== 'unknown' || state.pendingSyncReceipt)) {
      throw new SessionControlError('CONFLICT', 'Unknown send disposition no longer matches');
    }
    if (state.pendingSyncReceipt) {
      const pending = state.pendingSyncReceipt;
      if (state.control !== 'host_controlled' ||
          (request.expectedEpoch !== state.epoch && request.expectedEpoch !== pending.fromEpoch)) {
        throw new SessionControlError('CONFLICT', 'Pending receipt control changed');
      }
      const updated = changedState(state, { lastAckedSyncReceiptId: pending.receiptId });
      const next = { ...updated } as { -readonly [K in keyof SessionState]: SessionState[K] };
      delete next.pendingSyncReceipt;
      const receipt: ConversationSyncReceipt = { commandId: `conversation_${randomUUID()}`,
        bindingId: request.bindingId, state: next, messages: pending.messages, complete: true };
      const freshPermit = await this.permit(request, operation);
      return this.store.commitSync({ commandId: receipt.commandId, scope, payload, permit: freshPermit,
        bindingId: request.bindingId, expectedRevision: state.revision, expectedEpoch: state.epoch,
        nextState: next, messages: pending.messages, receipt }) as ConversationSyncReceipt;
    }
    if (!this.port) throw new SessionControlError('NOT_AVAILABLE', 'Conversation sync capability unavailable');
    if (state.epoch !== request.expectedEpoch ||
        (resume && state.control !== 'human_controlled' && state.control !== 'reconcile_required')) {
      throw new SessionControlError('CONFLICT', 'Control epoch or mode changed');
    }
    let delta;
    try { delta = await this.port.syncDelta(state); }
    catch {
      this.quarantineIfUnchanged(request, state);
      throw new SessionControlError('RECONCILE_REQUIRED', 'Conversation sync failed');
    }
    const current = this.binding(request);
    if (current.revision !== state.revision || current.epoch !== state.epoch) {
      throw new SessionControlError('CONFLICT', 'Control changed during sync');
    }
    let valid: boolean;
    let correlated = false;
    let hasMessages = false;
    try {
      valid = validDeltaForState(current, delta);
      if (valid) {
        correlated = Boolean(current.sendIntent) && confirmsSend(current, delta);
        hasMessages = delta.messages.length > 0;
      }
    } catch { valid = false; }
    if (!valid) {
      this.quarantineIfUnchanged(request, state);
      throw new SessionControlError('RECONCILE_REQUIRED', 'Native conversation identity or history changed');
    }
    const accepted = acceptedId !== undefined && !correlated && delta.completedSend === undefined &&
      current.sendIntent?.id === acceptedId && current.sendIntent.status === 'unknown' &&
      current.control === 'reconcile_required' && delta.messages.length >= 2 && delta.nextCursor !== current.cursor;
    if ((acceptedId !== undefined && !accepted) || (current.sendIntent && !correlated && !accepted)) {
      this.quarantineIfUnchanged(request, state);
      throw new SessionControlError('RECONCILE_REQUIRED', 'Send result needs native message correlation');
    }
    if (!resume && current.control === 'host_controlled' && !correlated && hasMessages) {
      this.quarantineIfUnchanged(request, state);
      throw new SessionControlError('RECONCILE_REQUIRED', 'Unexpected native messages while host controls session');
    }
    const freshPermit = await this.permit(request, operation);
    const nextControl = resume ? 'host_controlled' :
      current.control === 'host_controlled' ? 'host_controlled' : 'human_controlled';
    const updated = changedState(current, { cursor: delta.nextCursor, control: nextControl,
      epoch: current.epoch + (resume ? 1 : 0) });
    // The command receipt is canonical JSON. Removed optional fields must be absent, not undefined.
    const next: SessionState = correlated || accepted ? (() => {
      const cleared = { ...updated } as { -readonly [K in keyof SessionState]: SessionState[K] };
      delete cleared.sendIntent;
      return cleared;
    })() : updated;
    const receipt: ConversationSyncReceipt = { commandId: `conversation_${randomUUID()}`,
      bindingId: request.bindingId, state: next, messages: delta.messages, complete: true,
      ...(accepted ? { unknownSendDisposition: { kind: 'accepted_observed_history' as const,
        sendIntent: current.sendIntent!, fromCursor: current.cursor, nextCursor: delta.nextCursor,
        nativeMessageIds: delta.messages.map(message => message.nativeMessageId) } } : {}) };
    return this.store.commitSync({ commandId: receipt.commandId, scope, payload, permit: freshPermit,
      bindingId: request.bindingId, expectedRevision: current.revision, expectedEpoch: current.epoch,
      nextState: next, messages: delta.messages, receipt,
      ...(accepted ? { acceptedUnknownSendIntentId: acceptedId! } : {}),
      ...(correlated ? { completesCommandId: current.sendIntent!.id, completedSend: delta.completedSend! } : {})
    }) as ConversationSyncReceipt;
  }
}
