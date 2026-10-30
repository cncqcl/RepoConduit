import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
// @ts-expect-error The browser evaluation recipe is a standalone untyped ESM file.
import { observeChatgptDownloadDOM } from '../../tools/chatgpt-download-dom-observer.mjs';
import { parseChatgptDownloadObservation } from '../../src/adapters/chatgpt/host-download.js';
import { parseChatgptAttachmentMessage } from '../../src/adapters/chatgpt/dom-download-observation.js';

const chat = '11111111-1111-4111-8111-111111111111';
const message = '00000000-0000-4000-8000-000000000101';
const turn = '00000000-0000-4000-8000-000000000103';
const filename = 'rcac-download-probe.zip';
const expected = { nativeSessionId: chat, nativeMessageId: message, filename };
type Attrs = Record<string, string>;
class Element {
  readonly tagName: string;
  readonly attributes: { name: string; value: string }[];
  readonly children: Element[] = [];
  readonly childNodes: { nodeType: number; textContent: string }[] = [];
  parentElement: Element | null = null;
  text = '';
  rendered: string | null = null;
  rects = 1;
  display = 'block';
  constructor(tag: string, attrs: Attrs = {}, text = '') {
    this.tagName = tag;
    this.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
    this.text = text;
    if (text) this.childNodes.push({ nodeType: 3, textContent: text });
  }
  add(...children: Element[]): this {
    for (const child of children) { child.parentElement = this; this.children.push(child);
      this.childNodes.push({ nodeType: 1, textContent: child.textContent }); }
    return this;
  }
  getAttribute(key: string): string | null { return this.attributes.find(a => a.name === key)?.value ?? null; }
  setAttribute(key: string, value: string): void {
    const item = this.attributes.find(a => a.name === key);
    if (item) item.value = value; else this.attributes.push({ name: key, value });
  }
  get innerText(): string { return this.rendered ?? (this.text + this.children.map(child => child.innerText).join('')); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  getClientRects(): unknown[] { return this.rects ? [{}] : []; }
  contains(other: Element): boolean { for (let item: Element | null = other; item; item = item.parentElement) if (item === this) return true; return false; }
  closest(selector: string): Element | null {
    const find = (item: Element | null): Element | null => item === null ? null :
      matches(item, selector) ? item : find(item.parentElement);
    return find(this);
  }
  querySelectorAll(selector: string): Element[] {
    const result: Element[] = [];
    const visit = (element: Element): void => {
      for (const child of element.children) { if (matches(child, selector)) result.push(child); visit(child); }
    };
    visit(this); return result;
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}
function matches(element: Element, selector: string): boolean {
  return selector.split(',').some(part => {
    const value = part.trim();
    if (value === '*') return true;
    if (value.startsWith('[')) {
      const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(value);
      return !!match && element.getAttribute(match[1]!) !== null &&
        (match[2] === undefined || element.getAttribute(match[1]!) === match[2]);
    }
    return element.tagName.toLowerCase() === value;
  });
}
const el = (tag: string, attrs: Attrs = {}, text = '') => new Element(tag, attrs, text);
function fixture() {
  const root = el('DIV', { 'data-chatgpt-conversation-selection-target': 'true' });
  const nativeTurn = el('DIV', { 'data-turn-key': turn }); root.add(nativeTurn);
  const state = el('DIV', { 'data-talvt-turn-state': 'complete' }); nativeTurn.add(state);
  const messageNode = el('DIV', { 'data-chatgpt-selection-conversation-id': chat,
    'data-chatgpt-selection-message-id': message }); state.add(messageNode);
  const markdown = el('DIV', { 'data-markdown-text-style': 'assistant-message' }); messageNode.add(markdown);
  const p1 = el('P'); p1.rendered = `下载 ${filename}`; markdown.add(p1);
  const reference = el('SPAN', { 'data-chatgpt-copy-reference': '0', 'data-markdown-copy': 'contents' }); p1.add(reference);
  const inline = el('SPAN'); reference.add(inline);
  const control = el('SPAN', { 'data-file-reference': 'true', 'data-markdown-copy-text': filename,
    role: 'button', 'aria-busy': 'false', 'aria-label': `Download ${filename}` }); inline.add(control);
  const zipIcon = el('svg', { 'aria-hidden': 'true' }).add(el('path')); zipIcon.rects = 0;
  control.add(el('SPAN', {}, `下载 ${filename}`), zipIcon);
  const p2 = el('P'); p2.rendered = '文件清单：README.md、preview.png'; markdown.add(p2);
  const analysisIcon = el('svg', { 'aria-hidden': 'true' }).add(el('use')); analysisIcon.rects = 0;
  const analysis = el('BUTTON', { 'aria-label': 'View analysis' }).add(analysisIcon);
  p2.add(el('SPAN', {}, p2.rendered), el('SPAN').add(el('SPAN', { 'data-state': 'closed' }).add(analysis)));
  const card = el('DIV'); card.rendered = 'preview.png\nImage'; messageNode.add(card);
  const preview = el('BUTTON', { 'aria-label': 'Open preview of preview.png', 'aria-busy': 'false' });
  const download = el('BUTTON', { 'aria-label': 'Download file' });
  const imageLabel = el('SPAN', { class: 'group-focus-within/resource-row:hidden group-hover/resource-row:hidden' }, 'Image');
  const auxiliary = el('SPAN', { class: 'hidden group-focus-within/resource-row:inline group-hover/resource-row:inline',
    'data-markdown-copy': 'exclude' }, 'Open file'); auxiliary.display = 'none';
  const labelContainer = el('SPAN', { class: 'truncate text-secondary text-xs' }).add(imageLabel, auxiliary);
  const row = el('SPAN', { class: 'group/resource-row relative' }).add(preview, el('SPAN', {}, 'preview.png'), labelContainer, download);
  card.add(row);
  const composer = el('DIV', { contenteditable: 'true' }); root.add(composer);
  const previous = { document: globalThis.document, location: globalThis.location,
    getComputedStyle: globalThis.getComputedStyle };
  Object.assign(globalThis, { document: { querySelectorAll: (selector: string) => root.querySelectorAll(selector) },
    location: { href: `https://chatgpt.com/c/${chat}` },
    getComputedStyle: (element: Element) => ({ display: element.display, visibility: 'visible' }) });
  return { root, messageNode, markdown, p1, p2, reference, control, card, row, preview, download, analysis, auxiliary, labelContainer,
    restore() { Object.assign(globalThis, previous); } };
}
const account = { fields: [{ label: 'Email', value: 'synthetic@example.test' }] };
function parsed() { return parseChatgptDownloadObservation(observeChatgptDownloadDOM({ filename, account }), expected); }
function hiddenMarker() { const marker = el('SPAN', { hidden: '' }); marker.display = 'none'; return marker; }
function groupedFixture() {
  const f = fixture();
  const group = el('DIV'); f.messageNode.children.pop(); f.messageNode.childNodes.pop(); f.messageNode.add(group);
  const card = el('DIV'); group.add(card);
  const list = el('DIV', { id: 'resource-list' }); card.add(list);
  for (const [file, type] of [['README.md', 'Document'], ['index.html', 'HTML'],
    ['manifest.json', 'Code'], ['second.md', 'Document'], ['preview.png', 'Image']]) {
    const row = el('SPAN', { class: 'group/resource-row relative' }); row.rendered = `${file}\n${type}`; list.add(row);
    row.add(el('BUTTON', { 'aria-label': `Open preview of ${file}` }));
    const title = el('SPAN', { title: file! }, file);
    const label = el('SPAN', { class: 'truncate text-secondary text-xs' });
    label.add(el('SPAN', { class: 'group-focus-within/resource-row:hidden group-hover/resource-row:hidden' }, type));
    const open = el('SPAN', { class: 'hidden group-focus-within/resource-row:inline group-hover/resource-row:inline',
      'data-markdown-copy': 'exclude' }, 'Open file'); open.display = 'none'; open.rects = 0; label.add(open);
    const download = el('BUTTON', { 'aria-label': 'Download file' });
    download.add(el('svg').add(el('path')));
    const contents = el('SPAN', { 'data-state': 'closed', class: 'contents' }).add(download);
    contents.display = 'contents'; contents.rects = 0;
    row.add(el('SPAN').add(title, label), contents);
  }
  const control = el('BUTTON', { 'aria-controls': 'resource-list', 'aria-expanded': 'true' }, 'Show less');
  control.add(el('svg').add(el('path'))); card.add(control);
  group.rendered = Array.from(list.children).map(row => row.innerText).join('\n') + '\nShow less';
  return { ...f, group, list, control };
}

// Actual retained synthetic reply, with only chat/message/turn IDs anonymized.
function renderedFixture() {
  const f = fixture();
  type Tree = { tag: string; attrs: Attrs; parts?: (Tree | string)[]; display?: string; rects?: number; rendered?: string };
  const saved = JSON.parse(readFileSync(new URL('../fixtures/chatgpt/rendered-file-message.json', import.meta.url), 'utf8')) as
    { message: Tree; chain: Tree[] };
  const build = (tree: Tree): Element => {
    const e = el(tree.tag, tree.attrs);
    for (const part of tree.parts ?? []) {
      if (typeof part === 'string') { e.text += part; e.childNodes.push({ nodeType: 3, textContent: part }); }
      else e.add(build(part));
    }
    e.display = tree.display ?? 'block'; e.rects = tree.rects ?? 1; e.rendered = tree.rendered ?? null;
    return e;
  };
  const messageNode = build(saved.message);
  let root = messageNode;
  for (const parent of saved.chain) root = build(parent).add(root);
  root.add(el('DIV', { contenteditable: 'true' }));
  Object.assign(globalThis, { document: { querySelectorAll: (selector: string) => root.querySelectorAll(selector) } });
  return { ...f, root, messageNode };
}

test('retained rendered reply selects ZIP links and repeated card names by explicit attachment index', () => {
  const f = renderedFixture();
  try {
    const zip = { ...expected, filename: 'lease21-bundle-v1.zip', attachmentIndex: 0 };
    const observation = observeChatgptDownloadDOM({ ...zip, account });
    assert.equal(parseChatgptDownloadObservation(observation, zip).controlLabel, 'Open lease21-bundle-v1.zip');
    const selected = { ...expected, filename: 'README.md', attachmentIndex: 7 };
    const cards = observeChatgptDownloadDOM({ ...selected, account });
    assert.equal(parseChatgptDownloadObservation(cards, selected).controlLabel, 'Download file');
    assert.throws(() => parseChatgptDownloadObservation(cards, { ...expected, filename: 'README.md' }), /HOST_DOWNLOAD_UNAVAILABLE/);
    assert.throws(() => parseChatgptAttachmentMessage(cards, expected, ''), /HOST_DOWNLOAD_UNAVAILABLE/);
  } finally { f.restore(); }
});

test('retained rendered reply rejects index/name mismatch and changed body fingerprints', () => {
  const f = renderedFixture();
  try {
    const selected = { ...expected, filename: 'README.md', attachmentIndex: 7 };
    const observation = observeChatgptDownloadDOM({ ...selected, account });
    const first = parseChatgptDownloadObservation(observation, selected);
    assert.throws(() => parseChatgptDownloadObservation(observation, { ...selected, attachmentIndex: 3 }), /HOST_DOWNLOAD_UNAVAILABLE/);
    const changed = structuredClone(observation);
    changed.dom.blocks[0].renderedText += ' changed';
    assert.notEqual(parseChatgptDownloadObservation(changed, selected).sourceFingerprint, first.sourceFingerprint);
  } finally { f.restore(); }
});

test('rendered reply accepts an empty passive SVG circle and refuses an active or textual circle', () => {
  const f = renderedFixture();
  try {
    const rendered = f.messageNode.querySelector('[data-dil-source-message-id]')!;
    const icon = el('svg', { 'aria-hidden': 'true' }).add(el('circle'));
    rendered.add(icon);
    const selected = { ...expected, filename: 'README.md', attachmentIndex: 7 };
    assert.equal(parseChatgptDownloadObservation(observeChatgptDownloadDOM({ ...selected, account }), selected).controlLabel, 'Download file');
    icon.children[0]!.setAttribute('aria-busy', 'true');
    assert.throws(() => observeChatgptDownloadDOM({ ...selected, account }), /HOST_DOWNLOAD_DOM_UNAVAILABLE/);
    icon.children[0]!.setAttribute('aria-busy', 'false');
    icon.children[0]!.add(el('SPAN', {}, 'unobserved text'));
    assert.throws(() => observeChatgptDownloadDOM({ ...selected, account }), /HOST_DOWNLOAD_DOM_UNAVAILABLE/);
  } finally { f.restore(); }
});
test('rendered reply refuses a scripted SVG circle', () => {
  const f = renderedFixture();
  try {
    const rendered = f.messageNode.querySelector('[data-dil-source-message-id]')!;
    rendered.add(el('svg', { 'aria-hidden': 'true' }).add(el('circle', { onclick: 'unexpected()' })));
    assert.throws(() => observeChatgptDownloadDOM({ ...expected, filename: 'README.md', attachmentIndex: 7, account }),
      /HOST_DOWNLOAD_DOM_UNAVAILABLE/);
  } finally { f.restore(); }
});

const edgesAttributes = () => ({ 'aria-hidden': 'true', class: 'Edges-UXy4Ue',
  style: 'left: 0px; top: 0px; width: 495px; height: 408px;' });
test('rendered reply ignores only the observed empty Edges decoration', () => {
  const f = renderedFixture();
  try {
    const rendered = f.messageNode.querySelector('[data-dil-source-message-id]')!;
    const otherSize = edgesAttributes();
    otherSize.style = 'left: 0px; top: 0px; width: 1208px; height: 263px;';
    rendered.add(el('DIV', edgesAttributes()), el('DIV', otherSize));
    const selected = { ...expected, filename: 'README.md', attachmentIndex: 7 };
    const observation = observeChatgptDownloadDOM({ ...selected, account });
    assert.equal(parseChatgptDownloadObservation(observation, selected).controlLabel, 'Download file');
  } finally { f.restore(); }
});
for (const fault of ['child', 'text', 'interactive_attribute', 'busy_attribute', 'nonposition_style',
  'wrong_class', 'wrong_aria_hidden'] as const) {
  test(`rendered reply refuses Edges decoration with ${fault}`, () => {
    const f = renderedFixture();
    try {
      const rendered = f.messageNode.querySelector('[data-dil-source-message-id]')!;
      const edges = el('DIV', edgesAttributes()); rendered.add(edges);
      switch (fault) {
        case 'child': edges.add(el('SPAN')); break;
        case 'text': edges.text = 'hidden text'; edges.childNodes.push({ nodeType: 3, textContent: 'hidden text' }); break;
        case 'interactive_attribute': edges.setAttribute('role', 'button'); break;
        case 'busy_attribute': edges.setAttribute('aria-busy', 'true'); break;
        case 'nonposition_style': edges.setAttribute('style', 'left: 0px; top: 0px; width: 495px; height: 408px; display: none;'); break;
        case 'wrong_class': edges.setAttribute('class', 'Other'); break;
        case 'wrong_aria_hidden': edges.setAttribute('aria-hidden', 'false'); break;
      }
      assert.throws(() => observeChatgptDownloadDOM({ ...expected, filename: 'README.md', attachmentIndex: 7, account }),
        /HOST_DOWNLOAD_DOM_UNAVAILABLE/);
    } finally { f.restore(); }
  });
}

for (const fault of ['unknown_control', 'hidden_content', 'link_label', 'link_message', 'missing_alias_card',
  'disabled_link', 'streaming', 'collapsed', 'roleless_action', 'editable_plaintext', 'pending_icon'] as const) {
  test(`rendered file reply refuses ${fault}`, () => {
    const f = renderedFixture();
    try {
      const rendered = f.messageNode.querySelector('[data-dil-source-message-id]')!;
      const link = rendered.querySelector('[role="link"]')!;
      switch (fault) {
        case 'unknown_control': rendered.add(el('BUTTON', {}, 'Other')); break;
        case 'hidden_content': { const hidden = el('SPAN', {}, 'unread'); hidden.display = 'none'; rendered.add(hidden); break; }
        case 'link_label': link.setAttribute('aria-label', 'Open other.md'); break;
        case 'link_message': rendered.setAttribute('data-dil-source-message-id', turn); break;
        case 'missing_alias_card': {
          const list = f.messageNode.querySelector('[aria-controls]')!.getAttribute('aria-controls')!;
          const rows = f.messageNode.querySelector(`[id="${list}"]`)!; rows.children.pop(); break;
        }
        case 'disabled_link': link.setAttribute('aria-disabled', 'true'); break;
        case 'streaming': rendered.setAttribute('data-state', 'streaming'); break;
        case 'collapsed': f.messageNode.querySelector('[aria-controls]')!.setAttribute('aria-expanded', 'false'); break;
        case 'roleless_action': rendered.add(el('SPAN', { 'data-d-component': 'pressable', tabindex: '0', 'aria-label': 'Other action' })); break;
        case 'editable_plaintext': rendered.setAttribute('contenteditable', 'plaintext-only'); break;
        case 'pending_icon': {
          const icon = rendered.querySelector('svg')!; icon.setAttribute('data-state', 'pending'); icon.setAttribute('aria-hidden', 'false'); break;
        }
      }
      assert.throws(() => parseChatgptDownloadObservation(observeChatgptDownloadDOM({
        ...expected, filename: 'README.md', attachmentIndex: 7, account }), {
        ...expected, filename: 'README.md', attachmentIndex: 7 }), /HOST_DOWNLOAD_(DOM_)?UNAVAILABLE/);
    } finally { f.restore(); }
  });
}

for (const attachmentIndex of [-1, 64, 0.5, NaN]) {
  test(`attachment index rejects invalid value ${attachmentIndex}`, () => {
    const f = renderedFixture();
    try {
      assert.throws(() => observeChatgptDownloadDOM({ ...expected, filename: 'README.md', attachmentIndex, account }),
        /HOST_DOWNLOAD_DOM_UNAVAILABLE/);
    } finally { f.restore(); }
  });
}

test('expanded resource list projects five typed rows in DOM order', () => {
  const f = groupedFixture();
  try {
    const observation = observeChatgptDownloadDOM({ filename: 'second.md', account });
    const block = observation.dom.blocks.at(-1);
    assert.equal(block.kind, 'resource_card_group_v1');
    assert.deepEqual(block.rows.map((row: { filename: string }) => row.filename),
      ['README.md', 'index.html', 'manifest.json', 'second.md', 'preview.png']);
    assert.equal(Array.isArray(block.rows[0].downloadAncestry), true);
    assert.equal(parseChatgptDownloadObservation(observation, { ...expected, filename: 'second.md' }).controlLabel,
      'Download file');
  } finally { f.restore(); }
});
for (const fault of ['collapsed', 'wrong_controls', 'hidden_row', 'extra_button',
  'wrong_type', 'both_labels', 'hidden_unknown', 'wrong_title', 'title_busy',
  'descendant_streaming', 'type_hidden', 'paired_hidden', 'type_aria_hidden',
  'paired_aria_hidden', 'contents_loading', 'contents_busy', 'svg_text', 'svg_interactive'] as const) {
  test(`resource list producer refuses ${fault}`, () => {
    const f = groupedFixture();
    try {
      const row = f.list.children[1]!;
      const label = row.querySelector('[data-markdown-copy="exclude"]')!;
      switch (fault) {
        case 'collapsed': f.control.setAttribute('aria-expanded', 'false'); break;
        case 'wrong_controls': f.control.setAttribute('aria-controls', 'other'); break;
        case 'hidden_row': row.display = 'none'; break;
        case 'extra_button': row.add(el('BUTTON', { 'aria-label': 'Other' })); break;
        case 'wrong_type': label.parentElement!.children[0]!.text = 'Unknown'; break;
        case 'both_labels': label.display = 'inline'; break;
        case 'hidden_unknown': { const hidden = el('SPAN', {}, 'unknown'); hidden.display = 'none'; row.add(hidden); break; }
        case 'wrong_title': row.querySelector('[title]')!.setAttribute('title', 'other.md'); break;
        case 'title_busy': row.querySelector('[title]')!.setAttribute('aria-busy', 'true'); break;
        case 'descendant_streaming': row.querySelector('[title]')!.setAttribute('data-state', 'streaming'); break;
        case 'type_hidden': label.parentElement!.children[0]!.setAttribute('hidden', ''); break;
        case 'paired_hidden': label.setAttribute('hidden', ''); break;
        case 'type_aria_hidden': label.parentElement!.children[0]!.setAttribute('aria-hidden', 'true'); break;
        case 'paired_aria_hidden': label.setAttribute('aria-hidden', 'true'); break;
        case 'contents_loading': row.querySelector('[data-state="closed"]')!.setAttribute('data-state', 'loading'); break;
        case 'contents_busy': row.querySelector('[data-state="closed"]')!.setAttribute('aria-busy', 'true'); break;
        case 'svg_text': row.querySelector('svg')!.text = 'unsafe'; break;
        case 'svg_interactive': row.querySelector('path')!.setAttribute('role', 'button'); break;
      }
      assert.throws(() => observeChatgptDownloadDOM({ filename: 'second.md', account }),
        /HOST_DOWNLOAD_DOM_UNAVAILABLE/);
    } finally { f.restore(); }
  });
}

test('conversation attachment projection preserves the exact draft while download still rejects it', () => {
  const f = fixture();
  try {
    const composer = f.root.querySelector('[contenteditable="true"]')!;
    composer.text = '  next question\n';
    const observation = observeChatgptDownloadDOM({ filename, account });
    assert.equal(observation.ui.composerText, composer.text);
    assert.equal(parseChatgptAttachmentMessage(observation, expected, composer.text).turnId, turn);
    assert.throws(() => parseChatgptDownloadObservation(observation, expected));
    assert.throws(() => parseChatgptAttachmentMessage(observation, expected, 'next question'));
    composer.text = ''; composer.rendered = '\n';
    assert.equal(observeChatgptDownloadDOM({ filename, account }).ui.composerText, '');
  } finally { f.restore(); }
});

test('an explicit native message selects repeated filenames without weakening ambiguity within that message', () => {
  const f = fixture();
  try {
    const other = el('DIV', { 'data-chatgpt-selection-message-id': turn });
    other.add(el('SPAN', { 'data-file-reference': 'true', 'data-markdown-copy-text': filename }));
    f.root.add(other);
    assert.throws(() => observeChatgptDownloadDOM({ filename, account }));
    const observation = observeChatgptDownloadDOM({ filename, account, nativeMessageId: message });
    assert.equal(parseChatgptDownloadObservation(observation, expected).nativeMessageId, message);
    assert.throws(() => observeChatgptDownloadDOM({ filename, account, nativeMessageId: 'missing' }));
    f.messageNode.add(el('SPAN', { 'data-file-reference': 'true', 'data-markdown-copy-text': filename }));
    assert.throws(() => observeChatgptDownloadDOM({ filename, account, nativeMessageId: message }));
  } finally { f.restore(); }
});

test('first direct empty hidden span is projected in source order and bound to native message', () => {
  const f = fixture();
  try {
    const original = parsed();
    const marker = hiddenMarker(); marker.parentElement = f.messageNode;
    f.messageNode.children.unshift(marker);
    const observation = observeChatgptDownloadDOM({ filename, account });
    assert.equal(observation.dom.blocks[0].kind, 'empty_hidden_span_v1');
    assert.deepEqual(observation.dom.blocks[0].node, { tag: 'SPAN', attributes: [['hidden', '']] });
    assert.equal(observation.dom.blocks[0].ancestry[1].attributes[1][1], message);
    assert.notEqual(parseChatgptDownloadObservation(observation, expected).sourceFingerprint, original.sourceFingerprint);
  } finally { f.restore(); }
});

for (const fault of ['extra_attribute', 'until_found', 'wrong_tag', 'whitespace', 'comment', 'child',
  'not_first', 'nested', 'duplicate', 'parent_hidden'] as const) {
  test(`producer refuses hidden marker ${fault}`, () => {
    const f = fixture();
    try {
      const marker = hiddenMarker(); marker.parentElement = f.messageNode;
      f.messageNode.children.unshift(marker);
      switch (fault) {
        case 'extra_attribute': marker.setAttribute('class', 'other'); break;
        case 'until_found': marker.setAttribute('hidden', 'until-found'); break;
        case 'wrong_tag': { const other = el('DIV', { hidden: '' }); other.parentElement = f.messageNode;
          f.messageNode.children[0] = other; break; }
        case 'whitespace': marker.childNodes.push({ nodeType: 3, textContent: ' ' }); break;
        case 'comment': marker.childNodes.push({ nodeType: 8, textContent: '' }); break;
        case 'child': marker.add(el('SPAN')); break;
        case 'not_first': f.messageNode.children.push(f.messageNode.children.shift()!); break;
        case 'nested': f.messageNode.children.shift(); f.markdown.add(marker); break;
        case 'duplicate': { const second = hiddenMarker(); second.parentElement = f.messageNode;
          f.messageNode.children.splice(1, 0, second); break; }
        case 'parent_hidden': f.messageNode.setAttribute('hidden', ''); break;
      }
      assert.throws(parsed, /HOST_DOWNLOAD_(DOM_)?UNAVAILABLE/);
    } finally { f.restore(); }
  });
}

test('synthetic full message projection includes exact reference, second paragraph and PNG card', () => {
  const f = fixture();
  try {
    const observation = observeChatgptDownloadDOM({ filename, account });
    assert.equal(observation.dom.blocks.length, 3);
    assert.equal(observation.dom.blocks[0].kind, 'file_reference');
    assert.equal(observation.dom.blocks[1].kind, 'text');
    assert.equal(observation.dom.blocks[1].analysisControl?.label, 'View analysis');
    assert.equal(observation.dom.blocks[2].kind, 'image_card');
    assert.equal(observation.dom.blocks[2].auxiliaryLabel, 'Open file');
    assert.match(parseChatgptDownloadObservation(observation, expected).sourceFingerprint, /^[a-f0-9]{64}$/);
  } finally { f.restore(); }
});

test('browser evaluation function has no external helper closure', () => {
  const f = fixture();
  try {
    const isolated = runInNewContext(`(${observeChatgptDownloadDOM.toString()})`, {
      document: globalThis.document, location: globalThis.location, getComputedStyle: globalThis.getComputedStyle,
    }) as typeof observeChatgptDownloadDOM;
    assert.match(parseChatgptDownloadObservation(isolated({ filename, account }), expected).sourceFingerprint, /^[a-f0-9]{64}$/);
  } finally { f.restore(); }
});

test('synthetic PNG card selects the unique download within the original assistant message', () => {
  const f = fixture();
  try {
    const observation = observeChatgptDownloadDOM({ filename: 'preview.png', account });
    const parsed = parseChatgptDownloadObservation(observation, { ...expected, filename: 'preview.png' });
    assert.equal(parsed.controlLabel, 'Download file');
    assert.equal(observation.dom.blocks.length, 3);
  } finally { f.restore(); }
});

for (const fault of ['duplicate_png_card', 'same_name_ref_and_card', 'preview_download_different_row',
  'card_extra_button', 'card_missing_assistant'] as const) {
  test(`synthetic PNG selection refuses ${fault}`, () => {
    const f = fixture();
    try {
      switch (fault) {
        case 'duplicate_png_card': f.messageNode.add(el('DIV').add(el('SPAN', { class: 'group/resource-row relative' })
          .add(el('BUTTON', { 'aria-label': 'Open preview of preview.png' }), el('BUTTON', { 'aria-label': 'Download file' })))); break;
        case 'same_name_ref_and_card': f.control.setAttribute('data-markdown-copy-text', 'preview.png');
          f.control.setAttribute('aria-label', 'Download preview.png'); break;
        case 'preview_download_different_row': f.row.children.splice(f.row.children.indexOf(f.download), 1);
          f.card.add(el('SPAN', { class: 'group/resource-row relative' }).add(f.download)); break;
        case 'card_extra_button': f.row.add(el('BUTTON', { 'aria-label': 'Other action' })); break;
        case 'card_missing_assistant': f.markdown.setAttribute('data-markdown-text-style', 'unknown'); break;
      }
      assert.throws(() => parseChatgptDownloadObservation(
        observeChatgptDownloadDOM({ filename: 'preview.png', account }), { ...expected, filename: 'preview.png' }),
      /HOST_DOWNLOAD_(DOM_)?UNAVAILABLE/);
    } finally { f.restore(); }
  });
}

for (const fault of ['reference_extra_text', 'text_nested_control', 'card_extra_empty_block',
  'reference_hidden_child', 'text_hidden_child', 'card_hidden_child', 'reference_loading_child',
  'text_loading_child', 'card_loading_child', 'text_css_hidden_child', 'svg_embedded_text',
  'auxiliary_wrong_text', 'auxiliary_wrong_parent', 'auxiliary_duplicate', 'reference_extra_role_button'] as const) {
  test(`synthetic producer and parser refuse ${fault}`, () => {
    const f = fixture();
    try {
      switch (fault) {
        case 'reference_extra_text': f.p1.add(el('SPAN', {}, 'unobserved')); break;
        case 'text_nested_control': f.p2.add(el('BUTTON', { 'aria-label': 'Unknown' })); break;
        case 'card_extra_empty_block': f.card.add(el('DIV')); break;
        case 'reference_hidden_child': f.reference.add(el('SPAN', { hidden: '' })); break;
        case 'text_hidden_child': f.p2.add(el('SPAN', { 'aria-hidden': 'true' }, 'secret')); break;
        case 'card_hidden_child': f.card.add(el('SPAN', { hidden: '' })); break;
        case 'reference_loading_child': f.reference.add(el('SPAN', { 'data-state': 'loading' })); break;
        case 'text_loading_child': f.p2.add(el('SPAN', { 'data-state': 'loading' })); break;
        case 'card_loading_child': f.card.add(el('SPAN', { 'data-state': 'loading' })); break;
        case 'text_css_hidden_child': { const hidden = el('SPAN', {}, 'secret'); hidden.display = 'none'; f.p2.add(hidden); break; }
        case 'svg_embedded_text': f.control.add(el('svg', { 'aria-hidden': 'true' }).add(el('text', {}, 'secret'))); break;
        case 'auxiliary_wrong_text': f.auxiliary.text = 'Other hidden text'; f.auxiliary.childNodes[0]!.textContent = 'Other hidden text'; break;
        case 'auxiliary_wrong_parent': f.labelContainer.children.splice(1, 1); f.card.add(f.auxiliary); break;
        case 'auxiliary_duplicate': { const duplicate = el('SPAN', { class: 'hidden group-focus-within/resource-row:inline group-hover/resource-row:inline',
          'data-markdown-copy': 'exclude' }, 'Open file'); duplicate.display = 'none'; f.labelContainer.add(duplicate); break; }
        case 'reference_extra_role_button': f.control.children[0]!.setAttribute('role', 'button');
          f.control.children[0]!.setAttribute('aria-label', 'Unknown action'); break;
      }
      assert.throws(parsed, /HOST_DOWNLOAD_(DOM_)?UNAVAILABLE/);
    } finally { f.restore(); }
  });
}
