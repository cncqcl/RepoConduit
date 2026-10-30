import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatgptDownloadObservation } from '../../src/adapters/chatgpt/host-download.js';

const chat = '11111111-1111-4111-8111-111111111111';
const project = 'g-p-6ad380ac3ac881918d77b6d84349bfe0';
const message = '00000000-0000-4000-8000-000000000101';
const turn = '00000000-0000-4000-8000-000000000103';
const filename = 'rcac-download-probe.zip';
const expected = { nativeSessionId: chat, nativeMessageId: message, filename };
function raw() {
  return {
    account: { fields: [{ label: 'Email', value: 'synthetic@example.test' }] },
    ui: { url: `https://chatgpt.com/c/${chat}`, dialogs: [], composerText: '', downloads: [{
      label: `Download ${filename}`, filename, conversationId: chat, messageId: message,
      turnId: turn, turnState: 'complete', authorRole: 'assistant', referenceIndex: '0',
      fileReference: 'true', tag: 'SPAN', role: 'button', busy: 'false', visible: true,
    }] },
    host: { schemaVersion: 1, thread: { id: chat, kind: 'chatgpt', status: { type: 'idle' } },
      page: { order: 'newest_first', limit: 10, hasMore: false, nextCursor: null }, turns: [{
        id: turn, status: 'completed', items: [{ type: 'userMessage', id: turn,
          content: [{ type: 'text', text: 'Create a synthetic ZIP.' }] }, { type: 'agentMessage', id: message,
          text: `:chatgpt-content-reference{index="0"}[下载 ${filename}](sandbox:/mnt/data/${filename})` }],
      }], attachments: [] },
  };
}

test('download observation binds observed completed UI control to exact host source without exposing a platform URL', () => {
  const parsed = parseChatgptDownloadObservation(raw(), expected);
  assert.equal(parsed.account, 'synthetic@example.test');
  assert.equal(parsed.nativeSessionId, chat);
  assert.equal(parsed.nativeMessageId, message);
  assert.equal(parsed.filename, filename);
  assert.equal(parsed.controlLabel, `Download ${filename}`);
  assert.match(parsed.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(parsed).includes('sandbox:'), false);
  assert.equal(parsed.sourceKind, 'observed_host_ui_attachment');
});

test('Project chat native download retains exact host and message source identity', () => {
  const value = raw();
  value.ui.url = `https://chatgpt.com/g/${project}/c/${chat}`;
  assert.equal(parseChatgptDownloadObservation(value, expected).nativeSessionId, chat);
  value.ui.downloads[0]!.messageId = turn;
  assert.throws(() => parseChatgptDownloadObservation(value, expected), /HOST_DOWNLOAD_UNAVAILABLE/);
});

test('Project chat native download accepts observed lowercase slug with exact host source', () => {
  const value = raw();
  value.ui.url = `https://chatgpt.com/g/${project}-physicsairadar/c/${chat}`;
  assert.equal(parseChatgptDownloadObservation(value, expected).nativeMessageId, message);
});

test('Project chat native download rejects malformed or oversized lowercase slug', () => {
  for (const slug of ['-', '-PhysicsAIRadar', '-physics--airadar', `-${'a'.repeat(65)}`]) {
    const value = raw(); value.ui.url = `https://chatgpt.com/g/${project}${slug}/c/${chat}`;
    assert.throws(() => parseChatgptDownloadObservation(value, expected), /HOST_DOWNLOAD_UNAVAILABLE/);
  }
});

test('Project chat native download rejects roots, malformed IDs, other hosts and query strings', () => {
  for (const url of [
    `https://chatgpt.com/g/${project}/project`,
    `https://chatgpt.com/g/g-p-nothex/c/${chat}`,
    `https://example.test/g/${project}/c/${chat}`,
    `https://chatgpt.com/g/${project}/c/${chat}?x=1`,
  ]) {
    const value = raw(); value.ui.url = url;
    assert.throws(() => parseChatgptDownloadObservation(value, expected), /HOST_DOWNLOAD_UNAVAILABLE/, url);
  }
});

for (const fault of ['chat', 'message', 'turn', 'incomplete', 'busy', 'hidden', 'duplicate',
  'missing_reference', 'duplicate_reference', 'reference_index', 'account_conflict', 'dialog',
  'composer', 'host_pagination', 'host_error', 'control_url', 'filename_path', 'extra_input',
  'conflicting_reference_index', 'conflicting_ui_index'] as const) {
  test(`download source fails closed on ${fault}`, () => {
    const value = raw();
    const control = value.ui.downloads[0]!;
    switch (fault) {
      case 'chat': control.conversationId = '6abfffb8-4a4c-83e9-b509-af993eca409d'; break;
      case 'message': control.messageId = turn; break;
      case 'turn': control.turnId = message; break;
      case 'incomplete': control.turnState = 'streaming'; break;
      case 'busy': control.busy = 'true'; break;
      case 'hidden': control.visible = false; break;
      case 'duplicate': value.ui.downloads.push(structuredClone(control)); break;
      case 'missing_reference': value.host.turns[0]!.items[1] = { type: 'agentMessage', id: message, text: 'No file.' }; break;
      case 'duplicate_reference': value.host.turns[0]!.items[1]!.text += value.host.turns[0]!.items[1]!.text!; break;
      case 'reference_index': control.referenceIndex = '1'; break;
      case 'account_conflict': value.account.fields.push({ label: 'Email', value: 'other@example.test' }); break;
      case 'dialog': (value.ui.dialogs as unknown[]).push('challenge'); break;
      case 'composer': value.ui.composerText = 'unsent'; break;
      case 'host_pagination': value.host.page.hasMore = true; break;
      case 'host_error': value.host.thread.status.type = 'error'; break;
      case 'control_url': Object.assign(control, { url: 'https://untrusted.test/file' }); break;
      case 'filename_path': control.filename = '../rcac-download-probe.zip'; break;
      case 'extra_input': Object.assign(value, { sourceReceipt: 'authorized_local_collector' }); break;
      case 'conflicting_reference_index': value.host.turns[0]!.items[1]!.text += '\n:chatgpt-content-reference{index="0"}[Other](sandbox:/mnt/data/other.zip)'; break;
      case 'conflicting_ui_index': value.ui.downloads.push({ ...control, filename: 'other.zip', label: 'Download other.zip' }); break;
    }
    assert.throws(() => parseChatgptDownloadObservation(value, expected), /HOST_DOWNLOAD_UNAVAILABLE/);
  });
}

test('download identity cannot be selected by current UI rather than explicit expected binding', () => {
  assert.throws(() => parseChatgptDownloadObservation(raw(), { ...expected, nativeMessageId: turn }), /HOST_DOWNLOAD_UNAVAILABLE/);
  assert.throws(() => parseChatgptDownloadObservation(raw(), { ...expected, filename: 'other.zip' }), /HOST_DOWNLOAD_UNAVAILABLE/);
  assert.throws(() => parseChatgptDownloadObservation(raw(), { ...expected, nativeSessionId: turn }), /HOST_DOWNLOAD_UNAVAILABLE/);
});

test('identical observation replays one fingerprint while changed producer source has another', () => {
  const first = parseChatgptDownloadObservation(raw(), expected);
  assert.equal(parseChatgptDownloadObservation(raw(), expected).sourceFingerprint, first.sourceFingerprint);
  const value = raw();
  value.host.turns[0]!.items[1]!.text += '\nSource revision changed.';
  assert.notEqual(parseChatgptDownloadObservation(value, expected).sourceFingerprint, first.sourceFingerprint);
});
