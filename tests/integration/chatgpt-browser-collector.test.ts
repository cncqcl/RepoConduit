import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HostBrowserCollector } from '../../src/adapters/chatgpt/browser-collector.js';
import { BrowserCaptureSqlite } from '../../src/adapters/storage/browser-capture-sqlite.js';
import { ArtifactApplication, type ArtifactDependencies, type BrowserArtifactCollector } from '../../src/application/artifacts.js';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import type { HostAction } from '../../src/adapters/chatgpt/host-conversation.js';

const chat = '11111111-1111-4111-8111-111111111111', message = '00000000-0000-4000-8000-000000000101';
const turn = '00000000-0000-4000-8000-000000000103', filename = 'result.txt';
const bytes = Buffer.from('Exact receiver-known bytes');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function raw(account = 'synthetic@example.test') {
  return { account: { fields: [{ label: 'Email', value: account }] },
    ui: { url: `https://chatgpt.com/c/${chat}`, dialogs: [], composerText: '', downloads: [{
      label: `Download ${filename}`, filename, conversationId: chat, messageId: message, turnId: turn,
      turnState: 'complete', authorRole: 'assistant', referenceIndex: '0', fileReference: 'true',
      tag: 'SPAN', role: 'button', busy: 'false', visible: true }] },
    host: { schemaVersion: 1, thread: { id: chat, kind: 'chatgpt', status: { type: 'idle' } },
      page: { order: 'newest_first', limit: 10, hasMore: false, nextCursor: null }, turns: [{ id: turn,
        status: 'completed', items: [{ type: 'userMessage', id: turn, content: [{ type: 'text', text: 'fixture' }] },
          { type: 'agentMessage', id: message, text: `:chatgpt-content-reference{index="0"}[Download](sandbox:/mnt/data/${filename})` }] }], attachments: [] } };
}
function domRaw(account = 'synthetic@example.test', body = 'Full message body', cardName = 'preview.png',
  unknown = false, marker = false) {
  const node = (tag: string, ...attributes: [string, string][]) => ({ tag, attributes });
  const selected = node('DIV', ['data-chatgpt-selection-conversation-id', chat], ['data-chatgpt-selection-message-id', message]);
  const state = node('DIV', ['data-talvt-turn-state', 'complete']);
  const nativeTurn = node('DIV', ['data-turn-key', turn]);
  const blocks: unknown[] = [
    { kind: 'file_reference', filename, referenceIndex: '0', renderedText: `Download ${filename}`, visible: true,
      ancestry: [node('SPAN', ['data-file-reference', 'true'], ['data-markdown-copy-text', filename], ['role', 'button'],
        ['aria-busy', 'false'], ['aria-label', `Download ${filename}`]),
        node('SPAN', ['data-chatgpt-copy-reference', '0'], ['data-markdown-copy', 'contents']),
        node('DIV', ['data-markdown-text-style', 'assistant-message']), selected, state, nativeTurn] },
    { kind: 'text', renderedText: body },
    { kind: 'image_card', filename: cardName, typeImage: 'Image', previewLabel: `Open preview of ${cardName}`,
      downloadLabel: 'Download file', visible: true, ancestry: [node('BUTTON', ['aria-label', 'Download file']),
        selected, state, nativeTurn] },
  ];
  if (marker) {
    const hidden = node('SPAN', ['hidden', '']);
    blocks.unshift({ kind: 'empty_hidden_span_v1', node: hidden, ancestry: [hidden, selected, state, nativeTurn] });
  }
  if (unknown) blocks.push({ kind: 'unknown' });
  return { sourceKind: 'observed_chatgpt_dom_attachment_v1',
    account: { fields: [{ label: 'Email', value: account }] },
    ui: { url: `https://chatgpt.com/c/${chat}`, dialogs: [], composerText: '', turnStates: ['complete'], generationControls: [] },
    dom: { turn: nativeTurn, stateNode: state, message: selected, blocks } };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rcac-capture-port-'));
  const store = new BrowserCaptureSqlite(join(root, 'state.sqlite'));
  let commits = 0, onCommit = () => { writeFileSync(join(root, filename), bytes); },
    account = 'synthetic@example.test', binding: string | null = null, authority: () => Promise<void> = async () => {},
    lateCompletion = false, completedName = filename, completedIntentId = hash('capture'), source: 'host' | 'dom' = 'host',
    domBody = 'Full message body', domCard = 'preview.png', domUnknown = false, domMarker = false,
    retryMode = false, attachmentIndex: number | undefined;
  const retryContext = { browserId: 'browser2', originalTabId: 'tab10', retryTabId: 'tab12' };
  const completion = () => ({ captureIntentId: completedIntentId, kind: 'browser_download_completed', path: join(root, completedName) });
  const observation = () => source === 'dom' ? domRaw(account, domBody, domCard, domUnknown, domMarker) : raw(account);
  const transport = { async request(action: HostAction): Promise<unknown> {
    assert.equal(action.kind, 'download');
    if (action.kind !== 'download') throw new Error('Unexpected action');
    if (attachmentIndex !== undefined) assert.equal(action.target.attachmentIndex, attachmentIndex);
    if (action.phase === 'commit') { commits++; completedIntentId = action.captureIntentId; onCommit(); return { clicked: true, observation: observation(), completion: completion(), ...(retryMode ? { retryContext } : {}) }; }
    if (action.phase === 'reconcile') return { observation: observation(), completion: lateCompletion ? completion() : null, ...(retryMode ? { retryContext } : {}) };
    return retryMode ? { observation: observation(), retryContext } : observation();
  } };
  const collector = new HostBrowserCollector(store,
    { accountKey: (_provider: string, _kind: string, value: string) => value === 'synthetic@example.test'
      ? 'hacc_00000000-0000-4000-8000-000000000103' : 'hacc_00000000-0000-4000-8000-000000000101' },
    transport, root, () => [], () => binding);
  const request: Parameters<BrowserArtifactCollector['capture']>[0] = {
    id: hash('capture'), workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle', path: filename,
    principal: 'local', audience: 'local-os', recipient: 'local', grantId: 'original',
    nativeSessionId: chat, nativeMessageId: message, filename, expectedSha256: hash(bytes),
    expectedSize: bytes.length, assertAuthority: () => authority(),
  };
  return { root, store, collector, request, get commits() { return commits; },
    commit(action: () => void) { onCommit = action; }, account(value: string) { account = value; },
    binding(value: string | null) { binding = value; }, authority(action: () => Promise<void>) { authority = action; },
    source(value: 'host' | 'dom') { source = value; },
    index(value: number) { attachmentIndex = value; },
    domBody(value: string) { domBody = value; },
    domCard(value: string) { domCard = value; },
    domUnknown() { domUnknown = true; },
    domMarker(value: boolean) { domMarker = value; },
    retryMode(value: boolean) { retryMode = value; },
    retryContext(change: Partial<typeof retryContext>) { Object.assign(retryContext, change); },
    completeLate() { lateCompletion = true; }, completedName(value: string) { completedName = value; },
    completedIntentId(value: string) { completedIntentId = value; },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('indexed native capture persists selection and refuses replacement during retry or reconcile', async () => {
  const f = fixture(); f.source('dom'); f.index(0);
  const indexed = { ...f.request, attachmentIndex: 0 };
  try {
    f.commit(() => {});
    await assert.rejects(f.collector.capture(indexed), /RECONCILE_REQUIRED/);
    assert.equal(f.store.get(indexed.id)?.input.attachmentIndex, 0);
    await assert.rejects(f.collector.capture({ ...indexed, attachmentIndex: 1, reconcileOnlyCapture: true }), /CONFLICT/);
    f.index(1); f.retryMode(true);
    await assert.rejects(f.collector.capture({ ...indexed, attachmentIndex: 1, id: hash('changed-index'), retryOfCaptureId: indexed.id }), /CONFLICT|HOST_DOWNLOAD_UNAVAILABLE/);
    assert.equal(f.commits, 1);
    assert.equal(f.store.get(indexed.id)?.state, 'reconcile_required');
  } finally { f.close(); }
});

test('indexed DOM capture returns exact bytes and retains original index on replay', async () => {
  const f = fixture(); f.source('dom'); f.index(0);
  const indexed = { ...f.request, attachmentIndex: 0 };
  try {
    const result = await f.collector.capture(indexed);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(f.store.get(indexed.id)?.input.attachmentIndex, 0);
    assert.deepEqual(await f.collector.capture(indexed), result);
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('retry consumes a new tab download while leaving the original unknown and fenced', async () => {
  const f = fixture();
  try {
    f.commit(() => {});
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
    f.retryMode(true);
    f.commit(() => writeFileSync(join(f.root, filename), bytes));
    const next = { ...f.request, id: hash('retry-capture'), retryOfCaptureId: f.request.id };
    const result = await f.collector.capture(next);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
    assert.equal(f.store.get(next.id)?.state, 'verified_candidate');
    assert.deepEqual(f.store.getRetry(next.id), { predecessorId: f.request.id, successorId: next.id,
      browserId: 'browser2', originalTabId: 'tab10', retryTabId: 'tab12' });
    const downgraded: Parameters<BrowserArtifactCollector['capture']>[0] = { ...next };
    delete downgraded.retryOfCaptureId;
    await assert.rejects(f.collector.capture(downgraded), /CONFLICT/);
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/);
    assert.equal(f.commits, 2);
  } finally { f.close(); }
});

for (const mismatch of ['same-tab', 'changed-browser', 'changed-retry-tab'] as const) {
  test(`retry host context rejects ${mismatch} without promoting candidate`, async () => {
    const f = fixture();
    try {
      f.commit(() => {});
      await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
      f.retryMode(true);
      if (mismatch === 'same-tab') f.retryContext({ retryTabId: 'tab10' });
      else f.commit(() => {
        f.retryContext(mismatch === 'changed-browser' ? { browserId: 'browser3' } : { retryTabId: 'tab13' });
        writeFileSync(join(f.root, filename), bytes);
      });
      const next = { ...f.request, id: hash(`retry-${mismatch}`), retryOfCaptureId: f.request.id };
      await assert.rejects(f.collector.capture(next), /CONFLICT|RECONCILE_REQUIRED/);
      assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
      assert.equal(f.store.get(next.id)?.state, mismatch === 'same-tab' ? undefined : 'reconcile_required');
      assert.equal(f.commits, mismatch === 'same-tab' ? 1 : 2);
    } finally { f.close(); }
  });
}

test('durable baseline precedes one commit and exact bytes are captured without replay click', async () => {
  const f = fixture();
  try {
    f.commit(() => { assert.equal(f.store.get(f.request.id)?.state, 'capturing'); writeFileSync(join(f.root, filename), bytes); });
    const result = await f.collector.capture(f.request);
    assert.equal(result.sha256, hash(bytes)); assert.deepEqual(result.bytes, bytes);
    assert.equal(f.store.get(f.request.id)?.state, 'verified_candidate');
    assert.deepEqual(await f.collector.capture(f.request), result); assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('typed DOM source captures once and keeps the original intent on replay', async () => {
  const f = fixture(); f.source('dom');
  try {
    const result = await f.collector.capture(f.request);
    assert.equal(result.sha256, hash(bytes));
    assert.equal(f.store.get(f.request.id)?.state, 'verified_candidate');
    assert.deepEqual(await f.collector.capture(f.request), result);
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('prepared DOM source rejects a newly added hidden marker before any click', async () => {
  const f = fixture(); f.source('dom');
  try {
    f.authority(async () => { if (f.store.get(f.request.id)?.state === 'prepared') f.domMarker(true); });
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/);
    assert.equal(f.store.get(f.request.id)?.state, 'aborted_before_capture');
    assert.equal(f.store.get(f.request.id)?.abortReason, 'source_changed_before_capture');
    f.authority(async () => {});
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/);
    const next = { ...f.request, id: hash('new-key-after-source-change') };
    assert.deepEqual((await f.collector.capture(next)).bytes, bytes);
    assert.equal(f.store.get(f.request.id)?.state, 'aborted_before_capture');
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('prepared replay retires only on source drift with unchanged authority and binding', async () => {
  const f = fixture(); f.source('dom');
  try {
    f.authority(async () => { if (f.store.get(f.request.id)?.state === 'prepared') throw new Error('NOT_AVAILABLE'); });
    await assert.rejects(f.collector.capture(f.request), /NOT_AVAILABLE/);
    assert.equal(f.store.get(f.request.id)?.state, 'prepared');
    f.authority(async () => {});
    f.domMarker(true);
    f.authority(async () => { throw new Error('GRANT_REVOKED'); });
    await assert.rejects(f.collector.capture(f.request), /GRANT_REVOKED/);
    assert.equal(f.store.get(f.request.id)?.state, 'prepared');
    f.authority(async () => {});
    await assert.rejects(f.collector.capture({ ...f.request, grantId: 'other' }), /CONFLICT/);
    assert.equal(f.store.get(f.request.id)?.state, 'prepared');
    await assert.rejects(f.collector.capture({ ...f.request, nativeMessageId: '33333333-3333-4333-8333-333333333333' }), /HOST_DOWNLOAD_UNAVAILABLE|CONFLICT/);
    assert.equal(f.store.get(f.request.id)?.state, 'prepared');
    f.binding(hash('new-binding'));
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/);
    assert.equal(f.store.get(f.request.id)?.state, 'prepared');
    f.binding(null); f.account('other@example.test');
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/);
    assert.equal(f.store.get(f.request.id)?.state, 'prepared');
    f.account('synthetic@example.test');
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/);
    assert.equal(f.store.get(f.request.id)?.state, 'aborted_before_capture');
    assert.equal(f.commits, 0);
  } finally { f.close(); }
});

test('selected PNG card captures through its original completion object with one click', async () => {
  const f = fixture(); f.source('dom'); f.completedName('preview.png');
  const request = { ...f.request, filename: 'preview.png', path: 'preview.png' };
  try {
    f.commit(() => writeFileSync(join(f.root, 'preview.png'), bytes));
    const result = await f.collector.capture(request);
    assert.deepEqual(result.bytes, bytes);
    assert.deepEqual(await f.collector.capture(request), result);
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('changed PNG card after unknown completion does not repeat the click', async () => {
  const f = fixture(); f.source('dom'); f.completedName('preview.png');
  const request = { ...f.request, filename: 'preview.png', path: 'preview.png' };
  try {
    f.commit(() => { writeFileSync(join(f.root, 'preview.png'), bytes); throw new Error('timeout'); });
    await assert.rejects(f.collector.capture(request), /RECONCILE_REQUIRED/);
    f.domCard('different.png');
    await assert.rejects(f.collector.capture(request), /HOST_DOWNLOAD_UNAVAILABLE/);
    assert.equal(f.store.get(request.id)?.state, 'reconcile_required');
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('existing host intent cannot be converted to DOM source or clicked again', async () => {
  const f = fixture();
  try {
    f.commit(() => {});
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    f.source('dom');
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/);
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('unknown DOM completion remains unresolved without another click', async () => {
  const f = fixture(); f.source('dom');
  try {
    f.commit(() => { writeFileSync(join(f.root, filename), bytes); throw new Error('timeout'); });
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('changed complete DOM message cannot reconcile the original intent', async () => {
  const f = fixture(); f.source('dom');
  try {
    f.commit(() => { writeFileSync(join(f.root, filename), bytes); throw new Error('timeout'); });
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    f.domBody('Full message body changed after click');
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/);
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('changed DOM PNG card cannot reconcile the original intent', async () => {
  const f = fixture(); f.source('dom');
  try {
    f.commit(() => { writeFileSync(join(f.root, filename), bytes); throw new Error('timeout'); });
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    f.domCard('different.png');
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/);
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('unknown DOM content refuses collection before any click or intent', async () => {
  const f = fixture(); f.source('dom'); f.domUnknown();
  try {
    await assert.rejects(f.collector.capture(f.request), /HOST_DOWNLOAD_UNAVAILABLE/);
    assert.equal(f.store.get(f.request.id), null);
    assert.equal(f.commits, 0);
  } finally { f.close(); }
});

test('commit timeout with actual file remains unknown until the original host download object completes', async () => {
  const f = fixture();
  try {
    f.commit(() => { writeFileSync(join(f.root, filename), bytes); throw new Error('timeout'); });
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    f.completeLate();
    assert.deepEqual((await f.collector.capture(f.request)).bytes, bytes); assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('reconcile-only uses original intent and a current grant without another click', async () => {
  const f = fixture();
  try {
    f.commit(() => { writeFileSync(join(f.root, filename), bytes); throw new Error('timeout'); });
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    f.completeLate();
    const read = { ...f.request, grantId: 'replacement', reconcileOnlyCapture: true };
    const result = await f.collector.capture(read);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(f.store.get(f.request.id)?.state, 'verified_candidate');
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('reconcile-only reads persisted retry tab context and never creates a third attempt', async () => {
  const f = fixture();
  try {
    f.commit(() => {});
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    f.retryMode(true);
    f.commit(() => { writeFileSync(join(f.root, filename), bytes); throw new Error('timeout'); });
    const successor = { ...f.request, id: hash('retry-to-reconcile'), retryOfCaptureId: f.request.id };
    await assert.rejects(f.collector.capture(successor), /RECONCILE_REQUIRED/);
    f.completeLate();
    const read: Parameters<BrowserArtifactCollector['capture']>[0] = { ...successor, grantId: 'replacement',
      reconcileOnlyCapture: true };
    delete read.retryOfCaptureId;
    f.store.prepare = () => { throw new Error('unexpected prepare'); };
    f.store.prepareRetry = () => { throw new Error('unexpected retry'); };
    const result = await f.collector.capture(read);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(f.store.get(successor.id)?.state, 'verified_candidate');
    assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
    assert.equal(f.commits, 2);
  } finally { f.close(); }
});

test('application reconcile-only stages the original bytes under a new current grant', async () => {
  const f = fixture();
  const objects = new ArtifactObjects(join(f.root, 'objects'));
  const input = { workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle', contextRevision: 'ctx',
    snapshotRefs: [], expectedPaths: [filename] };
  objects.begin(input);
  const receipts = new Map<string, { payload: string; file: unknown }>();
  const app = new ArtifactApplication({
    objects, browserCollector: f.collector,
    authorize: r => ({ grantId: 'replacement', operation: r.operation, effect: 'artifact_transfer', scope: r,
      principal: r.context.principal, recipient: r.context.recipient }),
    collaborationBelongsToWorkspace: () => true, validateBundleReferences: () => {},
    getBundle: () => ({ input }), saveBundle: () => {}, publishBundle: () => {}, abortBundle: () => {},
    lookupIdempotent: (scope, payload) => {
      const prior = receipts.get(scope.idempotencyKey);
      if (prior && prior.payload !== JSON.stringify(payload)) throw new Error('CONFLICT');
      return prior?.file ?? null;
    },
    withBundleLock: (_id, action) => action(),
    runIdempotent: (scope, payload, mutation) => {
      const file = mutation(); receipts.set(scope.idempotencyKey, { payload: JSON.stringify(payload), file }); return file;
    },
  } as ArtifactDependencies);
  const request = { ...f.request, idempotencyKey: 'new-reconcile-key', reconcileOnly: { captureIntentId: f.request.id },
    context: { principal: 'local', audience: 'local-os', recipient: 'local', surface: 'local_cli' as const, now: new Date() } };
  try {
    f.commit(() => { writeFileSync(join(f.root, filename), bytes); throw new Error('timeout'); });
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    f.completeLate();
    f.store.prepare = () => { throw new Error('unexpected prepare'); };
    f.store.prepareRetry = () => { throw new Error('unexpected retry'); };
    const file = await app.collectBrowser(request);
    assert.equal(file.sha256, hash(bytes));
    assert.deepEqual(await app.collectBrowser(request), file);
    assert.equal(f.commits, 1);
    assert.equal(f.store.get(f.request.id)?.state, 'verified_candidate');
  } finally { f.close(); }
});

test('reconcile-only refuses absent, prepared, capturing and fenced intents before host actions', async () => {
  const f = fixture();
  try {
    const missing = { ...f.request, id: hash('missing-intent'), reconcileOnlyCapture: true };
    await assert.rejects(f.collector.capture(missing), /CONFLICT/);
    assert.equal(f.commits, 0);
    f.authority(async () => { if (f.store.get(f.request.id)?.state === 'prepared') throw new Error('PAUSE'); });
    await assert.rejects(f.collector.capture(f.request), /PAUSE/);
    await assert.rejects(f.collector.capture({ ...f.request, reconcileOnlyCapture: true }), /CONFLICT/);
    f.store.transition(f.request.id, 'prepared', 'capturing');
    await assert.rejects(f.collector.capture({ ...f.request, reconcileOnlyCapture: true }), /CONFLICT/);
    f.store.transition(f.request.id, 'capturing', 'reconcile_required');
    f.retryMode(true); f.authority(async () => {}); f.commit(() => {});
    await assert.rejects(f.collector.capture({ ...f.request, id: hash('successor'), retryOfCaptureId: f.request.id }), /RECONCILE_REQUIRED/);
    await assert.rejects(f.collector.capture({ ...f.request, reconcileOnlyCapture: true }), /CONFLICT/);
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('reconcile-only requires the entire original scope and expected bytes', async () => {
  const f = fixture();
  try {
    f.commit(() => {});
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    for (const changed of [
      { workspaceId: 'other' }, { collaborationId: 'other' }, { bundleId: 'other' },
      { path: 'other.txt' }, { principal: 'other' }, { audience: 'other' }, { recipient: 'other' },
      { nativeSessionId: '22222222-2222-4222-8222-222222222222' },
      { nativeMessageId: '33333333-3333-4333-8333-333333333333' },
      { filename: 'other.txt' }, { expectedSha256: hash('other') }, { expectedSize: bytes.length + 1 },
    ]) await assert.rejects(f.collector.capture({ ...f.request, ...changed, reconcileOnlyCapture: true }), /CONFLICT/);
    const otherRoot = mkdtempSync(join(tmpdir(), 'rcac-other-root-'));
    try {
      const collector = new HostBrowserCollector(f.store,
        { accountKey: () => 'hacc_00000000-0000-4000-8000-000000000103' },
        { request: async () => { throw new Error('unexpected host action'); } }, otherRoot, () => [], () => null);
      await assert.rejects(collector.capture({ ...f.request, reconcileOnlyCapture: true }), /CONFLICT/);
    } finally { rmSync(otherRoot, { recursive: true, force: true }); }
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

for (const change of ['target', 'account', 'binding', 'source', 'missing-object', 'wrong-object-id', 'wrong-object-path', 'late-ambiguity'] as const) {
  test(`reconcile-only rejects ${change} without another commit`, async () => {
    const f = fixture();
    try {
      f.commit(() => { writeFileSync(join(f.root, filename), bytes); throw new Error('timeout'); });
      await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
      await assert.rejects(f.collector.capture({ ...f.request, reconcileOnlyCapture: true,
        requireExistingCapture: true }), /CONFLICT/);
      if (change !== 'missing-object') f.completeLate();
      if (change === 'account') f.account('other@example.test');
      if (change === 'binding') f.binding(hash('different-binding'));
      if (change === 'source') f.source('dom');
      if (change === 'wrong-object-id') f.completedIntentId(hash('wrong-intent'));
      if (change === 'wrong-object-path') f.completedName('wrong.txt');
      if (change === 'late-ambiguity') writeFileSync(join(f.root, 'result (1).txt'), bytes);
      const changed = { ...f.request, reconcileOnlyCapture: true,
        ...(change === 'target' ? { path: 'other.txt' } : {}) };
      await assert.rejects(f.collector.capture(changed), /CONFLICT|RECONCILE_REQUIRED|HOST_DOWNLOAD_UNAVAILABLE/);
      assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
      assert.equal(f.commits, 1);
    } finally { f.close(); }
  });
}

test('stable partial candidate stays unresolved when exact bytes arrive without original completion', async () => {
  const f = fixture();
  try {
    f.commit(() => writeFileSync(join(f.root, filename), bytes.subarray(0, 3)));
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    writeFileSync(join(f.root, filename), bytes);
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/); assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('preexisting bytes cannot satisfy a new capture', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, filename), bytes); f.commit(() => {});
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
  } finally { f.close(); }
});

test('another unresolved intent owns root admission and prevents second commit', async () => {
  const f = fixture();
  try {
    f.commit(() => {}); await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    await assert.rejects(f.collector.capture({ ...f.request, id: hash('other') }), /ROOT_BUSY/);
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('changed account after click cannot capture or retry under a different owner', async () => {
  const f = fixture();
  try {
    f.commit(() => { writeFileSync(join(f.root, filename), bytes); f.account('other@example.test'); });
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/);
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('authority loss before commit retains unresolved intent without a click', async () => {
  const f = fixture();
  try {
    f.authority(async () => { if (f.store.get(f.request.id)?.state === 'capturing') throw new Error('NOT_AVAILABLE'); });
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    assert.equal(f.commits, 0); assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
  } finally { f.close(); }
});

test('binding epoch change cannot reconcile prior capture', async () => {
  const f = fixture();
  try {
    f.binding(hash('epoch1')); f.commit(() => {});
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    f.binding(hash('epoch2'));
    await assert.rejects(f.collector.capture(f.request), /CONFLICT/); assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('captured candidate changed after receipt is rejected on replay', async () => {
  const f = fixture();
  try { await f.collector.capture(f.request); writeFileSync(join(f.root, filename), 'different');
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/); assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('crash before click plus a third-party exact-byte copy cannot promote an unknown intent', async () => {
  const f = fixture();
  try {
    f.authority(async () => { if (f.store.get(f.request.id)?.state === 'capturing') throw new Error('NOT_AVAILABLE'); });
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    f.authority(async () => {}); writeFileSync(join(f.root, filename), bytes);
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required'); assert.equal(f.commits, 0);
  } finally { f.close(); }
});

test('download object for a different local file cannot authenticate the root candidate', async () => {
  const f = fixture();
  try {
    f.completedName('other.txt');
    f.commit(() => { writeFileSync(join(f.root, filename), bytes); writeFileSync(join(f.root, 'other.txt'), bytes); });
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    assert.equal(f.store.get(f.request.id)?.state, 'reconcile_required');
  } finally { f.close(); }
});

test('same intent replacement grant is rejected before a new click even after candidate verification', async () => {
  const f = fixture();
  try { await f.collector.capture(f.request);
    await assert.rejects(f.collector.capture({ ...f.request, grantId: 'replacement' }), /CONFLICT/);
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('real collector cannot reclick a staged destination under a new key, while original missing receipt recovers', async () => {
  const f = fixture();
  const objects = new ArtifactObjects(join(f.root, 'objects'));
  const input = { workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle', contextRevision: 'ctx', snapshotRefs: [], expectedPaths: [filename] };
  objects.begin(input);
  let failReceipt = true;
  const dependencies: ArtifactDependencies = {
    objects, browserCollector: f.collector,
    authorize: r => ({ grantId: 'original', operation: r.operation, effect: 'artifact_transfer', scope: r, principal: r.context.principal, recipient: r.context.recipient }),
    collaborationBelongsToWorkspace: () => true, validateBundleReferences: () => {},
    getBundle: () => ({ input }), saveBundle: () => {}, publishBundle: () => {}, abortBundle: () => {},
    lookupIdempotent: () => null, withBundleLock: (_id, action) => action(),
    runIdempotent: (_scope, _payload, mutation) => { if (failReceipt) throw new Error('receipt unavailable'); return mutation(); },
  };
  const app = new ArtifactApplication(dependencies);
  const request = { ...f.request, idempotencyKey: 'A', context: { principal: 'local', audience: 'local-os', recipient: 'local', surface: 'local_cli' as const, now: new Date() } };
  try {
    f.commit(() => {
      const name = existsSync(join(f.root, filename)) ? 'result (1).txt' : filename;
      f.completedName(name); writeFileSync(join(f.root, name), bytes);
    });
    await assert.rejects(app.collectBrowser(request), /receipt unavailable/);
    assert.equal(f.commits, 1);
    failReceipt = false;
    await assert.rejects(app.collectBrowser({ ...request, idempotencyKey: 'B' }));
    assert.equal(f.commits, 1);
    const recovered = await app.collectBrowser(request);
    assert.equal(recovered.sha256, hash(bytes)); assert.equal(f.commits, 1);
  } finally { f.close(); }
});

test('same verified retry recovers missing receipt without another download', async () => {
  const f = fixture();
  const objects = new ArtifactObjects(join(f.root, 'objects'));
  const input = { workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle', contextRevision: 'ctx', snapshotRefs: [], expectedPaths: [filename] };
  objects.begin(input);
  let failReceipt = true;
  const app = new ArtifactApplication({
    objects, browserCollector: f.collector,
    authorize: r => ({ grantId: 'original', operation: r.operation, effect: 'artifact_transfer', scope: r,
      principal: r.context.principal, recipient: r.context.recipient }),
    collaborationBelongsToWorkspace: () => true, validateBundleReferences: () => {},
    getBundle: () => ({ input }), saveBundle: () => {}, publishBundle: () => {}, abortBundle: () => {},
    lookupIdempotent: () => null, withBundleLock: (_id, action) => action(),
    runIdempotent: (_scope, _payload, mutation) => { if (failReceipt) throw new Error('receipt unavailable'); return mutation(); },
  });
  const request = { ...f.request, idempotencyKey: 'retry-A', retryOfCaptureId: f.request.id,
    context: { principal: 'local', audience: 'local-os', recipient: 'local', surface: 'local_cli' as const, now: new Date() } };
  try {
    f.commit(() => {});
    await assert.rejects(f.collector.capture(f.request), /RECONCILE_REQUIRED/);
    f.retryMode(true);
    f.commit(() => writeFileSync(join(f.root, filename), bytes));
    await assert.rejects(app.collectBrowser(request), /receipt unavailable/);
    assert.equal(f.commits, 2);
    failReceipt = false;
    const recovered = await app.collectBrowser(request);
    assert.equal(recovered.sha256, hash(bytes));
    assert.equal(f.commits, 2);
    await assert.rejects(app.collectBrowser({ ...request, idempotencyKey: 'retry-B' }), /CONFLICT/);
    assert.equal(f.commits, 2);
  } finally { f.close(); }
});

test('staged PNG card cannot be reclicked under a replacement key', async () => {
  const f = fixture(); f.source('dom'); f.completedName('preview.png');
  const objects = new ArtifactObjects(join(f.root, 'objects'));
  const input = { workspaceId: 'ws', collaborationId: 'col', bundleId: 'bundle', contextRevision: 'ctx',
    snapshotRefs: [], expectedPaths: ['preview.png'] };
  objects.begin(input);
  let failReceipt = true;
  const dependencies: ArtifactDependencies = {
    objects, browserCollector: f.collector,
    authorize: r => ({ grantId: 'original', operation: r.operation, effect: 'artifact_transfer',
      scope: r, principal: r.context.principal, recipient: r.context.recipient }),
    collaborationBelongsToWorkspace: () => true, validateBundleReferences: () => {},
    getBundle: () => ({ input }), saveBundle: () => {}, publishBundle: () => {}, abortBundle: () => {},
    lookupIdempotent: () => null, withBundleLock: (_id, action) => action(),
    runIdempotent: (_scope, _payload, mutation) => {
      if (failReceipt) throw new Error('receipt unavailable'); return mutation();
    },
  };
  const app = new ArtifactApplication(dependencies);
  const request = { ...f.request, filename: 'preview.png', path: 'preview.png', idempotencyKey: 'A',
    context: { principal: 'local', audience: 'local-os', recipient: 'local', surface: 'local_cli' as const, now: new Date() } };
  try {
    f.commit(() => writeFileSync(join(f.root, 'preview.png'), bytes));
    await assert.rejects(app.collectBrowser(request), /receipt unavailable/);
    assert.equal(f.commits, 1);
    failReceipt = false;
    await assert.rejects(app.collectBrowser({ ...request, idempotencyKey: 'B' }));
    assert.equal(f.commits, 1);
    const recovered = await app.collectBrowser(request);
    assert.equal(recovered.sha256, hash(bytes));
    assert.equal(f.commits, 1);
  } finally { f.close(); }
});
