/* eslint-disable @typescript-eslint/no-explicit-any -- malformed synthetic transport payloads exercise validation */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { ChatgptHostConversation, type HostAction } from '../../src/adapters/chatgpt/host-conversation.js';
import { HostConversationSqlite, type HostBaseline, type HostBaselineInput } from '../../src/adapters/storage/host-conversation-sqlite.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';
import { protectNewDataDirectory } from '../../src/runtime/local-security.js';

const chat = '11111111-1111-4111-8111-111111111111';
const project = 'g-p-6ad380ac3ac881918d77b6d84349bfe0';
const uid = '22222222-2222-4222-8222-222222222222';
const aid = '33333333-3333-4333-8333-333333333333';
const scope = { workspaceId: 'ws', collaborationId: 'collab' };

function raw(user = 'question', answer = 'answer', composer = ''): any {
  return { account: { labels: ['Change email: person@example.test'] }, ui: {
    url: `https://chatgpt.com/c/${chat}`, dialogs: [], buttons: [], media: [], composers: [{ text: composer }],
    headings: [
      { label: 'You said:', roleAttribute: null, messageIds: uid,
        bubble: { text: user, tags: [] }, assistant: null, selection: null },
      { label: 'ChatGPT said:', roleAttribute: 'assistant', messageIds: `${aid} ${aid}`,
        bubble: null, assistant: { text: answer, tags: ['P', 'SPAN'] },
        selection: { conversationId: chat, messageId: aid } },
    ],
  }, host: { schemaVersion: 1, thread: { id: chat, kind: 'chatgpt', status: { type: 'idle' } },
    page: { order: 'oldest_first', limit: 100, nextCursor: null, hasMore: false },
    turns: [{ id: 'turn-1', status: 'completed', items: [
      { type: 'userMessage', id: uid, content: [{ type: 'text', text: user }] },
      { type: 'agentMessage', id: aid, text: answer },
    ] }] } };
}

class MemoryStore {
  private rows = new Map<string, HostBaseline>();
  accountKey(_provider: string, _source: string, exact: string) { return `opaque:${exact}`; }
  putBaseline(input: HostBaselineInput) {
    const cursor = `cursor-${this.rows.size + 1}`;
    this.rows.set(cursor, { ...input, cursor, schemaVersion: 1 });
    return cursor;
  }
  getBaseline(cursor: string) { return this.rows.get(cursor) ?? null; }
}

function rig(initial = raw()) {
  const store = new MemoryStore();
  let current: any = initial;
  const actions: HostAction[] = [];
  const adapter = new ChatgptHostConversation(store, { request: async (action) => {
    actions.push(action);
    return action.kind === 'submit' && action.phase === 'commit' ? { toolResult: null } : current;
  } });
  return { store, adapter, actions, set: (value: any) => { current = value; } };
}

function binding(cursor: string, accountId = 'opaque:person@example.test'): SessionState {
  return { bindingId: 'binding', ...scope, providerId: 'chatgpt-host-web', accountId,
    nativeSessionId: chat, cursor, control: 'host_controlled', epoch: 0, revision: 0 };
}

function copyBody(value: any, index: number, copiedText: string) {
  const heading = value.ui.headings[index];
  const role = index % 2 === 0 ? 'user' : 'assistant';
  const source = { nativeSessionId: chat, nativeMessageId: index % 2 === 0 ? uid : aid,
    role, ...(role === 'user' ? heading.bubble : heading.assistant) };
  value.bodyCopies ??= [];
  value.bodyCopies.push({ kind: 'native_message_copy_v1', before: structuredClone(source),
    after: structuredClone(source), clipboardBefore: 'repoconduit-native-message-copy-v1', clipboardAfter: copiedText });
}

function attachmentRaw(): any {
  return JSON.parse(readFileSync(new URL('../fixtures/chatgpt/attachment-conversation-2026-10-16.json', import.meta.url), 'utf8'));
}
function attachmentBinding(cursor: string): SessionState {
  return { ...binding(cursor, 'opaque:synthetic@example.test'),
    nativeSessionId: '11111111-1111-4111-8111-111111111111' };
}
function firstAttachmentTurn(value: any) {
  value.host.turns = value.host.turns.slice(1);
  value.ui.headings = value.ui.headings.slice(0, 2);
  value.bodyCopies = value.bodyCopies.slice(0, 2);
  for (const c of value.bodyCopies.filter((x: any) => x.attachmentBefore)) {
    c.attachmentBefore.ui.turnStates = ['complete']; c.attachmentAfter.ui.turnStates = ['complete'];
  }
  return value;
}
function groupedAttachmentRaw() {
  const value = attachmentRaw();
  const copy = value.bodyCopies[1];
  const before = copy.attachmentBefore;
  const zip = before.dom.blocks[0];
  zip.filename = 'rcac-bundle-v1.zip'; zip.referenceIndex = '5';
  zip.renderedText = 'rcac-bundle-v1.zip';
  zip.ancestry[0].attributes.find((x: string[]) => x[0] === 'data-markdown-copy-text')[1] = zip.filename;
  zip.ancestry[0].attributes.find((x: string[]) => x[0] === 'aria-label')[1] = `Download ${zip.filename}`;
  zip.ancestry.find((x: any) => x.attributes.some((a: string[]) => a[0] === 'data-chatgpt-copy-reference'))
    .attributes.find((x: string[]) => x[0] === 'data-chatgpt-copy-reference')[1] = '5';
  const n = (tag: string, ...attributes: string[][]) => ({ tag, attributes });
  const messageNode = before.dom.message, state = before.dom.stateNode, turn = before.dom.turn;
  const wrapper = n('DIV'), container = n('DIV'), list = n('DIV', ['id', 'resource-list']);
  const control = n('BUTTON', ['aria-controls', 'resource-list'], ['aria-expanded', 'true']);
  const files = [['README.md', 'Document'], ['index.html', 'HTML'],
    ['manifest.json', 'Code'], ['second.md', 'Document'], ['preview.png', 'Image']];
  const rows = files.map(([filename, fileType], rowIndex) => {
    const row = n('SPAN', ['class', 'group/resource-row relative']);
    const preview = n('BUTTON', ['aria-label', `Open preview of ${filename}`]);
    const download = n('BUTTON', ['aria-label', 'Download file']);
    const path = [row, list, container, wrapper, messageNode, state, turn];
    return { filename, fileType, labelState: 'type', renderedText: `${filename}\n${fileType}`,
      rowIndex, previewRowIndex: rowIndex, downloadRowIndex: rowIndex,
      rowNode: row, rowAncestry: path, previewNode: preview, previewAncestry: [preview, ...path],
      downloadNode: download, downloadAncestry: [download, ...path] };
  });
  const groupText = rows.map(row => row.renderedText).join('\n') + '\nShow less';
  before.dom.blocks = [zip, { kind: 'resource_card_group_v1', listNode: list,
    ancestry: [list, container, wrapper, messageNode, state, turn],
    expandedControl: { label: 'Show less', node: control,
      ancestry: [control, container, wrapper, messageNode, state, turn] }, renderedText: groupText, rows }];
  copy.attachmentAfter = structuredClone(before);
  const body = `${zip.renderedText}\n\n${groupText}`;
  copy.before.text = body; copy.after.text = body; value.ui.headings[1].assistant.text = body;
  const tokens = files.map(([name], index) =>
    `:chatgpt-content-reference{index="${index}"}[${name}](sandbox:/mnt/data/rcac_bundle_20261018_v1/${name})`);
  const zipToken = `:chatgpt-content-reference{index="5"}[${zip.filename}](sandbox:/mnt/data/rcac_bundle_20261018_v1/${zip.filename})`;
  value.host.turns[1].items[1].text = [...tokens, zipToken].join('\n\n');
  copy.clipboardAfter = [...tokens,
    `${zip.filename}[${zip.filename}](sandbox:/mnt/data/rcac_bundle_20261018_v1/${zip.filename})`].join('\n\n');
  return value;
}

function appendWindowTurn(value: any, number: number) {
  const id = (prefix: string) => `${prefix}-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`;
  const turnId = id('aaaaaaaa'), userId = id('bbbbbbbb'), assistantId = id('cccccccc');
  const user = `question ${number}`, answer = `answer ${number}`;
  value.host.turns.unshift({ id: turnId, status: 'completed', items: [
    { type: 'userMessage', id: userId, content: [{ type: 'text', text: user }] },
    { type: 'agentMessage', id: assistantId, text: answer },
  ] });
  value.ui.headings.push(
    { label: 'You said:', roleAttribute: null, messageIds: userId,
      bubble: { text: user, tags: [] }, assistant: null, selection: null },
    { label: 'ChatGPT said:', roleAttribute: 'assistant', messageIds: `${assistantId} ${assistantId}`,
      bubble: null, assistant: { text: answer, tags: ['P', 'SPAN'] },
      selection: { conversationId: value.host.thread.id, messageId: assistantId } },
  );
  return value;
}
function fiveTurnBundle() {
  const value = groupedAttachmentRaw();
  for (const number of [3, 4, 5]) appendWindowTurn(value, number);
  return value;
}
function latestWindow(value: any) {
  const window = structuredClone(value);
  window.host.turns = window.host.turns.slice(0, 5);
  window.host.page.limit = 10;
  return window;
}

function observedUiWindows(value: any, starts: number[], length = 10) {
  const latest = latestWindow(value);
  const uiWindows = starts.map(start => {
    const ui = structuredClone(value.ui);
    ui.headings = ui.headings.slice(start, start + length);
    const ids = new Set(ui.headings.map((heading: any) => heading.messageIds.split(' ')[0]));
    return { account: structuredClone(value.account), ui,
      bodyCopies: structuredClone((value.bodyCopies ?? []).filter((copy: any) => ids.has(copy.before.nativeMessageId))) };
  });
  return { account: structuredClone(value.account), uiWindows,
    host: latest.host, hostAfter: structuredClone(latest.host) };
}

function twentyTurnHistory() {
  const value = fiveTurnBundle();
  for (let number = 6; number <= 10; number++) appendWindowTurn(value, number);
  value.host.page.limit = 100;
  return value;
}

test('two observed UI windows retain the single-window baseline behavior', async () => {
  const old = fiveTurnBundle(), r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const next = appendWindowTurn(structuredClone(old), 6);
  r.set(observedUiWindows(next, [0, 2]));
  const delta = await r.adapter.syncDelta(attachmentBinding(bound.cursor));
  assert.equal(delta.messages.length, 2);
  assert.deepEqual(r.store.getBaseline(delta.nextCursor)!.messages.slice(0, 10),
    r.store.getBaseline(bound.cursor)!.messages);
});

test('window first heading accepts repeated matching UUIDs in legacy UI ID text', async () => {
  const old = fiveTurnBundle(), r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const next = appendWindowTurn(structuredClone(old), 6);
  const observed = observedUiWindows(next, [0, 2]);
  for (const window of observed.uiWindows) {
    const heading = window.ui.headings[0];
    heading.messageIds = `${heading.messageIds}, ${heading.messageIds}`;
  }
  r.set(observed);
  assert.equal((await r.adapter.syncDelta(attachmentBinding(bound.cursor))).messages.length, 2);
});

test('window first heading rejects mixed or malformed UUIDs', async () => {
  const old = fiveTurnBundle(), r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const next = appendWindowTurn(structuredClone(old), 6);
  for (const ids of [`${uid}, ${aid}`, `${uid}; ${uid}`]) {
    const observed = observedUiWindows(next, [0, 2]);
    observed.uiWindows[0]!.ui.headings[0].messageIds = ids;
    r.set(observed);
    await assert.rejects(r.adapter.syncDelta(attachmentBinding(bound.cursor)));
  }
});

test('three observed UI windows cover a 22-message history and preserve the retained prefix', async () => {
  const old = twentyTurnHistory();
  const r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const value = structuredClone(old);
  appendWindowTurn(value, 11);
  const observed = observedUiWindows(value, [0, 8, 16]);
  r.set(observed);
  const delta = await r.adapter.syncDelta(attachmentBinding(bound.cursor));
  assert.equal(delta.messages.length, 2);
  const baseline = r.store.getBaseline(delta.nextCursor)!;
  assert.equal(baseline.messages.length, 22);
  assert.deepEqual(baseline.messages.slice(0, 20), r.store.getBaseline(bound.cursor)!.messages);
  assert.deepEqual((baseline.observation as any).uiWindows, observed.uiWindows);
  assert.equal((await r.adapter.syncDelta(attachmentBinding(delta.nextCursor))).nextCursor, delta.nextCursor);
});

test('three UI windows reject gaps, reversal, duplicate, overlap edits and changing identity or host', async () => {
  const old = twentyTurnHistory(), r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const value = appendWindowTurn(structuredClone(old), 11);
  for (const mutate of [
    (x: any) => { x.uiWindows.splice(1, 1); },
    (x: any) => { x.uiWindows.reverse(); },
    (x: any) => { x.uiWindows[1] = structuredClone(x.uiWindows[0]); },
    (x: any) => { x.uiWindows[1].ui.headings[0].bubble.text += ' changed'; },
    (x: any) => { x.uiWindows[1].ui.headings[0].messageIds = uid; },
    (x: any) => { x.uiWindows[1].ui.headings[1].selection.messageId = uid; },
    (x: any) => { x.uiWindows[2].account.fields[0].value = 'other@example.test'; },
    (x: any) => { x.uiWindows[2].ui.composers[0].text = 'unsent draft'; },
    (x: any) => { x.uiWindows[0].ui.dialogs.push('dialog'); },
    (x: any) => { x.hostAfter.turns[0].items[1].text += ' changed'; },
    (x: any) => { x.hostAfter.page.limit -= 1; },
  ]) {
    const changed = observedUiWindows(value, [0, 8, 16]); mutate(changed); r.set(changed);
    await assert.rejects(r.adapter.syncDelta(attachmentBinding(bound.cursor)));
  }
});

test('three UI windows settle only the exact single unknown send and do not settle wrong or multiple turns', async () => {
  const old = twentyTurnHistory(), r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const value = appendWindowTurn(structuredClone(old), 11);
  r.set(observedUiWindows(value, [0, 8, 16]));
  const state = { ...attachmentBinding(bound.cursor), sendIntent: {
    id: 'long-history-send', status: 'unknown' as const, text: 'question 11' } };
  const exact = await r.adapter.syncDelta(state);
  assert.equal(exact.completedSend?.sendIntentId, 'long-history-send');
  assert.equal(exact.messages.length, 2);
  assert.equal((await r.adapter.syncDelta({ ...state, sendIntent: { ...state.sendIntent, text: 'other' } })).completedSend,
    undefined);
  const extra = appendWindowTurn(structuredClone(value), 12);
  r.set(observedUiWindows(extra, [0, 8, 16]));
  const ambiguous = await r.adapter.syncDelta(state);
  assert.equal(ambiguous.messages.length, 4);
  assert.equal(ambiguous.completedSend, undefined);
});

test('three UI windows prepare requires an unchanged history and consistent draft before commit', async () => {
  const old = twentyTurnHistory(), r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const next = appendWindowTurn(structuredClone(old), 11);
  const makeDraft = (source: any) => {
    const observed = observedUiWindows(source, [0, 8, 16]);
    for (const window of observed.uiWindows) {
      window.ui.composers[0].text = 'draft';
      for (const copy of window.bodyCopies.filter((item: any) => item.attachmentBefore)) {
        copy.attachmentBefore.ui.composerText = 'draft';
        copy.attachmentAfter.ui.composerText = 'draft';
      }
    }
    return observed;
  };
  const state = { ...attachmentBinding(bound.cursor), sendIntent: {
    id: 'three-window-send', status: 'sending' as const, text: 'draft' } };
  let checkpoints = 0;
  r.set(makeDraft(next));
  assert.deepEqual(await r.adapter.send(state, 'draft', { onBeforeSubmit: async () => { checkpoints++; } }),
    { status: 'rejected' });
  assert.equal(checkpoints, 0);
  assert.equal(r.actions.filter(action => action.kind === 'submit' && action.phase === 'commit').length, 0);
  r.set(observedUiWindows(next, [0, 8, 16]));
  const synced = await r.adapter.syncDelta(attachmentBinding(bound.cursor));
  r.set(makeDraft(next));
  assert.deepEqual(await r.adapter.send({ ...state, cursor: synced.nextCursor }, 'draft',
    { onBeforeSubmit: async () => { checkpoints++; } }), { status: 'unknown' });
  assert.equal(checkpoints, 1);
  assert.equal(r.actions.filter(action => action.kind === 'submit' && action.phase === 'commit').length, 1);
});

test('native latest window appends one turn while full fresh UI validates ten prior messages', async () => {
  const old = fiveTurnBundle();
  const r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const next = appendWindowTurn(structuredClone(old), 6);
  r.set(latestWindow(next));
  const delta = await r.adapter.syncDelta(attachmentBinding(bound.cursor));
  assert.equal(delta.messages.length, 2);
  const baseline = r.store.getBaseline(delta.nextCursor)!;
  assert.equal(baseline.messages.length, 12);
  assert.deepEqual(baseline.messages.slice(0, 10), r.store.getBaseline(bound.cursor)!.messages);
  assert.equal((baseline.observation as any).host.turns.length, 5);
});

test('empty formal page binds and accepts its first complete turn', async () => {
  const empty = raw(); empty.host.turns = []; empty.ui.headings = [];
  const r = rig(empty);
  const bound = await r.adapter.observeBinding(scope);
  assert.equal(r.store.getBaseline(bound.cursor)?.messages.length, 0);
  assert.equal((await r.adapter.syncDelta(binding(bound.cursor))).nextCursor, bound.cursor);
  r.set(raw());
  const first = await r.adapter.syncDelta(binding(bound.cursor));
  assert.equal(first.messages.length, 2);
});

test('successive native windows retain original attachment source and recheck old Copy', async () => {
  const old = fiveTurnBundle(), r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const six = appendWindowTurn(structuredClone(old), 6);
  r.set(latestWindow(six));
  const first = await r.adapter.syncDelta(attachmentBinding(bound.cursor));
  const prior = r.store.getBaseline(first.nextCursor)!;
  const originalAttachment = old.host.turns.at(-1).items[1].text;
  assert.equal((prior.observation as any).nativeSourceProjectionV1.messages[1].text, originalAttachment);
  assert.notEqual(prior.messages[1]?.text, originalAttachment);
  const seven = appendWindowTurn(structuredClone(six), 7);
  r.set(latestWindow(seven));
  const second = await r.adapter.syncDelta(attachmentBinding(first.nextCursor));
  assert.equal(second.messages.length, 2);
  const secondBaseline = r.store.getBaseline(second.nextCursor)!;
  assert.equal((secondBaseline.observation as any).host.turns.length, 5);
  assert.equal((secondBaseline.observation as any).nativeSourceProjectionV1.messages[1].text, originalAttachment);
  const eight = appendWindowTurn(structuredClone(seven), 8);
  r.set(latestWindow(eight));
  const third = await r.adapter.syncDelta(attachmentBinding(second.nextCursor));
  assert.equal(third.messages.length, 2);
  assert.deepEqual(r.store.getBaseline(third.nextCursor)!.messages.slice(0, old.ui.headings.length),
    r.store.getBaseline(bound.cursor)!.messages);
  const changed = latestWindow(eight);
  changed.bodyCopies[1].clipboardAfter += 'x';
  r.set(changed);
  await assert.rejects(r.adapter.syncDelta(attachmentBinding(second.nextCursor)));
});

test('native window rejects untrusted projection and zero overlap', async () => {
  const old = fiveTurnBundle(), r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const six = appendWindowTurn(structuredClone(old), 6);
  const window = latestWindow(six);
  const injected = structuredClone(window);
  injected.nativeSourceProjectionV1 = { messages: [] };
  r.set(injected);
  await assert.rejects(r.adapter.syncDelta(attachmentBinding(bound.cursor)));
  await assert.rejects(rig(window).adapter.observeBinding(scope));
  const gap = structuredClone(window);
  gap.host.turns = gap.host.turns.slice(0, 1);
  r.set(gap);
  await assert.rejects(r.adapter.syncDelta(attachmentBinding(bound.cursor)));
});

test('native window rejects overlap source changes, old UI edits and corrupt retained projection', async () => {
  const old = fiveTurnBundle(), r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const six = appendWindowTurn(structuredClone(old), 6);
  const changedSource = latestWindow(six);
  changedSource.host.turns.at(-1).items[0].content[0].text += ' changed';
  r.set(changedSource);
  await assert.rejects(r.adapter.syncDelta(attachmentBinding(bound.cursor)));
  const changedUi = latestWindow(six);
  changedUi.ui.headings[0].bubble.text += ' changed';
  r.set(changedUi);
  await assert.rejects(r.adapter.syncDelta(attachmentBinding(bound.cursor)));
  r.set(latestWindow(six));
  const first = await r.adapter.syncDelta(attachmentBinding(bound.cursor));
  const retained = r.store.getBaseline(first.nextCursor)!;
  (retained.observation as any).nativeSourceProjectionV1.messages[0].text += ' changed';
  const seven = appendWindowTurn(structuredClone(six), 7);
  r.set(latestWindow(seven));
  await assert.rejects(r.adapter.syncDelta(attachmentBinding(first.nextCursor)));
});

test('send prepare with shifted native window requires no append', async () => {
  const old = fiveTurnBundle(), r = rig(old);
  const bound = await r.adapter.observeBinding(scope);
  const six = appendWindowTurn(structuredClone(old), 6);
  const draft = (value: any) => {
    value.ui.composers[0].text = 'draft';
    for (const copy of value.bodyCopies.filter((item: any) => item.attachmentBefore)) {
      copy.attachmentBefore.ui.composerText = 'draft';
      copy.attachmentAfter.ui.composerText = 'draft';
    }
    return value;
  };
  const appended = draft(latestWindow(six));
  r.set(appended);
  const state = { ...attachmentBinding(bound.cursor), sendIntent: {
    id: 'window-send', status: 'sending' as const, text: 'draft' } };
  let checkpoints = 0;
  assert.deepEqual(await r.adapter.send(state, 'draft', { onBeforeSubmit: async () => { checkpoints++; } }),
    { status: 'rejected' });
  assert.equal(checkpoints, 0);
  assert.equal(r.actions.filter(action => action.kind === 'submit' && action.phase === 'commit').length, 0);
  const normal = latestWindow(six); r.set(normal);
  const synced = await r.adapter.syncDelta(attachmentBinding(bound.cursor));
  const unchanged = draft(latestWindow(six)); r.set(unchanged);
  assert.deepEqual(await r.adapter.send({ ...state, cursor: synced.nextCursor }, 'draft',
    { onBeforeSubmit: async () => { checkpoints++; } }), { status: 'unknown' });
  assert.equal(checkpoints, 1);
});

test('resource group binds ZIP first in DOM while consuming ordered host card tokens and stable hover versions', async () => {
  const value = groupedAttachmentRaw();
  const r = rig(value); const bound = await r.adapter.observeBinding(scope);
  const baseline = r.store.getBaseline(bound.cursor)!;
  assert.equal(baseline.messages[1]?.text, value.bodyCopies[1].clipboardAfter);
  const hover = structuredClone(value);
  for (const copy of [hover.bodyCopies[1].attachmentBefore, hover.bodyCopies[1].attachmentAfter]) {
    const row = copy.dom.blocks[1].rows[3]; row.labelState = 'open_file'; row.renderedText = 'second.md\nOpen file';
    copy.dom.blocks[1].renderedText = copy.dom.blocks[1].rows.map((r: any) => r.renderedText).join('\n') + '\nShow less';
  }
  hover.bodyCopies[1].before.text = hover.bodyCopies[1].attachmentBefore.dom.blocks.map((b: any) => b.renderedText).join('\n\n');
  hover.bodyCopies[1].after.text = hover.bodyCopies[1].before.text;
  hover.ui.headings[1].assistant.text = hover.bodyCopies[1].before.text;
  r.set(hover);
  const delta = await r.adapter.syncDelta(attachmentBinding(bound.cursor));
  assert.equal(delta.nextCursor, bound.cursor);
});

test('resource group refuses changed Copy and unsafe producer paths', async () => {
  for (const path of ['../README.md', 'x//README.md', 'x/%2e%2e/README.md', 'x\\README.md']) {
    const value = groupedAttachmentRaw();
    value.host.turns[1].items[1].text = value.host.turns[1].items[1].text.replace(
      'rcac_bundle_20261018_v1/README.md', path);
    await assert.rejects(rig(value).adapter.observeBinding(scope));
  }
  const value = groupedAttachmentRaw(); value.bodyCopies[1].clipboardAfter += 'x';
  await assert.rejects(rig(value).adapter.observeBinding(scope));
});
test('resource group Copy is bound to card order, source identity and stable before/after', async () => {
  for (const mutate of [
    (x: any) => { const rows = x.bodyCopies[1].attachmentBefore.dom.blocks[1].rows;
      [rows[0], rows[1]] = [rows[1], rows[0]];
      x.bodyCopies[1].attachmentBefore.dom.blocks[1].renderedText =
        rows.map((r: any) => r.renderedText).join('\n') + '\nShow less';
      x.bodyCopies[1].attachmentAfter = structuredClone(x.bodyCopies[1].attachmentBefore);
      x.bodyCopies[1].before.text = x.bodyCopies[1].attachmentBefore.dom.blocks.map((b: any) => b.renderedText).join('\n\n');
      x.bodyCopies[1].after.text = x.bodyCopies[1].before.text;
      x.ui.headings[1].assistant.text = x.bodyCopies[1].before.text; },
    (x: any) => { x.bodyCopies[1].attachmentBefore.dom.blocks[0].referenceIndex = '0';
      x.bodyCopies[1].attachmentAfter = structuredClone(x.bodyCopies[1].attachmentBefore); },
    (x: any) => { x.bodyCopies[1].attachmentAfter.dom.blocks[1].rows[0].filename = 'other.md'; },
    (x: any) => { x.bodyCopies[1].attachmentBefore.account.fields[0].value = 'other@example.test';
      x.bodyCopies[1].attachmentAfter = structuredClone(x.bodyCopies[1].attachmentBefore); },
    (x: any) => { x.bodyCopies[1].attachmentBefore.dom.message.attributes[1][1] = uid;
      x.bodyCopies[1].attachmentAfter = structuredClone(x.bodyCopies[1].attachmentBefore); },
    (x: any) => { x.bodyCopies[1].attachmentBefore.dom.turn.attributes[0][1] = uid;
      x.bodyCopies[1].attachmentAfter = structuredClone(x.bodyCopies[1].attachmentBefore); },
  ]) { const value = groupedAttachmentRaw(); mutate(value);
    await assert.rejects(rig(value).adapter.observeBinding(scope)); }
});

test('observed attachment Copy binds complete history and preserves stable versions across later turns', async () => {
  const full = attachmentRaw();
  const r = rig(firstAttachmentTurn(attachmentRaw()));
  const bound = await r.adapter.observeBinding(scope);
  const first = r.store.getBaseline(bound.cursor)!;
  r.set(full);
  const delta = await r.adapter.syncDelta(attachmentBinding(bound.cursor));
  assert.equal(delta.messages.length, 2);
  const baseline = r.store.getBaseline(delta.nextCursor)!;
  assert.deepEqual(baseline.messages.slice(0, 2), first.messages);
  assert.deepEqual(baseline.messages.map(m => m.text), full.bodyCopies.map((c: any) => c.clipboardAfter));
  assert.deepEqual(baseline.observation, full);
  assert.equal((await r.adapter.syncDelta(attachmentBinding(delta.nextCursor))).nextCursor, delta.nextCursor);
});

test('attachment reply settles only its exact unknown send and supports the following prepare', async () => {
  const r = rig(firstAttachmentTurn(attachmentRaw()));
  const bound = await r.adapter.observeBinding(scope);
  const full = attachmentRaw(); r.set(full);
  const state = { ...attachmentBinding(bound.cursor), sendIntent: {
    id: 'attachment-send', status: 'unknown' as const, text: full.bodyCopies[2].clipboardAfter } };
  const delta = await r.adapter.syncDelta(state);
  assert.equal(delta.completedSend?.sendIntentId, 'attachment-send');
  assert.equal(delta.completedSend?.nativeReplyMessageId, full.bodyCopies[3].before.nativeMessageId);
  const followup = '  Continue this same file topic.\n';
  full.ui.composers[0].text = followup;
  for (const c of full.bodyCopies.filter((x: any) => x.attachmentBefore)) {
    c.attachmentBefore.ui.composerText = followup; c.attachmentAfter.ui.composerText = followup;
  }
  let checkpointed = 0;
  const result = await r.adapter.send({ ...attachmentBinding(delta.nextCursor), sendIntent: {
    id: 'followup', status: 'sending', text: followup } }, followup,
  { onBeforeSubmit: async () => { checkpointed++; } });
  assert.equal(checkpointed, 1); assert.equal(result.status, 'unknown');
  assert.equal(r.actions.filter(a => a.kind === 'submit' && a.phase === 'commit').length, 1);
});

test('attachment evidence cannot settle a different unknown or mutate the accepted prefix', async () => {
  const r = rig(firstAttachmentTurn(attachmentRaw()));
  const bound = await r.adapter.observeBinding(scope);
  r.set(attachmentRaw());
  assert.equal((await r.adapter.syncDelta({ ...attachmentBinding(bound.cursor), sendIntent: {
    id: 'other', status: 'unknown', text: 'not this request' } })).completedSend, undefined);
  const changed = attachmentRaw();
  changed.host.turns[1].items[1].text += ' changed';
  changed.bodyCopies[1].clipboardAfter += ' changed';
  r.set(changed);
  await assert.rejects(r.adapter.syncDelta(attachmentBinding(bound.cursor)));
  assert.equal(r.actions.some(a => a.kind === 'submit'), false);
});

test('attachment source and Copy differences remain narrowly bound to actual inline identities', async () => {
  const mutations: ((x: any) => void)[] = [
    x => { x.bodyCopies[1].kind = 'native_message_copy_v1'; },
    x => { delete x.bodyCopies[1].attachmentBefore; },
    x => { x.bodyCopies[1].attachmentAfter.dom.blocks[0].filename = 'changed.zip'; },
    x => { x.bodyCopies[1].clipboardAfter += ' rewritten'; },
    x => { x.host.turns[1].items[1].text = `::chatgpt-content-reference{index="0" source_message_id="${x.bodyCopies[1].before.nativeMessageId}"}`; },
    x => { x.host.turns[1].items[1].text = x.host.turns[1].items[1].text.replace('index="1"', 'index="0"'); },
    x => { x.host.turns[1].items[1].text = x.host.turns[1].items[1].text.replace('sandbox:/mnt/data/preview.png', 'https://example.test/preview.png'); },
    x => { x.host.turns[1].items[1].text += ':chatgpt-content-reference{index="2"}'; },
    x => { x.host.turns[1].items[1].text = x.host.turns[1].items[1].text.replace('sandbox:/mnt/data/preview.png', 'sandbox:/mnt/data/other.png'); },
  ];
  for (const mutate of mutations) { const value = attachmentRaw(); mutate(value);
    await assert.rejects(rig(value).adapter.observeBinding(scope)); }
  for (const mutate of [
    (dom: any) => { dom.account = { fields: [{ label: 'Email', value: 'other@example.test' }] }; },
    (dom: any) => { dom.dom.turn.attributes[0][1] = uid; },
    (dom: any) => { dom.dom.message.attributes[0][1] = uid; },
    (dom: any) => { dom.ui.composerText = 'unrelated draft'; },
    (dom: any) => { dom.dom.blocks.reverse(); },
    (dom: any) => { dom.dom.blocks.pop(); },
    (dom: any) => { dom.dom.blocks.push({ kind: 'unknown' }); },
    (dom: any) => { dom.dom.blocks.push(structuredClone(dom.dom.blocks[0])); },
    (dom: any) => { dom.ui.turnStates.push('streaming'); },
  ]) { const value = attachmentRaw();
    mutate(value.bodyCopies[1].attachmentBefore);
    mutate(value.bodyCopies[1].attachmentAfter);
    await assert.rejects(rig(value).adapter.observeBinding(scope));
  }
});

test('native message Copy preserves rich Markdown and plugin mentions without rewriting host text', async () => {
  const user = '[@Tool](plugin://synthetic-tool) question';
  const answer = '| state | value |\n| --- | --- |\n| result | `recovery_required` |';
  const value = raw(user, answer);
  value.ui.headings[0].bubble = { text: 'Tool question', tags: ['P', 'A', 'SPAN'] };
  value.ui.headings[1].assistant = { text: 'statevalueresultrecovery_required',
    tags: ['P', 'TABLE', 'TBODY', 'TR', 'TH', 'TD', 'CODE'] };
  copyBody(value, 0, user); copyBody(value, 1, answer);
  const r = rig(value);
  const bound = await r.adapter.observeBinding(scope);
  const baseline = r.store.getBaseline(bound.cursor)!;
  assert.deepEqual(baseline.messages.map(m => m.text), [user, answer]);
  assert.deepEqual(baseline.observation, value);
  assert.equal((await r.adapter.syncDelta(binding(bound.cursor))).nextCursor, bound.cursor);
});

for (const index of ['0', '1', '999']) test(`exact same-message content reference ${index} uses native Copy body and retains original host reference`, async () => {
  const value = raw();
  const reference = `::chatgpt-content-reference{index="${index}" source_message_id="${aid}"}`;
  value.host.turns[0].items[1].text = reference;
  value.ui.headings[1].assistant = { text: 'Recovered answer', tags: ['P', 'STRONG', 'SPAN'] };
  copyBody(value, 1, '**Recovered answer**');
  const r = rig(value);
  const bound = await r.adapter.observeBinding(scope);
  const baseline = r.store.getBaseline(bound.cursor)!;
  assert.equal(baseline.messages[1]?.text, '**Recovered answer**');
  assert.equal((baseline.observation as any).host.turns[0].items[1].text, reference);
  const resolved = structuredClone(value); resolved.host.turns[0].items[1].text = '**Recovered answer**';
  r.set(resolved);
  assert.equal((await r.adapter.syncDelta(binding(bound.cursor))).nextCursor, bound.cursor);
});

test('native message Copy allows a passive circle tag without implying a downloaded attachment', async () => {
  const value = raw('question', 'Visible file discussion');
  value.host.turns[0].items[1].text = `::chatgpt-content-reference{index="0" source_message_id="${aid}"}`;
  value.ui.headings[1].assistant.tags.push('svg', 'circle');
  copyBody(value, 1, 'Visible file discussion');
  const r = rig(value), bound = await r.adapter.observeBinding(scope);
  assert.equal(r.store.getBaseline(bound.cursor)?.messages[1]?.text, 'Visible file discussion');
  assert.equal(r.actions.some(a => a.kind === 'download'), false);
});

test('native Copy accepts only observed passive math and SVG rect tags', async () => {
  const value = raw('question', 'Rendered equation and shape');
  value.ui.headings[1].assistant.tags = ['P', 'math', 'semantics', 'mrow', 'msub',
    'mi', 'mo', 'annotation', 'svg', 'rect', 'path'];
  copyBody(value, 1, 'Rendered equation and shape');
  const r = rig(value), bound = await r.adapter.observeBinding(scope);
  assert.equal(r.store.getBaseline(bound.cursor)?.messages[1]?.text, 'Rendered equation and shape');
  const unknown = structuredClone(value);
  unknown.ui.headings[1].assistant.tags.push('foreignObject');
  unknown.bodyCopies[0].before.tags.push('foreignObject');
  unknown.bodyCopies[0].after.tags.push('foreignObject');
  await assert.rejects(rig(unknown).adapter.observeBinding(scope));
});

function richNativeCopy() {
  const copied = 'Review\n\n```\nconst x = 1;return x;\n```';
  const value = raw('question', `::chatgpt-content-reference{index="0" source_message_id="${aid}"}`);
  const attributes = (src: string) => [
    { name: 'alt', value: '' }, { name: 'data-d-component', value: 'svg' },
    { name: 'decoding', value: 'async' }, { name: 'style', value: 'width: 100%;' },
    { name: 'src', value: src },
  ];
  const rich = { account: 'person@example.test', nativeSessionId: chat, nativeMessageId: `${aid} ${aid}`,
    role: 'assistant', bodyText: 'Reviewconst x = 1;return x;',
    inlineImages: [
      { index: 0, attributes: attributes('data:image/svg+xml;charset=utf-8,%3Csvg%20id%3D%22a%22%3E%3C%2Fsvg%3E') },
      { index: 1, attributes: attributes('data:image/svg+xml;charset=utf-8,%3Csvg%20id%3D%22b%22%3E%3C%2Fsvg%3E') },
    ],
    codeEditors: [{ index: 0, attributes: [
      { name: 'spellcheck', value: 'false' }, { name: 'autocorrect', value: 'off' },
      { name: 'autocapitalize', value: 'off' }, { name: 'writingsuggestions', value: 'false' },
      { name: 'translate', value: 'no' }, { name: 'contenteditable', value: 'true' },
      { name: 'style', value: 'tab-size: 4;' }, { name: 'class', value: 'cm-content' },
      { name: 'role', value: 'textbox' }, { name: 'aria-multiline', value: 'true' },
      { name: 'aria-label', value: 'Edit code' },
      { name: 'data-language', value: 'javascript' },
    ], lines: ['const x = 1;', 'return x;'], text: 'const x = 1;\nreturn x;' }],
  };
  value.ui.headings[1].assistant = { text: rich.bodyText,
    tags: ['P', 'PRE', 'CODE', 'DIV', 'IMG'], rich: structuredClone(rich) };
  value.ui.media = [{ tag: 'IMG' }, { tag: 'IMG' }];
  value.bodyCopies = [{ kind: 'native_message_rich_copy_v1',
    before: { nativeSessionId: chat, nativeMessageId: `${aid} ${aid}`, role: 'assistant',
      text: rich.bodyText, tags: value.ui.headings[1].assistant.tags },
    after: { nativeSessionId: chat, nativeMessageId: `${aid} ${aid}`, role: 'assistant',
      text: rich.bodyText, tags: value.ui.headings[1].assistant.tags },
    richBefore: structuredClone(rich), richAfter: structuredClone(rich),
    clipboardBefore: 'repoconduit-native-message-copy-v1', clipboardAfter: copied }];
  return value;
}

test('rich native Copy binds inline SVG and full editor DOM while retaining native text', async () => {
  const value = richNativeCopy(), r = rig(value);
  const bound = await r.adapter.observeBinding(scope);
  const baseline = r.store.getBaseline(bound.cursor)!;
  assert.equal(baseline.messages[1]?.text, value.bodyCopies[0].clipboardAfter);
  assert.deepEqual(baseline.observation, value);
  assert.equal((await r.adapter.syncDelta(binding(bound.cursor))).nextCursor, bound.cursor);
  const changed = structuredClone(value);
  changed.bodyCopies[0].richBefore.inlineImages[0].attributes[4].value += 'A';
  changed.bodyCopies[0].richAfter.inlineImages[0].attributes[4].value += 'A';
  changed.ui.headings[1].assistant.rich.inlineImages[0].attributes[4].value += 'A';
  r.set(changed);
  await assert.rejects(r.adapter.syncDelta(binding(bound.cursor)));
});

test('SQLite reopen retains rich native evidence and message version', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-host-rich-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  let base: SqliteStore | undefined;
  let store: HostConversationSqlite | undefined;
  try {
    base = new SqliteStore(join(dir, 'state.sqlite'));
    protectNewDataDirectory(dir);
    base.insertWorkspace({ id: 'ws', name: 'Workspace', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertCollaboration({ id: 'collab', workspaceId: 'ws', openedBy: 'owner', purpose: 'question',
      hostThreadId: null, state: 'open' });
    store = new HostConversationSqlite(dir);
    const observed = richNativeCopy();
    let adapter = new ChatgptHostConversation(store, { request: async () => observed });
    const bound = await adapter.observeBinding(scope);
    const version = store.getBaseline(bound.cursor)!.messages[1]!.version;
    store.close(); store = new HostConversationSqlite(dir);
    adapter = new ChatgptHostConversation(store, { request: async () => observed });
    assert.equal(store.getBaseline(bound.cursor)?.messages[1]?.version, version);
    assert.deepEqual(store.getBaseline(bound.cursor)?.observation, observed);
    assert.equal((await adapter.syncDelta(binding(bound.cursor, bound.accountId))).nextCursor, bound.cursor);
  } finally {
    store?.close(); base?.close();
    assert.match(relative(resolve(process.platform === 'win32' ? homedir() : tmpdir()), resolve(outer)),
      /^rcac-host-rich-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  }
});

test('rich native Copy refuses changed image bytes, order, owner, editor or unsupported media', async () => {
  const mutate = [
    (v: any) => { v.bodyCopies[0].richAfter.inlineImages[0].attributes[4].value += 'A'; },
    (v: any) => { v.bodyCopies[0].richAfter.inlineImages.reverse(); },
    (v: any) => { v.bodyCopies[0].richBefore.nativeMessageId = uid; },
    (v: any) => { v.bodyCopies[0].before.nativeMessageId = `${aid} ${uid}`; },
    (v: any) => { v.bodyCopies[0].richBefore.account = 'other@example.test'; },
    (v: any) => { v.ui.headings[1].assistant.rich.inlineImages.reverse(); },
    (v: any) => { v.bodyCopies[0].richBefore.codeEditors[0].lines[0] = 'changed'; },
    (v: any) => { v.bodyCopies[0].richAfter.codeEditors[0].text = 'changed'; },
    (v: any) => { for (const rich of [v.bodyCopies[0].richBefore,
      v.bodyCopies[0].richAfter, v.ui.headings[1].assistant.rich]) {
      rich.codeEditors.push({ ...structuredClone(rich.codeEditors[0]), index: 1 });
    } },
    (v: any) => { v.bodyCopies[0].richBefore.codeEditors[0].attributes[7].value = 'other-editor';
      v.bodyCopies[0].richAfter.codeEditors[0].attributes[7].value = 'other-editor';
      v.ui.headings[1].assistant.rich.codeEditors[0].attributes[7].value = 'other-editor'; },
    (v: any) => { v.bodyCopies[0].richBefore.codeEditors = []; v.bodyCopies[0].richAfter.codeEditors = [];
      v.ui.headings[1].assistant.rich.codeEditors = []; },
    (v: any) => { v.bodyCopies[0].clipboardAfter = 'Review without code'; },
    (v: any) => { v.bodyCopies[0].richBefore.inlineImages[0].attributes[4].value = 'https://example.test/a.svg';
      v.bodyCopies[0].richAfter.inlineImages[0].attributes[4].value = 'https://example.test/a.svg';
      v.ui.headings[1].assistant.rich.inlineImages[0].attributes[4].value = 'https://example.test/a.svg'; },
    (v: any) => { v.bodyCopies[0].richBefore.inlineImages[0].attributes[1].value = 'other';
      v.bodyCopies[0].richAfter.inlineImages[0].attributes[1].value = 'other';
      v.ui.headings[1].assistant.rich.inlineImages[0].attributes[1].value = 'other'; },
    (v: any) => { v.host.turns[0].items[1].text = 'Conflicting full host body'; },
    (v: any) => { v.host.turns[0].items[1].text =
      `::chatgpt-content-reference{index="0" source_message_id="${uid}"}`; },
    (v: any) => { v.ui.media.pop(); },
    (v: any) => { v.ui.media.push({ tag: 'IMG' }); },
    (v: any) => { v.ui.media[0].tag = 'VIDEO'; },
  ];
  for (const [index, change] of mutate.entries()) {
    const value = richNativeCopy(); change(value);
    await assert.rejects(rig(value).adapter.observeBinding(scope), /./, `rich mutation ${index}`);
  }
});

test('native Copy rejects stale clipboard, changed source, conflicting API body and unsupported markup', async () => {
  for (const mutate of [
    (x: any) => { x.bodyCopies[0].clipboardBefore = 'answer'; },
    (x: any) => { x.bodyCopies[0].clipboardBefore = 'synthetic-unrelated-secret'; },
    (x: any) => { x.bodyCopies[0].after.text = 'changed'; },
    (x: any) => { x.bodyCopies[0].after.nativeMessageId = uid; },
    (x: any) => { x.bodyCopies[0].before.nativeSessionId = uid; },
    (x: any) => { x.bodyCopies[0].before.role = 'user'; },
    (x: any) => { x.bodyCopies[0].clipboardAfter = 'conflicting answer'; },
    (x: any) => { x.bodyCopies.push(structuredClone(x.bodyCopies[0])); },
    (x: any) => { x.bodyCopies[0].kind = 'clipboard_text'; },
    (x: any) => { x.ui.headings[1].assistant.tags = ['SCRIPT'];
      x.bodyCopies[0].before.tags = ['SCRIPT']; x.bodyCopies[0].after.tags = ['SCRIPT']; },
  ]) {
    const value = raw(); copyBody(value, 1, 'answer'); mutate(value);
    await assert.rejects(rig(value).adapter.observeBinding(scope));
  }
});

test('content reference cannot supply a body without Copy or select another message', async () => {
  for (const [source, prefix, index] of [[aid, '', '0'], [uid, '', '0'],
    [aid, ' \n', '0'], [aid, '', '01'], [aid, '', '-1'], [aid, '', '1000']] as const) {
    const value = raw();
    const reference = `${prefix}::chatgpt-content-reference{index="${index}" source_message_id="${source}"}`;
    value.host.turns[0].items[1].text = reference;
    value.ui.headings[1].assistant.text = reference;
    await assert.rejects(rig(value).adapter.observeBinding(scope));
    copyBody(value, 1, 'answer');
    if (source !== aid || prefix || index !== '0') await assert.rejects(rig(value).adapter.observeBinding(scope));
    value.bodyCopies[0].clipboardAfter = reference;
    await assert.rejects(rig(value).adapter.observeBinding(scope));
  }
});

test('native Copy does not bypass account, pagination, prior-history or pending-send guards', async () => {
  const value = raw(); copyBody(value, 1, 'answer');
  const r = rig(value);
  const bound = await r.adapter.observeBinding(scope);
  for (const mutate of [
    (x: any) => { x.account.labels = ['Change email: other@example.test']; },
    (x: any) => { x.host.page.hasMore = true; x.host.page.nextCursor = 'next'; },
    (x: any) => { x.host.turns[0].items[1].text = 'edited';
      x.ui.headings[1].assistant.text = 'edited'; x.bodyCopies = []; copyBody(x, 1, 'edited'); },
  ]) {
    const changed = structuredClone(value); mutate(changed); r.set(changed);
    await assert.rejects(r.adapter.syncDelta(binding(bound.cursor)));
  }
  r.set(value);
  const delta = await r.adapter.syncDelta({ ...binding(bound.cursor),
    sendIntent: { id: 'unknown', text: 'not sent', status: 'unknown' } });
  assert.equal(delta.completedSend, undefined);
  assert.equal(r.actions.some(a => a.kind === 'submit'), false);
});

test('bind persists trusted account and exact initial baseline; unchanged sync reuses cursor', async () => {
  const r = rig();
  const observed = await r.adapter.observeBinding(scope);
  assert.equal(observed.providerId, 'chatgpt-host-web');
  assert.equal(observed.accountId, 'opaque:person@example.test');
  assert.equal(observed.nativeSessionId, chat);
  const delta = await r.adapter.syncDelta(binding(observed.cursor));
  assert.equal(delta.nextCursor, observed.cursor);
  assert.deepEqual(delta.messages, []);
  assert.equal(r.actions.length, 2);
});

test('existing Project chat binds the opaque native chat and preserves history checks', async () => {
  const value = raw();
  value.ui.url = `https://chatgpt.com/g/${project}/c/${chat}`;
  const r = rig(value);
  const observed = await r.adapter.observeBinding(scope);
  assert.equal(observed.nativeSessionId, chat);
  assert.equal(observed.accountId, 'opaque:person@example.test');
  assert.deepEqual((await r.adapter.syncDelta(binding(observed.cursor))).messages, []);
  const mismatch = structuredClone(value);
  mismatch.host.turns[0].items[1].text = 'other answer';
  r.set(mismatch);
  await assert.rejects(r.adapter.syncDelta(binding(observed.cursor)));
});

test('Project chat with observed lowercase slug binds the same opaque native chat', async () => {
  const value = raw();
  value.ui.url = `https://chatgpt.com/g/${project}-physicsairadar/c/${chat}`;
  const r = rig(value);
  const observed = await r.adapter.observeBinding(scope);
  assert.equal(observed.nativeSessionId, chat);
  assert.equal(observed.accountId, 'opaque:person@example.test');
  assert.deepEqual((await r.adapter.syncDelta(binding(observed.cursor))).messages, []);
});

test('Project chat rejects malformed, uppercase, oversized or suffixed slug routes', async () => {
  for (const url of [
    `https://chatgpt.com/g/${project}-/c/${chat}`,
    `https://chatgpt.com/g/${project}-PhysicsAIRadar/c/${chat}`,
    `https://chatgpt.com/g/${project}-physics--airadar/c/${chat}`,
    `https://chatgpt.com/g/${project}-${'a'.repeat(65)}/c/${chat}`,
    `https://chatgpt.com/g/${project}-physicsairadar/c/${chat}#section`,
  ]) {
    const value = raw(); value.ui.url = url;
    await assert.rejects(rig(value).adapter.observeBinding(scope), /Native conversation mismatch/, url);
  }
});

test('Project chat route rejects mismatched native chat and non-chat URLs', async () => {
  const wrongChat = '66666666-6666-4666-8666-666666666666';
  for (const [url, reason] of [
    [`https://chatgpt.com/g/${project}/project`, /Native conversation mismatch/],
    [`https://chatgpt.com/g/g-p-nothex/c/${chat}`, /Native conversation mismatch/],
    [`https://chatgpt.com/g/${project}/c/${wrongChat}`, /host thread identity mismatch/],
    [`https://example.test/g/${project}/c/${chat}`, /Native conversation mismatch/],
    [`https://chatgpt.com/g/${project}/c/${chat}?x=1`, /Native conversation mismatch/],
  ] as const) {
    const value = raw(); value.ui.url = url;
    await assert.rejects(rig(value).adapter.observeBinding(scope), reason, url);
  }
});

test('bind rejects account, page, UI and host uncertainty', async () => {
  const mutations = [
    (x: any) => { x.account.labels = []; },
    (x: any) => { x.account.labels = ['Change email: a@example.test', 'Change email: b@example.test']; },
    (x: any) => { x.ui.url = `https://chatgpt.com/c/local-chatgpt-${chat}`; },
    (x: any) => { x.ui.dialogs = [{ label: 'Share', modal: null }]; },
    (x: any) => { x.ui.composers = []; },
    (x: any) => { x.ui.media = ['img']; },
    (x: any) => { x.ui.buttons = [{ label: 'Load older', disabled: false }]; },
    (x: any) => { x.host.page.hasMore = true; x.host.page.nextCursor = 'next'; },
    (x: any) => { x.host.turns[0].items[1].truncated = true; },
    (x: any) => { x.ui.headings[1].assistant.text = 'different'; },
    (x: any) => { x.ui.headings[1].selection.messageId = uid; },
    (x: any) => { x.ui.headings[1].assistant.tags = ['DIV']; },
    (x: any) => { x.host.thread.status.type = 'generating'; },
  ];
  for (const mutate of mutations) {
    const value = raw(); mutate(value);
    await assert.rejects(rig(value).adapter.observeBinding(scope));
  }
});

test('observed conversation toolbar More and More actions are not pagination evidence', async () => {
  const value = raw();
  value.ui.buttons = [{ label: 'More', disabled: false }, { label: 'More actions', disabled: false },
    { label: 'See versions', disabled: false }, { label: 'Add files and more', disabled: false }];
  assert.equal((await rig(value).adapter.observeBinding(scope)).nativeSessionId, chat);
});

test('Settings Email field maps to the same opaque account as Change email label', async () => {
  const first = await rig(raw()).adapter.observeBinding(scope);
  const value = raw();
  value.account = { fields: [{ label: 'Email', value: 'person@example.test' }] };
  const second = await rig(value).adapter.observeBinding(scope);
  assert.equal(second.accountId, first.accountId);
});

test('Settings Email field rejects ambiguity and unsupported account markup', async () => {
  const changes = [
    (x: any) => { x.account = { fields: [] }; },
    (x: any) => { x.account = { fields: [{ label: 'Name', value: 'person@example.test' }] }; },
    (x: any) => { x.account = { fields: [{ label: 'Email', value: '' }] }; },
    (x: any) => { x.account = { fields: [{ label: 'Email', value: 'not-email' }] }; },
    (x: any) => { x.account = { fields: [{ label: 'Email', value: 'person@example.test' },
      { label: 'Email', value: 'other@example.test' }] }; },
    (x: any) => { x.account = { fields: [{ label: 'Email', value: 'person@example.test', source: 'guess' }] }; },
    (x: any) => { x.account = { labels: ['Change email: person@example.test'],
      fields: [{ label: 'Email', value: 'person@example.test' }] }; },
  ];
  for (const mutate of changes) {
    const value = raw(); mutate(value);
    await assert.rejects(rig(value).adapter.observeBinding(scope));
  }
});

test('sync rejects scope/account and prior-message edits', async () => {
  const r = rig();
  const b = binding((await r.adapter.observeBinding(scope)).cursor);
  await assert.rejects(r.adapter.syncDelta({ ...b, workspaceId: 'other' }));
  const changed = raw(); changed.account.labels = ['Change email: other@example.test']; r.set(changed);
  await assert.rejects(r.adapter.syncDelta(b));
  r.set(raw('edited', 'answer'));
  await assert.rejects(r.adapter.syncDelta(b));
});

test('prepare validates typed composer and checkpoint precedes commit; send remains unknown', async () => {
  const r = rig();
  const b = binding((await r.adapter.observeBinding(scope)).cursor);
  const intent = { id: 'intent-1', text: 'next', status: 'sending' as const };
  r.set(raw('question', 'answer', 'next'));
  const result = await r.adapter.send({ ...b, sendIntent: intent }, 'next', {
    onBeforeSubmit: async () => { assert.equal(r.actions.at(-1)?.kind, 'submit');
      assert.equal((r.actions.at(-1) as any).phase, 'prepare'); },
  });
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal((r.actions.at(-1) as any).phase, 'commit');
  await assert.rejects(r.adapter.send({ ...b, sendIntent: intent }, 'next'));
});

test('failed prepare never releases commit', async () => {
  const r = rig();
  const b = binding((await r.adapter.observeBinding(scope)).cursor);
  r.set(raw());
  assert.deepEqual(await r.adapter.send({ ...b, sendIntent: { id: 'intent', text: 'next', status: 'sending' } },
    'next', { onBeforeSubmit: async () => assert.fail('Rejected prepare reached checkpoint') }), { status: 'rejected' });
  assert.equal(r.actions.some((action) => action.kind === 'submit' && action.phase === 'commit'), false);
});

test('returned invalid prepare is definitively rejected without normalizing text or releasing commit', async () => {
  const changes = [
    (x: any) => { x.ui.composers[0].text = 'next\n\n'; },
    (x: any) => { x.account.labels = ['Change email: other@example.test']; },
    (x: any) => { x.ui.url = 'https://chatgpt.com/c/66666666-6666-4666-8666-666666666666'; },
    (x: any) => { x.host.turns[0].items[0].content[0].text = 'changed'; x.ui.headings[0].bubble.text = 'changed'; },
    (x: any) => { delete x.host; },
  ];
  for (const change of changes) {
    const r = rig();
    const b = binding((await r.adapter.observeBinding(scope)).cursor);
    const prepared = raw('question', 'answer', 'next\n'); change(prepared); r.set(prepared);
    assert.deepEqual(await r.adapter.send({ ...b, sendIntent: { id: 'intent', text: 'next\n', status: 'sending' } },
      'next\n', { onBeforeSubmit: async () => assert.fail('Invalid observation reached checkpoint') }), { status: 'rejected' });
    assert.equal(r.actions.filter(a => a.kind === 'submit' && a.phase === 'commit').length, 0);
  }
});

test('prepare transport and checkpoint or commit ambiguity still throw for application unknown handling', async () => {
  for (const failure of ['prepare_transport', 'checkpoint', 'commit_transport', 'commit_payload']) {
    const store = new MemoryStore(); const actions: HostAction[] = [];
    const adapter = new ChatgptHostConversation(store, { request: async action => {
      actions.push(action);
      if (action.kind === 'observe') return raw();
      if (action.kind === 'submit' && action.phase === 'prepare') {
        if (failure === 'prepare_transport') throw new Error('lost prepare transport');
        return raw('question', 'answer', 'next');
      }
      if (failure === 'commit_transport') throw new Error('lost commit transport');
      return { unexpected: true };
    } });
    const b = binding((await adapter.observeBinding(scope)).cursor); let checkpoints = 0;
    await assert.rejects(adapter.send({ ...b, sendIntent: { id: 'intent', text: 'next', status: 'sending' } },
      'next', { onBeforeSubmit: async () => { checkpoints++; if (failure === 'checkpoint') throw new Error('checkpoint changed'); } }));
    assert.equal(checkpoints, failure === 'prepare_transport' ? 0 : 1);
    assert.equal(actions.filter(a => a.kind === 'submit' && a.phase === 'commit').length,
      ['prepare_transport', 'checkpoint'].includes(failure) ? 0 : 1);
  }
});

test('append creates candidate without adopting binding cursor and pairs only exact pending send', async () => {
  const r = rig();
  const observed = await r.adapter.observeBinding(scope);
  const next = raw();
  const user2 = '44444444-4444-4444-8444-444444444444';
  const assistant2 = '55555555-5555-4555-8555-555555555555';
  next.host.turns.push({ id: 'turn-2', status: 'completed', items: [
    { type: 'userMessage', id: user2, content: [{ type: 'text', text: 'next' }] },
    { type: 'agentMessage', id: assistant2, text: 'reply' },
  ] });
  next.ui.headings.push({ label: 'You said:', roleAttribute: null, messageIds: user2,
    bubble: { text: 'next', tags: [] }, assistant: null, selection: null },
  { label: 'ChatGPT said:', roleAttribute: 'assistant', messageIds: `${assistant2} ${assistant2}`,
    bubble: null, assistant: { text: 'reply', tags: ['P', 'SPAN'] },
    selection: { conversationId: chat, messageId: assistant2 } });
  r.set(next);
  const b = binding(observed.cursor);
  const delta = await r.adapter.syncDelta({ ...b, sendIntent: { id: 'intent', text: 'next', status: 'unknown' } });
  assert.notEqual(delta.nextCursor, observed.cursor);
  assert.deepEqual(delta.completedSend, { sendIntentId: 'intent', nativeUserMessageId: user2,
    nativeReplyMessageId: assistant2 });
  assert.equal(r.store.getBaseline(delta.nextCursor)?.parentCursor, observed.cursor);
  assert.equal(b.cursor, observed.cursor);
  const replay = await r.adapter.syncDelta(binding(delta.nextCursor));
  assert.equal(replay.nextCursor, delta.nextCursor);
  assert.deepEqual(replay.messages, []);
  const wrong = await r.adapter.syncDelta({ ...b, sendIntent: { id: 'other', text: 'different', status: 'unknown' } });
  assert.equal(wrong.completedSend, undefined);
});

test('sync rejects reordered, forked and unsupported UI history', async () => {
  const r = rig();
  const b = binding((await r.adapter.observeBinding(scope)).cursor);
  for (const mutate of [
    (x: any) => { x.ui.url = `https://chatgpt.com/c/66666666-6666-4666-8666-666666666666`; },
    (x: any) => { x.ui.headings.reverse(); },
    (x: any) => { x.host.turns[0].items.reverse(); },
    (x: any) => { x.ui.headings[0].messageIds = `${uid} ${aid}`; },
    (x: any) => { x.ui.headings[0].bubble.tags = ['SPAN']; },
  ]) {
    const changed = raw(); mutate(changed); r.set(changed);
    await assert.rejects(r.adapter.syncDelta(b));
  }
});

test('SQLite reopen retains original and unadopted candidate baseline', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-host-adapter-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  let base: SqliteStore | undefined;
  let store: HostConversationSqlite | undefined;
  try {
    base = new SqliteStore(join(dir, 'state.sqlite'));
    protectNewDataDirectory(dir);
    base.insertWorkspace({ id: 'ws', name: 'Workspace', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertCollaboration({ id: 'collab', workspaceId: 'ws', openedBy: 'owner', purpose: 'question',
      hostThreadId: null, state: 'open' });
    store = new HostConversationSqlite(dir);
    let current = raw();
    let adapter = new ChatgptHostConversation(store, { request: async () => current });
    const bound = await adapter.observeBinding(scope);
    const old = binding(bound.cursor, bound.accountId);
    const user2 = '44444444-4444-4444-8444-444444444444';
    const assistant2 = '55555555-5555-4555-8555-555555555555';
    current = raw();
    current.host.turns.push({ id: 'turn-2', status: 'completed', items: [
      { type: 'userMessage', id: user2, content: [{ type: 'text', text: 'next' }] },
      { type: 'agentMessage', id: assistant2, text: 'reply' },
    ] });
    current.ui.headings.push({ label: 'You said:', roleAttribute: null, messageIds: user2,
      bubble: { text: 'next', tags: [] }, assistant: null, selection: null },
    { label: 'ChatGPT said:', roleAttribute: 'assistant', messageIds: `${assistant2} ${assistant2}`,
      bubble: null, assistant: { text: 'reply', tags: ['P', 'SPAN'] },
      selection: { conversationId: chat, messageId: assistant2 } });
    const candidate = await adapter.syncDelta(old);
    store.close(); store = new HostConversationSqlite(dir);
    adapter = new ChatgptHostConversation(store, { request: async () => current });
    assert.equal(store.getBaseline(candidate.nextCursor)?.parentCursor, bound.cursor);
    assert.equal((await adapter.syncDelta(old)).messages.length, 2);
    assert.equal((await adapter.syncDelta({ ...old, cursor: candidate.nextCursor })).messages.length, 0);
  } finally {
    store?.close(); base?.close();
    assert.match(relative(resolve(process.platform === 'win32' ? homedir() : tmpdir()), resolve(outer)),
      /^rcac-host-adapter-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  }
});

test('SQLite reopen retains original native projection across a second shifted window', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-host-window-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  let base: SqliteStore | undefined;
  let store: HostConversationSqlite | undefined;
  try {
    base = new SqliteStore(join(dir, 'state.sqlite'));
    protectNewDataDirectory(dir);
    base.insertWorkspace({ id: 'ws', name: 'Workspace', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertCollaboration({ id: 'collab', workspaceId: 'ws', openedBy: 'owner', purpose: 'question',
      hostThreadId: null, state: 'open' });
    store = new HostConversationSqlite(dir);
    const old = fiveTurnBundle();
    let current = old;
    let adapter = new ChatgptHostConversation(store, { request: async () => current });
    const bound = await adapter.observeBinding(scope);
    const state = { ...attachmentBinding(bound.cursor), accountId: bound.accountId };
    const six = appendWindowTurn(structuredClone(old), 6);
    current = latestWindow(six);
    const first = await adapter.syncDelta(state);
    store.close(); store = new HostConversationSqlite(dir);
    const seven = appendWindowTurn(structuredClone(six), 7);
    current = latestWindow(seven);
    adapter = new ChatgptHostConversation(store, { request: async () => current });
    const second = await adapter.syncDelta({ ...state, cursor: first.nextCursor });
    assert.equal(second.messages.length, 2);
    assert.deepEqual(store.getBaseline(second.nextCursor)?.messages.slice(0, 10),
      store.getBaseline(bound.cursor)?.messages);
    assert.equal(((store.getBaseline(second.nextCursor)?.observation as any).nativeSourceProjectionV1.messages as any[]).length, 14);
  } finally {
    store?.close(); base?.close();
    assert.match(relative(resolve(process.platform === 'win32' ? homedir() : tmpdir()), resolve(outer)),
      /^rcac-host-window-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  }
});

test('SQLite reopen retains three observed UI windows and original native source', async () => {
  const outer = mkdtempSync(join(process.platform === 'win32' ? homedir() : tmpdir(), 'rcac-host-three-window-'));
  const dir = join(outer, 'data');
  mkdirSync(dir, { mode: 0o700 });
  let base: SqliteStore | undefined;
  let store: HostConversationSqlite | undefined;
  try {
    base = new SqliteStore(join(dir, 'state.sqlite'));
    protectNewDataDirectory(dir);
    base.insertWorkspace({ id: 'ws', name: 'Workspace', canonicalRoot: dir, registeredBy: 'owner' });
    base.insertCollaboration({ id: 'collab', workspaceId: 'ws', openedBy: 'owner', purpose: 'question',
      hostThreadId: null, state: 'open' });
    store = new HostConversationSqlite(dir);
    const old = twentyTurnHistory();
    let current: any = old;
    let adapter = new ChatgptHostConversation(store, { request: async () => current });
    const bound = await adapter.observeBinding(scope);
    const state = { ...attachmentBinding(bound.cursor), accountId: bound.accountId };
    const next = appendWindowTurn(structuredClone(old), 11);
    current = observedUiWindows(next, [0, 8, 16]);
    const first = await adapter.syncDelta(state);
    assert.equal(((store.getBaseline(first.nextCursor)?.observation as any).uiWindows as any[]).length, 3);
    store.close(); store = new HostConversationSqlite(dir);
    const later = appendWindowTurn(structuredClone(next), 12);
    current = observedUiWindows(later, [0, 8, 16]);
    adapter = new ChatgptHostConversation(store, { request: async () => current });
    const second = await adapter.syncDelta({ ...state, cursor: first.nextCursor });
    assert.equal(second.messages.length, 2);
    assert.deepEqual(store.getBaseline(second.nextCursor)?.messages.slice(0, 20),
      store.getBaseline(bound.cursor)?.messages);
    assert.equal(((store.getBaseline(second.nextCursor)?.observation as any).nativeSourceProjectionV1.messages as any[]).length, 24);
  } finally {
    store?.close(); base?.close();
    assert.match(relative(resolve(process.platform === 'win32' ? homedir() : tmpdir()), resolve(outer)),
      /^rcac-host-three-window-[A-Za-z0-9_-]{6}$/);
    rmSync(outer, { recursive: true, force: true });
  }
});
