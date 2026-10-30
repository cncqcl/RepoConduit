import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { request, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { TrustedFileTransfer } from '../../application/dispatch.js';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const NETWORK_INSPECTION_TIMEOUT_MS = 5_000;
export type FileSourcePolicy = 'chatgpt-official-v1';
export type PlatformFileFailureStage = 'input' | 'dns' | 'address' | 'request' |
  'http_status' | 'size' | 'stream' | 'timeout';
export type PlatformFileInputFailure = 'invalid_url' | 'origin_not_allowed' |
  'invalid_file_id' | 'invalid_mime' | 'target_name_missing';

/** Safe local diagnostic category; never carries a URL, file ID, response body or original error. */
export class PlatformFileDownloadError extends Error {
  constructor(readonly stage: PlatformFileFailureStage, readonly retryExhausted = false,
    readonly inputFailure?: PlatformFileInputFailure) {
    super('File transfer unavailable');
    this.name = 'PlatformFileDownloadError';
  }
}
class RetryableDownloadError extends PlatformFileDownloadError {}
const unavailable = (stage: PlatformFileFailureStage = 'input', inputFailure?: PlatformFileInputFailure): PlatformFileDownloadError =>
  new PlatformFileDownloadError(stage, false, inputFailure);
const hasControl = (value: string): boolean => [...value].some((char) => {
  const code = char.charCodeAt(0);
  return code <= 31 || code === 127;
});

export interface PlatformFileInput {
  download_url: string;
  file_id: string;
  mime_type?: string | undefined;
  file_name?: string | undefined;
}

export interface PlatformFileDownloadOptions {
  /** Exact HTTPS origins configured by the local operator. Empty disables downloads without a source policy. */
  allowedOrigins: readonly string[];
  /** Fixed local opt-in. Missing means the legacy exact-origin behavior. */
  fileSourcePolicy?: FileSourcePolicy;
  /** All attempts share timeoutMs; this never retries a bundle mutation or a browser action. */
  timeoutMs?: number;
  maxAttempts?: number;
  /** Trusted local diagnostic only. The origin is unapproved input, never authorization. */
  onRejectedOrigin?: (origin: string) => void;
}

interface Address { address: string; family: 4 | 6 }
interface Dependencies {
  resolveAddresses(hostname: string): Promise<Address[]>;
  request(url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void): ClientRequest;
}

const productionDependencies: Dependencies = {
  async resolveAddresses(hostname) {
    return lookup(hostname, { all: true, order: 'verbatim' }) as Promise<Address[]>;
  },
  request,
};

function safeUrl(raw: string): URL {
  if (typeof raw !== 'string' || !raw.startsWith('https://') || raw.includes('\\') || /\s/u.test(raw) || hasControl(raw)) throw unavailable('input', 'invalid_url');
  let url: URL;
  try { url = new URL(raw); } catch { throw unavailable('input', 'invalid_url'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || isIP(url.hostname) || url.hostname.startsWith('[') ||
      url.hostname.endsWith('.')) throw unavailable('input', 'invalid_url');
  return url;
}

/** Validate the exact operator input; URL parsing must not silently widen an allowlist. */
export function validateFileOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw unavailable();
  const result = new Set<string>();
  for (const raw of value) {
    const url = safeUrl(raw);
    if (raw !== url.origin || url.pathname !== '/' || url.search || result.has(raw)) throw unavailable();
    result.add(raw);
  }
  return [...result];
}

export function validateFileSourcePolicy(value: unknown): FileSourcePolicy | undefined {
  if (value === undefined || value === 'chatgpt-official-v1') return value;
  throw unavailable();
}

/** The official wildcard is narrowed to one canonical ASCII DNS label. */
function chatgptFileHost(hostname: string): boolean {
  const suffix = '.oaiusercontent.com';
  if (!hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  return label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label);
}

function permittedSource(url: URL, raw: string, origins: ReadonlySet<string>,
  policy: FileSourcePolicy | undefined): boolean {
  if (origins.has(url.origin)) return true;
  const authority = raw.slice('https://'.length).split(/[/?#]/u, 1)[0];
  return policy === 'chatgpt-official-v1' &&
    (authority === url.hostname || authority === `${url.hostname}:443`) &&
    chatgptFileHost(url.hostname);
}

/** Conservative IPv4 global-unicast check. IPv6 is refused until a complete range policy is available. */
function publicAddress(answer: Address): boolean {
  if (answer.family !== 4 || isIP(answer.address) !== 4) return false;
  const [a = 0, b = 0, c = 0] = answer.address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

function fakeIpAddress(answer: Address): boolean {
  if (answer.family !== 4 || isIP(answer.address) !== 4) return false;
  const [first, second] = answer.address.split('.').map(Number);
  return first === 198 && (second === 18 || second === 19);
}

export type PlatformFileNetworkStatus = 'public_ipv4' | 'fake_ip' |
  'non_public_or_unsupported' | 'dns_unavailable';
export interface PlatformFileNetworkInspection {
  status: PlatformFileNetworkStatus;
  dnsOnly: true;
  nextAction: string;
}

const networkAction: Record<PlatformFileNetworkStatus, string> = {
  public_ipv4: 'Public IPv4 observed. HTTPS and original-file retrieval remain untested.',
  fake_ip: 'A reserved 198.18/19 DNS answer was observed. If using Mihomo fake-ip blacklist mode, append *.oaiusercontent.com to the existing fake-ip-filter and verify public DNS again. Whitelist and rule modes need their own review.',
  non_public_or_unsupported: 'DNS returned an unsupported or nonpublic address. Original-file retrieval remains blocked.',
  dns_unavailable: 'DNS could not be checked within the bounded inspection. Original-file retrieval remains unverified.',
};

/** Local DNS-only preflight. The result wait is bounded; an OS lookup is not cancellable here. */
export async function inspectPlatformFileNetwork(origin: string,
  options: Pick<PlatformFileDownloadOptions, 'allowedOrigins' | 'fileSourcePolicy'>,
  dependencies: { resolveAddresses(hostname: string): Promise<Address[]>; timeoutMs?: number } = productionDependencies,
): Promise<PlatformFileNetworkInspection> {
  const policy = validateFileSourcePolicy(options.fileSourcePolicy);
  const origins = new Set(validateFileOrigins(options.allowedOrigins));
  const [exactOrigin] = validateFileOrigins([origin]);
  const url = safeUrl(exactOrigin!);
  if (!permittedSource(url, origin, origins, policy)) throw unavailable('input', 'origin_not_allowed');
  const timeoutMs = dependencies.timeoutMs ?? NETWORK_INSPECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > NETWORK_INSPECTION_TIMEOUT_MS) throw unavailable();
  let answers: Address[];
  try { answers = await withinTimeout(dependencies.resolveAddresses(url.hostname), timeoutMs); }
  catch { return { status: 'dns_unavailable', dnsOnly: true, nextAction: networkAction.dns_unavailable }; }
  const status: PlatformFileNetworkStatus = !Array.isArray(answers) || answers.length === 0
    ? 'non_public_or_unsupported'
    : answers.every(publicAddress) ? 'public_ipv4'
      : answers.every(fakeIpAddress) ? 'fake_ip' : 'non_public_or_unsupported';
  return { status, dnsOnly: true,
    nextAction: status === 'fake_ip' && !chatgptFileHost(url.hostname)
      ? 'A reserved 198.18/19 DNS answer was observed. Keep retrieval blocked and configure this approved source to resolve to public IPv4.'
      : networkAction[status] };
}

function withinTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RetryableDownloadError('dns')), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

const transientRequestCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);
const transientDnsCodes = new Set(['EAI_AGAIN', 'ETIMEOUT', 'ETIMEDOUT']);
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
function transientStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
function remainingMs(deadline: number): number { return Math.max(0, Math.ceil(deadline - performance.now())); }
async function pauseWithinDeadline(deadline: number, attempt: number): Promise<boolean> {
  const delay = Math.min(25 * 2 ** (attempt - 1), remainingMs(deadline));
  if (delay <= 0) return false;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
  return remainingMs(deadline) > 0;
}

/** Supplies ExternalMcpServerOptions.resolveFileTransfer. Only trusted local setup may configure origins. */
export function createPlatformFileDownloadResolver(
  options: PlatformFileDownloadOptions,
  dependencies: Dependencies = productionDependencies,
): (file: PlatformFileInput) => TrustedFileTransfer {
  const origins = new Set(validateFileOrigins(options.allowedOrigins));
  const policy = validateFileSourcePolicy(options.fileSourcePolicy);
  if (origins.size === 0 && policy === undefined) throw unavailable();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw unavailable();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw unavailable();
  return (file) => {
    const url = safeUrl(file.download_url);
    if (!permittedSource(url, file.download_url, origins, policy)) {
      try { options.onRejectedOrigin?.(url.origin); } catch { /* Diagnostics cannot change refusal. */ }
      throw unavailable('input', 'origin_not_allowed');
    }
    if (typeof file.file_id !== 'string' ||
        !file.file_id || file.file_id.length > 512 || hasControl(file.file_id)) throw unavailable('input', 'invalid_file_id');
    if (file.mime_type !== undefined && (typeof file.mime_type !== 'string' ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]{1,200})?$/iu.test(file.mime_type))) throw unavailable('input', 'invalid_mime');
    const mediaType = file.mime_type ?? null;
    return {
      referenceIdentity: createHash('sha256').update(file.file_id).digest('hex'),
      mediaType,
      async acquireBytes(maxBytes) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw unavailable();
        const limit = Math.min(maxBytes, MAX_FILE_BYTES);
        const deadline = performance.now() + timeoutMs;
        const downloadOnce = async (): Promise<Buffer> => {
          let answers: Address[];
          try { answers = await withinTimeout(dependencies.resolveAddresses(url.hostname), remainingMs(deadline)); }
          catch (error) {
            if (error instanceof RetryableDownloadError || transientDnsCodes.has(errorCode(error) ?? '')) {
              throw new RetryableDownloadError('dns');
            }
            throw unavailable('dns');
          }
          if (!Array.isArray(answers) || answers.length === 0 || !answers.every(publicAddress)) throw unavailable('address');
          const selected = answers[0]!;
          if (remainingMs(deadline) === 0) throw new RetryableDownloadError('timeout');
          return new Promise<Buffer>((resolve, reject) => {
          let settled = false;
          const timing: { timer?: ReturnType<typeof setTimeout> } = {};
          const fail = (stage: PlatformFileFailureStage, retryable = false) => {
            if (!settled) {
              settled = true;
              clearTimeout(timing.timer);
              reject(retryable ? new RetryableDownloadError(stage) : unavailable(stage));
            }
          };
          const succeed = (bytes: Buffer) => { if (!settled) { settled = true; clearTimeout(timing.timer); resolve(bytes); } };
          const requestOptions: RequestOptions = {
            method: 'GET', agent: false, servername: url.hostname, rejectUnauthorized: true,
            lookup(_host, lookupOptions, callback) {
              if (lookupOptions.all) {
                (callback as (error: NodeJS.ErrnoException | null,
                  addresses: Address[]) => void)(null, [selected]);
              } else callback(null, selected.address, selected.family);
            },
          };
          let req: ClientRequest;
          try {
            req = dependencies.request(url, requestOptions, (response) => {
              if (response.statusCode !== 200) {
                fail('http_status', transientStatus(response.statusCode)); response.destroy(); return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > limit) { fail('size'); response.destroy(); req.destroy(); return; }
                chunks.push(chunk);
              });
              response.on('end', () => succeed(Buffer.concat(chunks, size)));
              response.on('error', () => { fail('stream', true); req.destroy(); });
              response.on('aborted', () => { fail('stream', true); req.destroy(); });
              response.on('close', () => { if (!settled) { fail('stream', true); req.destroy(); } });
            });
          } catch { fail('request'); return; }
          req.on('error', (error: unknown) => fail('request', transientRequestCodes.has(errorCode(error) ?? '')));
          timing.timer = setTimeout(() => { fail('timeout', true); req.destroy(); }, remainingMs(deadline));
          try { req.end(); } catch { fail('request'); req.destroy(); }
          });
        };
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try { return await downloadOnce(); }
          catch (error) {
            if (!(error instanceof RetryableDownloadError)) throw error;
            if (attempt === maxAttempts || remainingMs(deadline) === 0 ||
                !(await pauseWithinDeadline(deadline, attempt))) {
              throw new PlatformFileDownloadError(error.stage, true);
            }
          }
        }
        throw unavailable('timeout');
      },
    };
  };
}
