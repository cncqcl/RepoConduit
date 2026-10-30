import { createHash } from 'node:crypto';
import { normalizeArtifactPath } from '../../core/artifact/paths.js';
import { parseChatgptDownloadAccount, type ChatgptDownloadSelection, type ChatgptDownloadObservation } from './host-download.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_CHAT_URL = /^https:\/\/chatgpt\.com\/g\/g-p-[0-9a-f]{32}(?:-(?=[a-z0-9-]{1,64}\/c\/)[a-z0-9]+(?:-[a-z0-9]+)*)?\/c\/([^/?#]+)$/;
function unavailable(): never { throw new Error('HOST_DOWNLOAD_UNAVAILABLE'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || Object.keys(result).some(key => !keys.includes(key))) unavailable();
  return result;
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > limit) unavailable();
  return value;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 255 ||
      normalizeArtifactPath(value) !== value || value.includes('/')) unavailable();
  return value;
}
type DomNode = { tag: string; attributes: [string, string][] };
function node(value: unknown): DomNode {
  const raw = object(value, ['tag', 'attributes']);
  if (typeof raw.tag !== 'string' || !/^[A-Z][A-Z0-9]{0,12}$/.test(raw.tag)) unavailable();
  if (!Array.isArray(raw.attributes) || raw.attributes.length > 32) unavailable();
  const attributes = raw.attributes.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
        typeof entry[1] !== 'string' || Buffer.byteLength(entry[0]) > 128 || Buffer.byteLength(entry[1]) > 4096) unavailable();
    return entry as [string, string];
  });
  if (new Set(attributes.map(entry => entry[0])).size !== attributes.length) unavailable();
  return { tag: raw.tag, attributes };
}
function attr(value: DomNode, key: string): string | undefined {
  return value.attributes.find(entry => entry[0] === key)?.[1];
}
function sameMarker(left: DomNode, right: DomNode, key: string): boolean {
  return left.tag === right.tag && attr(left, key) === attr(right, key);
}
function ancestry(value: unknown, message: DomNode, state: DomNode, turn: DomNode,
  leadingEmptyHidden = false): DomNode[] {
  const path = array(value, 32).map(node);
  const messageIndex = path.findIndex(item => sameMarker(item, message, 'data-chatgpt-selection-message-id'));
  const stateIndex = path.findIndex(item => sameMarker(item, state, 'data-talvt-turn-state'));
  const turnIndex = path.findIndex(item => sameMarker(item, turn, 'data-turn-key'));
  if (!(0 < messageIndex && messageIndex < stateIndex && stateIndex < turnIndex) ||
      attr(path[messageIndex]!, 'data-chatgpt-selection-conversation-id') !==
        attr(message, 'data-chatgpt-selection-conversation-id') ||
      path.filter(item => attr(item, 'data-chatgpt-selection-message-id') !== undefined).length !== 1 ||
      path.filter(item => attr(item, 'data-talvt-turn-state') !== undefined).length !== 1 ||
      path.filter(item => attr(item, 'data-turn-key') !== undefined).length !== 1) unavailable();
  for (const item of path) {
    if (leadingEmptyHidden && item === path[0]) continue;
    if (attr(item, 'aria-hidden') === 'true' || attr(item, 'hidden') !== undefined ||
        attr(item, 'aria-busy') === 'true' || attr(item, 'aria-disabled') === 'true' ||
        ['loading', 'pending', 'streaming'].includes(attr(item, 'data-state') ?? '')) unavailable();
  }
  return path;
}
function renderedText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 131_072) unavailable();
  return value;
}

export interface ChatgptAttachmentIdentity {
  kind: 'file_reference' | 'image_card' | 'resource_card' | 'file_link';
  filename: string;
  referenceIndex: string | null;
}

/** Shared full-message validation; callers supply their own expected composer. */
function parseAttachmentMessage(raw: unknown, expected: ChatgptDownloadSelection, expectedComposer: string) {
  try {
    const root = object(raw, ['sourceKind', 'account', 'ui', 'dom']);
    if (root.sourceKind !== 'observed_chatgpt_dom_attachment_v1' ||
        !UUID.test(expected.nativeSessionId) || !UUID.test(expected.nativeMessageId)) unavailable();
    name(expected.filename);
    if (Object.hasOwn(expected, 'attachmentIndex') && (!Number.isSafeInteger(expected.attachmentIndex) ||
        expected.attachmentIndex! < 0 || expected.attachmentIndex! > 63)) unavailable();
    const account = parseChatgptDownloadAccount(root.account);
    const ui = object(root.ui, ['url', 'dialogs', 'composerText', 'turnStates', 'generationControls']);
    const projectChatId = typeof ui.url === 'string' ? PROJECT_CHAT_URL.exec(ui.url)?.[1] : undefined;
    if ((ui.url !== `https://chatgpt.com/c/${expected.nativeSessionId}` && projectChatId !== expected.nativeSessionId) ||
        !Array.isArray(ui.dialogs) || ui.dialogs.length || ui.composerText !== expectedComposer ||
        !Array.isArray(ui.generationControls) || ui.generationControls.length ||
        array(ui.turnStates, 256).some(value => value !== 'complete')) unavailable();
    const dom = object(root.dom, ['turn', 'stateNode', 'message', 'blocks']);
    const turn = node(dom.turn), state = node(dom.stateNode), message = node(dom.message);
    if (turn.tag !== 'DIV' || !UUID.test(attr(turn, 'data-turn-key') ?? '') ||
        state.tag !== 'DIV' || attr(state, 'data-talvt-turn-state') !== 'complete' ||
        message.tag !== 'DIV' || attr(message, 'data-chatgpt-selection-conversation-id') !== expected.nativeSessionId ||
        attr(message, 'data-chatgpt-selection-message-id') !== expected.nativeMessageId) unavailable();
    const blocks = array(dom.blocks, 64);
    const indexes = new Set<string>();
    let selected = 0;
    let assistantReferences = 0;
    let controlLabel = '';
    const attachments: ChatgptAttachmentIdentity[] = [];
    const previewAliases: string[] = [];
    const rendered: string[] = [];
    for (const [index, value] of blocks.entries()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
      const kind = (value as Record<string, unknown>).kind;
      if (kind === 'empty_hidden_span_v1') {
        if (index !== 0) unavailable();
        const block = object(value, ['kind', 'node', 'ancestry']);
        const hidden = node(block.node);
        if (hidden.tag !== 'SPAN' || hidden.attributes.length !== 1 ||
            hidden.attributes[0]![0] !== 'hidden' || hidden.attributes[0]![1] !== '') unavailable();
        const path = ancestry(block.ancestry, message, state, turn, true);
        if (path.length < 4 || JSON.stringify(path[0]) !== JSON.stringify(hidden) ||
            JSON.stringify(path[1]) !== JSON.stringify(message)) unavailable();
      } else if (kind === 'text') {
        const hasAnalysis = Object.hasOwn(value, 'analysisControl');
        const block = object(value, hasAnalysis ? ['kind', 'renderedText', 'analysisControl'] : ['kind', 'renderedText']);
        renderedText(block.renderedText);
        rendered.push(block.renderedText as string);
        if (hasAnalysis) {
          const analysis = object(block.analysisControl, ['label', 'ancestry']);
          if (analysis.label !== 'View analysis') unavailable();
          const path = ancestry(analysis.ancestry, message, state, turn);
          const closed = path.findIndex(item => attr(item, 'data-state') === 'closed');
          const selectedMessage = path.findIndex(item => attr(item, 'data-chatgpt-selection-message-id') !== undefined);
          if (path[0]!.tag !== 'BUTTON' || attr(path[0]!, 'aria-label') !== 'View analysis' ||
              !(0 < closed && closed < selectedMessage)) unavailable();
        }
      } else if (kind === 'rendered_file_links_v1') {
        const block = object(value, ['kind', 'referenceIndex', 'renderedText', 'ancestry', 'links']);
        const text = renderedText(block.renderedText);
        if (typeof block.referenceIndex !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(block.referenceIndex) ||
            indexes.has(block.referenceIndex)) unavailable();
        indexes.add(block.referenceIndex);
        const path = ancestry(block.ancestry, message, state, turn);
        const wrapper = path[0]!;
        if (wrapper.tag !== 'DIV' || attr(wrapper, 'data-dil-source-message-id') !== expected.nativeMessageId ||
            attr(wrapper, 'data-chatgpt-copy-reference') !== block.referenceIndex ||
            attr(wrapper, 'data-markdown-copy') !== 'contents' ||
            attr(path[1]!, 'data-markdown-text-style') !== 'assistant-message') unavailable();
        for (const rawLink of array(block.links, 64)) {
          const link = object(rawLink, ['label', 'renderedText', 'ancestry']);
          const displayPath = renderedText(link.renderedText);
          if (normalizeArtifactPath(displayPath) !== displayPath || displayPath.length > 1024 ||
              link.label !== `Open ${displayPath}` || !text.includes(displayPath)) unavailable();
          const filename = name(displayPath.split('/').at(-1));
          const linkPath = ancestry(link.ancestry, message, state, turn);
          const entry = linkPath[0]!;
          const refAt = linkPath.findIndex(item => attr(item, 'data-dil-source-message-id') !== undefined);
          const renderer = linkPath.findIndex(item => attr(item, 'data-dil-message-id') !== undefined);
          if (entry.tag !== 'SPAN' || attr(entry, 'role') !== 'link' ||
              attr(entry, 'data-d-component') !== 'pressable' || attr(entry, 'tabindex') !== '0' ||
              attr(entry, 'aria-label') !== link.label || !(0 < renderer && renderer < refAt) ||
              attr(linkPath[renderer]!, 'data-dil-message-id') !== expected.nativeMessageId ||
              JSON.stringify(linkPath.slice(refAt)) !== JSON.stringify(path)) unavailable();
          // Non-ZIP Open links are preview aliases of the separately paired native download cards.
          if (!filename.endsWith('.zip')) { previewAliases.push(filename); continue; }
          attachments.push({ kind: 'file_link', filename, referenceIndex: block.referenceIndex });
          if (filename === expected.filename) { selected++; controlLabel = link.label as string; }
        }
        assistantReferences++;
        rendered.push(text);
      } else if (kind === 'file_reference') {
        const block = object(value, ['kind', 'filename', 'referenceIndex', 'renderedText', 'visible', 'ancestry']);
        const filename = name(block.filename), text = renderedText(block.renderedText);
        if (block.visible !== true || typeof block.referenceIndex !== 'string' ||
            !/^(0|[1-9][0-9]{0,2})$/.test(block.referenceIndex) || indexes.has(block.referenceIndex) ||
            !text.includes(filename)) unavailable();
        indexes.add(block.referenceIndex);
        const path = ancestry(block.ancestry, message, state, turn);
        const control = path[0]!;
        if (control.tag !== 'SPAN' || attr(control, 'data-file-reference') !== 'true' ||
            attr(control, 'data-markdown-copy-text') !== filename || attr(control, 'role') !== 'button' ||
            attr(control, 'aria-busy') !== 'false' || attr(control, 'aria-label') !== `Download ${filename}`) unavailable();
        const ref = path.findIndex(item => attr(item, 'data-chatgpt-copy-reference') !== undefined);
        const markdown = path.findIndex(item => attr(item, 'data-markdown-text-style') !== undefined);
        const selectedMessage = path.findIndex(item => attr(item, 'data-chatgpt-selection-message-id') !== undefined);
        if (!(0 < ref && ref < markdown && markdown < selectedMessage) ||
            attr(path[ref]!, 'data-chatgpt-copy-reference') !== block.referenceIndex ||
            attr(path[ref]!, 'data-markdown-copy') !== 'contents' ||
            attr(path[markdown]!, 'data-markdown-text-style') !== 'assistant-message' ||
            attr(path[selectedMessage]!, 'data-chatgpt-selection-conversation-id') !== expected.nativeSessionId) unavailable();
        assistantReferences++;
        attachments.push({ kind, filename, referenceIndex: block.referenceIndex });
        rendered.push(text);
        if (filename === expected.filename) { selected++; controlLabel = `Download ${filename}`; }
      } else if (kind === 'resource_card_group_v1') {
        const block = object(value, ['kind', 'listNode', 'ancestry', 'expandedControl', 'renderedText', 'rows']);
        const list = node(block.listNode), listPath = ancestry(block.ancestry, message, state, turn);
        const listId = attr(list, 'id');
        const control = object(block.expandedControl, ['label', 'node', 'ancestry']);
        const controlNode = node(control.node), controlPath = ancestry(control.ancestry, message, state, turn);
        if (!listId || list.tag !== 'DIV' || JSON.stringify(listPath[0]) !== JSON.stringify(list) ||
            control.label !== 'Show less' || controlNode.tag !== 'BUTTON' ||
            attr(controlNode, 'aria-controls') !== listId || attr(controlNode, 'aria-expanded') !== 'true' ||
            JSON.stringify(controlPath[0]) !== JSON.stringify(controlNode) ||
            JSON.stringify(listPath[1]) !== JSON.stringify(controlPath[1])) unavailable();
        const rows = array(block.rows, 32);
        if (rows.length < 2) unavailable();
        const texts: string[] = [];
        for (const [index, rawRow] of rows.entries()) {
          const row = object(rawRow, ['filename', 'fileType', 'labelState', 'renderedText', 'rowNode',
            'rowAncestry', 'previewNode', 'previewAncestry', 'downloadNode', 'downloadAncestry',
            'rowIndex', 'previewRowIndex', 'downloadRowIndex']);
          const filename = name(row.filename);
          if (!['Document', 'HTML', 'Code', 'Image'].includes(row.fileType as string) ||
              !['type', 'open_file'].includes(row.labelState as string) ||
              row.renderedText !== `${filename}\n${row.labelState === 'type' ? row.fileType : 'Open file'}`) unavailable();
          const rowNode = node(row.rowNode), preview = node(row.previewNode), download = node(row.downloadNode);
          const rowPath = ancestry(row.rowAncestry, message, state, turn);
          const previewPath = ancestry(row.previewAncestry, message, state, turn);
          const downloadPath = ancestry(row.downloadAncestry, message, state, turn);
          const rowAt = (path: DomNode[]) => path.findIndex(item =>
            (attr(item, 'class') ?? '').split(/\s+/).includes('group/resource-row'));
          const previewRowAt = rowAt(previewPath), downloadRowAt = rowAt(downloadPath);
          if (row.rowIndex !== index || row.previewRowIndex !== index || row.downloadRowIndex !== index ||
              rowNode.tag !== 'SPAN' || !(attr(rowNode, 'class') ?? '').split(/\s+/).includes('group/resource-row') ||
              JSON.stringify(rowPath[0]) !== JSON.stringify(rowNode) ||
              JSON.stringify(rowPath[1]) !== JSON.stringify(list) ||
              preview.tag !== 'BUTTON' || attr(preview, 'aria-label') !== `Open preview of ${filename}` ||
              download.tag !== 'BUTTON' || attr(download, 'aria-label') !== 'Download file' ||
              previewRowAt < 1 || downloadRowAt < 1 ||
              JSON.stringify(previewPath.slice(previewRowAt)) !== JSON.stringify(rowPath) ||
              JSON.stringify(downloadPath.slice(downloadRowAt)) !== JSON.stringify(rowPath) ||
              JSON.stringify(previewPath[0]) !== JSON.stringify(preview) ||
              JSON.stringify(downloadPath[0]) !== JSON.stringify(download)) unavailable();
          attachments.push({ kind: 'resource_card', filename, referenceIndex: null });
          texts.push(row.renderedText as string);
          if (filename === expected.filename) { selected++; controlLabel = 'Download file'; }
        }
        if (renderedText(block.renderedText).replace(/\s+/g, ' ').trim() !==
            `${texts.join(' ')} Show less`.replace(/\s+/g, ' ').trim()) unavailable();
        rendered.push(block.renderedText as string);
      } else if (kind === 'image_card') {
        const hasAuxiliary = Object.hasOwn(value, 'auxiliaryLabel');
        const block = object(value, hasAuxiliary ?
          ['kind', 'filename', 'typeImage', 'previewLabel', 'downloadLabel', 'visible', 'ancestry', 'auxiliaryLabel'] :
          ['kind', 'filename', 'typeImage', 'previewLabel', 'downloadLabel', 'visible', 'ancestry']);
        const filename = name(block.filename);
        if (block.visible !== true || block.typeImage !== 'Image' ||
            block.previewLabel !== `Open preview of ${filename}` || block.downloadLabel !== 'Download file' ||
            (hasAuxiliary && block.auxiliaryLabel !== 'Open file')) unavailable();
        const path = ancestry(block.ancestry, message, state, turn);
        if (path[0]!.tag !== 'BUTTON' || attr(path[0]!, 'aria-label') !== 'Download file' ||
            path.some(item => attr(item, 'data-chatgpt-copy-reference') !== undefined)) unavailable();
        attachments.push({ kind, filename, referenceIndex: null });
        rendered.push(`${filename}\nImage`);
        if (filename === expected.filename) { selected++; controlLabel = 'Download file'; }
      } else unavailable();
    }
    if (previewAliases.length && JSON.stringify([...previewAliases].sort()) !== JSON.stringify(attachments
      .filter(item => item.kind === 'resource_card').map(item => item.filename).sort())) unavailable();
    if (expected.attachmentIndex !== undefined) {
      const attachment = attachments[expected.attachmentIndex];
      if (!attachment || attachment.filename !== expected.filename) unavailable();
      controlLabel = attachment.kind === 'file_link' ? `Open ${attachment.filename}` :
        attachment.kind === 'file_reference' ? `Download ${attachment.filename}` : 'Download file';
    } else if (selected !== 1 || new Set(attachments.map(item => item.filename)).size !== attachments.length) unavailable();
    if (!assistantReferences || attachments.length > 64) unavailable();
    const download: ChatgptDownloadObservation = { ...expected, account, controlLabel,
      sourceKind: 'observed_chatgpt_dom_attachment_v1',
      sourceFingerprint: createHash('sha256').update(JSON.stringify([
        'observed_chatgpt_dom_attachment_v1', expected, ui.turnStates, turn, state, message, blocks])).digest('hex') };
    return { download, account, turnId: attr(turn, 'data-turn-key')!, attachments,
      renderedText: rendered.join('\n\n') };
  } catch { unavailable(); }
}

/** A bounded projection of the selected native message DOM. The producer must visit every content block. */
export function parseChatgptDomDownloadObservation(raw: unknown, expected: ChatgptDownloadSelection): ChatgptDownloadObservation {
  return parseAttachmentMessage(raw, expected, '').download;
}

/** Supplies conversation content identity, never download completion or history authority. */
export function parseChatgptAttachmentMessage(raw: unknown,
  expected: Pick<ChatgptDownloadSelection, 'nativeSessionId' | 'nativeMessageId'>, expectedComposer: string) {
  const root = object(raw, ['sourceKind', 'account', 'ui', 'dom']);
  const dom = object(root.dom, ['turn', 'stateNode', 'message', 'blocks']);
  const blocks = array(dom.blocks, 64);
  const first = blocks.find(value => value !== null && typeof value === 'object' &&
    ['file_reference', 'image_card', 'resource_card_group_v1'].includes((value as Record<string, unknown>).kind as string)) as Record<string, unknown> | undefined;
  if (!first) unavailable();
  const { account, turnId, attachments, renderedText } = parseAttachmentMessage(raw,
    { ...expected, filename: name(first.kind === 'resource_card_group_v1' ?
      (array((first as Record<string, unknown>).rows, 32)[0] as Record<string, unknown>).filename : first.filename) }, expectedComposer);
  if (new Set(attachments.map(item => item.filename)).size !== attachments.length) unavailable();
  return { account, turnId, attachments, renderedText };
}
