/* eslint-disable @typescript-eslint/no-explicit-any -- malformed native DOM observations exercise the boundary */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatgptHostConversation, type HostAction } from '../../src/adapters/chatgpt/host-conversation.js';
import { type HostBaseline, type HostBaselineInput } from '../../src/adapters/storage/host-conversation-sqlite.js';
import type { SessionState } from '../../src/core/collaboration/session-control.js';

const chat = '11111111-1111-4111-8111-111111111111';
const uid = '22222222-2222-4222-8222-222222222222';
const aid = '33333333-3333-4333-8333-333333333333';
const appId = 'asdk_app_6ab8b97ee7c081918e275108762a4be7';
const slug = 'repoconduit-capability-probe';
const display = 'RepoConduit capability probe';
const appPath = `app://${appId}`;
const suffix = ' continue the investigation';
const canonical = `[$${slug}](${appPath})${suffix}`;
const scope = { workspaceId: 'ws', collaborationId: 'collab' };

function observation(composer: any = { text: '' }): any {
  return {
    account: { labels: ['Change email: person@example.test'] },
    ui: { url: `https://chatgpt.com/c/${chat}`, dialogs: [], buttons: [], media: [],
      composers: [composer], headings: [
        { label: 'You said:', roleAttribute: null, messageIds: uid,
          bubble: { text: 'question', tags: [] }, assistant: null, selection: null },
        { label: 'ChatGPT said:', roleAttribute: 'assistant', messageIds: `${aid} ${aid}`,
          bubble: null, assistant: { text: 'answer', tags: ['P', 'SPAN'] },
          selection: { conversationId: chat, messageId: aid } },
      ] },
    host: { schemaVersion: 1, thread: { id: chat, kind: 'chatgpt', status: { type: 'idle' } },
      page: { order: 'oldest_first', limit: 100, nextCursor: null, hasMore: false },
      turns: [{ id: 'turn-1', status: 'completed', items: [
        { type: 'userMessage', id: uid, content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', id: aid, text: 'answer' },
      ] }] },
  };
}

function nativeComposer(trailing = suffix): any {
  const attributes = [
    ['app-mention-name', slug],
    ['app-mention-display-name', display],
    ['app-mention-path', appPath],
    ['app-mention-icon', `connectors://${appId}/logo?theme=light`],
    ['app-mention-brand-color', ''],
    ['data-prompt-link-href', appPath],
    ['data-prompt-link-label', `$${slug}`],
    ['class', 'Mention-hIgCkC'],
    ['data-appearance', 'inline-mention'],
    ['data-layout', 'inline-flow'],
    ['data-font-weight', 'medium'],
    ['data-tone', 'accent'],
    ['data-interactive', ''],
    ['data-underline-on-hover', ''],
    ['contenteditable', 'false'],
  ].map(([name, value]) => ({ name, value }));
  return { text: display + trailing, nodes: [{ tag: 'P', text: display + trailing, attributes: [],
    children: [{ tag: 'SPAN', text: display, attributes },
      { tag: '#text', text: trailing, attributes: [] }] }] };
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

async function rig() {
  const store = new MemoryStore();
  let current = observation();
  const actions: HostAction[] = [];
  const adapter = new ChatgptHostConversation(store, { request: async action => {
    actions.push(action);
    return action.kind === 'submit' && action.phase === 'commit' ? { toolResult: null } : current;
  } });
  const observed = await adapter.observeBinding(scope);
  const binding: SessionState = { bindingId: 'binding', ...scope, providerId: 'chatgpt-host-web',
    accountId: observed.accountId, nativeSessionId: chat, cursor: observed.cursor,
    control: 'host_controlled', epoch: 0, revision: 0 };
  return { adapter, binding, actions, set(value: any) { current = value; } };
}

async function send(r: Awaited<ReturnType<typeof rig>>, intentText: string) {
  let checkpoints = 0;
  const result = await r.adapter.send({ ...r.binding,
    sendIntent: { id: 'mention-intent', text: intentText, status: 'sending' } }, intentText,
  { onBeforeSubmit: async () => { checkpoints++; } });
  return { result, checkpoints,
    prepares: r.actions.filter(a => a.kind === 'submit' && a.phase === 'prepare').length,
    commits: r.actions.filter(a => a.kind === 'submit' && a.phase === 'commit').length };
}

test('observed leading native app chip matches exact canonical persisted intent and commits once', async () => {
  const r = await rig();
  r.set(observation(nativeComposer()));
  assert.deepEqual(await send(r, canonical), {
    result: { status: 'unknown' }, checkpoints: 1, prepares: 1, commits: 1,
  });
});

test('legacy plain composer text still prepares and commits', async () => {
  const r = await rig();
  r.set(observation({ text: 'continue the investigation' }));
  assert.deepEqual(await send(r, 'continue the investigation'), {
    result: { status: 'unknown' }, checkpoints: 1, prepares: 1, commits: 1,
  });
});

test('literal app Markdown without an observed native chip cannot commit', async () => {
  const r = await rig();
  r.set(observation({ text: canonical }));
  assert.deepEqual(await send(r, canonical), {
    result: { status: 'rejected' }, checkpoints: 0, prepares: 1, commits: 0,
  });
});

test('coherent second app ID and observed dark icon or changed CSS class retain canonical identity', async () => {
  const secondId = 'asdk_app_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const cases: [string, (composer: any) => void, string][] = [
    ['second app ID', composer => {
      const chip = composer.nodes[0].children[0];
      chip.attributes.find((a: any) => a.name === 'app-mention-path').value = `app://${secondId}`;
      chip.attributes.find((a: any) => a.name === 'data-prompt-link-href').value = `app://${secondId}`;
      chip.attributes.find((a: any) => a.name === 'app-mention-icon').value =
        `connectors://${secondId}/logo?theme=light`;
    }, `[$${slug}](app://${secondId})${suffix}`],
    ['dark icon', composer => { composer.nodes[0].children[0].attributes
      .find((a: any) => a.name === 'app-mention-icon').value =
        `connectors://${appId}/logo?theme=dark`; }, canonical],
    ['CSS class changed', composer => { composer.nodes[0].children[0].attributes
      .find((a: any) => a.name === 'class').value = 'Mention-new-build'; }, canonical],
  ];
  for (const [name, change, intent] of cases) {
    const r = await rig(); const composer = nativeComposer();
    change(composer); r.set(observation(composer));
    assert.deepEqual(await send(r, intent), {
      result: { status: 'unknown' }, checkpoints: 1, prepares: 1, commits: 1,
    }, name);
  }
});

test('native chip rejects wrong identity, conflicting metadata, changed suffix, and noncanonical intent before commit', async () => {
  const cases: [string, (value: any) => void, string?][] = [
    ['different app ID with same display', x => {
      const chip = x.ui.composers[0].nodes[0].children[0];
      chip.attributes.find((a: any) => a.name === 'app-mention-path').value = 'app://asdk_app_other';
      chip.attributes.find((a: any) => a.name === 'data-prompt-link-href').value = 'app://asdk_app_other';
      chip.attributes.find((a: any) => a.name === 'app-mention-icon').value = 'connectors://asdk_app_other/logo?theme=light';
    }],
    ['different slug with same display', x => {
      const chip = x.ui.composers[0].nodes[0].children[0];
      chip.attributes.find((a: any) => a.name === 'app-mention-name').value = 'other-slug';
      chip.attributes.find((a: any) => a.name === 'data-prompt-link-label').value = '$other-slug';
    }],
    ['conflicting href', x => { x.ui.composers[0].nodes[0].children[0].attributes
      .find((a: any) => a.name === 'data-prompt-link-href').value = 'app://asdk_app_other'; }],
    ['conflicting icon', x => { x.ui.composers[0].nodes[0].children[0].attributes
      .find((a: any) => a.name === 'app-mention-icon').value = 'connectors://asdk_app_other/logo?theme=light'; }],
    ['conflicting label', x => { x.ui.composers[0].nodes[0].children[0].attributes
      .find((a: any) => a.name === 'data-prompt-link-label').value = '$other-slug'; }],
    ['different suffix', x => { x.ui.composers[0] = nativeComposer(' altered suffix'); }],
    ['different whitespace', x => { x.ui.composers[0] = nativeComposer('  continue the investigation'); }],
    ['duplicate attribute', x => { x.ui.composers[0].nodes[0].children[0].attributes.push(
      { name: 'app-mention-name', value: slug }); }],
    ['missing attribute', x => { x.ui.composers[0].nodes[0].children[0].attributes.pop(); }],
    ['extra attribute', x => { x.ui.composers[0].nodes[0].children[0].attributes.push(
      { name: 'data-unsupported', value: 'x' }); }],
    ['extra inline node', x => { x.ui.composers[0].nodes[0].children.push(
      { tag: 'BR', text: '', attributes: [] }); }],
    ['wrong paragraph tag', x => { x.ui.composers[0].nodes[0].tag = 'DIV'; }],
    ['wrong chip tag', x => { x.ui.composers[0].nodes[0].children[0].tag = 'A'; }],
    ['wrong suffix tag', x => { x.ui.composers[0].nodes[0].children[1].tag = 'SPAN'; }],
    ['nested chip child', x => { x.ui.composers[0].nodes[0].children[0].children = []; }],
    ['paragraph text mismatch', x => { x.ui.composers[0].nodes[0].text += '!'; }],
    ['suffix lacks leading space', x => { x.ui.composers[0] = nativeComposer('continue the investigation'); }],
    ['empty CSS class', x => { x.ui.composers[0].nodes[0].children[0].attributes
      .find((a: any) => a.name === 'class').value = ''; }],
    ['editable chip', x => { x.ui.composers[0].nodes[0].children[0].attributes
      .find((a: any) => a.name === 'contenteditable').value = 'true'; }],
    ['second chip', x => { x.ui.composers[0].nodes[0].children.splice(1, 0,
      structuredClone(x.ui.composers[0].nodes[0].children[0])); }],
    ['second paragraph', x => { x.ui.composers[0].nodes.push(
      { tag: 'P', text: '', attributes: [], children: [] }); }],
    ['composer text mismatch', x => { x.ui.composers[0].text += '!'; }],
    ['old plain label intent', () => {}, `${display}${suffix}`],
    ['account changed', x => { x.account.labels = ['Change email: other@example.test']; }],
    ['chat changed', x => { x.ui.url = 'https://chatgpt.com/c/66666666-6666-4666-8666-666666666666'; }],
    ['prior message changed', x => { x.ui.headings[0].bubble.text = 'edited';
      x.host.turns[0].items[0].content[0].text = 'edited'; }],
  ];
  for (const [name, change, intent = canonical] of cases) {
    const r = await rig();
    const value = observation(nativeComposer());
    change(value); r.set(value);
    assert.deepEqual(await send(r, intent), {
      result: { status: 'rejected' }, checkpoints: 0, prepares: 1, commits: 0,
    }, name);
  }
});
