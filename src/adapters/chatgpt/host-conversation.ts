import { createHash } from 'node:crypto';
import type { ConversationBindingAdapter, ConversationBindingObservation } from '../../application/bindings.js';
import type { ConversationDelta, ConversationPort } from '../../application/session-control.js';
import type { SessionState } from '../../core/collaboration/session-control.js';
import type { HostBaseline, HostMessage } from '../storage/host-conversation-sqlite.js';
import { parseChatgptHostObservation, type ChatgptHostObservation } from './host-observation.js';
import { parseChatgptAttachmentMessage } from './dom-download-observation.js';

const PROVIDER = 'chatgpt-host-web';
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const CHAT_URL = new RegExp(`^https://chatgpt\\.com/c/(${UUID})$`, 'i');
const PROJECT_CHAT_URL = new RegExp(
  `^https://chatgpt\\.com/g/g-p-[0-9a-f]{32}(?:-(?=[a-z0-9-]{1,64}/c/)[a-z0-9]+(?:-[a-z0-9]+)*)?/c/(${UUID})$`);
const UUID_EXACT = new RegExp(`^${UUID}$`, 'i');

export type HostAction =
  | { kind: 'observe'; target: { workspaceId: string; collaborationId: string; nativeSessionId?: string } }
  | { kind: 'download'; phase: 'observe' | 'reconcile'; target: { workspaceId: string; collaborationId: string;
      nativeSessionId: string; nativeMessageId: string; filename: string; attachmentIndex?: number }; captureIntentId: string; retryOfCaptureId?: string }
  | { kind: 'download'; phase: 'commit'; target: { workspaceId: string; collaborationId: string;
      nativeSessionId: string; nativeMessageId: string; filename: string; attachmentIndex?: number }; captureIntentId: string;
      sourceFingerprint: string; expectedAccount: string; retryOfCaptureId?: string }
  | { kind: 'submit'; phase: 'prepare' | 'commit'; target: { workspaceId: string; collaborationId: string; nativeSessionId: string };
      sendIntentId: string; text: string };
export interface HostActionTransport { request(action: HostAction): Promise<unknown> }
type Store = Pick<import('../storage/host-conversation-sqlite.js').HostConversationSqlite,
  'accountKey' | 'putBaseline' | 'getBaseline'>;
type Scope = { workspaceId: string; collaborationId: string };

function object(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || Object.keys(result).some((key) => !keys.includes(key))) {
    throw new Error(`${label} has unsupported fields`);
  }
  return result;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 131_072) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

// A genuine composer chip renders its display name, but native history stores its
// app Markdown. Normalize only this observed prepare shape, never saved messages.
function composerText(value: unknown): unknown {
  const hasNodes = value !== null && typeof value === 'object' && Object.hasOwn(value, 'nodes');
  const composer = object(value, 'composer', hasNodes ? ['text', 'nodes'] : ['text']);
  if (!hasNodes) {
    if (typeof composer.text === 'string' && /^\[\$[^\]\r\n]+\]\(app:\/\//.test(composer.text)) {
      throw new Error('Native app chip observation required');
    }
    return composer.text;
  }
  const nodes = array(composer.nodes, 'composer nodes');
  if (nodes.length !== 1) throw new Error('Unsupported composer paragraphs');
  const paragraph = object(nodes[0], 'composer paragraph', ['tag', 'text', 'attributes', 'children']);
  const children = array(paragraph.children, 'composer children');
  if (paragraph.tag !== 'P' || !equal(paragraph.attributes, []) || paragraph.text !== composer.text ||
      children.length !== 2) throw new Error('Unsupported composer layout');
  const chip = object(children[0], 'composer app chip', ['tag', 'text', 'attributes']);
  const suffix = object(children[1], 'composer suffix', ['tag', 'text', 'attributes']);
  if (chip.tag !== 'SPAN' || suffix.tag !== '#text' || !equal(suffix.attributes, []) ||
      typeof suffix.text !== 'string' || !suffix.text.startsWith(' ') ||
      typeof chip.text !== 'string' || !chip.text || chip.text.length > 256 ||
      chip.text + suffix.text !== composer.text) throw new Error('Unsupported composer app boundary');
  const attributes = new Map<string, string>();
  for (const item of array(chip.attributes, 'composer app attributes')) {
    const attribute = object(item, 'composer app attribute', ['name', 'value']);
    if (typeof attribute.name !== 'string' || typeof attribute.value !== 'string' ||
        attributes.has(attribute.name)) throw new Error('Invalid composer app attribute');
    attributes.set(attribute.name, attribute.value);
  }
  const fixed = {
    'app-mention-brand-color': '', 'data-appearance': 'inline-mention', 'data-layout': 'inline-flow',
    'data-font-weight': 'medium', 'data-tone': 'accent', 'data-interactive': '',
    'data-underline-on-hover': '', contenteditable: 'false',
  };
  const names = [...Object.keys(fixed), 'app-mention-name', 'app-mention-display-name',
    'app-mention-path', 'app-mention-icon', 'data-prompt-link-href', 'data-prompt-link-label', 'class'];
  const slug = attributes.get('app-mention-name');
  const path = attributes.get('app-mention-path');
  const app = /^app:\/\/(asdk_app_[0-9a-f]{32})$/.exec(path ?? '');
  const className = attributes.get('class');
  if (attributes.size !== names.length || [...attributes.keys()].some(name => !names.includes(name)) ||
      Object.entries(fixed).some(([name, expected]) => attributes.get(name) !== expected) ||
      !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 128 || !app ||
      attributes.get('app-mention-display-name') !== chip.text ||
      attributes.get('data-prompt-link-href') !== path || attributes.get('data-prompt-link-label') !== `$${slug}` ||
      !['light', 'dark'].some(theme => attributes.get('app-mention-icon') ===
        `connectors://${app[1]}/logo?theme=${theme}`) || !className || className.length > 256) {
    throw new Error('Composer app identity mismatch');
  }
  return `[$${slug}](${path})${suffix.text}`;
}

function sameMessage(a: HostMessage, b: HostMessage): boolean {
  return a.nativeMessageId === b.nativeMessageId && a.role === b.role && a.text === b.text &&
    a.version === b.version && a.turnId === b.turnId;
}
function sameMessages(a: readonly HostMessage[], b: readonly HostMessage[]): boolean {
  return a.length === b.length && a.every((message, index) => sameMessage(message, b[index]!));
}

interface Parsed { account: string; nativeSessionId: string; messages: HostMessage[]; observation: unknown }
type NativeSource = Pick<HostMessage, 'nativeMessageId' | 'role' | 'text' | 'turnId'>;
const PROJECTION_KEY = 'nativeSourceProjectionV1';

function nativeSource(host: ChatgptHostObservation): NativeSource[] {
  const turns = host.page.order === 'newest_first' ? [...host.turns].reverse() : host.turns;
  const messages: NativeSource[] = [];
  for (const turn of turns) {
    if (turn.status !== 'completed' || turn.messages.length !== 2 || turn.messages[0]?.role !== 'user' ||
        turn.messages[1]?.role !== 'agent' || turn.messages.some(message => message.status !== 'completed')) {
      throw new Error('Incomplete or unsupported turn');
    }
    for (const message of turn.messages) messages.push({ nativeMessageId: message.id,
      role: message.role === 'agent' ? 'assistant' : 'user', text: message.text, turnId: turn.id });
  }
  return messages;
}
function checkNativeSource(messages: readonly NativeSource[]): void {
  if (messages.length > 200 || messages.length % 2 !== 0 ||
      Buffer.byteLength(JSON.stringify(messages), 'utf8') > 1_048_576) throw new Error('Native history exceeds bound');
  const ids = new Set<string>(), turns = new Set<string>();
  for (let i = 0; i < messages.length; i += 2) {
    const user = messages[i]!, assistant = messages[i + 1]!;
    if (user.role !== 'user' || assistant.role !== 'assistant' || user.turnId !== assistant.turnId ||
        typeof user.turnId !== 'string' || !user.turnId || turns.has(user.turnId)) throw new Error('Native turn order changed');
    turns.add(user.turnId);
    for (const message of [user, assistant]) {
      if (!UUID_EXACT.test(message.nativeMessageId) || ids.has(message.nativeMessageId) ||
          typeof message.text !== 'string' || !message.text || Buffer.byteLength(message.text, 'utf8') > 131_072) {
        throw new Error('Native message identity changed');
      }
      ids.add(message.nativeMessageId);
    }
  }
  if (turns.size > 100) throw new Error('Native history exceeds turn bound');
}
function sameNative(a: NativeSource, b: NativeSource): boolean {
  return a.nativeMessageId === b.nativeMessageId && a.role === b.role && a.turnId === b.turnId && a.text === b.text;
}
function stableHostWindows(before: ChatgptHostObservation, after: ChatgptHostObservation): NativeSource[] {
  if (before.threadStatus !== 'idle' || after.threadStatus !== 'idle' ||
      before.page.hasMore || after.page.hasMore ||
      before.page.nextCursor !== null || after.page.nextCursor !== null ||
      !equal(before.page, after.page)) throw new Error('Host windows changed or incomplete');
  const source = nativeSource(before), checked = nativeSource(after);
  checkNativeSource(source);
  if (source.length !== checked.length || source.some((item, i) => !sameNative(item, checked[i]!))) {
    throw new Error('Host windows changed');
  }
  return source;
}
function priorNativeSource(prior: HostBaseline): NativeSource[] {
  const observation = prior.observation;
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new Error('Prior native source unavailable');
  }
  const multipleWindows = Object.hasOwn(observation, 'uiWindows');
  const expected = multipleWindows ? ['account', 'uiWindows', 'host', 'hostAfter'] : ['account', 'ui', 'host'];
  if (!multipleWindows && Object.hasOwn(observation, 'bodyCopies')) expected.push('bodyCopies');
  if (Object.hasOwn(observation, PROJECTION_KEY)) expected.push(PROJECTION_KEY);
  const root = object(observation, 'prior observation', expected);
  if (multipleWindows && (array(root.uiWindows, 'prior UI windows').length < 2 ||
      array(root.uiWindows, 'prior UI windows').length > 32)) {
    throw new Error('Prior UI windows unavailable');
  }
  const hostWindow = multipleWindows ? stableHostWindows(
    parseChatgptHostObservation(root.host, prior.nativeSessionId),
    parseChatgptHostObservation(root.hostAfter, prior.nativeSessionId)) :
    nativeSource(parseChatgptHostObservation(root.host, prior.nativeSessionId));
  checkNativeSource(hostWindow);
  let source = hostWindow;
  if (Object.hasOwn(root, PROJECTION_KEY)) {
    const projection = object(root[PROJECTION_KEY], 'native source projection', ['messages']);
    source = array(projection.messages, 'native source messages').map((item) => {
      const row = object(item, 'native source message', ['nativeMessageId', 'role', 'text', 'turnId']);
      return row as NativeSource;
    });
    checkNativeSource(source);
    if (hostWindow.length > source.length ||
        hostWindow.some((item, i) => !sameNative(item, source[source.length - hostWindow.length + i]!))) {
      throw new Error('Native projection conflicts with stored host window');
    }
  }
  if (source.length !== prior.messages.length || source.some((item, i) =>
    item.nativeMessageId !== prior.messages[i]?.nativeMessageId || item.role !== prior.messages[i]?.role ||
    item.turnId !== prior.messages[i]?.turnId)) throw new Error('Prior native source identity changed');
  return source;
}
function joinNativeWindow(prior: readonly NativeSource[], window: readonly NativeSource[]): NativeSource[] {
  checkNativeSource(window);
  const offsets: number[] = [];
  for (let offset = 0; offset < prior.length; offset += 2) {
    const overlap = prior.length - offset;
    if (window.length >= overlap && prior.slice(offset).every((item, i) => sameNative(item, window[i]!))) offsets.push(offset);
  }
  if (offsets.length !== 1) throw new Error('Native window has no unique complete overlap');
  const combined = [...prior.slice(0, offsets[0]), ...window];
  checkNativeSource(combined);
  return combined;
}

// Native Copy returns the original Markdown; DOM text is a different representation.
// These records are collected by the trusted host around that one UI action.
const COPY_TAGS = new Set(['DIV', 'P', 'SPAN', 'A', 'STRONG', 'EM', 'CODE', 'PRE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY',
  'TR', 'TH', 'TD', 'BLOCKQUOTE', 'HR', 'BR', 'DEL', 'S', 'SUP', 'SUB',
  'svg', 'path', 'use', 'circle', 'rect',
  'math', 'semantics', 'mrow', 'msub', 'mi', 'mo', 'annotation']);
const COPY_SENTINEL = 'repoconduit-native-message-copy-v1';

function copiedBody(copy: Record<string, unknown>, message: HostMessage, nativeSessionId: string,
  body: Record<string, unknown>, account: string, expectedComposer: string): Pick<HostMessage, 'text' | 'version'> {
  const hasAttachments = copy.kind === 'native_message_attachment_copy_v1';
  const hasRichDom = copy.kind === 'native_message_rich_copy_v1';
  const keys = ['nativeSessionId', 'nativeMessageId', 'role', 'text', 'tags'];
  const before = object(copy.before, 'copy source before', keys);
  const after = object(copy.after, 'copy source after', keys);
  for (const source of [before, after]) {
    if (source.nativeSessionId !== nativeSessionId ||
        uiMessageId(source.nativeMessageId, message.nativeMessageId) !== message.nativeMessageId ||
        source.role !== message.role || source.text !== body.text || !equal(source.tags, body.tags)) {
      throw new Error('Native Copy source changed or mismatched');
    }
  }
  text(body.text, 'rendered message body');
  const tags = array(body.tags, 'rendered message tags');
  if (tags.length > 64 || tags.some(tag => typeof tag !== 'string' ||
      (!COPY_TAGS.has(tag) && !(hasAttachments && tag === 'BUTTON') && !(hasRichDom && tag === 'IMG')))) {
    throw new Error('Unsupported copied message markup');
  }
  // Never capture or persist the person's pre-existing clipboard contents.
  if (copy.clipboardBefore !== COPY_SENTINEL) throw new Error('Native Copy sentinel missing');
  const result = text(copy.clipboardAfter, 'clipboard after');
  if (result === COPY_SENTINEL || /^\s*::chatgpt-content-reference\b/.test(result)) {
    throw new Error('Native Copy did not supply a resolved body');
  }
  if (!hasAttachments) {
    const reference = /^::chatgpt-content-reference\{index="(?:0|[1-9][0-9]{0,2})" source_message_id="([^"]+)"\}$/.exec(message.text);
    if (reference) {
      if (message.role !== 'assistant' || reference[1] !== message.nativeMessageId) {
        throw new Error('Content reference message mismatch');
      }
    } else if (message.text !== result) {
      throw new Error('Native Copy conflicts with host body');
    }
  }
  if (hasRichDom) {
    if (message.role !== 'assistant' || !equal(copy.richBefore, copy.richAfter) ||
        !equal(copy.richBefore, body.rich)) throw new Error('Rich Copy DOM changed or mismatched');
    const rich = object(copy.richBefore, 'rich Copy DOM',
      ['account', 'nativeSessionId', 'nativeMessageId', 'role', 'bodyText', 'inlineImages', 'codeEditors']);
    if (rich.account !== account || rich.nativeSessionId !== nativeSessionId ||
        uiMessageId(rich.nativeMessageId, message.nativeMessageId) !== message.nativeMessageId ||
        rich.role !== message.role ||
        rich.bodyText !== body.text) throw new Error('Rich Copy identity mismatch');
    const images = array(rich.inlineImages, 'rich inline images');
    const editors = array(rich.codeEditors, 'rich code editors');
    if ((!images.length && !editors.length) || images.length > 8 || editors.length > 1 ||
        ((tags.includes('PRE') || tags.includes('CODE')) && !editors.length) ||
        tags.includes('IMG') !== (images.length > 0) ||
        (editors.length > 0 && !tags.includes('DIV'))) {
      throw new Error('Rich Copy markup mismatch');
    }
    for (const [index, item] of images.entries()) {
      const image = object(item, 'rich inline image', ['index', 'attributes']);
      if (image.index !== index) throw new Error('Rich image order mismatch');
      const attributes = array(image.attributes, 'rich image attributes').map(item =>
        object(item, 'rich image attribute', ['name', 'value']));
      const names = ['alt', 'data-d-component', 'decoding', 'style', 'src'];
      const attr = new Map(attributes.map(item => [item.name, item.value]));
      const src = attr.get('src');
      if (attributes.length !== names.length || attr.size !== names.length ||
          attributes.some((item, i) => item.name !== names[i] || typeof item.value !== 'string') ||
          attr.get('alt') !== '' || attr.get('data-d-component') !== 'svg' ||
          attr.get('decoding') !== 'async' || typeof attr.get('style') !== 'string' ||
          (attr.get('style') as string).length > 1024 || typeof src !== 'string' ||
          Buffer.byteLength(src, 'utf8') > 65_536 ||
          !/^data:image\/svg\+xml;charset=utf-8,(?:%[0-9a-f]{2}|[A-Za-z0-9._~!$&'()*+,;=:/?@-])+$/i.test(src)) {
        throw new Error('Unsupported rich inline image');
      }
    }
    for (const [index, item] of editors.entries()) {
      const editor = object(item, 'rich code editor', ['index', 'attributes', 'lines', 'text']);
      const attributes = array(editor.attributes, 'rich editor attributes').map(item =>
        object(item, 'rich editor attribute', ['name', 'value']));
      const attr = new Map(attributes.map(item => [item.name, item.value]));
      const lines = array(editor.lines, 'rich editor lines');
      const editorNames = ['spellcheck', 'autocorrect', 'autocapitalize', 'writingsuggestions',
        'translate', 'contenteditable', 'style', 'class', 'role', 'aria-multiline',
        'aria-label', 'data-language'];
      if (editor.index !== index || attributes.length !== editorNames.length ||
          attr.size !== editorNames.length || attributes.some((item, i) =>
            item.name !== editorNames[i] || typeof item.value !== 'string' || item.value.length > 1024) ||
          attr.get('spellcheck') !== 'false' || attr.get('autocorrect') !== 'off' ||
          attr.get('autocapitalize') !== 'off' || attr.get('writingsuggestions') !== 'false' ||
          attr.get('translate') !== 'no' || attr.get('style') !== 'tab-size: 4;' ||
          attr.get('contenteditable') !== 'true' || attr.get('role') !== 'textbox' ||
          attr.get('aria-multiline') !== 'true' || attr.get('aria-label') !== 'Edit code' ||
          attr.get('class') !== 'cm-content' ||
          typeof attr.get('data-language') !== 'string' ||
          !/^[A-Za-z0-9_-]{1,32}$/.test(attr.get('data-language') as string) ||
          !lines.length || lines.length > 512 || lines.some(line =>
            typeof line !== 'string' || /[\r\n]/.test(line) || line.length > 4096) ||
          editor.text !== lines.join('\n') || Buffer.byteLength(editor.text, 'utf8') > 131_072) {
        throw new Error('Unsupported rich code editor');
      }
      const markdown = `\`\`\`\n${lines.join('')}\n\`\`\``;
      if (result.split(markdown).length !== 2) throw new Error('Rich editor and native Copy code differ');
    }
    // text remains the native Copy text portion; the inert DOM evidence is
    // retained in the observation and hashed into this message version.
    return { text: result, version: createHash('sha256').update(JSON.stringify([
      'native_message_rich_copy_v1', message.role, message.nativeMessageId, result, rich])).digest('hex') };
  }
  if (hasAttachments) {
    if (message.role !== 'assistant' || !equal(copy.attachmentBefore, copy.attachmentAfter)) {
      throw new Error('Attachment Copy source changed or mismatched');
    }
    const attachment = parseChatgptAttachmentMessage(copy.attachmentBefore,
      { nativeSessionId, nativeMessageId: message.nativeMessageId }, expectedComposer);
    if (attachment.account !== account || attachment.turnId !== message.turnId || attachment.renderedText !== body.text) {
      throw new Error('Attachment Copy identity or body mismatch');
    }
    const identities: unknown[] = [];
    const byFilename = new Map(attachment.attachments.map(item => [item.filename, item]));
    if (byFilename.size !== attachment.attachments.length) throw new Error('Duplicate DOM attachment');
    const consumed = new Set<string>();
    const cardOrder: string[] = [];
    let index = 0;
    // eslint-disable-next-line no-useless-escape -- explicit brackets keep the native token boundary readable
    const inlineReference = /(?<!:):chatgpt-content-reference\{index="(0|[1-9][0-9]{0,2})"\}(\[([^\[\]\r\n]+)\]\((sandbox:\/mnt\/data\/[^()[\]\\\r\n]+)\))/g;
    const expectedCopy = message.text.replace(inlineReference,
      (whole: string, referenceIndex: string, link: string, label: string, producerReference: string) => {
        const segments = producerReference.slice('sandbox:/mnt/data/'.length).split('/');
        const filename = segments.at(-1)!;
        if (segments.some(segment => !segment || segment === '.' || segment === '..' ||
            segment.includes('%') || segment.includes('\\')) ||
            segments.slice(0, -1).some(segment => !/^[A-Za-z0-9._-]+$/.test(segment)) ||
            !(label === filename || (segments.length === 1 && label === `下载 ${filename}`)) ||
            segments.length > 8 || producerReference.length > 2048) throw new Error('Unsafe producer reference');
        const item = byFilename.get(filename);
        if (!item || consumed.has(filename) || referenceIndex !== String(index) ||
            (item.kind === 'file_reference' && item.referenceIndex !== referenceIndex)) {
          throw new Error('Attachment inline reference mismatch');
        }
        consumed.add(filename);
        if (item.kind === 'resource_card') cardOrder.push(filename);
        identities.push({ ...item, referenceIndex, producerReference });
        index++;
        return item.kind === 'file_reference' ? `${filename}${link}` : whole;
      });
    // Every token must be one matched inline identity; never strip or guess unresolved references.
    const residue = message.text.replace(inlineReference, '');
    const domCardOrder = attachment.attachments.filter(item => item.kind === 'resource_card').map(item => item.filename);
    if (index !== attachment.attachments.length || consumed.size !== attachment.attachments.length ||
        !equal(cardOrder, domCardOrder) || /chatgpt-content-reference\b/.test(residue) || expectedCopy !== result) {
      throw new Error('Attachment Copy conflicts with complete host body');
    }
    return { text: result, version: createHash('sha256').update(JSON.stringify([
      'native_message_attachment_copy_v1', message.role, message.nativeMessageId, result, identities])).digest('hex') };
  }
  return { text: result, version: createHash('sha256').update(JSON.stringify([
    message.role, message.nativeMessageId, result])).digest('hex') };
}

function accountEmail(accountRaw: unknown): string {
  if (accountRaw === null || typeof accountRaw !== 'object' || Array.isArray(accountRaw)) {
    throw new Error('Account identity unavailable');
  }
  const accountKeys = Object.keys(accountRaw);
  if (accountKeys.length !== 1 || (accountKeys[0] !== 'labels' && accountKeys[0] !== 'fields')) {
    throw new Error('Unsupported account source');
  }
  const account = object(accountRaw, 'account', [accountKeys[0]!]);
  let email: string;
  if (accountKeys[0] === 'labels') {
    const labels = array(account.labels, 'account labels');
    if (labels.length < 1 || labels.some((label) => typeof label !== 'string' ||
        !/^Change email: [^\s@]+@[^\s@]+\.[^\s@]+$/.test(label))) throw new Error('Account identity unavailable');
    const emails = [...new Set(labels.map((label) => (label as string).slice('Change email: '.length)))];
    if (emails.length !== 1) throw new Error('Conflicting account identity');
    email = emails[0]!;
  } else {
    const fields = array(account.fields, 'account fields');
    if (fields.length !== 1) throw new Error('Unique Email field required');
    const field = object(fields[0], 'account field', ['label', 'value']);
    if (field.label !== 'Email' || typeof field.value !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(field.value)) throw new Error('Account Email field unavailable');
    email = field.value;
  }
  return email;
}

function validatedUi(raw: unknown, expectedNative: string | undefined, expectedComposer: string):
  { ui: Record<string, unknown>; nativeSessionId: string } {
  const ui = object(raw, 'ui', ['url', 'dialogs', 'buttons', 'headings', 'composers', 'media']);
  const url = text(ui.url, 'chat URL');
  const match = CHAT_URL.exec(url) ?? PROJECT_CHAT_URL.exec(url);
  if (!match || (expectedNative && match[1] !== expectedNative)) throw new Error('Native conversation mismatch');
  const nativeSessionId = match[1]!;
  const media = array(ui.media, 'media');
  if (array(ui.dialogs, 'dialogs').length || media.length > 8 ||
      media.some(item => object(item, 'media item', ['tag']).tag !== 'IMG')) {
    throw new Error('Unsupported dialog or media');
  }
  const composers = array(ui.composers, 'composers');
  if (composers.length !== 1 || composerText(composers[0]) !== expectedComposer) {
    throw new Error('Composer is not in expected state');
  }
  for (const item of array(ui.buttons, 'buttons')) {
    const button = object(item, 'button', ['label', 'disabled']);
    if (typeof button.label !== 'string' || typeof button.disabled !== 'boolean') throw new Error('Invalid button');
    if (/stop generating|load older/i.test(button.label)) throw new Error('Incomplete or unsupported page');
  }
  return { ui, nativeSessionId };
}

function uiMessageId(raw: unknown, expected?: string): string {
  const value = text(raw, 'UI message ids');
  const ids = value.match(new RegExp(UUID, 'gi'));
  const id = ids?.[0];
  if (!id || !UUID_EXACT.test(id) || (expected !== undefined && (!UUID_EXACT.test(expected) || id !== expected)) ||
      ids.some(item => item !== id) ||
      value.replace(new RegExp(UUID, 'gi'), '').trim().replace(/[\s,]+/g, '') !== '') {
    throw new Error('UI message identity mismatch');
  }
  return id;
}

function parseWindowMessages(ui: Record<string, unknown>, copiesRaw: unknown, source: readonly NativeSource[],
  nativeSessionId: string, email: string, expectedComposer: string): HostMessage[] {
  const headings = array(ui.headings, 'headings');
  const messages: HostMessage[] = source.map(message => ({ ...message,
    version: createHash('sha256').update(JSON.stringify([message.role, message.nativeMessageId, message.text])).digest('hex') }));
  if (headings.length !== messages.length) throw new Error('UI and host history length mismatch');
  const copies = new Map<string, Record<string, unknown>>();
  let boundRichImages = 0;
  for (const item of copiesRaw === undefined ? [] : array(copiesRaw, 'body copies')) {
    const kind = item !== null && typeof item === 'object' ? (item as Record<string, unknown>).kind : null;
    const copy = object(item, 'body copy', kind === 'native_message_attachment_copy_v1' ?
      ['kind', 'before', 'after', 'clipboardBefore', 'clipboardAfter', 'attachmentBefore', 'attachmentAfter'] :
      kind === 'native_message_rich_copy_v1' ?
      ['kind', 'before', 'after', 'clipboardBefore', 'clipboardAfter', 'richBefore', 'richAfter'] :
      ['kind', 'before', 'after', 'clipboardBefore', 'clipboardAfter']);
    if (copy.kind !== 'native_message_copy_v1' && copy.kind !== 'native_message_attachment_copy_v1' &&
        copy.kind !== 'native_message_rich_copy_v1') {
      throw new Error('Unsupported body Copy source');
    }
    const before = object(copy.before, 'copy source before', ['nativeSessionId', 'nativeMessageId', 'role', 'text', 'tags']);
    const id = uiMessageId(before.nativeMessageId);
    if (copies.size >= messages.length || copies.has(id)) throw new Error('Duplicate or extra body Copy');
    copies.set(id, copy);
  }
  for (let i = 0; i < headings.length; i++) {
    const heading = object(headings[i], 'heading',
      ['label', 'roleAttribute', 'messageIds', 'bubble', 'assistant', 'selection']);
    const message = messages[i]!;
    const expectedLabel = message.role === 'user' ? 'You said:' : 'ChatGPT said:';
    if (heading.label !== expectedLabel || heading.roleAttribute !== (message.role === 'user' ? null : 'assistant')) {
      throw new Error('UI role mismatch');
    }
    uiMessageId(heading.messageIds, message.nativeMessageId);
    const copy = copies.get(message.nativeMessageId);
    if (!copy && /^\s*::chatgpt-content-reference\b/.test(message.text)) {
      throw new Error('Unresolved host content reference');
    }
    if (message.role === 'user') {
      const bubble = object(heading.bubble, 'user bubble', ['text', 'tags']);
      if (heading.assistant !== null || heading.selection !== null) throw new Error('Unsupported user markup');
      if (copy) Object.assign(message, copiedBody(copy, message, nativeSessionId, bubble, email, expectedComposer));
      else if (bubble.text !== message.text || array(bubble.tags, 'user tags').length) {
        throw new Error('Unsupported user markup');
      }
    } else {
      const assistant = object(heading.assistant, 'assistant body', copy?.kind === 'native_message_rich_copy_v1' ?
        ['text', 'tags', 'rich'] : ['text', 'tags']);
      const selection = object(heading.selection, 'assistant selection', ['conversationId', 'messageId']);
      if (selection.conversationId !== nativeSessionId || selection.messageId !== message.nativeMessageId ||
          heading.bubble !== null) throw new Error('Unsupported assistant markup or selection');
      if (copy) {
        Object.assign(message, copiedBody(copy, message, nativeSessionId, assistant, email, expectedComposer));
        if (copy.kind === 'native_message_rich_copy_v1') {
          boundRichImages += array(object(assistant.rich, 'bound rich DOM',
            ['account', 'nativeSessionId', 'nativeMessageId', 'role', 'bodyText',
              'inlineImages', 'codeEditors']).inlineImages, 'bound rich images').length;
        }
      }
      else if (assistant.text !== message.text || !equal(assistant.tags, ['P', 'SPAN'])) {
        throw new Error('Unsupported assistant markup or selection');
      }
    }
    if (copy) copies.delete(message.nativeMessageId);
  }
  if (copies.size) throw new Error('Unmatched body Copy');
  if (array(ui.media, 'media').length !== boundRichImages) throw new Error('Unbound page media');
  return messages;
}

function parseUiWindows(decoded: unknown, expectedNative: string | undefined,
  expectedComposer: string, prior: HostBaseline | undefined): Parsed {
  const root = object(decoded, 'host bridge result', ['account', 'uiWindows', 'host', 'hostAfter']);
  if (!prior) throw new Error('Multiple UI windows require a retained native prefix');
  const email = accountEmail(root.account);
  const windows = array(root.uiWindows, 'UI windows');
  if (windows.length < 2 || windows.length > 32) throw new Error('Unsupported UI window count');
  const parsed = windows.map(item => {
    const window = object(item, 'UI window', ['account', 'ui', 'bodyCopies']);
    if (!equal(window.account, root.account) || accountEmail(window.account) !== email) {
      throw new Error('UI window account changed');
    }
    const { ui, nativeSessionId } = validatedUi(window.ui, expectedNative, expectedComposer);
    return { ui, bodyCopies: window.bodyCopies, nativeSessionId };
  });
  const nativeSessionId = parsed[0]!.nativeSessionId;
  if (parsed.some(window => window.nativeSessionId !== nativeSessionId) || prior.nativeSessionId !== nativeSessionId) {
    throw new Error('UI window conversation changed');
  }
  const hostWindow = stableHostWindows(
    parseChatgptHostObservation(root.host, nativeSessionId),
    parseChatgptHostObservation(root.hostAfter, nativeSessionId));
  const source = joinNativeWindow(priorNativeSource(prior), hostWindow);
  const messages: HostMessage[] = [];
  let previousStart = -1;
  for (const window of parsed) {
    const headings = array(window.ui.headings, 'UI headings');
    if (headings.length < 2 || headings.length % 2) throw new Error('Incomplete UI window');
    const firstHeading = object(headings[0], 'first heading',
      ['label', 'roleAttribute', 'messageIds', 'bubble', 'assistant', 'selection']);
    const firstId = uiMessageId(firstHeading.messageIds);
    const start = source.findIndex(item => item.nativeMessageId === firstId);
    if (start < 0 || start % 2 || start + headings.length > source.length || start <= previousStart ||
        (previousStart === -1 ? start !== 0 : start > messages.length - 2)) {
      throw new Error('UI windows have no ordered complete-turn overlap');
    }
    const observed = parseWindowMessages(window.ui, window.bodyCopies,
      source.slice(start, start + headings.length), nativeSessionId, email, expectedComposer);
    const overlap = messages.length - start;
    if (previousStart !== -1 && (overlap < 2 || overlap % 2 || overlap >= observed.length ||
        observed.slice(0, overlap).some((item, i) => !sameMessage(item, messages[start + i]!)))) {
      throw new Error('UI window overlap changed');
    }
    messages.push(...observed.slice(overlap));
    previousStart = start;
  }
  if (messages.length !== source.length) throw new Error('UI windows do not cover complete history');
  return { account: email, nativeSessionId, messages,
    observation: { ...root, [PROJECTION_KEY]: { messages: source } } };
}

function parse(raw: unknown, expectedNative?: string, expectedComposer = '', prior?: HostBaseline): Parsed {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(raw); } catch { throw new Error('Host bridge result is not JSON serializable'); }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > 1_048_576) throw new Error('Host bridge result exceeds limit');
  const decoded: unknown = JSON.parse(encoded);
  if (decoded !== null && typeof decoded === 'object' && Object.hasOwn(decoded, 'uiWindows')) {
    return parseUiWindows(decoded, expectedNative, expectedComposer, prior);
  }
  const hasCopies = decoded !== null && typeof decoded === 'object' && Object.hasOwn(decoded, 'bodyCopies');
  const root = object(decoded, 'host bridge result', hasCopies ? ['account', 'ui', 'host', 'bodyCopies'] : ['account', 'ui', 'host']);
  const email = accountEmail(root.account);
  const { ui, nativeSessionId } = validatedUi(root.ui, expectedNative, expectedComposer);
  const host = parseChatgptHostObservation(root.host, nativeSessionId);
  if (host.threadStatus !== 'idle' || host.page.hasMore || host.page.nextCursor !== null) {
    throw new Error('Host history is not idle and complete');
  }
  const window = nativeSource(host);
  const headings = array(ui.headings, 'headings');
  const completeCurrentPage = prior && window.length >= prior.messages.length && headings.length === window.length &&
    prior.messages.every((message, index) => message.nativeMessageId === window[index]?.nativeMessageId &&
      message.role === window[index]?.role && message.turnId === window[index]?.turnId);
  const source = prior && !completeCurrentPage ? joinNativeWindow(priorNativeSource(prior), window) : window;
  checkNativeSource(source);
  const messages = parseWindowMessages(ui, hasCopies ? root.bodyCopies : undefined,
    source, nativeSessionId, email, expectedComposer);
  return { account: email, nativeSessionId, messages,
    observation: source.length > window.length ? { ...root, [PROJECTION_KEY]: { messages: source } } : root };
}

export class ChatgptHostConversation implements ConversationBindingAdapter, ConversationPort {
  constructor(private readonly store: Store, private readonly transport: HostActionTransport) {}

  async observeBinding(scope: Scope): Promise<ConversationBindingObservation> {
    const parsed = parse(await this.transport.request({ kind: 'observe', target: scope }));
    const accountId = this.store.accountKey(PROVIDER, 'settings-account-email', parsed.account);
    const cursor = this.store.putBaseline({ ...scope, providerId: PROVIDER, accountId,
      nativeSessionId: parsed.nativeSessionId, parentCursor: null, messages: parsed.messages,
      observation: parsed.observation });
    return { providerId: PROVIDER, accountId, nativeSessionId: parsed.nativeSessionId, cursor };
  }

  private baseline(binding: SessionState): HostBaseline {
    const prior = this.store.getBaseline(binding.cursor);
    if (!prior || prior.workspaceId !== binding.workspaceId || prior.collaborationId !== binding.collaborationId ||
        prior.providerId !== PROVIDER || prior.providerId !== binding.providerId ||
        prior.accountId !== binding.accountId || prior.nativeSessionId !== binding.nativeSessionId) {
      throw new Error('Baseline does not match binding');
    }
    return prior;
  }

  async syncDelta(binding: SessionState): Promise<ConversationDelta> {
    const prior = this.baseline(binding);
    const parsed = parse(await this.transport.request({ kind: 'observe', target: {
      workspaceId: binding.workspaceId, collaborationId: binding.collaborationId,
      nativeSessionId: binding.nativeSessionId } }), binding.nativeSessionId, '', prior);
    if (this.store.accountKey(PROVIDER, 'settings-account-email', parsed.account) !== binding.accountId ||
        parsed.messages.length < prior.messages.length ||
        prior.messages.some((message, i) => !sameMessage(message, parsed.messages[i]!))) {
      throw new Error('Account or prior conversation history changed');
    }
    const appended = parsed.messages.slice(prior.messages.length);
    const nextCursor = appended.length ? this.store.putBaseline({ workspaceId: binding.workspaceId,
      collaborationId: binding.collaborationId, providerId: PROVIDER, accountId: binding.accountId,
      nativeSessionId: binding.nativeSessionId, parentCursor: prior.cursor, messages: parsed.messages,
      observation: parsed.observation }) : prior.cursor;
    const intent = binding.sendIntent;
    const completedSend = intent && appended.length === 2 && appended[0]?.role === 'user' &&
      appended[1]?.role === 'assistant' && appended[0].turnId === appended[1].turnId &&
      appended[0].text === intent.text ? { sendIntentId: intent.id,
        nativeUserMessageId: appended[0].nativeMessageId,
        nativeReplyMessageId: appended[1].nativeMessageId } : undefined;
    return { providerId: PROVIDER, accountId: binding.accountId, nativeSessionId: binding.nativeSessionId,
      fromCursor: binding.cursor, nextCursor, complete: true, generating: false, historyChanged: false,
      messages: appended.map((message) => ({ nativeMessageId: message.nativeMessageId,
        version: message.version, text: message.text })), ...(completedSend ? { completedSend } : {}) };
  }

  async send(binding: SessionState, requestText: string,
    hooks?: { onBeforeSubmit(): Promise<void> }): Promise<{ status: 'unknown' | 'rejected' }> {
    if (!hooks || !binding.sendIntent || binding.sendIntent.text !== requestText || !requestText.trim()) {
      throw new Error('Persisted send intent and checkpoint are required');
    }
    const prior = this.baseline(binding);
    const target = { workspaceId: binding.workspaceId, collaborationId: binding.collaborationId,
      nativeSessionId: binding.nativeSessionId };
    const action = { kind: 'submit' as const, target, sendIntentId: binding.sendIntent.id, text: requestText };
    const rawPrepared = await this.transport.request({ ...action, phase: 'prepare' });
    try {
      // A returned prepare observation cannot submit; only commit releases that action.
      const prepared = parse(rawPrepared, binding.nativeSessionId, requestText, prior);
      if (this.store.accountKey(PROVIDER, 'settings-account-email', prepared.account) !== binding.accountId ||
          !sameMessages(prepared.messages, prior.messages)) return { status: 'rejected' };
    } catch { return { status: 'rejected' }; }
    await hooks.onBeforeSubmit();
    const result = await this.transport.request({ ...action, phase: 'commit' });
    const commit = object(result, 'submit result', ['toolResult']);
    if (JSON.stringify(commit.toolResult) === undefined) throw new Error('Unserializable submit result');
    return { status: 'unknown' };
  }
}
