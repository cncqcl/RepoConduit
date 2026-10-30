import { createHash } from 'node:crypto';
import { RepositorySnapshot } from '../adapters/repository/snapshots.js';
import type { PersistedSnapshot } from '../adapters/repository/snapshots.js';
import type { InvestigationClaim } from
  '../adapters/storage/investigation-sqlite.js';
import type { SqliteInvestigationStore, RunningReadBinding } from
  '../adapters/storage/investigation-sqlite.js';
import { parseInvestigationResult, type ParsedInvestigationResult } from '../core/investigation/result.js';
import type { ContextRevision } from '../core/collaboration/context.js';
import type { InvestigationRecord } from '../core/investigation/request.js';
import { observeClaudeModelTreeTerminal, validateClaudeModelTreeTerminal,
  type ClaudeModelTreeTerminalObservation } from
  '../adapters/secondary-investigator/claude-model-tree-terminal.js';
import { runClaudeModelOriginalOwner, type ClaudeModelOriginalOwnerCandidate,
  type ClaudeModelOriginalOwnerInput, type ClaudeModelOriginalOwnerPorts } from
  './claude-model-original-owner.js';
import type { ClaudeModelSupervisorState } from
  '../adapters/secondary-investigator/claude-model-supervisor.js';
import type { createClaudeModelOriginalCompletionTickets } from './claude-model-tree-tickets.js';
import {validateInvestigationResultEvidence} from './investigation-result-evidence.js';

export interface VerifiedClaudeModelOriginalOutcome {
  candidate: ClaudeModelOriginalOwnerCandidate;
  result: ParsedInvestigationResult;
  verifiedAt: string;
  evidenceReceiptIds: string[];
}

export interface ClaudeModelInvestigationInput extends ClaudeModelOriginalOwnerInput {
  contextRevision: ContextRevision;
  getSnapshot(id: string, workspaceId: string, collaborationId: string):
    Promise<{workspaceId:string; collaborationId:string; workingCopyId:string;
      snapshot: PersistedSnapshot} | null>;
  completionTickets: ReturnType<typeof createClaudeModelOriginalCompletionTickets>;
}

export interface ClaudeModelInvestigationPorts {
  owner?: ClaudeModelOriginalOwnerPorts;
  observeTree?: (fact: Awaited<ReturnType<typeof runClaudeModelOriginalOwner>>['fact'],
    closed: ClaudeModelSupervisorState) =>
    Promise<ClaudeModelTreeTerminalObservation>;
  now?: () => Date;
}

/** Bounded original-owner lease renewal. A failed renewal aborts new execution work. */
export function startClaudeModelOriginalLeaseHeartbeat(input: {
  claim: InvestigationClaim; store: SqliteInvestigationStore;
  binding: RunningReadBinding; profileRevision: string;
  maxWallSeconds: number; commandDigest: string;
  now?:()=>Date; intervalMs?:number;
}) {
  const now=input.now??(()=>new Date());
  const controller=new AbortController();
  let failed=false;
  let stopped=false;
  const tick=():boolean=>{
    if(failed||stopped) return false;
    try {
      const record=input.store.get(input.claim.requestId);
      const current=input.store.listUnsettled().find(item=>
        item.requestId===input.claim.requestId && item.attemptId===input.claim.attemptId);
      if(!record||!current||current.workerEpoch!==input.claim.workerEpoch||
        current.workerId!==input.claim.workerId||current.workspaceId!==input.claim.workspaceId||
        current.wslResource?.gate?.launch?.commandDigest!==input.commandDigest||
        record.budget.maxWallSeconds!==input.maxWallSeconds||
        !['start_intent','started'].includes(current.phase)) throw new Error('NOT_AVAILABLE');
      const clock=now();
      const started=record.attempts.find(item=>item.id===current.attemptId)?.startedAt;
      if(started&&clock.getTime()>=Date.parse(started)+input.maxWallSeconds*1000) {
        // The last renewed lease covers bounded tree cleanup; execution may not continue.
        return true;
      }
      input.store.renewLease(current,clock);
      return true;
    } catch {
      failed=true; controller.abort(); return false;
    }
  };
  if(!tick()) throw new Error('NOT_AVAILABLE');
  const interval=setInterval(tick,input.intervalMs??5000);
  return {signal:controller.signal,tick,
    ensure(){if(failed) throw new Error('NOT_AVAILABLE');},
    stop(){stopped=true;clearInterval(interval);}};
}

export { InvestigationPromptLimitExceeded as ClaudeModelPromptLimitExceeded,
  buildInvestigationPrompt as buildClaudeModelInvestigationPrompt,
  preflightInvestigationPrompt as preflightClaudeModelInvestigationPrompt } from './investigation-prompt.js';
import { InvestigationPromptLimitExceeded as ClaudeModelPromptLimitExceeded,
  buildInvestigationPrompt as buildClaudeModelInvestigationPrompt } from './investigation-prompt.js';

/** One original owner, one prompt, exact result validation, independent tree proof, atomic store publish. */
export async function runClaudeModelInvestigation(input: ClaudeModelInvestigationInput,
  ports: ClaudeModelInvestigationPorts = {}): Promise<InvestigationRecord | null> {
  const now = ports.now ?? (() => new Date());
  const record = input.store.get(input.claim.requestId);
  if (!record || record.workspaceId !== input.claim.workspaceId ||
    record.budget.maxWallSeconds !== input.limits.maxWallSeconds ||
    record.budget.maxTurns !== input.limits.maxTurns) throw new Error('NOT_AVAILABLE');
  const saved = await input.getSnapshot(record.snapshotRef, record.workspaceId, record.collaborationId);
  if (!saved || saved.workspaceId !== record.workspaceId ||
    saved.collaborationId !== record.collaborationId ||
    saved.workingCopyId !== record.workingCopyId) throw new Error('NOT_AVAILABLE');
  const snapshot = RepositorySnapshot.fromPersisted(saved.snapshot);
  let prompt: Buffer;
  try {
    prompt = buildClaudeModelInvestigationPrompt(record, input.contextRevision,snapshot,
      input.claim.attemptId);
  } catch (error) {
    if (error instanceof ClaudeModelPromptLimitExceeded) {
      input.store.markRecoveryRequired(input.claim, now(), 'model_prompt_limit_exceeded');
    }
    throw error;
  }
  const promptHash = createHash('sha256').update(prompt).digest('hex');
  let owner: Awaited<ReturnType<typeof runClaudeModelOriginalOwner>> | undefined;
  let heartbeat: ReturnType<typeof startClaudeModelOriginalLeaseHeartbeat> | undefined;
  let treeReceipt: string | undefined;
  let outcomeReceipt: string | undefined;
  try {
    heartbeat=startClaudeModelOriginalLeaseHeartbeat({claim:input.claim,store:input.store,
      binding:input.binding,profileRevision:input.profileRevision,
      maxWallSeconds:input.limits.maxWallSeconds,
      commandDigest:input.descriptor.commandDigest,now});
    const signal=input.signal ? AbortSignal.any([input.signal,heartbeat.signal]) : heartbeat.signal;
    owner = await runClaudeModelOriginalOwner({...input,signal}, ports.owner);
    heartbeat.ensure();
    const current: InvestigationClaim | undefined = input.store.listUnsettled().find(item =>
      item.requestId === input.claim.requestId && item.attemptId === input.claim.attemptId &&
      item.workerEpoch === input.claim.workerEpoch && item.phase === 'started' &&
      item.wslResource?.gate?.launch?.commandDigest === input.descriptor.commandDigest);
    if (!current || !current.nativeRef) throw new Error('NOT_AVAILABLE');
    heartbeat.ensure();
    await owner.sendPrompt(prompt, promptHash);
    const candidate = await owner.readNativeOutcomeCandidate();
    heartbeat.ensure();
    let verified: VerifiedClaudeModelOriginalOutcome | null = null;
    const fact = owner.fact;
    const intent = input.store.getModelPromptIntent(current);
    if (candidate && intent && candidate.requestId === record.id &&
      candidate.attemptId === current.attemptId && candidate.workspaceId === current.workspaceId &&
      candidate.workerEpoch === current.workerEpoch && candidate.nativeRef === current.nativeRef &&
      candidate.promptHash === intent.promptHash && candidate.commandDigest === intent.commandDigest &&
      /^[0-9a-f]{64}$/.test(candidate.rawBytesSha256)) {
      try {
        const result = parseInvestigationResult(candidate.result);
        const receipts = input.store.getSucceededReadReceipts(current);
        validateInvestigationResultEvidence(result, receipts, snapshot, {
          requestId: record.id, attemptId: current.attemptId, workspaceId: record.workspaceId,
          collaborationId: record.collaborationId, workingCopyId: record.workingCopyId,
          snapshotId: record.snapshotRef, contextRevisionId: record.contextRevisionId,
          launchEpoch: current.workerEpoch, nativeRef: current.nativeRef,
          workerPrincipal: current.workerId, workerAudience: input.binding.workerAudience,
          workerRecipient: input.binding.workerRecipient,
          workerGrantId: input.binding.workerGrantId});
        const observedAt = now();
        const startedAt = Date.parse(input.store.get(record.id)?.attempts.find(item =>
          item.id === current.attemptId)?.startedAt ?? '');
        if (observedAt.getTime() < startedAt ||
          observedAt.getTime() >= startedAt + record.budget.maxWallSeconds * 1000)
          throw new Error('NOT_AVAILABLE');
        verified = {candidate, result, verifiedAt: observedAt.toISOString(),
          evidenceReceiptIds: result.evidence.map(item => item.toolReceipt)};
      } catch { verified = null; }
    }
    heartbeat.ensure();
    input.store.preflightClaudeModelOriginalTermination(current, now());
    const closed = await owner.closeOriginalGate();
    if (!closed) return null;
    heartbeat.ensure();
    input.store.preflightClaudeModelOriginalTermination(current, now(), 17_000);
    const observation = await (ports.observeTree ?? observeClaudeModelTreeTerminal)(fact, closed);
    if (!validateClaudeModelTreeTerminal(fact, observation)) return null;
    heartbeat.ensure();
    treeReceipt = input.completionTickets.issueTree(current, fact, observation);
    if (verified && intent) outcomeReceipt = input.completionTickets.issueOutcome(current, fact, intent, verified);
    return input.store.settleClaudeModelOriginalOutcome(current, observation, treeReceipt,
      verified && outcomeReceipt ? {...verified, receipt: outcomeReceipt} : null, now());
  } catch { return null; }
  finally {
    heartbeat?.stop();
    if (treeReceipt) input.completionTickets.revoke(treeReceipt);
    if (outcomeReceipt) input.completionTickets.revoke(outcomeReceipt);
    await owner?.close();
  }
}

export {validateInvestigationResultEvidence, type TrustedInvestigationResultBinding}
  from './investigation-result-evidence.js';
