/** A bounded, read-only record of one Codex App read_thread page. */
export interface ChatgptHostObservation {
  readonly threadId: string;
  readonly threadStatus: string;
  readonly page: {
    readonly order: 'newest_first' | 'oldest_first';
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
  readonly turns: readonly {
    readonly id: string;
    readonly status: string;
    readonly messages: readonly {
      readonly id: string;
      readonly role: 'user' | 'agent';
      readonly text: string;
      readonly status: string;
      readonly truncated: false;
    }[];
  }[];
  readonly coverage: 'observed_host_api_page';
  readonly accountIdentity: 'unknown';
  readonly branchHistory: 'unverified';
  readonly lifetimeHistory: 'unverified';
}

const MAX_BYTES = 1_048_576;
const MAX_TEXT_BYTES = 131_072;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error(`${label} must be nonempty bounded text`);
  }
  return value;
}

function optionalScalarString(value: unknown, label: string, maxBytes: number, nullable = false): void {
  if (value === undefined || (nullable && value === null)) return;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${label} must be bounded scalar text`);
  }
}

function optionalScalarNumber(value: unknown, label: string, nullable = false): void {
  if (value === undefined || (nullable && value === null)) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite nonnegative scalar`);
  }
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function rejectTruncation(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === null || typeof next !== 'object') continue;
    if (Array.isArray(next)) {
      pending.push(...next);
      continue;
    }
    for (const [key, child] of Object.entries(next)) {
      if (/truncat/i.test(key) && child !== false && child !== null) {
        throw new Error('truncated host observations are unsupported');
      }
      if (key === 'attachments' && (!Array.isArray(child) || child.length !== 0)) {
        throw new Error('attachments are unsupported');
      }
      pending.push(child);
    }
  }
}

/** Parses only the observed host page; it does not establish account, history or send authority. */
export function parseChatgptHostObservation(raw: unknown, expectedThreadId: string): ChatgptHostObservation {
  boundedText(expectedThreadId, 'expectedThreadId');
  let serialized: string | undefined;
  try { serialized = JSON.stringify(raw); } catch { throw new Error('host observation is not JSON serializable'); }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) {
    throw new Error('host observation exceeds 1 MiB or is not JSON serializable');
  }
  // Work only on JSON data. The caller may otherwise pass cycles or custom objects.
  const root = record(JSON.parse(serialized) as unknown, 'host observation');
  rejectTruncation(root);
  onlyKeys(root, ['schemaVersion', 'untrustedDataNotice', 'thread', 'page', 'turns', 'attachments'], 'host observation');
  if (root.schemaVersion !== 1) throw new Error('unsupported host schema version');
  optionalScalarString(root.untrustedDataNotice, 'untrusted data notice', 4096);
  if (root.attachments !== undefined && (!Array.isArray(root.attachments) || root.attachments.length !== 0)) {
    throw new Error('attachments are unsupported');
  }
  const thread = record(root.thread, 'thread');
  onlyKeys(thread, ['id', 'kind', 'title', 'preview', 'status', 'cwd', 'createdAt', 'updatedAt'], 'thread');
  optionalScalarString(thread.title, 'thread title', 4096);
  optionalScalarString(thread.preview, 'thread preview', MAX_TEXT_BYTES);
  optionalScalarString(thread.cwd, 'thread cwd', 4096, true);
  optionalScalarNumber(thread.createdAt, 'thread createdAt');
  optionalScalarNumber(thread.updatedAt, 'thread updatedAt');
  if (thread.kind !== 'chatgpt' || thread.id !== expectedThreadId) {
    throw new Error('host thread identity mismatch');
  }
  const statusRecord = record(thread.status, 'thread status');
  onlyKeys(statusRecord, ['type'], 'thread status');
  const threadStatus = boundedText(statusRecord.type, 'thread status type');
  const page = record(root.page, 'page');
  onlyKeys(page, ['order', 'limit', 'nextCursor', 'hasMore'], 'page');
  if (page.order !== 'newest_first' && page.order !== 'oldest_first') throw new Error('unsupported page order');
  if (!Number.isSafeInteger(page.limit) || (page.limit as number) < 1 || (page.limit as number) > 100) {
    throw new Error('invalid page limit');
  }
  if (typeof page.hasMore !== 'boolean' ||
      (page.hasMore && (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0 || page.nextCursor.length > 4096)) ||
      (!page.hasMore && page.nextCursor !== null)) {
    throw new Error('inconsistent page continuation');
  }
  if (!Array.isArray(root.turns) || root.turns.length > (page.limit as number)) {
    throw new Error('turns exceed page limit or are missing');
  }
  const turnIds = new Set<string>();
  const messageIds = new Set<string>();
  const turns = root.turns.map((value: unknown) => {
    const turn = record(value, 'turn');
    onlyKeys(turn, ['id', 'status', 'error', 'startedAt', 'completedAt', 'durationMs', 'items'], 'turn');
    if (turn.error !== undefined && turn.error !== null) throw new Error('turn error diagnostics are unsupported');
    optionalScalarNumber(turn.startedAt, 'turn startedAt', true);
    optionalScalarNumber(turn.completedAt, 'turn completedAt', true);
    optionalScalarNumber(turn.durationMs, 'turn durationMs', true);
    const id = boundedText(turn.id, 'turn id');
    if (turnIds.has(id)) throw new Error('duplicate turn id');
    turnIds.add(id);
    const status = boundedText(turn.status, 'turn status');
    if (!Array.isArray(turn.items) || turn.items.length > 100) throw new Error('invalid turn items');
    const messages = turn.items.map((itemValue: unknown) => {
      const item = record(itemValue, 'item');
      const role: 'user' | 'agent' | null = item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' ? 'agent' : null;
      if (role === null) throw new Error('unsupported host item');
      onlyKeys(item, role === 'user' ? ['type', 'id', 'content', 'truncated'] : ['type', 'id', 'text', 'truncated'], 'item');
      const messageId = boundedText(item.id, 'message id');
      if (messageIds.has(messageId)) throw new Error('duplicate message id');
      messageIds.add(messageId);
      let messageText: unknown;
      if (role === 'user') {
        if (!Array.isArray(item.content) || item.content.length !== 1) throw new Error('unsupported user content');
        const content = record(item.content[0], 'user content');
        onlyKeys(content, ['type', 'text', 'truncated'], 'user content');
        if (content.type !== 'text') throw new Error('unsupported user content type');
        messageText = content.text;
      } else {
        messageText = item.text;
      }
      return { id: messageId, role, text: boundedText(messageText, 'message text'), status, truncated: false as const };
    });
    return { id, status, messages };
  });
  return {
    threadId: expectedThreadId,
    threadStatus,
    page: { order: page.order, limit: page.limit as number, hasMore: page.hasMore, nextCursor: page.nextCursor as string | null },
    turns,
    coverage: 'observed_host_api_page',
    accountIdentity: 'unknown',
    branchHistory: 'unverified',
    lifetimeHistory: 'unverified',
  };
}
