/** Provider-neutral, persisted facts for one external conversation binding. */
export type ControlMode = 'host_controlled' | 'human_controlled' | 'syncing' | 'reconcile_required';

export interface SendIntent {
  readonly id: string;
  readonly text: string;
  readonly status: 'sending' | 'awaiting_result' | 'unknown';
}

export interface ObservedConversationMessage {
  readonly nativeMessageId: string;
  readonly version: string;
  readonly text: string;
}

export interface PendingSyncReceipt {
  readonly receiptId: string;
  readonly fromEpoch: number;
  readonly fromCursor: string;
  readonly nextCursor: string;
  readonly messages: readonly ObservedConversationMessage[];
}

export interface SessionState {
  readonly bindingId: string;
  readonly lifecycle?: 'current' | 'superseded';
  readonly parentBindingId?: string;
  readonly contextRevisionId?: string;
  readonly workspaceId: string;
  readonly collaborationId: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly nativeSessionId: string;
  readonly cursor: string;
  readonly control: ControlMode;
  readonly epoch: number;
  readonly revision: number;
  readonly sendIntent?: SendIntent | undefined;
  readonly pendingSyncReceipt?: PendingSyncReceipt | undefined;
  readonly lastAckedSyncReceiptId?: string | undefined;
}

export class SessionControlError extends Error {
  constructor(readonly code: 'NOT_AVAILABLE' | 'CONFLICT' | 'RECONCILE_REQUIRED', message: string) {
    super(message);
  }
}

export function assertHostControl(state: SessionState, expectedEpoch: number): SessionState {
  if (state.lifecycle === 'superseded' || state.epoch !== expectedEpoch || state.control !== 'host_controlled' ||
      state.sendIntent || state.pendingSyncReceipt) {
    throw new SessionControlError('CONFLICT', 'Host control, epoch, or send intent changed');
  }
  return state;
}

export function handoffState(state: SessionState, expectedEpoch: number): SessionState {
  if (state.lifecycle === 'superseded' || state.epoch !== expectedEpoch ||
      state.control !== 'host_controlled' || state.pendingSyncReceipt) {
    throw new SessionControlError('CONFLICT', 'Host control or epoch changed');
  }
  return { ...state, control: state.sendIntent ? 'reconcile_required' : 'human_controlled',
    epoch: state.epoch + 1, revision: state.revision + 1 };
}

export function changedState(state: SessionState, patch: Partial<SessionState>): SessionState {
  return { ...state, ...patch, revision: state.revision + 1 };
}
