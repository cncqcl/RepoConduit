import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import {CLAUDE_GLM_ENVIRONMENT_NAMES,pickExistingClaudeGlmEnvironment} from './claude-windows-model-environment.js';

/** The current installed Windows CLI contract; older print-json receipts retain their own formatContract. */
export const CLAUDE_WINDOWS_FORMAT_CONTRACT = 'claude_windows_stream_json_2_1_287' as const;

export interface ClaudeWindowsLaunchInput {
  /** Selected by the trusted local host, never by an external request. */
  executablePath: string;
  /** A new private attempt root. The owner creates root/work and locks root/mcp.json. */
  root: string;
  /** Current official print-mode CLI limit; one stdin user frame is sent. */
  maxTurns: number;
  mcpEndpoint: string;
  /** Fresh per-attempt secret for the sole loopback MCP server. */
  bearerToken: string;
  inheritedEnv: NodeJS.ProcessEnv;
  /** Selected only by the trusted local host from the existing user configuration. */
  modelEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

export interface ClaudeWindowsLaunchSpec {
  file: string;
  cwd: string;
  argv: readonly string[];
  env: Readonly<NodeJS.ProcessEnv>;
  mcpConfigPath: string;
  /** Sensitive: write under the owned root with private ACL; never log or publish. */
  mcpConfigBytes: Buffer;
  mcpConfigSha256: string;
  formatContract: typeof CLAUDE_WINDOWS_FORMAT_CONTRACT;
}

const envNames = [
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
] as const;

function absoluteWindowsPath(value: unknown): value is string {
  return typeof value === 'string' && value.length < 4096 &&
    /^[A-Za-z]:\\/.test(value) &&
    ![...value].some(ch => ch.charCodeAt(0) < 32 || '"<>|?*'.includes(ch)) &&
    !value.includes('/') && win32.normalize(value) === value &&
    !value.split('\\').some(part => part === '..' || part === '.');
}

function loopbackMcpEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' &&
      /^[0-9]{1,5}$/.test(parsed.port) && Number(parsed.port) >= 1 &&
      parsed.pathname === '/mcp' && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash && parsed.href === value;
  } catch {return false;}
}

/** A pure recipe. The trusted owner validates the installed executable and seals the private file. */
export function buildClaudeWindowsLaunchSpec(input: ClaudeWindowsLaunchInput): ClaudeWindowsLaunchSpec {
  if (!input || typeof input !== 'object' || !absoluteWindowsPath(input.executablePath) ||
    !input.executablePath.toLowerCase().endsWith('\\claude.exe') ||
    !absoluteWindowsPath(input.root) || !loopbackMcpEndpoint(input.mcpEndpoint) ||
    !Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 8 ||
    typeof input.bearerToken !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(input.bearerToken) ||
    !input.inheritedEnv || typeof input.inheritedEnv !== 'object') {
    throw new TypeError('invalid trusted Windows Claude launch input');
  }
  const mcpConfigPath = win32.join(input.root, 'mcp.json');
  const mcpConfigBytes = Buffer.from(JSON.stringify({mcpServers: {
    'repo-conduit': {type: 'http', url: input.mcpEndpoint,
      headers: {Authorization: `Bearer ${input.bearerToken}`}},
  }}), 'utf8');
  const env: NodeJS.ProcessEnv = {};
  for (const name of envNames) {
    const sourceKey = Object.keys(input.inheritedEnv).find(
      key => key.toLowerCase() === name.toLowerCase());
    const value = sourceKey ? input.inheritedEnv[sourceKey] : undefined;
    if (typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
      ![...value].some(ch => ch.charCodeAt(0) === 0 || ch === '\r' || ch === '\n')) {
      env[name] = value;
    }
  }
  // Disable CLAUDE.md discovery without --bare, which would disable existing OAuth.
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  if(input.modelEnvironment){
    if(Object.keys(input.modelEnvironment).some(name=>
      !CLAUDE_GLM_ENVIRONMENT_NAMES.includes(name as typeof CLAUDE_GLM_ENVIRONMENT_NAMES[number])))
      throw new TypeError('invalid trusted Windows Claude model environment');
    Object.assign(env,pickExistingClaudeGlmEnvironment({env:input.modelEnvironment}));
  }
  const argv = [
    '--print', '--verbose', '--output-format', 'stream-json',
    '--input-format', 'stream-json', '--no-session-persistence',
    '--tools', '', '--restricted', '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', mcpConfigPath,
    '--disable-slash-commands', '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--settings', '{"disableAllHooks":true}',
    '--max-turns', String(input.maxTurns),
    // Current CLI accepts comma-separated exact tool names. Keep this variadic flag last.
    '--allowedTools', 'mcp__repo-conduit__repo.read,mcp__repo-conduit__repo_read',
  ];
  return {file: input.executablePath, cwd: win32.join(input.root, 'work'),
    argv: Object.freeze(argv), env: Object.freeze(env), mcpConfigPath,
    mcpConfigBytes,
    mcpConfigSha256: createHash('sha256').update(mcpConfigBytes).digest('hex'),
    formatContract: CLAUDE_WINDOWS_FORMAT_CONTRACT};
}

/** Single user message for the current CLI's stream-json stdin. The exact native handling is verified live. */
export function buildClaudeWindowsUserFrame(prompt: string): Readonly<{
  type: 'user'; message: Readonly<{role: 'user'; content: string}>;
  parent_tool_use_id: null; session_id: '';
}> {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') ||
    Buffer.byteLength(prompt, 'utf8') > 16 * 1024) throw new TypeError('invalid Claude prompt');
  return {type: 'user', message: {role: 'user', content: prompt},
    parent_tool_use_id: null, session_id: ''};
}

export interface ClaudeWindowsStreamLimits {
  /** Exact actual name observed from this launch's native init frame. */
  expectedToolName: string;
  maxTurns: number;
  maxToolCalls?: number;
  elapsedMs?: number;
  maxElapsedMs?: number;
}

/** A model text candidate; paired MCP receipts and natural process exit are checked by the owner. */
export interface ClaudeWindowsStreamOutcomeCandidate {
  kind: 'claude_model_outcome_candidate_v1';
  formatContract: typeof CLAUDE_WINDOWS_FORMAT_CONTRACT;
  result: string;
  sessionId: string;
  numTurns: number;
  observedToolCalls: number;
  rawBytesSha256: string;
}

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LINES = 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function notificationIdentity(value: Record<string, unknown>): boolean {
  return typeof value.session_id === 'string' && value.session_id.length > 0 &&
    value.session_id.length <= 200 && !value.session_id.includes('\0') &&
    typeof value.uuid === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.uuid);
}

/** Reject duplicate envelope fields before JSON.parse can silently keep the last value. */
function uniqueTopLevelKeys(source: string): boolean {
  let at = 0;
  const space = () => {while (/\s/.test(source[at] ?? '')) at++;};
  space();
  if (source[at++] !== '{') return false;
  const keys = new Set<string>();
  space();
  if (source[at] === '}') return true;
  while (at < source.length) {
    space();
    if (source[at] !== '"') return false;
    const keyStart = at++;
    let escaped = false;
    while (at < source.length) {
      const ch = source[at++];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') break;
    }
    const key = JSON.parse(source.slice(keyStart, at)) as string;
    if (keys.has(key)) return false;
    keys.add(key);
    space();
    if (source[at++] !== ':') return false;
    space();
    let depth = 0; let quoted = false; escaped = false;
    for (; at < source.length; at++) {
      const ch = source[at];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) break;
    }
    if (source[at] === '}') return true;
    if (source[at++] !== ',') return false;
  }
  return false;
}

/**
 * Conservative interpretation of the observed stream-json envelope family.
 * Includes the identity-bound UI/progress notifications observed with 2.1.287.
 * No returned field is itself proof that repo.read was authorized or executed.
 */
export function parseClaudeWindowsStreamOutcome(raw: Buffer,
  limits: ClaudeWindowsStreamLimits): ClaudeWindowsStreamOutcomeCandidate | null {
  const maxToolCalls = limits?.maxToolCalls ?? 3;
  const elapsedMs = limits?.elapsedMs ?? 0;
  const maxElapsedMs = limits?.maxElapsedMs ?? 60_000;
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > MAX_OUTPUT_BYTES ||
    !limits || !/^mcp__repo-conduit__repo[._]read$/.test(limits.expectedToolName) ||
    !Number.isSafeInteger(limits.maxTurns) || limits.maxTurns < 1 || limits.maxTurns > 8 ||
    !Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 ||
    maxToolCalls > 64 || !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0 || !Number.isSafeInteger(maxElapsedMs) ||
    maxElapsedMs < 1 || elapsedMs > maxElapsedMs) return null;
  try {
    const source = new TextDecoder('utf-8', {fatal: true}).decode(raw);
    const lines = source.split('\n').filter(line => line.trim().length > 0);
    if (lines.length < 4 || lines.length > MAX_LINES) return null;
    let initialized = false;
    let completed = false;
    let toolCalls = 0;
    let successfulToolCalls = 0;
    let sessionId = '';
    let preInitSession: string | undefined;
    const pending = new Set<string>();
    const usedToolIds = new Set<string>();
    let result = '';
    let numTurns = 0;
    for (const line of lines) {
      if (!uniqueTopLevelKeys(line)) return null;
      const value: unknown = JSON.parse(line);
      if (!object(value) || completed) return null;
      if (value.type === 'system' && value.subtype === 'ui_invalidate') {
        if (!exactFields(value, ['type', 'subtype', 'event', 'uuid', 'session_id']) ||
            value.event !== 'ui.render' || !notificationIdentity(value) ||
            (initialized ? value.session_id !== sessionId :
              preInitSession !== undefined && value.session_id !== preInitSession)) return null;
        if (!initialized) preInitSession = value.session_id as string;
      } else if (value.type === 'system' && value.subtype === 'thinking_tokens' && initialized) {
        if (!exactFields(value, ['type', 'subtype', 'estimated_tokens', 'estimated_tokens_delta',
          'session_id', 'uuid']) || !notificationIdentity(value) || value.session_id !== sessionId ||
            !Number.isSafeInteger(value.estimated_tokens) || (value.estimated_tokens as number) < 0 ||
            !Number.isSafeInteger(value.estimated_tokens_delta) || (value.estimated_tokens_delta as number) < 0) return null;
      } else if (value.type === 'system' && value.subtype === 'init' && !initialized) {
        if (!Array.isArray(value.tools) || value.tools.length !== 1 ||
          value.tools[0] !== limits.expectedToolName ||
          typeof value.session_id !== 'string' || !value.session_id ||
          value.session_id.length > 200 || (preInitSession !== undefined && preInitSession !== value.session_id)) return null;
        sessionId = value.session_id;
        initialized = true;
      } else if (value.type === 'assistant' && initialized) {
        if (!object(value.message) || !Array.isArray(value.message.content)) return null;
        if (Object.hasOwn(value, 'session_id') && value.session_id !== sessionId) return null;
        for (const item of value.message.content) {
          if (!object(item)) return null;
          if (item.type === 'tool_use') {
            if (item.name !== limits.expectedToolName || typeof item.id !== 'string' ||
              !item.id || usedToolIds.has(item.id) || ++toolCalls > maxToolCalls) return null;
            usedToolIds.add(item.id);
            pending.add(item.id);
          } else if (item.type === 'thinking') {
            // This opaque native block cannot supply a result, tool action or evidence.
            if (!exactFields(item, ['type', 'thinking', 'signature']) ||
                typeof item.thinking !== 'string' || item.thinking.includes('\0') ||
                typeof item.signature !== 'string' || item.signature.includes('\0')) return null;
          } else if (item.type !== 'text') return null;
        }
      } else if (value.type === 'user' && initialized) {
        if (!object(value.message) || !Array.isArray(value.message.content)) return null;
        for (const item of value.message.content) {
          if (!object(item) || item.type !== 'tool_result' ||
            typeof item.tool_use_id !== 'string' || !pending.has(item.tool_use_id)) return null;
          if (item.is_error !== true) successfulToolCalls++;
          pending.delete(item.tool_use_id);
        }
      } else if (value.type === 'result' && initialized && pending.size === 0 &&
        successfulToolCalls > 0) {
        if (value.subtype !== 'success' || value.is_error !== false ||
          !Number.isSafeInteger(value.num_turns) || (value.num_turns as number) < 1 ||
          (value.num_turns as number) > limits.maxTurns ||
          value.session_id !== sessionId ||
          typeof value.result !== 'string' || !value.result.trim() ||
          value.result.includes('\0')) return null;
        // This presentation wrapper has no authority: preserve the inner JSON
        // verbatim for the existing closed-schema and receipt validators.
        const fenced = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(value.result);
        result = fenced && !/(?:^|\r?\n)```/.test(fenced[1]!) ? fenced[1]! : value.result;
        numTurns = value.num_turns as number;
        completed = true;
      } else return null;
    }
    if (!completed) return null;
    return {kind: 'claude_model_outcome_candidate_v1',
      formatContract: CLAUDE_WINDOWS_FORMAT_CONTRACT, result, sessionId, numTurns,
      observedToolCalls: toolCalls,
      rawBytesSha256: createHash('sha256').update(raw).digest('hex')};
  } catch {return null;}
}
