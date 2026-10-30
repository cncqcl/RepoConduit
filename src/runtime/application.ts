import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ArtifactApplication } from '../application/artifacts.js';
import { HostBrowserCollector } from '../adapters/chatgpt/browser-collector.js';
import type { HostActionTransport } from '../adapters/chatgpt/host-conversation.js';
import type { HostConversationSqlite } from '../adapters/storage/host-conversation-sqlite.js';
import type { BrowserCaptureSqlite } from '../adapters/storage/browser-capture-sqlite.js';
import { DispatchService } from '../application/dispatch.js';
import { RepositoryApplication } from '../application/repository.js';
import { ContextDecisionApplication } from '../application/context-decisions.js';
import { BindingApplication, type ConversationBindingAdapter } from '../application/bindings.js';
import { ConversationApplication } from '../application/conversation.js';
import type { ConversationPort } from '../application/session-control.js';
import { InvestigationApplication, type InvestigationDependencies } from '../application/investigations.js';
import { ArtifactObjects } from '../adapters/storage/objects.js';
import { ContextDecisionSqlite } from '../adapters/storage/context-decisions-sqlite.js';
import { SqliteStore } from '../adapters/storage/sqlite.js';
import { RepositorySnapshot } from '../adapters/repository/snapshots.js';
import { SessionControlSqlite } from '../adapters/storage/session-control-sqlite.js';
import { SqliteInvestigationStore } from '../adapters/storage/investigation-sqlite.js';
import { authorize } from '../core/policy/authorize.js';
import { BundleLocks } from './bundle-locks.js';
import { assertPrivateDataDirectory } from './local-security.js';
import { startInvestigationRecovery } from './investigation-recovery.js';
import { createFixedCanaryTerminationTickets } from './fixed-canary-termination-tickets.js';
import { createSupervisorV2TerminationTickets } from './supervisor-v2-termination-tickets.js';
import { createClaudeModelPreventionTickets } from './claude-model-prevention-tickets.js';
import { createClaudeModelRunningTickets } from './claude-model-running-tickets.js';
import { createClaudeModelOuterTickets } from './claude-model-outer-tickets.js';
import { createClaudeModelTreeTickets } from './claude-model-tree-tickets.js';
import { createClaudeModelOriginalCompletionTickets } from './claude-model-tree-tickets.js';
import { runClaudeModelInvestigation, preflightClaudeModelInvestigationPrompt,
  type ClaudeModelInvestigationInput, type ClaudeModelInvestigationPorts } from './claude-model-investigation.js';
import type { InvestigationRecord } from '../core/investigation/request.js';
import { createDockerVolumeCleanupTickets } from './docker-volume-cleanup-tickets.js';
import { createWindowsOriginalOwnerFactory } from '../adapters/codex/investigator/windows-original-owner.js';
import { acquireInstallationRuntime, assertActiveInstallation, retainInstallationRuntime, type InstallationRuntime } from './installation.js';
import { createInvestigationScheduler, type InvestigationSchedulerDependencies } from './investigation-scheduler.js';
import {createPersonalCodexInvestigator,type PersonalCodexInvestigatorConfiguration,
 type PersonalCodexDiagnostic} from './codex-owned-investigation.js';
import {createCodexInvestigationQueue} from './codex-investigation-queue.js';
import {createPersonalClaudeInvestigator,type PersonalClaudeConfiguration,
 type PersonalClaudeDiagnostic} from './claude-personal-investigation.js';

/** Internal composition dependency, never obtained from transport payload or a verified:true config. */
type InvestigationRuntimeAuthority = InvestigationSchedulerDependencies['authority'] & {
  selectProfile: InvestigationDependencies['selectProfile'];
  verifyIsolation(evidence: string, record: InvestigationRecord, revision: string): boolean;
};
type ApplicationOptions = { conversation?: ConversationBindingAdapter; conversationPort?: ConversationPort;
  investigator?: InvestigationRuntimeAuthority;
  /** Trusted local composition only; neither MCP nor CLI request payloads carry native connections. */
  codexInvestigator?:PersonalCodexInvestigatorConfiguration;
  /** Installation-owned resolver; request payloads never choose a runtime or profile. */
  selectCodexInvestigator?:(workspaceId:string)=>PersonalCodexInvestigatorConfiguration|null;
  claudeInvestigator?:PersonalClaudeConfiguration;
  onClaudeDiagnostic?:(diagnostic:PersonalClaudeDiagnostic)=>void;
  /** Explicit trusted host admission; never part of a request or native runtime configuration. */
  codexManaged?:boolean;
  /** Local diagnostic sink; never wired from external request payloads. */
  onCodexDiagnostic?:(diagnostic:PersonalCodexDiagnostic)=>void;
  browserDownload?: { store: BrowserCaptureSqlite; accounts: HostConversationSqlite;
    transport: HostActionTransport; root: string } };
type ModelRunInput = Omit<ClaudeModelInvestigationInput,
  'store' | 'completionTickets' | 'getSnapshot' | 'contextRevision' | 'dispatcher' |
  'runningTickets' | 'outerTickets'>;
type ApplicationHandle = { dispatch: DispatchService; ready: Promise<void>;
  runCodexInvestigation(requestId:string):Promise<InvestigationRecord|null>;
  runClaudeInvestigation(requestId:string):Promise<InvestigationRecord|null>;
  preflightModelInvestigation(requestId: string): Promise<{actualBytes:number;maxBytes:16384}>;
  runModelInvestigation(input: ModelRunInput,
    ports?: ClaudeModelInvestigationPorts): Promise<InvestigationRecord | null>;
  close(): Promise<void> | void };

/** The production composition root. Transport adapters receive dispatch only. */
export function openApplication(dataDirectory: string,
  options: ApplicationOptions = {}): ApplicationHandle {
  const runtime = acquireInstallationRuntime(dataDirectory);
  let application: ApplicationHandle;
  try { application = openApplicationWithinInstallation(runtime, options); }
  catch (error) {
    if (error instanceof AggregateError) retainInstallationRuntime(runtime);
    else {
      try { runtime.release(); }
      catch (releaseError) { retainInstallationRuntime(runtime);
        throw new AggregateError([error, releaseError], 'Application startup cleanup unconfirmed', { cause: releaseError }); }
    }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return { dispatch: application.dispatch, ready: application.ready,
    runCodexInvestigation:application.runCodexInvestigation,
    runClaudeInvestigation:application.runClaudeInvestigation,
    preflightModelInvestigation: application.preflightModelInvestigation,
    runModelInvestigation: application.runModelInvestigation,
    close: () => {
    if (closing) return closing;
    try {
      const pending = application.close();
      if (pending) {
        closing = pending.then(() => { runtime.release(); }).catch(error => {
          retainInstallationRuntime(runtime);
          throw error;
        });
        return closing;
      }
      runtime.release();
    } catch (error) { retainInstallationRuntime(runtime); throw error; }
  } };
}

/** Borrow the outer service/CLI owner's gate; only that owner releases it. */
export function openApplicationWithinInstallation(runtime: InstallationRuntime,
  options: ApplicationOptions = {}): ApplicationHandle {
  assertActiveInstallation(runtime);
  const dataDirectory = runtime.dataDirectory;
  if (!dataDirectory || !isAbsolute(dataDirectory)) throw new TypeError('Absolute data directory required');
  const root = resolve(dataDirectory);
  if((options.codexManaged!==undefined&&typeof options.codexManaged!=='boolean')||
    (options.selectCodexInvestigator!==undefined&&typeof options.selectCodexInvestigator!=='function')||
    (options.codexInvestigator&&options.selectCodexInvestigator)||
    (options.selectCodexInvestigator&&options.claudeInvestigator)||
    (options.codexManaged===true&&!options.codexInvestigator&&!options.selectCodexInvestigator))throw new Error('NOT_AVAILABLE');
  const investigator = options.investigator ?? {
    prepareForRequest: () => null, selectProfile: () => null, verifyIsolation: () => false,
  };
  const codexScope=(record:Pick<InvestigationRecord,'workspaceId'|'profileRef'|'budgetRef'>)=>
    !!options.selectCodexInvestigator||!!options.codexInvestigator&&record.workspaceId===options.codexInvestigator.workspaceId&&
    record.profileRef===options.codexInvestigator.profileRevision&&
    record.budgetRef===options.codexInvestigator.profileRevision;
  type CodexOwner=ReturnType<typeof createPersonalCodexInvestigator>;
  const codexOwners=new Map<string,{configuration:string;owner:CodexOwner}>();
  const requestOwners=new Map<string,CodexOwner>();
  const ownerKey=(record:Pick<InvestigationRecord,'workspaceId'|'profileRef'>)=>JSON.stringify([record.workspaceId,record.profileRef]);
  const configurationKey=(configuration:PersonalCodexInvestigatorConfiguration)=>JSON.stringify({
    workspaceId:configuration.workspaceId,profileRevision:configuration.profileRevision,
    ...(configuration.runtimeSource?{runtimeSource:{dataDirectory:configuration.runtimeSource.dataDirectory,
      workspaceId:configuration.runtimeSource.workspaceId,profileRevision:configuration.runtimeSource.profileRevision}}:{})});
  const selectCodex=(record:Pick<InvestigationRecord,'workspaceId'|'profileRef'|'budgetRef'>):CodexOwner|undefined=>{
    const selected=options.selectCodexInvestigator?.(record.workspaceId)??
      (options.selectCodexInvestigator?null:options.codexInvestigator);
    if(!selected||selected.workspaceId!==record.workspaceId||selected.profileRevision!==record.profileRef||
      selected.profileRevision!==record.budgetRef)return undefined;
    const key=ownerKey(record),fingerprint=configurationKey(selected),existing=codexOwners.get(key);
    // A profile cannot silently acquire a different logged-in source. In-flight
    // proofs always remain owned by the instance which started the request.
    if(existing){if(existing.configuration!==fingerprint)throw new Error('NOT_AVAILABLE');return existing.owner;}
    const owner=createPersonalCodexInvestigator(root,selected,options.onCodexDiagnostic);
    codexOwners.set(key,{configuration:fingerprint,owner});return owner;
  };
  if(options.codexInvestigator)selectCodex({workspaceId:options.codexInvestigator.workspaceId,
    profileRef:options.codexInvestigator.profileRevision,budgetRef:options.codexInvestigator.profileRevision});
  if(options.claudeInvestigator?.workspaceId===options.codexInvestigator?.workspaceId&&options.claudeInvestigator)
    throw new Error('NOT_AVAILABLE');
  const claude=options.claudeInvestigator?createPersonalClaudeInvestigator(root,options.claudeInvestigator,
    options.onClaudeDiagnostic):undefined;
  assertPrivateDataDirectory(root);
  const store = new SqliteStore(join(root, 'state.sqlite'));
  let contextStore: ContextDecisionSqlite | undefined;
  let sessionStore: SessionControlSqlite | undefined;
  let investigationStore: SqliteInvestigationStore | undefined;
  try {
    contextStore = new ContextDecisionSqlite(join(root, 'state.sqlite'));
    sessionStore = new SessionControlSqlite(join(root, 'state.sqlite'));
    const canaryTickets = createFixedCanaryTerminationTickets();
    const supervisorV2Tickets = createSupervisorV2TerminationTickets();
    const modelPreventionTickets = createClaudeModelPreventionTickets();
    const modelRunningTickets = createClaudeModelRunningTickets();
    const modelOuterTickets = createClaudeModelOuterTickets();
    const modelTreeTickets = createClaudeModelTreeTickets();
    const modelOriginalTickets = createClaudeModelOriginalCompletionTickets();
    const dockerVolumeTickets = createDockerVolumeCleanupTickets();
    const windowsOriginalOwners = createWindowsOriginalOwnerFactory();
    investigationStore = new SqliteInvestigationStore(join(root, 'state.sqlite'), {
      verifyIsolation: (evidence, record, revisionId) => {
        const revision = store.getProfileRevision(record.workspaceId, revisionId);
        return !!revision && revision.id === record.profileRef && revision.id === record.budgetRef &&
          isDeepStrictEqual(record.budget, revision.budget) &&
          (codexOwners.get(ownerKey(record))?.owner.verifyIsolation(evidence,structuredClone(record),revisionId)===true||
           claude?.verifyIsolation(evidence,structuredClone(record),revisionId)===true||
           investigator.verifyIsolation(evidence, structuredClone(record), revisionId));
      },
      verifyNativeReceipt: (claim,nativeRef,receipt)=>modelRunningTickets.verifyNativeStart(claim,nativeRef,receipt)||
        claude?.verifyNativeReceipt(claim,nativeRef,receipt)===true,
      verifyModelRunningReceipt: modelRunningTickets.verifyRunning,
      verifyModelRunningObservationReceipt: modelRunningTickets.verifyRunningObservation,
      verifyModelOuterReceipt: modelOuterTickets.verifyOuter,
      verifyModelPromptWindowReceipt: modelOuterTickets.verifyPromptWindow,
      verifyOutcomeReceipt: (claim,result,nativeRef,receipt)=>claude?.verifyOutcomeReceipt(claim,result,nativeRef,receipt)===true,
      ...((options.codexInvestigator||options.selectCodexInvestigator)?{
        verifyCodexSessionClosure:(claim,closure)=>requestOwners.get(claim.requestId)?.verifyClosure(claim,closure)===true}:{}),
      verifyWslTerminationReceipt: canaryTickets.verify,
      verifySupervisorV2TerminalReceipt: supervisorV2Tickets.verify,
      verifyClaudeModelPreventionReceipt: modelPreventionTickets.verify,
      verifyClaudeModelTreeReceipt: modelTreeTickets.verify,
      verifyClaudeModelOriginalTreeReceipt: modelOriginalTickets.verifyTree,
      verifyClaudeModelOriginalOutcomeReceipt: modelOriginalTickets.verifyOutcome,
      verifyDockerVolumeCleanupReceipt: dockerVolumeTickets.verify,
      verifyWindowsLaunchNotStarted: windowsOriginalOwners.verifyNotStarted,
    });
    const contextDb = contextStore;
    const sessionDb = sessionStore;
    const investigationDb = investigationStore;
    const contextDecision = new ContextDecisionApplication(contextDb,
      (context) => store.grantsFor(context.principal, context.audience), () => new Date(), {
        sign: (body) => store.signBundleCursor(`decision.list\n${body}`),
        verify: (body, signature) => store.verifyBundleCursor(`decision.list\n${body}`, signature),
      });
    const objects = new ArtifactObjects(join(root, 'artifact-objects'));
    const locks = new BundleLocks();
    const currentPermit = async (request: { context: Parameters<typeof authorize>[0]; operation: string; workspaceId: string; collaborationId: string }) => {
      await request.context.assertFreshAuthority?.();
      const current = { ...request.context, now: new Date() };
      return authorize(current, request.operation, { workspaceId: request.workspaceId,
        collaborationId: request.collaborationId }, store.grantsFor(current.principal, current.audience));
    };
    const repository = new RepositoryApplication({
      authorize: currentPermit,
      getWorkingCopy: (workspaceId, workingCopyId) => store.getWorkingCopy(workspaceId, workingCopyId),
      collaborationBelongsToWorkspace: (workspaceId, collaborationId) => store.collaborationBelongsToWorkspace(workspaceId, collaborationId),
      lookupCapture: (input, key, principal, audience) => store.lookupCapture(input, key, principal, audience),
      saveSnapshot: (record, input, key, principal, audience) => store.saveSnapshot(record, input, key, principal, audience),
      getSnapshot: (id, workspaceId, collaborationId) => store.getSnapshot(id, workspaceId, collaborationId),
    });
    const artifact = new ArtifactApplication({ objects, authorize: currentPermit,
      ...(options.browserDownload ? { browserCollector: new HostBrowserCollector(
        options.browserDownload.store, options.browserDownload.accounts, options.browserDownload.transport,
        options.browserDownload.root, () => [runtime.installationDirectory, ...store.localSourceExclusionRoots()],
        (request, accountKey) => {
          const state = sessionDb.currentForScope(request.workspaceId, request.collaborationId);
          if (!state) return null;
          if (state.providerId !== 'chatgpt-host-web' || state.accountId !== accountKey ||
              state.nativeSessionId !== request.nativeSessionId || state.control !== 'host_controlled' ||
              state.sendIntent || state.pendingSyncReceipt) throw new Error('NOT_AVAILABLE');
          return createHash('sha256').update(JSON.stringify([state.bindingId, state.providerId,
            state.accountId, state.nativeSessionId, state.epoch, state.revision, state.cursor])).digest('hex');
        }) } : {}),
      exportRoot: join(root, 'exports'),
      forbiddenSourceRoots: () => [runtime.installationDirectory, ...store.localSourceExclusionRoots()],
      registeredRoots: () => store.localSourceExclusionRoots(),
      validateBundleReferences: (input) => store.validateBundleReferences(input),
      collaborationBelongsToWorkspace: (workspaceId, collaborationId) => store.collaborationBelongsToWorkspace(workspaceId, collaborationId),
      getBundle: (id) => store.getBundle(id), saveBundle: (record) => store.saveBundle(record),
      publishedBundleHighWater: (workspaceId, collaborationId) =>
        store.publishedBundleHighWater(workspaceId, collaborationId),
      signBundleCursor: (body) => store.signBundleCursor(body),
      verifyBundleCursor: (body, signature) => store.verifyBundleCursor(body, signature),
      listPublishedBundles: (workspaceId, collaborationId, afterSeq, highWater, limit) =>
        store.listPublishedBundles(workspaceId, collaborationId, afterSeq, highWater, limit),
      publishBundle: (manifest) => store.publishBundle(manifest),
      abortBundle: (id, state) => store.abortBundle(id, state),
      lookupIdempotent: (scope, payload) => store.lookupIdempotent(scope, payload),
      withBundleLock: (id, action) => locks.withBundleLock(id, action),
      runIdempotent: (scope, payload, mutation) => store.runIdempotent(scope, payload, mutation),
    });
    const binding = new BindingApplication(sessionDb, currentPermit, options.conversation);
    const conversation = new ConversationApplication(sessionDb, currentPermit, options.conversationPort);
    const investigation = new InvestigationApplication({
      authorize: currentPermit,
      resolveBinding: async (request) => {
        const workingCopy = await store.getWorkingCopy(request.workspaceId, request.workingCopyId);
        const revision = request.expected ? contextDb.getRevision(request.workspaceId,
          request.collaborationId, request.expected.contextRevisionId) :
          contextDb.getCurrentRevision(request.workspaceId, request.collaborationId);
        if (!workingCopy || !revision) return null;
        if (request.expected && revision.snapshotId !== request.expected.snapshotRef) return null;
        const snapshot = await store.getSnapshot(revision.snapshotId, request.workspaceId, request.collaborationId);
        if (!snapshot || snapshot.workingCopyId !== request.workingCopyId) return null;
        return { workspaceId: request.workspaceId, collaborationId: request.collaborationId,
          workingCopyId: request.workingCopyId, snapshotRef: revision.snapshotId,
          contextRevisionId: revision.id, recipient: request.context.recipient };
      },
      // Only a trusted owner can select an independently verified runtime. Persisted
      // configuration alone cannot enable submission or change the bound budget.
      selectProfile: async request => {
        const revision = store.getCurrentProfileRevision(request.workspaceId);
        if (!revision) return null;
        let selected:Awaited<ReturnType<InvestigationDependencies['selectProfile']>>;
        if(options.selectCodexInvestigator||request.workspaceId===options.codexInvestigator?.workspaceId){
          if(options.codexManaged&&codexQueue?.failed)return null;
          try{const record={workspaceId:request.workspaceId,profileRef:revision.id,budgetRef:revision.id};
            const codex=selectCodex(record);if(!codex)return null;codex.load(record);
            selected={profileRef:revision.id,budgetRef:revision.id,budget:revision.budget,isolationVerified:true};}
          catch{return null;}
        }else if(claude&&request.workspaceId===options.claudeInvestigator?.workspaceId){
          selected=claude.matches({workspaceId:request.workspaceId,profileRef:revision.id,budgetRef:revision.id})?
            {profileRef:revision.id,budgetRef:revision.id,budget:revision.budget,isolationVerified:true}:null;
        }else selected=await investigator.selectProfile(request);
        if (!selected || selected.profileRef !== revision.id || selected.budgetRef !== revision.id ||
          !isDeepStrictEqual(selected.budget, revision.budget) ||
          store.getCurrentProfileRevision(request.workspaceId)?.id !== revision.id) return null;
        return selected;
      },
      enqueue: (record, key, fingerprint) => investigationDb.enqueue(record, key, fingerprint),
      get: (id) => investigationDb.get(id),
      requestCancel: (record, key, grantId) => investigationDb.requestCancel(record, key, grantId),
    });
    // Reconcile persisted attempts before starting background queue admission.
    const recovery = startInvestigationRecovery(investigationDb, canaryTickets,
      supervisorV2Tickets, dockerVolumeTickets, modelPreventionTickets, modelTreeTickets);
    const dispatch = new DispatchService(store, undefined, undefined,
      { repository, artifact, contextDecision, binding, conversation, investigation }, runtime.installationDirectory);
    let closing: Promise<void> | undefined;
    let closed = false;
    let closeFailure: unknown;
    const modelRuns = new Set<Promise<InvestigationRecord | null>>();
    const codexRuns=new Map<string,Promise<InvestigationRecord|null>>();
    const claudeRuns=new Map<string,Promise<InvestigationRecord|null>>();
    const codexAbort=new AbortController();
    let codexQueue:ReturnType<typeof createCodexInvestigationQueue>|undefined;
    const closeStores = () => {
      const errors: unknown[] = [];
      for (const db of [investigationDb, sessionDb, contextDb, store]) {
        try { db.close(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Application store close failed');
    };
    const application: ApplicationHandle = { dispatch,
    ready: recovery.ready,
    runClaudeInvestigation:(requestId)=>{
      if(closed||closing||!claude)throw new Error('NOT_AVAILABLE');
      const pending=claudeRuns.get(requestId);if(pending)return pending;
      const run=(async()=>{
        await recovery.ready;
        if(closed||closing||codexAbort.signal.aborted)throw new Error('NOT_AVAILABLE');
        const record=investigationDb.get(requestId);
        if(!record||!claude.matches(record))throw new Error('NOT_AVAILABLE');
        if(record.state!=='queued'||record.attempts.length)return record;
        const revision=contextDb.getRevision(record.workspaceId,record.collaborationId,record.contextRevisionId);
        const saved=await store.getSnapshot(record.snapshotRef,record.workspaceId,record.collaborationId);
        if(!revision||revision.snapshotId!==record.snapshotRef||!saved||saved.workingCopyId!==record.workingCopyId)
          throw new Error('NOT_AVAILABLE');
        return claude.run({store:investigationDb,grants:store,dispatcher:dispatch,record,contextRevision:revision,
          snapshot:RepositorySnapshot.fromPersisted(saved.snapshot),signal:codexAbort.signal});
      })();
      claudeRuns.set(requestId,run);modelRuns.add(run);
      void run.finally(()=>{claudeRuns.delete(requestId);modelRuns.delete(run);}).catch(()=>undefined);
      return run;
    },
    runCodexInvestigation:(requestId)=>{
      if(closed||closing||!options.codexInvestigator&&!options.selectCodexInvestigator)throw new Error('NOT_AVAILABLE');
      const pending=codexRuns.get(requestId);if(pending)return pending;
      const run=(async()=>{
        await recovery.ready;
        if(closed||closing||codexAbort.signal.aborted)throw new Error('NOT_AVAILABLE');
        const record=investigationDb.get(requestId);
        if(!record)throw new Error('NOT_AVAILABLE');
        if(!codexScope(record))throw new Error('NOT_AVAILABLE');
        if(record.state!=='queued'||record.attempts.length)return record;
        const codex=selectCodex(record);if(!codex)throw new Error('NOT_AVAILABLE');
        const revision=contextDb.getRevision(record.workspaceId,record.collaborationId,record.contextRevisionId);
        const saved=await store.getSnapshot(record.snapshotRef,record.workspaceId,record.collaborationId);
        if(!revision||revision.snapshotId!==record.snapshotRef||!saved||saved.workingCopyId!==record.workingCopyId)
          throw new Error('NOT_AVAILABLE');
        if(closed||closing||codexAbort.signal.aborted)throw new Error('NOT_AVAILABLE');
        // Snapshot lookup yields: a peer may already hold the claim before synchronous admission.
        const current=investigationDb.get(requestId);
        if(!current)throw new Error('NOT_AVAILABLE');
        if(current.state!=='queued'||current.attempts.length)return current;
        if(selectCodex(current)!==codex||store.getCurrentProfileRevision(current.workspaceId)?.id!==current.profileRef)
          throw new Error('NOT_AVAILABLE');
        requestOwners.set(current.id,codex);
        try{return await codex.run({store:investigationDb,grants:store,dispatcher:dispatch,record:current,contextRevision:revision,
          snapshot:RepositorySnapshot.fromPersisted(saved.snapshot),signal:codexAbort.signal});}
        finally{requestOwners.delete(current.id);}
      })();
      codexRuns.set(requestId,run);modelRuns.add(run);
      void run.finally(()=>{codexRuns.delete(requestId);modelRuns.delete(run);}).catch(()=>undefined);
      return run;
    },
    preflightModelInvestigation: async (requestId) => {
      if (closed || closing) throw new Error('NOT_AVAILABLE');
      const record = investigationDb.get(requestId);
      const contextRevision = record && contextDb.getRevision(record.workspaceId,
        record.collaborationId, record.contextRevisionId);
      if (!record || !contextRevision) throw new Error('NOT_AVAILABLE');
      const saved=await store.getSnapshot(record.snapshotRef,record.workspaceId,
        record.collaborationId);
      if (!saved || saved.workingCopyId!==record.workingCopyId) throw new Error('NOT_AVAILABLE');
      return preflightClaudeModelInvestigationPrompt(record, contextRevision,
        RepositorySnapshot.fromPersisted(saved.snapshot));
    },
    runModelInvestigation: (input, ports) => {
      if (closed || closing) throw new Error('NOT_AVAILABLE');
      const record = investigationDb.get(input.claim.requestId);
      const contextRevision = record && contextDb.getRevision(record.workspaceId,
        record.collaborationId, record.contextRevisionId);
      if (!record || !contextRevision) throw new Error('NOT_AVAILABLE');
      const run = runClaudeModelInvestigation({...input,store:investigationDb,dispatcher:dispatch,
        runningTickets:modelRunningTickets,outerTickets:modelOuterTickets,
        contextRevision,completionTickets:modelOriginalTickets,
        getSnapshot:(id,ws,col)=>store.getSnapshot(id,ws,col)},ports);
      modelRuns.add(run);
      void run.finally(() => modelRuns.delete(run)).catch(() => undefined);
      return run;
    },
    close: () => {
      if (closing) return closing;
      if (closed) { if (closeFailure) throw closeFailure; return; }
      // Close admission synchronously, before any asynchronous shutdown work.
      scheduler.stopAdmission();
      codexQueue?.stopAdmission();
      codexAbort.abort();
      clearInterval(schedulerTimer);
      dispatch.stopAccepting();
      const pendingDispatch = dispatch.hasInFlightRequests ? dispatch.drain() : undefined;
      const pendingRecovery = recovery.close();
      const pendingModels = modelRuns.size ? Promise.allSettled([...modelRuns]) : undefined;
      const shutdownErrors: unknown[] = [];
      let pendingScheduler: Promise<void> | undefined;
      try { pendingScheduler = scheduler.close(); }
      catch (error) { shutdownErrors.push(error); }
      let pendingCodexQueue:Promise<void>|undefined;
      try { pendingCodexQueue=codexQueue?.close(); }
      catch(error){shutdownErrors.push(error);}
      if (!pendingDispatch && !pendingRecovery && !pendingModels && !pendingScheduler && !pendingCodexQueue) {
        closed = true;
        try { closeStores(); } catch (error) { shutdownErrors.push(error); }
        if (shutdownErrors.length) {
          closeFailure = new AggregateError(shutdownErrors, 'Application shutdown failed');
          throw closeFailure;
        }
        return;
      }
      closing = Promise.allSettled([pendingDispatch, pendingRecovery, pendingModels, pendingScheduler,
        pendingCodexQueue]).then(results => {
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason as unknown);
        errors.push(...shutdownErrors);
        try { closeStores(); } catch (error) { errors.push(error); }
        closed = true;
        if (errors.length) {
          closeFailure = new AggregateError(errors, 'Application shutdown failed');
          throw closeFailure;
        }
      });
      return closing;
    } };
    const scheduler = createInvestigationScheduler({ store: investigationDb, grants: store,
      authority:{prepareForRequest:(record,signal)=>codexScope(record)||claude?.matches(record)?null:
        investigator.prepareForRequest(record,signal)},
      preflightPrompt: requestId => application.preflightModelInvestigation(requestId),
      getSourceDigest: async record => {
        const saved = await store.getSnapshot(record.snapshotRef, record.workspaceId, record.collaborationId);
        if (!saved || saved.workingCopyId !== record.workingCopyId ||
          saved.workspaceId !== record.workspaceId || saved.collaborationId !== record.collaborationId) {
          throw new Error('NOT_AVAILABLE');
        }
        const snapshot = RepositorySnapshot.fromPersisted(saved.snapshot);
        if (snapshot.id !== record.snapshotRef || snapshot.workingCopyId !== record.workingCopyId) {
          throw new Error('NOT_AVAILABLE');
        }
        return createHash('sha256').update(JSON.stringify(saved.snapshot)).digest('hex');
      },
      runModelInvestigation: input => application.runModelInvestigation(input),
    });
    if(options.codexManaged&&(options.codexInvestigator||options.selectCodexInvestigator)){
      codexQueue=createCodexInvestigationQueue({...(options.selectCodexInvestigator?{
        matches:(record:InvestigationRecord)=>{try{
          if(store.getCurrentProfileRevision(record.workspaceId)?.id!==record.profileRef)return false;
          const codex=selectCodex(record);if(!codex)return false;codex.load(record);return true;
        }catch{return false;}}
      }:{selection:options.codexInvestigator!}),
        listPending:()=>investigationDb.listPending(),get:id=>investigationDb.get(id),
        run:id=>application.runCodexInvestigation(id)});
    }
    // Server readiness must not wait for an investigator/model; the queue advances independently.
    application.ready = recovery.ready;
    let startupReady = false;
    const schedule = () => {
      if (!startupReady || closed || closing) return;
      void scheduler.tick().catch(() => undefined);
      if(codexQueue&&!codexQueue.failed)void codexQueue.tick().catch(()=>{
        try{
          if(options.onCodexDiagnostic)options.onCodexDiagnostic({requestId:'managed_queue',
            failure:{stage:'admission',code:'INTERNAL_ERROR'}});
          else process.stderr.write('CODEX_MANAGED_ADMISSION_FAILED\n');
        }catch{/* Close retains the original queue failure. */}
      });
    };
    void application.ready.then(() => { startupReady = true; schedule(); }).catch(() => undefined);
    const schedulerTimer = setInterval(() => {
      schedule();
    }, 10_000);
    schedulerTimer.unref();
    return application;
  } catch (error) {
    const failures: unknown[] = [];
    for (const db of [investigationStore, sessionStore, contextStore, store]) {
      try { db?.close(); } catch (closeError) { failures.push(closeError); }
    }
    if (failures.length) throw new AggregateError([error, ...failures],
      'Application startup cleanup unconfirmed', { cause: error });
    throw error;
  }
}
