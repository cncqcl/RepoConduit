export interface CodexRepoReadCall {
  threadId: string;
  turnId: string;
  callId: string;
  arguments: unknown;
}

export interface FixedDynamicToolResponse {
  success: boolean;
  contentItems: Array<{ type: 'inputText'; text: string }>;
}

export interface CodexRepoReadCapability {
  read(call: CodexRepoReadCall, emit: (response: FixedDynamicToolResponse) => void): Promise<void>;
}

export interface ParsedCodexRepoReadArguments {
  path: string;
  maxBytes: number;
  maxLines: number;
  cursor?: string;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const REPO_READ_DYNAMIC_TOOL = deepFreeze({
  type: 'namespace', name: 'repo', description: 'Read a bounded page of the authorized repository snapshot.',
  tools: [{ type: 'function', name: 'read',
    description: 'Read one bounded source page from the authorized snapshot.',
    inputSchema: { type: 'object', additionalProperties: false,
      required: ['path'], properties: {
        path: { type: 'string', minLength: 1, maxLength: 512 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 8192 },
        maxLines: { type: 'integer', minimum: 1, maximum: 400 },
        cursor: { type: 'string', minLength: 1, maxLength: 2048 },
      } },
  }],
});

export function parseCodexRepoReadArguments(value: unknown): ParsedCodexRepoReadArguments {
  const invalid = (): never => { throw new Error('PROTOCOL_REJECTED'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some(key => !['path', 'maxBytes', 'maxLines', 'cursor'].includes(key))) invalid();
  const path = args.path;
  if (typeof path !== 'string' || !path || Buffer.byteLength(path, 'utf8') > 512 ||
      path.startsWith('/') || path.includes('\\') || path.includes(':') || path.includes('\0') ||
      path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
        [...part].some(char => char.charCodeAt(0) < 32) ||
        /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) invalid();
  if (args.maxBytes !== undefined && (!Number.isInteger(args.maxBytes) ||
      (args.maxBytes as number) < 1 || (args.maxBytes as number) > 8192)) invalid();
  if (args.maxLines !== undefined && (!Number.isInteger(args.maxLines) ||
      (args.maxLines as number) < 1 || (args.maxLines as number) > 400)) invalid();
  if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor ||
      Buffer.byteLength(args.cursor, 'utf8') > 2048 || args.cursor.includes('\0'))) invalid();
  return { path: path as string, maxBytes: (args.maxBytes as number | undefined) ?? 4096,
    maxLines: (args.maxLines as number | undefined) ?? 200,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }) };
}

export function validRepoReadArguments(value: unknown): boolean {
  try { parseCodexRepoReadArguments(value); return true; }
  catch { return false; }
}

export function validFixedDynamicToolResponse(value: unknown): value is FixedDynamicToolResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (Object.keys(response).length !== 2 || typeof response.success !== 'boolean' ||
      !Array.isArray(response.contentItems) || response.contentItems.length > 8) return false;
  return response.contentItems.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).length === 2 && item.type === 'inputText' && typeof item.text === 'string' &&
    Buffer.byteLength(item.text, 'utf8') <= 64 * 1024);
}
