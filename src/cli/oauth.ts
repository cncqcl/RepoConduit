import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, fsyncSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../adapters/storage/sqlite.js';
import type { IssuerOperatorBinding } from '../adapters/auth/introspection-verifier.js';
import type { LocalIssuerOptions } from '../adapters/auth/issuer.js';
import { authorize, operationPolicy, type RequestContext } from '../core/policy/authorize.js';
import { assertPrivateDataDirectory } from '../runtime/local-security.js';
import { startSelfHostedOAuthHttpWithinInstallation } from '../runtime/self-hosted-oauth-http.js';
import type { PersonalCodexInvestigatorConfiguration, PersonalCodexDiagnostic } from '../runtime/codex-owned-investigation.js';
import { authorizeCodexSelection } from './codex-investigation.js';
import { validateFileOrigins } from '../adapters/mcp/platform-file-download.js';
import { acquireInstallationRuntime, assertActiveInstallation, retainInstallationRuntime,
  type InstallationRuntime } from '../runtime/installation.js';

type IssuerConfig = Omit<LocalIssuerOptions, 'db'>;
interface SavedOAuthConfig { issuer: IssuerConfig; bindings: [IssuerOperatorBinding]; allowedFileOrigins: string[] }

function releaseAfterFailure(runtime: InstallationRuntime, error: unknown): never {
  if (error instanceof AggregateError) retainInstallationRuntime(runtime);
  else {
    try { runtime.release(); }
    catch (releaseError) {
      retainInstallationRuntime(runtime);
      throw new AggregateError([error, releaseError], 'OAuth installation cleanup unconfirmed',
        { cause: releaseError });
    }
  }
  throw error;
}

function releaseAfterSuccess(runtime: InstallationRuntime): void {
  try { runtime.release(); }
  catch (error) { retainInstallationRuntime(runtime); throw error; }
}

function writeAndClose(fd: number, bytes: string): void {
  let failure: unknown;
  let failed = false;
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  catch (error) { failure = error; failed = true; }
  try { closeSync(fd); }
  catch (closeError) {
    throw new AggregateError(failed ? [failure, closeError] : [closeError],
      'OAuth file close unconfirmed', { cause: closeError });
  }
  if (failed) throw failure;
}

function conflict(): Error {
  return Object.assign(new Error('CONFLICT'), { code: 'CONFLICT' });
}

function sqliteConflict(error: unknown): boolean {
  const value = error as { errcode?: unknown; message?: unknown };
  return value?.errcode === 5 || value?.errcode === 6 ||
    (typeof value?.message === 'string' && /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/u.test(value.message));
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('Invalid OAuth configuration');
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value &&
    !value.includes('\0');
}

function publicOrigin(value: unknown): value is string {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/' && value === url.origin;
  } catch { return false; }
}

function publicResource(value: unknown): value is string {
  if (!text(value, 2048) || /[?#]|%(?![0-9A-Fa-f]{2})/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      (value === url.origin || (url.pathname !== '/' && !url.pathname.endsWith('/') && value === url.href));
  } catch { return false; }
}

function redirectUri(value: unknown): value is string {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && value === url.href;
  } catch { return false; }
}

function scopeName(value: unknown): value is string {
  return text(value, 64) && /^[a-z][a-z0-9.:-]{1,63}$/.test(value) &&
    value !== 'openid' && value !== 'offline_access';
}

function uniqueStrings(value: unknown, predicate: (value: unknown) => value is string): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 &&
    value.every(predicate) && new Set(value).size === value.length;
}

function validBinding(value: unknown, issuer: string, clientId: string, subject: string,
  scopes: readonly string[]): IssuerOperatorBinding {
  const binding = object(value, ['issuer', 'clientId', 'subject', 'principal', 'recipient',
    'workspaceId', 'collaborationId', 'scopes']);
  if (binding.issuer !== issuer || binding.clientId !== clientId || binding.subject !== subject ||
      !text(binding.principal) || !text(binding.recipient) || !text(binding.workspaceId) ||
      (binding.collaborationId !== undefined && !text(binding.collaborationId))) {
    throw new TypeError('Invalid OAuth operator binding');
  }
  const scopeMap = object(binding.scopes, scopes);
  if (Object.keys(scopeMap).length !== scopes.length || scopes.some(scope => !Object.hasOwn(scopeMap, scope))) {
    throw new TypeError('Invalid OAuth operator scopes');
  }
  for (const scope of scopes) {
    const entry = object(scopeMap[scope], ['delegatedPermissions', 'visibleOperations']);
    if (!uniqueStrings(entry.delegatedPermissions, value => text(value)) ||
        !uniqueStrings(entry.visibleOperations, value => text(value))) {
      throw new TypeError('Invalid OAuth operator scopes');
    }
    for (const operation of entry.visibleOperations) {
      const policy = operationPolicy(operation);
      if (!policy.surfaces.includes('external_mcp') || !entry.delegatedPermissions.includes(policy.requiredGrant) ||
          (binding.collaborationId && (operation === 'collab.open' || operation === 'collab.list'))) {
        throw new TypeError('Invalid OAuth operator scopes');
      }
    }
  }
  return binding as unknown as IssuerOperatorBinding;
}

function validateInput(value: unknown): { issuer: string; resource: string; clientId: string;
  redirectUris: string[]; scopes: string[]; subject: string; password: string;
  binding: IssuerOperatorBinding } {
  const input = object(value, ['issuer', 'resource', 'clientId', 'redirectUris', 'scopes', 'operator', 'binding']);
  const operator = object(input.operator, ['subject', 'password']);
  if (!publicOrigin(input.issuer) || !publicResource(input.resource) ||
      !text(input.clientId, 128) || !/^[A-Za-z0-9._:-]{3,128}$/.test(input.clientId) ||
      !uniqueStrings(input.redirectUris, redirectUri) ||
      !uniqueStrings(input.scopes, scopeName) ||
      !text(operator.subject) || typeof operator.password !== 'string' ||
      operator.password.length < 16 || operator.password.length > 1024 ||
      new URLSearchParams({ csrf: 'x'.repeat(43), password: operator.password }).toString().length > 4096) {
    throw new TypeError('Invalid OAuth configuration');
  }
  return { issuer: input.issuer, resource: input.resource, clientId: input.clientId,
    redirectUris: input.redirectUris, scopes: input.scopes, subject: operator.subject,
    password: operator.password,
    binding: validBinding(input.binding, input.issuer, input.clientId, operator.subject, input.scopes) };
}

function localAdmin(): RequestContext {
  const account = userInfo();
  return { principal: `${hostname()}\\${account.username}`, audience: 'local-os',
    recipient: `${hostname()}\\${account.username}`, surface: 'local_admin', now: new Date() };
}

function validateAuthority(root: string, input: ReturnType<typeof validateInput>): void {
  assertPrivateDataDirectory(root);
  const store = new SqliteStore(join(root, 'state.sqlite'));
  try {
    const local = localAdmin();
    authorize(local, 'admin.grant', { workspaceId: 'management' }, store.grantsFor(local.principal, local.audience));
    const binding = input.binding;
    if (!store.getWorkspace(binding.workspaceId) ||
        (binding.collaborationId && !store.getCollaboration(binding.collaborationId, binding.workspaceId))) {
      throw new Error('NOT_AVAILABLE');
    }
    const external: RequestContext = { principal: binding.principal, audience: input.resource,
      recipient: binding.recipient, surface: 'external_mcp', now: new Date() };
    const grants = store.grantsFor(binding.principal, input.resource);
    for (const mapped of Object.values(binding.scopes)) {
      for (const operation of mapped.visibleOperations) {
        const scope = { workspaceId: binding.workspaceId,
          ...(operation === 'collab.open' || !binding.collaborationId ? {} :
            { collaborationId: binding.collaborationId }) };
        authorize({ ...external, delegatedPermissions: mapped.delegatedPermissions }, operation, scope, grants);
      }
    }
  } catch (error) {
    try { store.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], 'OAuth authority cleanup unconfirmed',
      { cause: closeError }); }
    throw error;
  }
  try { store.close(); }
  catch (closeError) { throw new AggregateError([closeError], 'OAuth authority cleanup unconfirmed',
    { cause: closeError }); }
}

/** Creates private credentials once; public CLI output contains no generated secrets. */
export async function configureOAuth(root: string, value: unknown): Promise<{ configured: true;
  issuer: string; resource: string; workspaceId: string }> {
  const runtime = acquireInstallationRuntime(root);
  let result: Awaited<ReturnType<typeof configureOAuthWithinInstallation>>;
  try { result = await configureOAuthWithinInstallation(runtime, value); }
  catch (error) { return releaseAfterFailure(runtime, error); }
  releaseAfterSuccess(runtime);
  return result;
}

/** Borrow the caller's installation owner; configuration never releases its gate. */
export async function configureOAuthWithinInstallation(runtime: InstallationRuntime,
  value: unknown): Promise<{ configured: true; issuer: string; resource: string; workspaceId: string }> {
  assertActiveInstallation(runtime);
  const root = runtime.dataDirectory;
  const input = validateInput(value);
  validateAuthority(root, input);
  const salt = randomBytes(16);
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const saved: SavedOAuthConfig = { issuer: {
    issuer: input.issuer, resource: input.resource, clientId: input.clientId,
    redirectUris: input.redirectUris, scopes: input.scopes,
    operator: { subject: input.subject, saltHex: salt.toString('hex'),
      hashHex: scryptSync(input.password, salt, 64).toString('hex') },
    cookieKeys: [randomBytes(32).toString('hex')],
    jwks: { keys: [{ ...await exportJWK(privateKey), kid: randomUUID(), alg: 'RS256', use: 'sig' }] },
  }, bindings: [input.binding], allowedFileOrigins: [] };
  const path = join(root, 'oauth-config.json');
  assertActiveInstallation(runtime);
  const fd = openSync(path, 'wx', 0o600);
  try { writeAndClose(fd, JSON.stringify(saved)); assertPrivateDataDirectory(root, path); }
  catch (error) {
    try { unlinkSync(path); }
    catch (unlinkError) { throw new AggregateError([error, unlinkError], 'OAuth file cleanup unconfirmed',
      { cause: unlinkError }); }
    throw error;
  }
  return { configured: true, issuer: input.issuer, resource: input.resource,
    workspaceId: input.binding.workspaceId };
}

function loadConfig(root: string): SavedOAuthConfig {
  const path = join(root, 'oauth-config.json');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError('OAuth configuration must be a regular file');
  assertPrivateDataDirectory(root, path);
  const saved: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const envelope = object(saved, ['issuer', 'bindings', 'allowedFileOrigins']);
  const issuer = object(envelope.issuer, ['issuer', 'resource', 'clientId', 'redirectUris',
    'scopes', 'operator', 'cookieKeys', 'jwks', 'port']);
  const operator = object(issuer.operator, ['subject', 'saltHex', 'hashHex']);
  if (!publicOrigin(issuer.issuer) || !publicResource(issuer.resource) || !text(issuer.clientId, 128) ||
      !text(operator.subject) || !uniqueStrings(issuer.redirectUris, redirectUri) ||
      !uniqueStrings(issuer.scopes, scopeName) ||
      !Array.isArray(envelope.bindings) || envelope.bindings.length !== 1 ||
      !Array.isArray(issuer.cookieKeys) || issuer.cookieKeys.length !== 1 ||
      !text(issuer.cookieKeys[0]) || !/^[a-f0-9]{64}$/.test(issuer.cookieKeys[0]) ||
      typeof operator.saltHex !== 'string' || !/^[a-f0-9]{32}$/.test(operator.saltHex) ||
      typeof operator.hashHex !== 'string' || !/^[a-f0-9]{128}$/.test(operator.hashHex) ||
      issuer.port !== undefined) throw new TypeError('Invalid saved OAuth configuration');
  validBinding(envelope.bindings[0], issuer.issuer, issuer.clientId, operator.subject, issuer.scopes);
  return { issuer: envelope.issuer as IssuerConfig, bindings: envelope.bindings as [IssuerOperatorBinding],
    allowedFileOrigins: validateFileOrigins(envelope.allowedFileOrigins === undefined ? [] : envelope.allowedFileOrigins) };
}

/** Borrow the installation owner and expose only the validated file-origin policy. */
export function readFileOriginsWithinInstallation(runtime: InstallationRuntime): string[] {
  assertActiveInstallation(runtime);
  const path = join(runtime.dataDirectory, 'oauth-config.json');
  try { lstatSync(path); }
  catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'ENOENT' && failure.path === path) return [];
    throw error;
  }
  return [...loadConfig(runtime.dataDirectory).allowedFileOrigins];
}

/** Only the local OS administrator may change file origins. A stale expected list fails closed. */
export function configureFileOrigins(root: string, value: unknown): {
  configured: true; allowedFileOrigins: string[]; restartRequired: true } {
  const runtime = acquireInstallationRuntime(root);
  let result: ReturnType<typeof configureFileOriginsWithinInstallation>;
  try { result = configureFileOriginsWithinInstallation(runtime, value); }
  catch (error) { return releaseAfterFailure(runtime, error); }
  releaseAfterSuccess(runtime);
  return result;
}

/** Borrow the caller's installation owner for the full SQLite/file update. */
export function configureFileOriginsWithinInstallation(runtime: InstallationRuntime, value: unknown): {
  configured: true; allowedFileOrigins: string[]; restartRequired: true } {
  assertActiveInstallation(runtime);
  const root = runtime.dataDirectory;
  const input = object(value, ['allowedFileOrigins', 'expectedAllowedFileOrigins']);
  const allowedFileOrigins = validateFileOrigins(input.allowedFileOrigins);
  const expected = validateFileOrigins(input.expectedAllowedFileOrigins);
  assertPrivateDataDirectory(root);
  const statePath = join(root, 'state.sqlite');
  const path = join(root, 'oauth-config.json');
  let store: SqliteStore | undefined;
  let db: DatabaseSync | undefined;
  let inTransaction = false;
  let failed = false;
  let primary: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    store = new SqliteStore(statePath);
    db = new DatabaseSync(statePath);
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    inTransaction = true;
    const local = localAdmin();
    authorize(local, 'admin.grant', { workspaceId: 'management' }, store.grantsFor(local.principal, local.audience));
    const saved = loadConfig(root);
    if (JSON.stringify(saved.allowedFileOrigins) !== JSON.stringify(expected)) throw conflict();
    const temp = join(root, `oauth-config.${randomUUID()}.tmp`);
    let tempCreated = false;
    let tempFailure: unknown;
    let tempFailed = false;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      tempCreated = true;
      writeAndClose(fd, JSON.stringify({ ...saved, allowedFileOrigins }));
      assertPrivateDataDirectory(root, temp);
      renameSync(temp, path);
      tempCreated = false;
    } catch (error) { tempFailure = error; tempFailed = true; }
    if (tempCreated) {
      try { unlinkSync(temp); }
      catch (unlinkError) { throw new AggregateError(tempFailed ? [tempFailure, unlinkError] : [unlinkError],
        'OAuth temporary file cleanup unconfirmed', { cause: unlinkError }); }
    }
    if (tempFailed) throw tempFailure;
    db.exec('COMMIT');
    inTransaction = false;
  } catch (error) {
    failed = true;
    primary = sqliteConflict(error) ? conflict() : error;
    if (inTransaction) {
      try { db?.exec('ROLLBACK'); }
      catch (rollbackError) { cleanupErrors.push(rollbackError); }
    }
  }
  try { db?.close(); } catch (error) { cleanupErrors.push(error); }
  try { store?.close(); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primary, ...cleanupErrors] : cleanupErrors,
    'OAuth file origins cleanup unconfirmed', { cause: failed ? primary : cleanupErrors[0] });
  if (failed) throw primary;
  return { configured: true, allowedFileOrigins, restartRequired: true };
}

export async function serveOAuthHttp(root: string, issuerPort?: number, mcpPort?: number,
  selection?: PersonalCodexInvestigatorConfiguration, codexManaged?:boolean,
  onCodexDiagnostic?:(diagnostic:PersonalCodexDiagnostic)=>void): Promise<void> {
  if((codexManaged!==undefined&&typeof codexManaged!=='boolean')||
    (codexManaged===true&&!selection))throw new Error('NOT_AVAILABLE');
  const runtime = acquireInstallationRuntime(root);
  let handle: Awaited<ReturnType<typeof startSelfHostedOAuthHttpWithinInstallation>> | undefined;
  try {
    const saved = loadConfig(runtime.dataDirectory);
    const codexInvestigator = selection === undefined ? undefined :
      authorizeCodexSelection(runtime, localAdmin(), selection, saved.bindings[0].workspaceId);
    handle = await startSelfHostedOAuthHttpWithinInstallation(runtime, {
      ...saved, issuer: { ...saved.issuer, ...(issuerPort === undefined ? {} : { port: issuerPort }) },
      ...(mcpPort === undefined ? {} : { mcpPort }),
      ...(codexInvestigator ? { codexInvestigator } : {}),
      ...(codexManaged !== undefined ? {codexManaged} : {}),
      ...(codexInvestigator && onCodexDiagnostic ? {onCodexDiagnostic} : {}),
    });
    process.stdout.write(`${JSON.stringify({ issuerUrl: handle.issuerUrl, mcpUrl: handle.mcpUrl })}\n`);
  } catch (error) {
    if (handle) {
      try { await handle.close(); }
      catch (closeError) { return releaseAfterFailure(runtime, new AggregateError([error, closeError],
        'OAuth HTTP startup cleanup unconfirmed', { cause: error })); }
    }
    return releaseAfterFailure(runtime, error);
  }
  const active = handle;
  let onSignal = () => undefined;
  try {
    await new Promise<void>((done, reject) => {
      let closing: Promise<void> | undefined;
      onSignal = () => {
        closing ??= (async () => {
          try { await active.close(); }
          catch (error) { retainInstallationRuntime(runtime); throw error; }
          releaseAfterSuccess(runtime);
        })();
        void closing.then(done, reject);
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}
