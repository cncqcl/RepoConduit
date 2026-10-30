import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { InvestigationClaim, WslResource } from '../adapters/storage/investigation-sqlite.js';
import { validateCurrentClaudeModelOuterFact, type ModelOuterConfinedFact } from
  '../adapters/secondary-investigator/claude-model-outer-fact.js';
import { validClaudeModelLaunchLimits } from
  '../adapters/secondary-investigator/claude-model-supervisor.js';

type Purpose = 'outer' | 'intent' | 'send';
type Limits = { maxWallSeconds: number; maxTurns: number };
type Handle = { closed: Promise<unknown> };
type Ticket = { purpose: Purpose; claim: InvestigationClaim; fact: ModelOuterConfinedFact;
  owner: OwnerState };
type OwnerState = { alive: boolean; deadline: number; claim: InvestigationClaim;
  limits: Limits; signal: AbortSignal | undefined; abort: () => void; timer: NodeJS.Timeout;
  fact?: ModelOuterConfinedFact;
  factIssued: boolean; outerVerified: boolean; intentIssued: boolean;
  intentVerified: boolean; sendIssued: boolean };

function originalBinding(claim: InvestigationClaim): boolean {
  const resource = claim?.wslResource; const gate = resource?.gate; const launch = gate?.launch;
  return !!resource && !!gate && !!launch && claim.phase === 'started' &&
    typeof claim.nativeRef === 'string' && claim.nativeRef.length > 0 && claim.nativeRef.length <= 256 &&
    claim.launchProtocol === 'resource_reservation_v1' && !claim.sourceView && !claim.windowsSource &&
    !claim.containerId && !claim.containerName && !claim.scratchRoot && !claim.dockerVolume &&
    !!claim.requestId && !!claim.workerId && !!claim.attemptId && !!claim.workspaceId &&
    Number.isSafeInteger(claim.workerEpoch) && claim.workerEpoch > 0 &&
    gate.protocol === 'attempt_gate_v1' && gate.payloadKind === 'claude_model_v1' &&
    launch.action === 'claude_model_v1' && !!launch.commandDigest &&
    launch.workerEpoch === claim.workerEpoch;
}

function exactFact(claim: InvestigationClaim, limits: Limits, fact: ModelOuterConfinedFact): boolean {
  if (!originalBinding(claim) || !validateCurrentClaudeModelOuterFact(fact) ||
    !isDeepStrictEqual(fact.expectation.limits, limits)) return false;
  const resource = claim.wslResource!; const gate = resource.gate!; const launch = gate.launch!;
  const descriptor = { attemptId: claim.attemptId, workspaceId: claim.workspaceId,
    distro: resource.distro, linuxUser: gate.linuxUser, uid: resource.uid,
    bootId: resource.bootId, unitName: resource.unitName,
    launchWorkerEpoch: launch.workerEpoch, sourceDigest: launch.sourceDigest,
    profileDigest: launch.profileDigest, commandDigest: launch.commandDigest };
  return isDeepStrictEqual(fact.observation.candidate.running.resource, resource) &&
    isDeepStrictEqual(fact.expectation.descriptor, descriptor);
}

/** Process-local original-owner bridge. Caller must invoke beginOwner before its first release;
 * this factory cannot independently establish prior native release history or current lease/grant. */
export function createClaudeModelOuterTickets() {
  const usedHandles = new WeakSet<Handle>();
  const issued = new Map<string, Ticket>();
  const closeOwner = (owner: OwnerState): void => {
    if (!owner.alive) return;
    owner.alive = false;
    clearTimeout(owner.timer);
    owner.signal?.removeEventListener('abort', owner.abort);
    for (const [receipt, ticket] of issued) if (ticket.owner === owner) issued.delete(receipt);
  };
  const live = (owner: OwnerState): boolean => {
    if (!owner.alive) return false;
    if (owner.signal?.aborted || performance.now() >= owner.deadline) {
      closeOwner(owner); return false;
    }
    return true;
  };
  const matching = (claim: InvestigationClaim, fact: ModelOuterConfinedFact,
    ticket: Ticket, purpose: Purpose): boolean =>
    ticket.purpose === purpose && live(ticket.owner) &&
    isDeepStrictEqual(ticket.claim, claim) && isDeepStrictEqual(ticket.fact, fact) &&
    isDeepStrictEqual(ticket.owner.claim, claim) &&
    exactFact(claim, ticket.owner.limits, fact);
  return {
    beginOwner(claim: InvestigationClaim, handle: Handle, startedAt: Date,
      limits: Limits, signal?: AbortSignal) {
      const now = Date.now();
      const started = startedAt instanceof Date ? startedAt.getTime() : NaN;
      const wall = limits?.maxWallSeconds;
      if (!handle || typeof handle !== 'object' || !(handle.closed instanceof Promise) ||
        usedHandles.has(handle) || !originalBinding(claim) ||
        !Number.isFinite(started) || started > now ||
        !validClaudeModelLaunchLimits(limits) ||
        now - started >= wall * 1000 || signal?.aborted) throw new Error('NOT_AVAILABLE');
      const remaining = Math.min(5000, started + wall * 1000 - now);
      if (remaining <= 0) throw new Error('NOT_AVAILABLE');
      const deadline = performance.now() + remaining;
      const savedClaim = structuredClone(claim);
      const savedLimits = structuredClone(limits);
      usedHandles.add(handle);
      const owner: OwnerState = { alive: true, deadline, claim: savedClaim, limits: savedLimits,
        signal, abort: () => {}, timer: undefined as unknown as NodeJS.Timeout,
        factIssued: false, outerVerified: false, intentIssued: false,
        intentVerified: false, sendIssued: false };
      owner.abort = () => closeOwner(owner);
      owner.timer = setTimeout(owner.abort, remaining);
      owner.timer.unref();
      signal?.addEventListener('abort', owner.abort, { once: true });
      // A never-settling native promise must not retain the owner after expiry/close.
      const weakOwner = new WeakRef(owner);
      const closed = () => { weakOwner.deref()?.abort(); };
      void handle.closed.then(closed, closed);
      const issue = (purpose: Purpose, fact: ModelOuterConfinedFact): string => {
        if (!live(owner) || issued.size >= 128 ||
          (owner.fact && !isDeepStrictEqual(owner.fact, fact)) ||
          !exactFact(owner.claim, owner.limits, fact)) throw new Error('NOT_AVAILABLE');
        const ticket: Ticket = {purpose, claim: structuredClone(owner.claim),
          fact: structuredClone(fact), owner};
        if (!live(owner)) throw new Error('NOT_AVAILABLE');
        const receipt = randomUUID();
        issued.set(receipt, ticket);
        return receipt;
      };
      return {
        get deadline() { return deadline; },
        issueFact(fact: ModelOuterConfinedFact): string {
          if (owner.factIssued) throw new Error('NOT_AVAILABLE');
          const receipt = issue('outer', fact);
          owner.fact = structuredClone(fact);
          owner.factIssued = true;
          return receipt;
        },
        issuePrompt(fact: ModelOuterConfinedFact, purpose: 'intent' | 'send'): string {
          if (purpose === 'intent' ? !owner.outerVerified || owner.intentIssued :
            purpose === 'send' ? !owner.intentVerified || owner.sendIssued : true)
            throw new Error('NOT_AVAILABLE');
          const receipt = issue(purpose, fact);
          if (purpose === 'intent') owner.intentIssued = true;
          else owner.sendIssued = true;
          return receipt;
        },
        close(): void { closeOwner(owner); },
      };
    },
    verifyOuter(claim: InvestigationClaim, resource: WslResource,
      fact: ModelOuterConfinedFact, receipt: string): boolean {
      const ticket = issued.get(receipt);
      if (!ticket || !matching(claim, fact, ticket, 'outer') ||
        !isDeepStrictEqual(claim.wslResource, resource) || !live(ticket.owner)) return false;
      issued.delete(receipt);
      ticket.owner.outerVerified = true;
      return true;
    },
    verifyPromptWindow(claim: InvestigationClaim, fact: ModelOuterConfinedFact,
      receipt: string, purpose: 'intent' | 'send'): boolean {
      const ticket = issued.get(receipt);
      if (!ticket || !matching(claim, fact, ticket, purpose) ||
        (purpose === 'intent' ? !ticket.owner.outerVerified : !ticket.owner.intentVerified) ||
        !live(ticket.owner))
        return false;
      issued.delete(receipt);
      if (purpose === 'intent') ticket.owner.intentVerified = true;
      return true;
    },
    revoke(receipt: string): void { issued.delete(receipt); },
  };
}
