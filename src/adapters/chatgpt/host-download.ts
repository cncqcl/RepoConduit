import { createHash } from 'node:crypto';
import { normalizeArtifactPath } from '../../core/artifact/paths.js';
import { parseChatgptHostObservation } from './host-observation.js';
import { parseChatgptDomDownloadObservation } from './dom-download-observation.js';

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
  if (!Array.isArray(value) || value.length > limit) unavailable();
  return value;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Normal Account UI only. The returned value is private transport input, never a public receipt. */
export function parseChatgptDownloadAccount(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) unavailable();
  const source = raw as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== 1 || !['fields', 'labels'].includes(keys[0]!)) unavailable();
  let values: unknown[];
  if (keys[0] === 'fields') {
    const fields = array(source.fields, 1);
    if (fields.length !== 1) unavailable();
    const field = object(fields[0], ['label', 'value']);
    if (field.label !== 'Email') unavailable();
    values = [field.value];
  } else {
    const labels = array(source.labels, 8);
    if (!labels.length || labels.some(label => typeof label !== 'string' || !label.startsWith('Change email: '))) unavailable();
    values = labels.map(label => (label as string).slice('Change email: '.length));
  }
  if (values.some(value => typeof value !== 'string' || Buffer.byteLength(value) > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) unavailable();
  if (new Set(values).size !== 1) unavailable();
  return values[0] as string;
}

export interface ChatgptDownloadSelection {
  nativeSessionId: string;
  nativeMessageId: string;
  filename: string;
  /** Zero-based recognized download entry in the complete selected message. */
  attachmentIndex?: number;
}
export interface ChatgptDownloadObservation extends ChatgptDownloadSelection {
  /** Private input for installation-scoped accountKey; never serialized as capture evidence. */
  account: string;
  controlLabel: string;
  sourceFingerprint: string;
  sourceKind: 'observed_host_ui_attachment' | 'observed_chatgpt_dom_attachment_v1';
}

/** A source observation only: does not authorize a click, authenticate file bytes, or establish a session baseline. */
export function parseChatgptDownloadObservation(raw: unknown, expected: ChatgptDownloadSelection): ChatgptDownloadObservation {
  try {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(raw); } catch { unavailable(); }
    if (!serialized || Buffer.byteLength(serialized) > 1_048_576) unavailable();
    const indexed = Object.hasOwn(expected, 'attachmentIndex');
    const selection = object(expected, ['nativeSessionId', 'nativeMessageId', 'filename', ...(indexed ? ['attachmentIndex'] : [])]);
    if (indexed && (!Number.isSafeInteger(selection.attachmentIndex) ||
        (selection.attachmentIndex as number) < 0 || (selection.attachmentIndex as number) > 63)) unavailable();
    if (typeof selection.nativeSessionId !== 'string' || !UUID.test(selection.nativeSessionId) ||
        typeof selection.nativeMessageId !== 'string' || !UUID.test(selection.nativeMessageId) ||
        typeof selection.filename !== 'string' || Buffer.byteLength(selection.filename) > 255 ||
        normalizeArtifactPath(selection.filename) !== selection.filename || selection.filename.includes('/')) unavailable();
    const source = JSON.parse(serialized) as unknown;
    if (source && typeof source === 'object' && !Array.isArray(source) &&
        Object.hasOwn(source, 'sourceKind')) return parseChatgptDomDownloadObservation(source, expected);
    const root = object(source, ['account', 'ui', 'host']);
    // Legacy native UI observations do not carry an ordered complete attachment set.
    if (indexed) unavailable();
    const account = parseChatgptDownloadAccount(root.account);
    const ui = object(root.ui, ['url', 'dialogs', 'composerText', 'downloads']);
    const projectChatId = typeof ui.url === 'string' ? PROJECT_CHAT_URL.exec(ui.url)?.[1] : undefined;
    if ((ui.url !== `https://chatgpt.com/c/${expected.nativeSessionId}` && projectChatId !== expected.nativeSessionId) ||
        array(ui.dialogs, 8).length || ui.composerText !== '') unavailable();
    const controls = array(ui.downloads, 32).map(item => object(item,
      ['label', 'filename', 'conversationId', 'messageId', 'turnId', 'turnState', 'authorRole',
        'referenceIndex', 'fileReference', 'tag', 'role', 'busy', 'visible']));
    const candidates = controls.filter(control => control.filename === expected.filename);
    if (candidates.length !== 1) unavailable();
    const control = candidates[0]!;
    const label = `Download ${expected.filename}`;
    if (control.label !== label || control.conversationId !== expected.nativeSessionId ||
        control.messageId !== expected.nativeMessageId || control.turnState !== 'complete' ||
        control.authorRole !== 'assistant' || control.fileReference !== 'true' || control.tag !== 'SPAN' ||
        control.role !== 'button' || control.busy !== 'false' || control.visible !== true ||
        typeof control.turnId !== 'string' || !UUID.test(control.turnId) ||
        typeof control.referenceIndex !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(control.referenceIndex)) unavailable();
    const host = parseChatgptHostObservation(root.host, expected.nativeSessionId);
    if (host.threadStatus !== 'idle' || host.page.hasMore || host.page.nextCursor !== null) unavailable();
    const turn = host.turns.find(item => item.id === control.turnId);
    const message = turn?.messages.find(item => item.id === expected.nativeMessageId);
    if (!turn || turn.status !== 'completed' || !message || message.role !== 'agent' || message.status !== 'completed') unavailable();
    // A sandbox reference is only the producer's selected attachment identity, never a fetch URL or local path.
    const escapedName = expected.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reference = new RegExp(`:chatgpt-content-reference\\{index="${control.referenceIndex}"\\}\\[[^\\]\\r\\n]+\\]\\(sandbox:/mnt/data/${escapedName}\\)`, 'g');
    const selectedIndex = new RegExp(`:chatgpt-content-reference\\{index="${control.referenceIndex}"\\}`, 'g');
    if ([...message.text.matchAll(selectedIndex)].length !== 1 || controls.filter(item =>
      item.conversationId === expected.nativeSessionId && item.messageId === expected.nativeMessageId &&
      item.referenceIndex === control.referenceIndex).length !== 1) unavailable();
    if ([...message.text.matchAll(reference)].length !== 1) unavailable();
    return { ...expected, account, controlLabel: label, sourceKind: 'observed_host_ui_attachment',
      sourceFingerprint: hash(JSON.stringify([expected.nativeSessionId, expected.nativeMessageId,
        control.turnId, expected.filename, control.referenceIndex, hash(message.text)])) };
  } catch { unavailable(); }
}
