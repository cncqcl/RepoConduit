import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { BrowserArtifactCollector } from '../../application/artifacts.js';
import { BundleLocks } from '../../runtime/bundle-locks.js';
import type { BrowserCaptureSqlite, BrowserCaptureInput, BrowserCaptureRecord, BrowserRetryContext } from '../storage/browser-capture-sqlite.js';
import type { HostConversationSqlite } from '../storage/host-conversation-sqlite.js';
import { captureBrowserDownloadDelta, establishBrowserDownloadBaseline } from '../transfers/browser-download.js';
import { parseChatgptDownloadObservation } from './host-download.js';
import type { HostActionTransport } from './host-conversation.js';

type CaptureRequest = Parameters<BrowserArtifactCollector['capture']>[0];
type AccountStore = Pick<HostConversationSqlite, 'accountKey'>;
type BindingFingerprint = (request: CaptureRequest, accountKey: string) => string | null;
function reconcile(): never { throw new Error('BROWSER_CAPTURE_RECONCILE_REQUIRED'); }
function conflict(): never { throw new Error('CONFLICT'); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Fixed foreground-host download actions. Only a download object from the same host action proves completion.
 * Private durable intents never authorize another click after an uncertain commit. */
export class HostBrowserCollector implements BrowserArtifactCollector {
  private readonly roots = new BundleLocks();
  constructor(private readonly store: BrowserCaptureSqlite, private readonly accounts: AccountStore,
    private readonly transport: HostActionTransport, private readonly downloadRoot: string,
    private readonly forbiddenRoots: () => readonly string[], private readonly bindingFingerprint: BindingFingerprint) {}

  capture(request: CaptureRequest): Promise<{ bytes: Buffer; sha256: string; sourceIdentity: string }> {
    return this.roots.withBundleLock(this.downloadRoot, () => this.captureWithinRoot(request));
  }
  assertCaptureWritable(id: string): void { this.store.assertCaptureWritable(id); }
  assertRetryRecovery(id: string, predecessorId: string): void {
    const relation = this.store.getRetry(id);
    const capture = this.store.get(id);
    if (!relation || relation.predecessorId !== predecessorId || capture?.state !== 'verified_candidate') conflict();
  }

  private async captureWithinRoot(request: CaptureRequest): Promise<{ bytes: Buffer; sha256: string; sourceIdentity: string }> {
    if (request.reconcileOnlyCapture) return this.reconcileExisting(request);
    const prior = this.store.get(request.id);
    this.store.assertCaptureWritable(request.id);
    const savedRetry = this.store.getRetry(request.id);
    if ((savedRetry?.predecessorId ?? undefined) !== (prior ? request.retryOfCaptureId : undefined) ||
        (prior && request.retryOfCaptureId && !savedRetry)) conflict();
    if (request.retryOfCaptureId && request.retryOfCaptureId === request.id) conflict();
    const predecessor = request.retryOfCaptureId ? this.store.get(request.retryOfCaptureId) : null;
    if (request.retryOfCaptureId && (!predecessor || predecessor.state !== 'reconcile_required')) conflict();
    if (request.requireExistingCapture && (!prior || prior.state !== 'verified_candidate')) conflict();
    const target = { workspaceId: request.workspaceId, collaborationId: request.collaborationId,
      nativeSessionId: request.nativeSessionId, nativeMessageId: request.nativeMessageId, filename: request.filename,
      ...(request.attachmentIndex === undefined ? {} : { attachmentIndex: request.attachmentIndex }) };
    const retryAction = request.retryOfCaptureId ? { retryOfCaptureId: request.retryOfCaptureId } : {};
    const parseObserved = (raw: unknown): { observed: ReturnType<typeof parseChatgptDownloadObservation>; retryContext: BrowserRetryContext | null } => {
      if (!request.retryOfCaptureId) return { observed: parseChatgptDownloadObservation(raw, targetSelection()), retryContext: null };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          Object.keys(raw).sort().join(',') !== 'observation,retryContext') conflict();
      const envelope = raw as { observation: unknown; retryContext: unknown };
      const ctx = envelope.retryContext;
      if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx) ||
          Object.keys(ctx).sort().join(',') !== 'browserId,originalTabId,retryTabId') conflict();
      const context = ctx as BrowserRetryContext;
      if (![context.browserId, context.originalTabId, context.retryTabId]
        .every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) ||
          context.originalTabId === context.retryTabId) conflict();
      const relation = this.store.getRetry(request.id);
      if (relation && (relation.predecessorId !== request.retryOfCaptureId || relation.browserId !== context.browserId ||
          relation.originalTabId !== context.originalTabId || relation.retryTabId !== context.retryTabId)) conflict();
      return { observed: parseChatgptDownloadObservation(envelope.observation, targetSelection()), retryContext: context };
    };
    const observe = async () => {
      await request.assertAuthority();
      const raw = await this.transport.request({ kind: 'download', phase: 'observe', target, captureIntentId: request.id, ...retryAction });
      await request.assertAuthority();
      return parseObserved(raw);
    };
    const targetSelection = () => ({ nativeSessionId: request.nativeSessionId,
      nativeMessageId: request.nativeMessageId, filename: request.filename,
      ...(request.attachmentIndex === undefined ? {} : { attachmentIndex: request.attachmentIndex }) });
    const first = await observe();
    const observed = first.observed;
    const accountKey = this.accounts.accountKey('chatgpt-host-web', 'settings-account-email', observed.account);
    const bindingFingerprint = this.bindingFingerprint(request, accountKey);
    const rootKey = (root: string) => process.platform === 'win32' ? resolve(root).toLocaleLowerCase('en-US') : resolve(root);
    if (prior && rootKey(prior.input.baseline.root) !== rootKey(this.downloadRoot)) conflict();
    const input: BrowserCaptureInput = { id: request.id, workspaceId: request.workspaceId,
      collaborationId: request.collaborationId, bundleId: request.bundleId, path: request.path,
      principal: request.principal, audience: request.audience, recipient: request.recipient, grantId: request.grantId,
      accountKey, bindingFingerprint, ...targetSelection(), sourceFingerprint: observed.sourceFingerprint,
      expectedSha256: request.expectedSha256, expectedSize: request.expectedSize,
      baseline: prior?.input.baseline ?? establishBrowserDownloadBaseline(this.downloadRoot, request.filename, this.forbiddenRoots()) };
    if (prior && !isDeepStrictEqual(prior.input, input)) {
      const onlySourceChanged = prior.input.sourceFingerprint !== input.sourceFingerprint &&
        isDeepStrictEqual({ ...prior.input, sourceFingerprint: input.sourceFingerprint }, input);
      if (prior.state === 'prepared' && onlySourceChanged) {
        await request.assertAuthority();
        if (this.bindingFingerprint(request, accountKey) !== bindingFingerprint) conflict();
        this.store.abortPreparedForSourceChange(request.id, prior.input.sourceFingerprint, input.sourceFingerprint);
      }
      conflict();
    }
    let record = request.retryOfCaptureId ? this.store.prepareRetry(input, request.retryOfCaptureId, first.retryContext!) : this.store.prepare(input);
    const fresh = async () => {
      await request.assertAuthority();
      if (this.bindingFingerprint(request, accountKey) !== bindingFingerprint) conflict();
    };
    const verifyObserved = (current: ReturnType<typeof parseChatgptDownloadObservation>) => {
      if (current.account !== observed.account || current.sourceFingerprint !== observed.sourceFingerprint) conflict();
    };
    let completedPath: string | null = null;
    const verifyRetryContext = (raw: unknown) => {
      if (!request.retryOfCaptureId) return;
      const ctx = raw as BrowserRetryContext;
      const relation = this.store.getRetry(request.id);
      if (!relation || !ctx || typeof ctx !== 'object' || Array.isArray(ctx) ||
          Object.keys(ctx).sort().join(',') !== 'browserId,originalTabId,retryTabId' ||
          relation.browserId !== ctx.browserId || relation.originalTabId !== ctx.originalTabId ||
          relation.retryTabId !== ctx.retryTabId) reconcile();
    };
    const verifyCompletion = (result: unknown, requireClick: boolean) => {
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          Object.keys(result).sort().join(',') !== (requireClick ?
            request.retryOfCaptureId ? 'clicked,completion,observation,retryContext' : 'clicked,completion,observation' :
            request.retryOfCaptureId ? 'completion,observation,retryContext' : 'completion,observation')) reconcile();
      if (requireClick && (result as { clicked?: unknown }).clicked !== true) reconcile();
      verifyRetryContext((result as { retryContext?: unknown }).retryContext);
      verifyObserved(parseChatgptDownloadObservation((result as { observation: unknown }).observation, targetSelection()));
      const completion = (result as { completion: unknown }).completion;
      if (!completion || typeof completion !== 'object' || Array.isArray(completion) ||
          Object.keys(completion).sort().join(',') !== 'captureIntentId,kind,path') reconcile();
      const value = completion as { captureIntentId: unknown; kind: unknown; path: unknown };
      if (value.captureIntentId !== request.id || value.kind !== 'browser_download_completed' ||
          typeof value.path !== 'string' || !isAbsolute(value.path)) reconcile();
      completedPath = value.path;
    };
    if (record.state === 'prepared') {
      // Re-observe after the baseline and durable intent; a pre-commit delta cannot belong to this click.
      const currentResult = await observe();
      const current = currentResult.observed;
      if (current.account !== observed.account) conflict();
      if (current.sourceFingerprint !== observed.sourceFingerprint) {
        await fresh();
        this.store.abortPreparedForSourceChange(request.id, observed.sourceFingerprint, current.sourceFingerprint);
        conflict();
      }
      await fresh();
      if (captureBrowserDownloadDelta(record.input.baseline, this.forbiddenRoots()).state !== 'pending') conflict();
      record = this.store.transition(request.id, 'prepared', 'capturing');
      try {
        await fresh();
        const result = await this.transport.request({ kind: 'download', phase: 'commit', target,
          captureIntentId: request.id, sourceFingerprint: observed.sourceFingerprint,
          expectedAccount: observed.account, ...retryAction });
        await fresh();
        verifyCompletion(result, true);
      } catch {
        this.markUnknown(record);
        reconcile();
      }
    }
    try {
      await fresh();
      if (record.state === 'capturing' || record.state === 'reconcile_required') {
        if (completedPath === null) {
          const result = await this.transport.request({ kind: 'download', phase: 'reconcile', target, captureIntentId: request.id, ...retryAction });
          await fresh();
          verifyCompletion(result, false);
        }
      }
      const candidate = captureBrowserDownloadDelta(record.input.baseline, this.forbiddenRoots());
      if (candidate.state !== 'candidate' || candidate.bytes.length !== request.expectedSize ||
          candidate.sha256 !== request.expectedSha256) reconcile();
      // Neither stable metadata nor caller-supplied expected bytes authenticates the original browser action.
      if (record.state === 'verified_candidate' && record.candidateFingerprint !== candidate.candidateFingerprint) reconcile();
      if (record.state !== 'verified_candidate') {
        if (completedPath === null || hash(rootKey(realpathSync(completedPath))) !== candidate.identity) reconcile();
        if (record.state !== 'capturing' && record.state !== 'reconcile_required') reconcile();
        record = this.store.transition(request.id, record.state, 'verified_candidate', candidate.candidateFingerprint);
      }
      await fresh();
      return { bytes: candidate.bytes, sha256: candidate.sha256,
        sourceIdentity: hash(JSON.stringify([request.id, accountKey, observed.sourceFingerprint,
          bindingFingerprint, candidate.candidateFingerprint, 'browser_download', 'host_download_object'])) };
    } catch {
      this.markUnknown(record);
      reconcile();
    }
  }

  private async reconcileExisting(request: CaptureRequest): Promise<{ bytes: Buffer; sha256: string; sourceIdentity: string }> {
    if (request.retryOfCaptureId) conflict();
    const record = this.store.get(request.id);
    this.store.assertCaptureWritable(request.id);
    if (!record || (record.state !== 'reconcile_required' && record.state !== 'verified_candidate')) conflict();
    if (request.requireExistingCapture && record.state !== 'verified_candidate') conflict();
    const saved = record.input;
    const retry = this.store.getRetry(request.id);
    const normalizeRoot = (root: string) => process.platform === 'win32' ? resolve(root).toLocaleLowerCase('en-US') : resolve(root);
    if (saved.workspaceId !== request.workspaceId || saved.collaborationId !== request.collaborationId ||
        saved.bundleId !== request.bundleId || saved.path !== request.path ||
        saved.principal !== request.principal || saved.audience !== request.audience ||
        saved.recipient !== request.recipient || saved.nativeSessionId !== request.nativeSessionId ||
        saved.nativeMessageId !== request.nativeMessageId || saved.filename !== request.filename ||
        saved.attachmentIndex !== request.attachmentIndex ||
        saved.expectedSha256 !== request.expectedSha256 || saved.expectedSize !== request.expectedSize ||
        normalizeRoot(saved.baseline.root) !== normalizeRoot(this.downloadRoot)) conflict();
    const target = { workspaceId: request.workspaceId, collaborationId: request.collaborationId,
      nativeSessionId: request.nativeSessionId, nativeMessageId: request.nativeMessageId, filename: request.filename,
      ...(request.attachmentIndex === undefined ? {} : { attachmentIndex: request.attachmentIndex }) };
    const selection = { nativeSessionId: request.nativeSessionId, nativeMessageId: request.nativeMessageId,
      filename: request.filename,
      ...(request.attachmentIndex === undefined ? {} : { attachmentIndex: request.attachmentIndex }) };
    const retryAction = retry ? { retryOfCaptureId: retry.predecessorId } : {};
    const verifyContext = (value: unknown) => {
      if (!retry) return;
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).sort().join(',') !== 'browserId,originalTabId,retryTabId') conflict();
      const context = value as BrowserRetryContext;
      if (context.browserId !== retry.browserId || context.originalTabId !== retry.originalTabId ||
          context.retryTabId !== retry.retryTabId) conflict();
    };
    const parseObserved = (raw: unknown) => {
      if (!retry) return parseChatgptDownloadObservation(raw, selection);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          Object.keys(raw).sort().join(',') !== 'observation,retryContext') conflict();
      const envelope = raw as { observation: unknown; retryContext: unknown };
      verifyContext(envelope.retryContext);
      return parseChatgptDownloadObservation(envelope.observation, selection);
    };
    const fresh = async () => {
      await request.assertAuthority();
      if (this.bindingFingerprint(request, saved.accountKey) !== saved.bindingFingerprint) conflict();
      this.store.assertCaptureWritable(request.id);
    };
    await fresh();
    const observedRaw = await this.transport.request({ kind: 'download', phase: 'observe', target,
      captureIntentId: request.id, ...retryAction });
    await fresh();
    const observed = parseObserved(observedRaw);
    const accountKey = this.accounts.accountKey('chatgpt-host-web', 'settings-account-email', observed.account);
    if (accountKey !== saved.accountKey || observed.sourceFingerprint !== saved.sourceFingerprint) conflict();
    await fresh();
    const result = await this.transport.request({ kind: 'download', phase: 'reconcile', target,
      captureIntentId: request.id, ...retryAction });
    await fresh();
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        Object.keys(result).sort().join(',') !== (retry ? 'completion,observation,retryContext' : 'completion,observation')) reconcile();
    const envelope = result as { observation: unknown; completion: unknown; retryContext?: unknown };
    verifyContext(envelope.retryContext);
    const current = parseChatgptDownloadObservation(envelope.observation, selection);
    if (current.account !== observed.account || current.sourceFingerprint !== saved.sourceFingerprint) conflict();
    const completion = envelope.completion;
    if (!completion || typeof completion !== 'object' || Array.isArray(completion) ||
        Object.keys(completion).sort().join(',') !== 'captureIntentId,kind,path') reconcile();
    const completed = completion as { captureIntentId: unknown; kind: unknown; path: unknown };
    if (completed.captureIntentId !== request.id || completed.kind !== 'browser_download_completed' ||
        typeof completed.path !== 'string' || !isAbsolute(completed.path)) reconcile();
    let candidate: ReturnType<typeof captureBrowserDownloadDelta>;
    try {
      candidate = captureBrowserDownloadDelta(saved.baseline, this.forbiddenRoots());
      if (candidate.state !== 'candidate' || candidate.bytes.length !== saved.expectedSize ||
          candidate.sha256 !== saved.expectedSha256 ||
          hash(normalizeRoot(realpathSync(completed.path))) !== candidate.identity) reconcile();
    } catch { reconcile(); }
    if (candidate.state !== 'candidate') reconcile();
    if (record.state === 'verified_candidate') {
      if (record.candidateFingerprint !== candidate.candidateFingerprint) reconcile();
    } else this.store.transition(request.id, 'reconcile_required', 'verified_candidate', candidate.candidateFingerprint);
    await fresh();
    return { bytes: candidate.bytes, sha256: candidate.sha256,
      sourceIdentity: hash(JSON.stringify([request.id, saved.accountKey, saved.sourceFingerprint,
        saved.bindingFingerprint, candidate.candidateFingerprint, 'browser_download', 'host_download_object'])) };
  }

  private markUnknown(record: BrowserCaptureRecord): void {
    if (record.state === 'capturing') this.store.transition(record.input.id, 'capturing', 'reconcile_required');
  }
}
