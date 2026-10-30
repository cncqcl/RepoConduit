import { createHash } from 'node:crypto';
import type { RequestContext } from '../core/policy/authorize.js';
import type { InvestigationInput } from '../core/investigation/request.js';
import type { DailyUseApplication } from './daily-use.js';
import type { DispatchService } from './dispatch.js';

type Dependencies = { daily: Pick<DailyUseApplication, 'resolveTopic'>; dispatcher: Pick<DispatchService, 'dispatch'> };
const intentKey = (context: RequestContext, topic: string, action: string, name: string) =>
  `daily-investigation-${createHash('sha256').update(JSON.stringify([
    context.principal, context.audience, context.recipient, topic, action, name,
  ])).digest('hex')}`;

/** Name-to-intent convenience only. The existing handler owns all grants, budgets and state transitions. */
export async function submitDailyInvestigation(deps: Dependencies, context: RequestContext, input: {
  topic: string; requestName: string; question: string; scope: InvestigationInput['scope'];
  requestedOutputs: InvestigationInput['requestedOutputs']; parentInvestigation?: string | undefined;
}): Promise<unknown> {
  if (typeof input.requestName !== 'string' || !input.requestName.trim() ||
    Buffer.byteLength(input.requestName, 'utf8') > 128 || input.requestName.includes('\0')) throw new TypeError('Invalid request name');
  const topic = await deps.daily.resolveTopic(context, { topicHandle: input.topic });
  return deps.dispatcher.dispatch(context, { operation: 'investigate.submit',
    scope: { workspaceId: topic.workspaceId, collaborationId: topic.collaborationId },
    idempotencyKey: intentKey(context, topic.topicHandle, 'submit', input.requestName),
    payload: { workingCopyId: topic.workingCopyId, input: {
      snapshotRef: topic.snapshotId, contextRevisionId: topic.contextRevisionId,
      question: input.question, scope: input.scope, requestedOutputs: input.requestedOutputs,
      parentInvestigationId: input.parentInvestigation ?? null,
    } } });
}

export async function readDailyInvestigation(deps: Dependencies, context: RequestContext,
  operation: 'investigate.get' | 'investigate.result' | 'investigate.cancel',
  input: { topic: string; investigation: string }): Promise<unknown> {
  const topic = await deps.daily.resolveTopic(context, { topicHandle: input.topic });
  return deps.dispatcher.dispatch(context, { operation,
    scope: { workspaceId: topic.workspaceId, collaborationId: topic.collaborationId },
    payload: { workingCopyId: topic.workingCopyId, requestId: input.investigation },
    ...(operation === 'investigate.cancel' ? { idempotencyKey: intentKey(context, topic.topicHandle, 'cancel', input.investigation) } : {}),
  });
}
