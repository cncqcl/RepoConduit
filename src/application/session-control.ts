import { randomUUID } from 'node:crypto';
import {
  assertHostControl, changedState, handoffState, SessionControlError,
  type ObservedConversationMessage, type SessionState,
} from '../core/collaboration/session-control.js';

export interface ConversationDelta {
  readonly providerId: string;
  readonly accountId: string;
  readonly nativeSessionId: string;
  readonly fromCursor: string;
  readonly nextCursor: string;
  readonly complete: boolean;
  readonly generating: boolean;
  readonly historyChanged: boolean;
  readonly messages: readonly ObservedConversationMessage[];
  /** Trusted adapter observation tying both native messages to the persisted send intent. */
  readonly completedSend?: {
    readonly sendIntentId: string;
    readonly nativeUserMessageId: string;
    readonly nativeReplyMessageId: string;
  } | undefined;
}

/** A trusted observation must describe this exact native session and one complete cursor step. */
export function validDeltaForState(state: SessionState, delta: ConversationDelta): boolean {
  const ids = new Set<string>();
  const messagesValid = delta.messages.every((message) => {
    if (!message.nativeMessageId || !message.version || ids.has(message.nativeMessageId)) return false;
    ids.add(message.nativeMessageId);
    return true;
  });
  return delta.providerId === state.providerId && delta.accountId === state.accountId &&
    delta.nativeSessionId === state.nativeSessionId && delta.fromCursor === state.cursor &&
    delta.complete && !delta.generating && !delta.historyChanged && Boolean(delta.nextCursor) &&
    messagesValid;
}

export function confirmsSend(state: SessionState, delta: ConversationDelta): boolean {
  const evidence = delta.completedSend;
  const ids = new Set(delta.messages.map((message) => message.nativeMessageId));
  const user = delta.messages.find((message) => message.nativeMessageId === evidence?.nativeUserMessageId);
  return validDeltaForState(state, delta) && delta.nextCursor !== state.cursor && Boolean(evidence &&
    evidence.sendIntentId === state.sendIntent?.id && evidence.nativeUserMessageId &&
    evidence.nativeReplyMessageId && evidence.nativeUserMessageId !== evidence.nativeReplyMessageId &&
    ids.has(evidence.nativeUserMessageId) && user?.text === state.sendIntent?.text &&
    ids.has(evidence.nativeReplyMessageId));
}

export interface ConversationPort {
  syncDelta(binding: SessionState): Promise<ConversationDelta>;
  send?(binding: SessionState, text: string, hooks?: { onBeforeSubmit(): Promise<void> }): Promise<{ status: 'submitted' | 'unknown' | 'rejected' }>;
}

/** Implementations must make compareAndSwap durable and atomic before returning true. */
export interface SessionStateStore {
  get(bindingId: string): SessionState | null;
  compareAndSwap(expectedRevision: number, next: SessionState): boolean;
}

export interface SyncReceipt {
  readonly state: SessionState;
  readonly receiptId?: string;
  readonly messages: readonly ObservedConversationMessage[];
  readonly complete: boolean;
}

export class SessionControlService {
  constructor(private readonly store: SessionStateStore, private readonly port: ConversationPort) {}

  private read(bindingId: string): SessionState {
    const state = this.store.get(bindingId);
    if (!state || state.bindingId !== bindingId || state.lifecycle === 'superseded') {
      throw new SessionControlError('NOT_AVAILABLE', 'Binding unavailable');
    }
    return state;
  }

  private save(prior: SessionState, next: SessionState): SessionState {
    if (prior.bindingId !== next.bindingId || next.revision !== prior.revision + 1 ||
        !this.store.compareAndSwap(prior.revision, next)) {
      throw new SessionControlError('CONFLICT', 'Session control revision changed');
    }
    return next;
  }

  assertHostCanSend(bindingId: string, expectedEpoch: number): SessionState {
    return assertHostControl(this.read(bindingId), expectedEpoch);
  }

  handoff(bindingId: string, expectedEpoch: number): SessionState {
    const prior = this.read(bindingId);
    return this.save(prior, handoffState(prior, expectedEpoch));
  }

  private matches(state: SessionState, delta: ConversationDelta): boolean {
    return validDeltaForState(state, delta);
  }

  async syncAndResume(bindingId: string, expectedEpoch: number): Promise<SyncReceipt> {
    const prior = this.read(bindingId);
    const pending = prior.pendingSyncReceipt;
    if (prior.control === 'host_controlled' && pending &&
        (pending.fromEpoch === expectedEpoch || prior.epoch === expectedEpoch)) {
      return { state: prior, receiptId: pending.receiptId, messages: pending.messages, complete: true };
    }
    if (prior.epoch !== expectedEpoch ||
        (prior.control !== 'human_controlled' && prior.control !== 'reconcile_required' && prior.control !== 'syncing') || pending) {
      throw new SessionControlError('CONFLICT', 'Control epoch or mode changed');
    }
    const syncing = this.save(prior, changedState(prior, { control: 'syncing' }));
    let delta: ConversationDelta;
    try {
      delta = await this.port.syncDelta(syncing);
    } catch {
      const current = this.read(bindingId);
      if (current.revision === syncing.revision) {
        this.save(current, changedState(current, { control: 'reconcile_required' }));
      }
      throw new SessionControlError('RECONCILE_REQUIRED', 'Conversation sync failed');
    }
    const current = this.read(bindingId);
    if (current.revision !== syncing.revision || current.epoch !== expectedEpoch) {
      throw new SessionControlError('CONFLICT', 'Control changed during sync');
    }
    // A prior unknown send cannot be proven absent by a quiet page or text-only delta.
    const complete = this.matches(current, delta) && !current.sendIntent;
    const receiptId = complete ? randomUUID() : undefined;
    const state = this.save(current, changedState(current, complete ? {
      control: 'host_controlled', cursor: delta.nextCursor, epoch: current.epoch + 1,
      pendingSyncReceipt: { receiptId: receiptId!, fromEpoch: expectedEpoch, fromCursor: current.cursor,
        nextCursor: delta.nextCursor, messages: delta.messages },
    } : { control: 'reconcile_required' }));
    return { state, ...(receiptId ? { receiptId } : {}), messages: complete ? delta.messages : [], complete };
  }

  /** Reconcile only a confirmed submission; an unknown send still needs separate native investigation. */
  async reconcileAwaitingResult(bindingId: string, expectedEpoch: number): Promise<SyncReceipt> {
    const prior = this.read(bindingId);
    if (prior.epoch !== expectedEpoch ||
        (prior.control !== 'host_controlled' && prior.control !== 'syncing' &&
          prior.control !== 'reconcile_required') ||
        prior.sendIntent?.status !== 'awaiting_result' || prior.pendingSyncReceipt) {
      throw new SessionControlError('CONFLICT', 'Control epoch or send intent changed');
    }
    const syncing = prior.control === 'syncing' ? prior :
      this.save(prior, changedState(prior, { control: 'syncing' }));
    let delta: ConversationDelta;
    try {
      delta = await this.port.syncDelta(syncing);
    } catch {
      const current = this.read(bindingId);
      if (current.revision === syncing.revision && current.epoch === expectedEpoch) {
        this.save(current, changedState(current, { control: 'reconcile_required' }));
      }
      throw new SessionControlError('RECONCILE_REQUIRED', 'Conversation sync failed');
    }
    const current = this.read(bindingId);
    if (current.revision !== syncing.revision || current.epoch !== expectedEpoch) {
      throw new SessionControlError('CONFLICT', 'Control changed during sync');
    }
    const complete = confirmsSend(current, delta);
    const receiptId = complete ? randomUUID() : undefined;
    const state = this.save(current, changedState(current, complete ? {
      control: 'host_controlled', cursor: delta.nextCursor, epoch: current.epoch + 1,
      sendIntent: undefined,
      pendingSyncReceipt: { receiptId: receiptId!, fromEpoch: expectedEpoch, fromCursor: current.cursor,
        nextCursor: delta.nextCursor, messages: delta.messages },
    } : { control: 'reconcile_required' }));
    return { state, ...(receiptId ? { receiptId } : {}), messages: complete ? delta.messages : [], complete };
  }

  ackSyncReceipt(bindingId: string, receiptId: string): SessionState {
    if (!receiptId) throw new TypeError('Receipt ID required');
    const prior = this.read(bindingId);
    if (!prior.pendingSyncReceipt && prior.lastAckedSyncReceiptId === receiptId) return prior;
    if (prior.control !== 'host_controlled' || prior.pendingSyncReceipt?.receiptId !== receiptId) {
      throw new SessionControlError('CONFLICT', 'Sync receipt changed');
    }
    return this.save(prior, changedState(prior, { pendingSyncReceipt: undefined,
      lastAckedSyncReceiptId: receiptId }));
  }

  async send(bindingId: string, expectedEpoch: number, text: string): Promise<{ status: 'submitted' | 'unknown' | 'rejected' }> {
    if (!text.trim()) throw new TypeError('Message required');
    if (!this.port.send) throw new SessionControlError('NOT_AVAILABLE', 'Send capability unavailable');
    const starting = this.assertHostCanSend(bindingId, expectedEpoch);
    const delta = await this.port.syncDelta(starting);
    const current = this.assertHostCanSend(bindingId, expectedEpoch);
    if (current.revision !== starting.revision) throw new SessionControlError('CONFLICT', 'Control changed before send');
    if (!this.matches(current, delta) || delta.nextCursor !== current.cursor || delta.messages.length !== 0) {
      this.save(current, changedState(current, { control: 'reconcile_required' }));
      throw new SessionControlError('RECONCILE_REQUIRED', 'Remote account or history changed before send');
    }
    const sending = this.save(current, changedState(current, { sendIntent: { id: randomUUID(), text, status: 'sending' } }));
    let result: { status: 'submitted' | 'unknown' | 'rejected' };
    try {
      result = await this.port.send(sending, text);
    } catch {
      result = { status: 'unknown' };
    }
    const after = this.read(bindingId);
    if (after.revision !== sending.revision || after.epoch !== expectedEpoch) {
      // A concurrent handoff invalidates this worker even if the provider reported submission.
      const intent = after.sendIntent;
      if (intent && intent.id === sending.sendIntent?.id) {
        this.save(after, changedState(after, { control: 'reconcile_required',
          sendIntent: { ...intent, status: 'unknown' } }));
      }
      return { status: 'unknown' };
    }
    if (result.status === 'rejected') {
      this.save(after, changedState(after, { sendIntent: undefined }));
    } else if (result.status === 'unknown') {
      this.save(after, changedState(after, { control: 'reconcile_required',
        sendIntent: { ...sending.sendIntent!, status: 'unknown' } }));
    } else {
      this.save(after, changedState(after, { sendIntent: { ...sending.sendIntent!, status: 'awaiting_result' } }));
    }
    return result;
  }
}
