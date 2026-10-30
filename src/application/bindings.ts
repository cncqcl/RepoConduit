import { randomUUID } from 'node:crypto';
import { SessionControlSqlite } from '../adapters/storage/session-control-sqlite.js';
import { handoffState, SessionControlError, type SessionState } from '../core/collaboration/session-control.js';
import { PolicyError, type Permit, type RequestContext } from '../core/policy/authorize.js';

/** Native identifiers are supplied by a trusted local adapter, never command JSON. */
export interface ConversationBindingObservation {
  providerId: string;
  accountId: string;
  nativeSessionId: string;
  cursor: string;
}

export interface ConversationBindingAdapter {
  observeBinding(scope: { workspaceId: string; collaborationId: string }): Promise<ConversationBindingObservation>;
}

interface BindingRequest {
  context: RequestContext;
  workspaceId: string;
  collaborationId: string;
  idempotencyKey: string;
}

export class BindingApplication {
  constructor(private readonly store: SessionControlSqlite,
    private readonly authorize: (request: { context: RequestContext; operation: string;
      workspaceId: string; collaborationId: string }) => Promise<Permit>,
    private readonly adapter?: ConversationBindingAdapter) {}

  private scope(request: BindingRequest, operation: string) {
    return { principal: request.context.principal, audience: request.context.audience,
      workspaceId: request.workspaceId, operation, idempotencyKey: request.idempotencyKey };
  }

  private async permit(request: BindingRequest, operation: string): Promise<Permit> {
    const permit = await this.authorize({ context: request.context, operation, workspaceId: request.workspaceId,
      collaborationId: request.collaborationId });
    if (!permit || permit.operation !== operation || permit.effect !== 'state_write' ||
        permit.principal !== request.context.principal || permit.recipient !== request.context.recipient ||
        permit.scope.workspaceId !== request.workspaceId ||
        permit.scope.collaborationId !== request.collaborationId) throw new PolicyError();
    return permit;
  }

  async bind(request: BindingRequest): Promise<SessionState> {
    if (!this.adapter) throw new SessionControlError('NOT_AVAILABLE', 'Conversation binding capability unavailable');
    const payload = { scope: { workspaceId: request.workspaceId, collaborationId: request.collaborationId }, payload: {} };
    await this.permit(request, 'conversation.bind');
    const prior = this.store.lookupIdempotent<SessionState>(this.scope(request, 'conversation.bind'), payload);
    if (prior) return prior;
    const observed = await this.adapter.observeBinding({ workspaceId: request.workspaceId, collaborationId: request.collaborationId });
    if (![observed?.providerId, observed?.accountId, observed?.nativeSessionId, observed?.cursor]
      .every((part) => typeof part === 'string' && part.trim().length > 0)) {
      throw new SessionControlError('RECONCILE_REQUIRED', 'Native conversation identity incomplete');
    }
    const permit = await this.permit(request, 'conversation.bind');
    return this.store.runIdempotent(this.scope(request, 'conversation.bind'), payload, permit, () => {
      const state: SessionState = { bindingId: `binding_${randomUUID()}`, workspaceId: request.workspaceId,
        collaborationId: request.collaborationId, providerId: observed.providerId,
        accountId: observed.accountId, nativeSessionId: observed.nativeSessionId,
        cursor: observed.cursor, control: 'host_controlled', epoch: 0, revision: 0 };
      this.store.create(state);
      return state;
    });
  }

  async handoff(request: BindingRequest & { bindingId: string; expectedEpoch: number }): Promise<SessionState> {
    const permit = await this.permit(request, 'conversation.handoff');
    const payload = { scope: { workspaceId: request.workspaceId, collaborationId: request.collaborationId },
      payload: { bindingId: request.bindingId, expectedEpoch: request.expectedEpoch } };
    return this.store.runIdempotent(this.scope(request, 'conversation.handoff'), payload, permit, () => {
      const prior = this.store.get(request.bindingId);
      if (!prior || prior.workspaceId !== request.workspaceId || prior.collaborationId !== request.collaborationId) throw new PolicyError();
      const next = handoffState(prior, request.expectedEpoch);
      if (!this.store.compareAndSwap(prior.revision, next)) throw new SessionControlError('CONFLICT', 'Control changed');
      return next;
    });
  }

  async successor(request: BindingRequest & { predecessorBindingId: string; expectedEpoch: number;
    expectedRevision: number; contextRevisionId: string }): Promise<SessionState> {
    const operation = 'conversation.successor';
    const payload = { scope: { workspaceId: request.workspaceId, collaborationId: request.collaborationId },
      payload: { predecessorBindingId: request.predecessorBindingId, expectedEpoch: request.expectedEpoch,
        expectedRevision: request.expectedRevision, contextRevisionId: request.contextRevisionId } };
    await this.permit(request, operation);
    const prior = this.store.lookupIdempotent<SessionState>(this.scope(request, operation), payload);
    if (prior) return prior;
    if (!this.adapter) throw new SessionControlError('NOT_AVAILABLE', 'Conversation binding capability unavailable');
    const predecessor = this.store.get(request.predecessorBindingId);
    if (!predecessor || predecessor.workspaceId !== request.workspaceId ||
        predecessor.collaborationId !== request.collaborationId ||
        !this.store.isCurrent(request.predecessorBindingId)) throw new PolicyError();
    if (predecessor.epoch !== request.expectedEpoch || predecessor.revision !== request.expectedRevision) {
      throw new SessionControlError('CONFLICT', 'Predecessor changed');
    }
    const observed = await this.adapter.observeBinding({ workspaceId: request.workspaceId, collaborationId: request.collaborationId });
    if (![observed?.providerId, observed?.accountId, observed?.nativeSessionId, observed?.cursor]
      .every((part) => typeof part === 'string' && part.trim().length > 0)) {
      throw new SessionControlError('RECONCILE_REQUIRED', 'Native conversation identity incomplete');
    }
    const permit = await this.permit(request, operation);
    return this.store.successor({ predecessorBindingId: request.predecessorBindingId,
      expectedEpoch: request.expectedEpoch, expectedRevision: request.expectedRevision,
      observed, contextRevisionId: request.contextRevisionId, newBindingId: `binding_${randomUUID()}`,
      scope: this.scope(request, operation), permit });
  }
}
