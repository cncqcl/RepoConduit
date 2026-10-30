import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatgptDownloadObservation } from '../../src/adapters/chatgpt/host-download.js';
import { parseChatgptAttachmentMessage } from '../../src/adapters/chatgpt/dom-download-observation.js';
/* eslint-disable @typescript-eslint/no-explicit-any -- malformed synthetic DOM projections exercise validation */

const chat = '11111111-1111-4111-8111-111111111111';
const project = 'g-p-6ad380ac3ac881918d77b6d84349bfe0';
const message = '00000000-0000-4000-8000-000000000101';
const turn = '00000000-0000-4000-8000-000000000103';
const filename = 'rcac-download-probe.zip';
const expected = { nativeSessionId: chat, nativeMessageId: message, filename };
type Node = { tag: string; attributes: [string, string][] };
const node = (tag: string, ...attributes: [string, string][]): Node => ({ tag, attributes });
function ancestry() {
  return [node('SPAN', ['data-file-reference', 'true'], ['data-markdown-copy-text', filename],
    ['role', 'button'], ['aria-busy', 'false'], ['aria-label', `Download ${filename}`]),
  node('SPAN'), node('SPAN', ['data-chatgpt-copy-reference', '0'], ['data-markdown-copy', 'contents']),
  node('P'), node('DIV', ['data-markdown-text-style', 'assistant-message']),
  node('DIV', ['data-chatgpt-selection-conversation-id', chat], ['data-chatgpt-selection-message-id', message]),
  node('DIV'), node('DIV'), node('DIV'), node('DIV'),
  node('DIV', ['data-talvt-turn-state', 'complete']), node('DIV'), node('DIV'),
  node('DIV', ['data-turn-key', turn]), node('DIV'), node('DIV'), node('DIV'),
  node('DIV', ['data-chatgpt-conversation-selection-target', 'true'])];
}
function raw() {
  return { sourceKind: 'observed_chatgpt_dom_attachment_v1',
    account: { fields: [{ label: 'Email', value: 'synthetic@example.test' }] },
    ui: { url: `https://chatgpt.com/c/${chat}`, dialogs: [] as string[], composerText: '', turnStates: ['complete'], generationControls: [] as string[] },
    dom: { turn: node('DIV', ['data-turn-key', turn]),
      stateNode: node('DIV', ['data-talvt-turn-state', 'complete']),
      message: node('DIV', ['data-chatgpt-selection-conversation-id', chat], ['data-chatgpt-selection-message-id', message]),
      blocks: [
        { kind: 'file_reference', filename, referenceIndex: '0', renderedText: `下载 ${filename}`, visible: true, ancestry: ancestry() },
        { kind: 'text', renderedText: 'Complete file list: README.md, preview.png' },
        { kind: 'image_card', filename: 'preview.png', typeImage: 'Image', previewLabel: 'Open preview of preview.png',
          downloadLabel: 'Download file', visible: true, ancestry: [node('BUTTON', ['aria-label', 'Download file']),
            node('DIV', ['data-chatgpt-selection-conversation-id', chat], ['data-chatgpt-selection-message-id', message]),
            node('DIV', ['data-talvt-turn-state', 'complete']), node('DIV', ['data-turn-key', turn])] },
      ] } };
}
function withHiddenMarker() {
  const value = raw();
  const hidden = node('SPAN', ['hidden', '']);
  (value.dom.blocks as unknown[]).unshift({ kind: 'empty_hidden_span_v1', node: hidden,
    ancestry: [hidden, value.dom.message, value.dom.stateNode, value.dom.turn] });
  return value;
}
function grouped() {
  const value = raw();
  value.dom.blocks[0]!.referenceIndex = '5';
  value.dom.blocks[0]!.ancestry![2]!.attributes[0]![1] = '5';
  const base = [value.dom.message, value.dom.stateNode, value.dom.turn];
  const wrapper = node('DIV'), container = node('DIV');
  const list = node('DIV', ['id', 'resource-list']);
  const control = node('BUTTON', ['aria-controls', 'resource-list'], ['aria-expanded', 'true']);
  const files = [['README.md', 'Document'], ['index.html', 'HTML'],
    ['manifest.json', 'Code'], ['second.md', 'Document'], ['preview.png', 'Image']];
  const rows = files.map(([file, type], rowIndex) => {
    const row = node('SPAN', ['class', 'group/resource-row relative']);
    const preview = node('BUTTON', ['aria-label', `Open preview of ${file}`]);
    const download = node('BUTTON', ['aria-label', 'Download file']);
    const path = [row, list, container, wrapper, ...base];
    return { filename: file, fileType: type, labelState: 'type', renderedText: `${file}\n${type}`,
      rowIndex, previewRowIndex: rowIndex, downloadRowIndex: rowIndex,
      rowNode: row, rowAncestry: path, previewNode: preview, previewAncestry: [preview, ...path],
      downloadNode: download, downloadAncestry: [download, ...path] };
  });
  value.dom.blocks[2] = { kind: 'resource_card_group_v1', listNode: list,
    ancestry: [list, container, wrapper, ...base],
    expandedControl: { label: 'Show less', node: control, ancestry: [control, container, wrapper, ...base] },
    renderedText: rows.map(row => row.renderedText).join('\n') + '\nShow less', rows } as any;
  return value;
}

test('expanded resource group selects each exact card and retains the ZIP reference without row IDs', () => {
  const value = grouped();
  const parsed = parseChatgptAttachmentMessage(value, expected, '');
  assert.deepEqual(parsed.attachments.map(item => item.filename), [filename,
    'README.md', 'index.html', 'manifest.json', 'second.md', 'preview.png']);
  assert.equal(parseChatgptDownloadObservation(value, { ...expected, filename: 'second.md' }).controlLabel, 'Download file');
});

test('Project chat download keeps the selected native message and source identity', () => {
  const value = raw();
  value.ui.url = `https://chatgpt.com/g/${project}/c/${chat}`;
  assert.equal(parseChatgptAttachmentMessage(value, expected, '').attachments[0]?.filename, filename);
  assert.equal(parseChatgptDownloadObservation(value, expected).controlLabel, `Download ${filename}`);
  value.dom.message.attributes[0]![1] = message;
  assert.throws(() => parseChatgptAttachmentMessage(value, expected, ''), /HOST_DOWNLOAD_UNAVAILABLE/);
});

test('Project chat download accepts observed lowercase slug with exact selected source', () => {
  const value = raw();
  value.ui.url = `https://chatgpt.com/g/${project}-physicsairadar/c/${chat}`;
  assert.equal(parseChatgptAttachmentMessage(value, expected, '').attachments[0]?.filename, filename);
  assert.equal(parseChatgptDownloadObservation(value, expected).nativeMessageId, message);
});

test('Project chat download rejects malformed or oversized lowercase slug', () => {
  for (const slug of ['-', '-PhysicsAIRadar', '-physics--airadar', `-${'a'.repeat(65)}`]) {
    const value = raw(); value.ui.url = `https://chatgpt.com/g/${project}${slug}/c/${chat}`;
    assert.throws(() => parseChatgptAttachmentMessage(value, expected, ''), /HOST_DOWNLOAD_UNAVAILABLE/);
  }
});

test('Project chat download rejects roots, malformed IDs, other hosts and query strings', () => {
  for (const url of [
    `https://chatgpt.com/g/${project}/project`,
    `https://chatgpt.com/g/g-p-nothex/c/${chat}`,
    `https://example.test/g/${project}/c/${chat}`,
    `https://chatgpt.com/g/${project}/c/${chat}?x=1`,
  ]) {
    const value = raw(); value.ui.url = url;
    assert.throws(() => parseChatgptAttachmentMessage(value, expected, ''), /HOST_DOWNLOAD_UNAVAILABLE/, url);
  }
});

for (const fault of ['collapsed', 'wrong_controls', 'missing_row', 'duplicate_row', 'cross_row_button', 'other_list_button', 'truncated_ancestry',
  'wrong_type', 'hidden_row', 'wrong_message', 'changed_text'] as const) {
  test(`resource group refuses ${fault}`, () => {
    const value = grouped(); const group: any = value.dom.blocks[2]!;
    switch (fault) {
      case 'collapsed': group.expandedControl!.node.attributes[1]![1] = 'false'; break;
      case 'wrong_controls': group.expandedControl!.node.attributes[0]![1] = 'other'; break;
      case 'missing_row': group.rows!.pop(); break;
      case 'duplicate_row': group.rows!.push(structuredClone(group.rows![0]!)); break;
      case 'cross_row_button': group.rows![1]!.downloadRowIndex = 0; break;
      case 'other_list_button': {
        const path = group.rows![1]!.downloadAncestry;
        path[2].attributes[0][1] = 'other-list';
        break;
      }
      case 'truncated_ancestry': {
        const path = group.rows![1]!.downloadAncestry;
        path[1].attributes = ['[MaxDepth]'];
        break;
      }
      case 'wrong_type': group.rows![1]!.fileType = 'Executable'; break;
      case 'hidden_row': group.rows![1]!.rowNode.attributes.push(['hidden', '']); break;
      case 'wrong_message': {
        const path = group.rows![1]!.rowAncestry;
        path.at(-3).attributes[1][1] = turn;
        break;
      }
      case 'changed_text': group.rows![1]!.renderedText = 'modified'; break;
    }
    assert.throws(() => parseChatgptAttachmentMessage(value, expected, ''), /HOST_DOWNLOAD_UNAVAILABLE/);
  });
}

test('first direct empty hidden marker is fingerprinted without changing old source identity', () => {
  const original = parseChatgptDownloadObservation(raw(), expected);
  assert.equal(parseChatgptDownloadObservation(raw(), expected).sourceFingerprint, original.sourceFingerprint);
  const marked = parseChatgptDownloadObservation(withHiddenMarker(), expected);
  assert.notEqual(marked.sourceFingerprint, original.sourceFingerprint);
  assert.equal(marked.controlLabel, `Download ${filename}`);
  const changed = withHiddenMarker(); changed.dom.blocks[2]!.renderedText += ' revision';
  assert.notEqual(parseChatgptDownloadObservation(changed, expected).sourceFingerprint, marked.sourceFingerprint);
});

for (const fault of ['extra_attribute', 'until_found', 'wrong_tag', 'whitespace', 'comment', 'child',
  'not_first', 'duplicate', 'wrong_ancestor', 'parent_hidden'] as const) {
  test(`empty hidden marker refuses ${fault}`, () => {
    const value = withHiddenMarker();
    const marker = value.dom.blocks[0] as unknown as { node: Node; ancestry: Node[] };
    switch (fault) {
      case 'extra_attribute': marker.node.attributes.push(['class', 'other']); break;
      case 'until_found': marker.node.attributes[0]![1] = 'until-found'; break;
      case 'wrong_tag': marker.node.tag = 'DIV'; break;
      case 'whitespace': Object.assign(marker, { textContent: ' ' }); break;
      case 'comment': Object.assign(marker, { childNodes: [{ type: 'comment' }] }); break;
      case 'child': Object.assign(marker, { childNodes: [{ type: 'element' }] }); break;
      case 'not_first': value.dom.blocks.push(value.dom.blocks.shift()!); break;
      case 'duplicate': value.dom.blocks.splice(1, 0, structuredClone(value.dom.blocks[0]!)); break;
      case 'wrong_ancestor': marker.ancestry[1]!.attributes[1]![1] = turn; break;
      case 'parent_hidden': marker.ancestry[1]!.attributes.push(['hidden', '']); break;
    }
    assert.throws(() => parseChatgptDownloadObservation(value, expected), /HOST_DOWNLOAD_UNAVAILABLE/);
  });
}

test('typed DOM source binds original message, turn, complete state and all content', () => {
  const parsed = parseChatgptDownloadObservation(raw(), expected);
  assert.equal(parsed.sourceKind, 'observed_chatgpt_dom_attachment_v1');
  assert.equal(parsed.account, 'synthetic@example.test');
  assert.match(parsed.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(parsed).includes('sandbox:'), false);
  assert.equal(parseChatgptDownloadObservation(raw(), expected).sourceFingerprint, parsed.sourceFingerprint);
  const body = raw(); body.dom.blocks[1]!.renderedText += ' changed';
  assert.notEqual(parseChatgptDownloadObservation(body, expected).sourceFingerprint, parsed.sourceFingerprint);
  const card = raw(); card.dom.blocks[2]!.filename = 'changed.png';
  card.dom.blocks[2]!.previewLabel = 'Open preview of changed.png';
  assert.notEqual(parseChatgptDownloadObservation(card, expected).sourceFingerprint, parsed.sourceFingerprint);
});

test('observed PNG auxiliary label is typed, fingerprinted and rejects substitution', () => {
  const base = parseChatgptDownloadObservation(raw(), expected);
  const value = raw();
  Object.assign(value.dom.blocks[2]!, { auxiliaryLabel: 'Open file' });
  const withAuxiliary = parseChatgptDownloadObservation(value, expected);
  assert.notEqual(withAuxiliary.sourceFingerprint, base.sourceFingerprint);
  Object.assign(value.dom.blocks[2]!, { auxiliaryLabel: 'Open other file' });
  assert.throws(() => parseChatgptDownloadObservation(value, expected), /HOST_DOWNLOAD_UNAVAILABLE/);
});

test('PNG card selects its own native download while assistant markdown reference remains bound', () => {
  const parsed = parseChatgptDownloadObservation(raw(), { ...expected, filename: 'preview.png' });
  assert.equal(parsed.controlLabel, 'Download file');
  assert.equal(parsed.nativeMessageId, message);
  assert.match(parsed.sourceFingerprint, /^[a-f0-9]{64}$/);
});

for (const fault of ['duplicate_card', 'same_name_reference_and_card', 'missing_assistant_reference',
  'wrong_card_ancestor', 'extra_card_button'] as const) {
  test(`PNG card source refuses ${fault}`, () => {
    const value = raw();
    switch (fault) {
      case 'duplicate_card': value.dom.blocks.push(structuredClone(value.dom.blocks[2]!)); break;
      case 'same_name_reference_and_card': value.dom.blocks[0]!.filename = 'preview.png';
        value.dom.blocks[0]!.renderedText = '下载 preview.png';
        value.dom.blocks[0]!.ancestry![0]!.attributes[1]![1] = 'preview.png';
        value.dom.blocks[0]!.ancestry![0]!.attributes[4]![1] = 'Download preview.png'; break;
      case 'missing_assistant_reference': value.dom.blocks.splice(0, 1); break;
      case 'wrong_card_ancestor': value.dom.blocks[2]!.ancestry![1]!.attributes[1]![1] = turn; break;
      case 'extra_card_button': value.dom.blocks[2]!.ancestry![0]!.attributes.push(['aria-busy', 'true']); break;
    }
    assert.throws(() => parseChatgptDownloadObservation(value, { ...expected, filename: 'preview.png' }),
      /HOST_DOWNLOAD_UNAVAILABLE/);
  });
}

for (const fault of ['account', 'chat', 'message', 'turn', 'state', 'busy', 'hidden', 'dialog', 'composer',
  'duplicate_control', 'duplicate_index', 'wrong_index', 'wrong_ancestor', 'unknown_block',
  'missing_card', 'unknown_completion', 'mixed_host', 'missing_kind', 'missing_reference',
  'other_turn_generating', 'generation_control', 'image_wrong_message'] as const) {
  test(`typed DOM source refuses ${fault} before a click`, () => {
    const value = raw(); const path = value.dom.blocks[0]!.ancestry!;
    switch (fault) {
      case 'account': value.account.fields[0]!.value = 'other@example.test'; value.account.fields.push({ label: 'Email', value: 'synthetic@example.test' }); break;
      case 'chat': path[5]!.attributes[0]![1] = turn; break;
      case 'message': path[5]!.attributes[1]![1] = turn; break;
      case 'turn': path[13]!.attributes[0]![1] = message; break;
      case 'state': path[10]!.attributes[0]![1] = 'streaming'; break;
      case 'busy': path[0]!.attributes[3]![1] = 'true'; break;
      case 'hidden': value.dom.blocks[0]!.visible = false; break;
      case 'dialog': value.ui.dialogs.push('modal'); break;
      case 'composer': value.ui.composerText = 'draft'; break;
      case 'duplicate_control': value.dom.blocks.push(structuredClone(value.dom.blocks[0]!)); break;
      case 'duplicate_index': value.dom.blocks.push({ ...structuredClone(value.dom.blocks[0]!), filename: 'other.zip' }); break;
      case 'wrong_index': value.dom.blocks[0]!.referenceIndex = '1'; break;
      case 'wrong_ancestor': path[4]!.attributes[0]![1] = 'user-message'; break;
      case 'unknown_block': (value.dom.blocks as unknown[]).push({ kind: 'unknown' }); break;
      case 'missing_card': value.dom.blocks.splice(2, 1); (value.dom.blocks as unknown[]).push({ kind: 'unknown' }); break;
      case 'unknown_completion': path[10]!.attributes = []; break;
      case 'mixed_host': Object.assign(value, { host: {} }); break;
      case 'missing_kind': delete (value as {sourceKind?: string}).sourceKind; break;
      case 'missing_reference': value.dom.blocks.splice(0, 1); break;
      case 'other_turn_generating': value.ui.turnStates.push('streaming'); break;
      case 'generation_control': value.ui.generationControls.push('Stop generating'); break;
      case 'image_wrong_message': value.dom.blocks[2]!.ancestry![1]!.attributes[1]![1] = turn; break;
    }
    assert.throws(() => parseChatgptDownloadObservation(value, expected), /HOST_DOWNLOAD_UNAVAILABLE/);
  });
}
