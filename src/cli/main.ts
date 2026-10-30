#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteStore } from '../adapters/storage/sqlite.js';
import { openApplicationWithinInstallation } from '../runtime/application.js';
import { acquireInstallationRuntime, assertActiveInstallation, assertFreshManagedInstallationDestination, retainInstallationRuntime,
  type InstallationRuntime } from '../runtime/installation.js';
import { assertPrivateDataDirectory, protectNewDataDirectory } from '../runtime/local-security.js';
import type { Command } from '../application/dispatch.js';
import type { RequestContext } from '../core/policy/authorize.js';
import { authorize } from '../core/policy/authorize.js';
import { startExternalStdio } from '../adapters/mcp/stdio.js';
import { createPlatformFileDownloadResolver } from '../adapters/mcp/platform-file-download.js';
import { operationPolicy } from '../core/policy/authorize.js';
import { configureFileOriginsWithinInstallation, configureOAuthWithinInstallation,
  readFileOriginsWithinInstallation, serveOAuthHttp } from './oauth.js';
import { LocalArtifactSource } from '../adapters/transfers/local-source.js';
import { validateArtifactPaths } from '../core/artifact/paths.js';
import { preflightWindowsDesktop } from '../adapters/codex/investigator/windows-preflight.js';
import { diagnoseInstallation } from '../application/diagnostics.js';
import { createManagedInstallation } from './install.js';
import { backupInstallation, restoreInstallation } from '../runtime/installation-backup.js';
import { dryRunInstallationUpgrade, upgradeInstallation } from '../runtime/installation-upgrade.js';
import { HostConversationBridge } from './host-conversation.js';
import { ChatgptHostConversation } from '../adapters/chatgpt/host-conversation.js';
import { HostConversationSqlite } from '../adapters/storage/host-conversation-sqlite.js';
import { BrowserCaptureSqlite } from '../adapters/storage/browser-capture-sqlite.js';
import {runWindowsRuntimeCommand} from './windows-runtime.js';
import {parseCodexStartupArguments,authorizeCodexSelection,runCodexInvestigationCommand} from './codex-investigation.js';
import {parseClaudeStartupArguments,authorizeClaudeSelection,runClaudeInvestigationCommand} from './claude-investigation.js';
import {createCliCodexDiagnosticSink} from './codex-diagnostic.js';
import { isDailyCommand, runDailyCommand } from './daily-use.js';

function localIdentity(): { principal: string; audience: string; recipient: string } {
  const account = userInfo();
  const principal = `${hostname()}\\${account.username}`;
  return { principal, audience: 'local-os', recipient: principal };
}

function publicError(error: unknown): { code: string; message: string } {
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const code = typeof value.code === 'string' && /^(?:NOT_AVAILABLE|CONFLICT|BASELINE_MISMATCH|INTEGRITY_ERROR|UNKNOWN)$/.test(value.code)
    ? value.code : 'ERROR';
  const message = typeof value.message === 'string' && [
    'Installation path already exists; refusing to create a new administrator',
    'Installation missing; run init first',
    'Invalid MCP binding', 'MCP binding must be a regular file',
    'Data directory permissions unavailable or unsafe', 'Data directory is not private',
    'Existing different Skill preserved; choose another --skill-dir',
    'Existing file-origin policy preserved',
    'Unsupported file source',
    'Read-only file network check requires a flat installation',
    'Daily binding save outcome unknown',
    'Existing Tunnel connection preserved', 'Installed Tunnel interface is unverified',
    'Existing restricted Tunnel key required in CONTROL_PLANE_API_KEY; never paste it into chat',
    'Build or install RepoConduit before connecting Tunnel',
    'Tunnel transport could not start', 'Tunnel transport stopped; preserve pending deliveries before reconnecting',
    'Project unavailable; use discuss with an explicit sharing scope first',
    'Topic unavailable or ambiguous',
  ].includes(value.message) ? value.message : 'Request failed or resource unavailable';
  return { code, message };
}

/** Trusted local CLI metadata only; external MCP/HTTP error projection stays separate. */
export function localCliError(error: unknown): { code: string; message: string;
  privateDirectory?: { component: 'private_directory'; operation: string; reason: string } } {
  const result = publicError(error);
  if (!(error instanceof Error) || error.message !== 'Data directory permissions unavailable or unsafe') return result;
  const cause: unknown = error.cause;
  if (!cause || typeof cause !== 'object' || Array.isArray(cause)) return result;
  const value = cause as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'component,operation,reason' ||
    value.component !== 'private_directory' || typeof value.operation !== 'string' ||
    !['protect', 'verify_data', 'verify_installation'].includes(value.operation) ||
    typeof value.reason !== 'string' ||
    !['timeout', 'output_limit', 'spawn_missing', 'spawn_denied', 'helper_rejected', 'unknown'].includes(value.reason)) return result;
  return { ...result, privateDirectory: { component: 'private_directory',
    operation: value.operation, reason: value.reason } };
}

function args(raw: readonly string[]): { root: string; action: 'init' | 'init-managed' | 'backup' | 'restore' | 'doctor' | 'request' | 'collect-local' | 'collect-local-set' | 'mcp' | 'configure-mcp' | 'configure-oauth' | 'configure-file-origins' | 'serve-http' | 'codex-windows-readiness' | 'host-conversation' | 'prepare-windows-investigator' | 'check-windows-investigator' | 'run-codex-investigation' | 'run-claude-investigation'; sourcePath?: string; issuerPort?: number; mcpPort?: number; codexSelection?:{workspaceId:string;profileRevision:string};claudeSelection?:{workspaceId:string;profileRevision:string};codexManaged?:true } {
  const claude=parseClaudeStartupArguments(raw);
  const {argv,selection,managed}=parseCodexStartupArguments(claude.argv);
  if(claude.selection&&selection)throw new TypeError('Select one investigator runtime per MCP connection');
  const ports: { issuerPort?: number; mcpPort?: number } = {};
  if (argv[2] === 'serve-http') {
    for (let index = 3; index < argv.length; index += 2) {
      const flag = argv[index];
      const value = argv[index + 1] ?? '';
      if ((flag !== '--issuer-port' && flag !== '--mcp-port') ||
          !/^[1-9][0-9]*$/.test(value) || Number(value) > 65535 ||
          (flag === '--issuer-port' && ports.issuerPort !== undefined) ||
          (flag === '--mcp-port' && ports.mcpPort !== undefined)) {
        throw new TypeError('Invalid HTTP listener port');
      }
      if (flag === '--issuer-port') ports.issuerPort = Number(value);
      else ports.mcpPort = Number(value);
    }
  }
  if ((argv.length !== 3 && argv.length !== 4 && argv[2] !== 'serve-http') || argv[0] !== '--data-dir' || !argv[1] || !isAbsolute(argv[1]) ||
      (argv[2] !== 'init' && argv[2] !== 'init-managed' && argv[2] !== 'backup' && argv[2] !== 'restore' && argv[2] !== 'doctor' && argv[2] !== 'request' && argv[2] !== 'mcp' && argv[2] !== 'configure-mcp' &&
        argv[2] !== 'configure-oauth' && argv[2] !== 'configure-file-origins' && argv[2] !== 'serve-http' && argv[2] !== 'collect-local' && argv[2] !== 'collect-local-set' && argv[2] !== 'codex-windows-readiness' && argv[2] !== 'host-conversation' && argv[2] !== 'prepare-windows-investigator' && argv[2] !== 'check-windows-investigator' && argv[2] !== 'run-codex-investigation' && argv[2] !== 'run-claude-investigation') ||
      (argv[2] === 'collect-local' || argv[2] === 'backup' || argv[2] === 'restore' ? argv.length !== 4 || !isAbsolute(argv[3] ?? '') :
        argv[2] === 'host-conversation' ? argv.length !== 3 && (argv.length !== 4 || !isAbsolute(argv[3] ?? '')) :
        argv[2] === 'serve-http' ? argv.length !== 3 && argv.length !== 5 && argv.length !== 7 : argv.length !== 3)) {
    throw new TypeError('Usage: rcac --data-dir ABSOLUTE_PATH init|init-managed|backup ABSOLUTE_DESTINATION|restore ABSOLUTE_BACKUP|doctor|request|host-conversation [ABSOLUTE_DOWNLOAD_ROOT]|collect-local ABSOLUTE_SOURCE|collect-local-set|configure-mcp|mcp [--codex-workspace ID --codex-profile REVISION] [--codex-managed] [--claude-workspace ID --claude-profile REVISION]|configure-oauth|configure-file-origins|serve-http [--issuer-port PORT] [--mcp-port PORT] [--codex-workspace ID --codex-profile REVISION] [--codex-managed]|codex-windows-readiness|prepare-windows-investigator|check-windows-investigator|run-codex-investigation|run-claude-investigation; daily: rcac setup [--file-source chatgpt]; rcac enable-chatgpt-files; rcac check-file-network --file-origin HTTPS_ORIGIN; rcac add-file-origin --data-dir ABSOLUTE_PATH --file-origin HTTPS_ORIGIN [--file-origin HTTPS_ORIGIN...]');
  }
  return { root: resolve(argv[1]), action: argv[2],
    ...(argv[2] === 'collect-local' || argv[2] === 'backup' || argv[2] === 'restore' ||
      (argv[2] === 'host-conversation' && argv.length === 4) ? { sourcePath: argv[3] } : {}),
    ...ports,...(selection?{codexSelection:selection}:{}),...(claude.selection?{claudeSelection:claude.selection}:{}),
    ...(managed?{codexManaged:true as const}:{}) };
}

interface LocalSetFile { sourcePath: string; path: string; mediaType: string }
interface LocalSetManifest { scope: { workspaceId: string; collaborationId: string }; bundleId: string;
  contextRevision: string; snapshotRefs: string[]; parentBundleId?: string; files: LocalSetFile[] }

function localSetManifest(value: unknown): LocalSetManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Local set manifest required');
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some(key => !['scope', 'bundleId', 'contextRevision', 'snapshotRefs', 'parentBundleId', 'files'].includes(key)) ||
      !entry.scope || typeof entry.scope !== 'object' || Array.isArray(entry.scope)) throw new TypeError('Invalid local set manifest');
  const scope = entry.scope as Record<string, unknown>;
  if (Object.keys(scope).some(key => !['workspaceId', 'collaborationId'].includes(key)) ||
      typeof scope.workspaceId !== 'string' || !scope.workspaceId.trim() ||
      typeof scope.collaborationId !== 'string' || !scope.collaborationId.trim() ||
      typeof entry.bundleId !== 'string' || !entry.bundleId.trim() ||
      typeof entry.contextRevision !== 'string' || !entry.contextRevision.trim() ||
      !Array.isArray(entry.snapshotRefs) || entry.snapshotRefs.length === 0 ||
      !entry.snapshotRefs.every(item => typeof item === 'string' && Boolean(item.trim())) ||
      (entry.parentBundleId !== undefined && (typeof entry.parentBundleId !== 'string' || !entry.parentBundleId.trim())) ||
      !Array.isArray(entry.files) || entry.files.length < 1 || entry.files.length > 256) {
    throw new TypeError('Invalid local set manifest');
  }
  const files = entry.files as unknown[];
  if (!files.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
      Object.keys(item).every(key => ['sourcePath', 'path', 'mediaType'].includes(key)) &&
      typeof (item as Record<string, unknown>).sourcePath === 'string' &&
      isAbsolute((item as LocalSetFile).sourcePath) &&
      typeof (item as Record<string, unknown>).path === 'string' &&
      typeof (item as Record<string, unknown>).mediaType === 'string' &&
      Boolean((item as LocalSetFile).mediaType.trim()))) throw new TypeError('Invalid local set file');
  validateArtifactPaths(files.map(item => (item as LocalSetFile).path));
  const sorted = (files as LocalSetFile[]).slice().sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { scope: { workspaceId: scope.workspaceId, collaborationId: scope.collaborationId },
    bundleId: entry.bundleId, contextRevision: entry.contextRevision,
    snapshotRefs: entry.snapshotRefs as string[],
    ...(entry.parentBundleId === undefined ? {} : { parentBundleId: entry.parentBundleId as string }), files: sorted };
}

function localSetKey(bundleId: string, phase: string, path = ''): string {
  return `local-set-${createHash('sha256').update(JSON.stringify([bundleId, phase, path])).digest('hex')}`;
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 1024 * 1024) throw new TypeError('Request exceeds 1 MiB');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function command(value: unknown): Command {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Command object required');
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !['operation', 'scope', 'payload', 'idempotencyKey'].includes(key)) ||
      typeof entry.operation !== 'string' || !entry.scope || typeof entry.scope !== 'object' ||
      Array.isArray(entry.scope) || typeof (entry.scope as Record<string, unknown>).workspaceId !== 'string' ||
      (entry.idempotencyKey !== undefined && typeof entry.idempotencyKey !== 'string')) {
    throw new TypeError('Invalid command envelope');
  }
  const scope = entry.scope as Record<string, unknown>;
  if (Object.keys(scope).some((key) => !['workspaceId', 'collaborationId'].includes(key)) ||
      (scope.collaborationId !== undefined && typeof scope.collaborationId !== 'string')) throw new TypeError('Invalid scope');
  return { operation: entry.operation, scope: { workspaceId: scope.workspaceId as string,
    ...(scope.collaborationId === undefined ? {} : { collaborationId: scope.collaborationId as string }) },
    payload: entry.payload, ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey as string }) };
}

export async function main(argv: readonly string[]): Promise<unknown> {
  if (isDailyCommand(argv)) return runDailyCommand(argv, root => main(['--data-dir', root, 'init']));
  if (argv[2] === 'host-conversation') { await serveHostConversation(argv); return { closed: true }; }
  if (argv[2] === 'upgrade') {
    const dryRun = argv.length === 8 && argv[7] === '--dry-run';
    if ((!dryRun && argv.length !== 7) || argv[0] !== '--data-dir' || !isAbsolute(argv[1] ?? '') ||
        argv[3] !== '--package' || !isAbsolute(argv[4] ?? '') || argv[5] !== '--backup' ||
        !isAbsolute(argv[6] ?? '')) {
      throw new TypeError('Usage: rcac --data-dir ABSOLUTE_PATH upgrade --package ABSOLUTE_ARCHIVE --backup ABSOLUTE_DESTINATION [--dry-run]');
    }
    if (dryRun) return dryRunInstallationUpgrade(resolve(argv[1]!), resolve(argv[4]!), resolve(argv[6]!));
    return upgradeInstallation(resolve(argv[1]!), resolve(argv[4]!), resolve(argv[6]!));
  }
  const { root, action, sourcePath } = args(argv);
  if (action === 'init-managed') return createManagedInstallation(root);
  if (action === 'backup') return backupInstallation(root, sourcePath!);
  if (action === 'restore') return restoreInstallation(sourcePath!, root);
  const file = join(root, 'state.sqlite');
  const identity = localIdentity();
  if (action === 'init') {
    if (existsSync(root)) throw new Error('Installation path already exists; refusing to create a new administrator');
    assertFreshManagedInstallationDestination(root);
    mkdirSync(root, { mode: 0o700 });
    protectNewDataDirectory(root);
    const store = new SqliteStore(file);
    try {
      assertPrivateDataDirectory(root);
      store.insertGrant({ id: `gr_${randomUUID()}`, ...identity, workspaceId: 'management',
        permissions: ['admin.workspace', 'admin.grant', 'admin.revoke', 'admin.profile'],
        expiresAt: null, revokedAt: null });
    } finally { store.close(); }
    assertPrivateDataDirectory(root);
    return { initialized: true, dataDirectory: root, principal: identity.principal };
  }
  const runtime = acquireInstallationRuntime(root);
  let result: unknown;
  try { result = await runDataCommand(runtime, action, identity, sourcePath); }
  catch (error) { releaseAfterFailure(runtime, error); }
  try { runtime.release(); } catch (error) { retainInstallationRuntime(runtime); throw error; }
  return result;
}

/** The signed-in local host services fixed actions; no background browser executor or global config. */
export async function serveHostConversation(argv: readonly string[]): Promise<void> {
  const parsed = args(argv);
  if (parsed.action !== 'host-conversation') throw new TypeError('Host conversation action required');
  const runtime = acquireInstallationRuntime(parsed.root);
  const bridge = new HostConversationBridge(process.stdin, process.stdout);
  let store: HostConversationSqlite | undefined;
  let downloads: BrowserCaptureSqlite | undefined;
  let app: ReturnType<typeof openApplicationWithinInstallation> | undefined;
  let failure: unknown;
  const signalStop = () => bridge.close();
  process.once('SIGINT', signalStop);
  process.once('SIGTERM', signalStop);
  try {
    assertActiveInstallation(runtime);
    store = new HostConversationSqlite(runtime.dataDirectory);
    const adapter = new ChatgptHostConversation(store, bridge);
    if (parsed.sourcePath) downloads = new BrowserCaptureSqlite(join(runtime.dataDirectory, 'state.sqlite'));
    app = openApplicationWithinInstallation(runtime, { conversation: adapter, conversationPort: adapter,
      ...(downloads && parsed.sourcePath ? { browserDownload: { store: downloads, accounts: store,
        transport: bridge, root: parsed.sourcePath } } : {}) });
    await app.ready;
    const identity = localIdentity();
    const dispatcher = app.dispatch;
    await bridge.run(async raw => dispatcher.dispatch({ ...identity, surface: 'local_cli', now: new Date() }, command(raw)));
  } catch (error) { failure = error; }
  bridge.close();
  const cleanup: unknown[] = [];
  try { await app?.close(); } catch (error) { cleanup.push(error); }
  try { downloads?.close(); } catch (error) { cleanup.push(error); }
  try { store?.close(); } catch (error) { cleanup.push(error); }
  process.removeListener('SIGINT', signalStop);
  process.removeListener('SIGTERM', signalStop);
  if (cleanup.length) {
    retainInstallationRuntime(runtime);
    throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], 'Host bridge cleanup unconfirmed');
  }
  if (failure !== undefined) releaseAfterFailure(runtime, failure);
  try { runtime.release(); } catch (error) { retainInstallationRuntime(runtime); throw error; }
}

function releaseAfterFailure(runtime: InstallationRuntime, error: unknown): never {
  if (error instanceof AggregateError) retainInstallationRuntime(runtime);
  else {
    try { runtime.release(); }
    catch (releaseError) { retainInstallationRuntime(runtime);
      throw new AggregateError([error, releaseError], 'CLI installation cleanup unconfirmed', { cause: releaseError }); }
  }
  throw error;
}

function withOwnedClose<T>(action: () => T, close: () => void): T {
  let result: T;
  try { result = action(); }
  catch (error) {
    try { close(); }
    catch (closeError) { throw new AggregateError([error, closeError],
      'CLI resource cleanup unconfirmed', { cause: closeError }); }
    throw error;
  }
  try { close(); }
  catch (error) { throw new AggregateError([error], 'CLI resource cleanup unconfirmed', { cause: error }); }
  return result;
}

async function closeApplication(application: ReturnType<typeof openApplicationWithinInstallation>, primary: unknown): Promise<void> {
  try { await application.close(); }
  catch (error) { throw new AggregateError([primary, error], 'CLI application cleanup unconfirmed', { cause: error }); }
}

async function runDataCommand(runtime: InstallationRuntime, action: ReturnType<typeof args>['action'],
  identity: ReturnType<typeof localIdentity>, sourcePath?: string): Promise<unknown> {
  assertActiveInstallation(runtime);
  const root = runtime.dataDirectory;
  if (action === 'doctor') return diagnoseInstallation(root,{...identity,surface:'local_cli',now:new Date()});
  if (action === 'codex-windows-readiness') return preflightWindowsDesktop();
  if (action === 'prepare-windows-investigator' || action === 'check-windows-investigator')
    return runWindowsRuntimeCommand(runtime,action,identity,await readStdin());
  if (action === 'run-codex-investigation')
    return runCodexInvestigationCommand(runtime,identity,await readStdin());
  if (action === 'run-claude-investigation')
    return runClaudeInvestigationCommand(runtime,identity,await readStdin());
  if (action === 'mcp') throw new TypeError('Use MCP stdio entrypoint');
  if (action === 'serve-http') throw new TypeError('Use HTTP server entrypoint');
  if (action === 'configure-mcp') return configureMcp(runtime, await readStdin());
  if (action === 'configure-oauth') return configureOAuthWithinInstallation(runtime, await readStdin());
  if (action === 'configure-file-origins') return configureFileOriginsWithinInstallation(runtime, await readStdin());
  if (action === 'collect-local-set') {
    const input = localSetManifest(await readStdin());
    const context: RequestContext = { ...identity, surface: 'local_cli', now: new Date() };
    const application = openApplicationWithinInstallation(runtime);
    const { scope, bundleId } = input;
    let primary: unknown;
    try {
      await application.ready;
      await application.dispatch.dispatch(context, { operation: 'artifact.begin', scope,
        idempotencyKey: localSetKey(bundleId, 'begin'), payload: { bundleId,
          contextRevision: input.contextRevision, snapshotRefs: input.snapshotRefs,
          ...(input.parentBundleId ? { parentBundleId: input.parentBundleId } : {}),
          expectedPaths: input.files.map(file => file.path) } });
      for (const file of input.files) {
        await application.dispatch.dispatch(context, { operation: 'artifact.collect_local', scope,
          idempotencyKey: localSetKey(bundleId, 'collect', file.path),
          payload: { bundleId, path: file.path, mediaType: file.mediaType } },
        undefined, new LocalArtifactSource(file.sourcePath));
      }
      return await application.dispatch.dispatch(context, { operation: 'artifact.finalize', scope,
        idempotencyKey: localSetKey(bundleId, 'finalize'), payload: { bundleId } });
    } catch (error) { primary = error; throw error; }
    finally { await closeApplication(application, primary); }
  }
  const input = command(await readStdin());
  if ((action === 'collect-local') !== (input.operation === 'artifact.collect_local')) throw new TypeError('Local collection requires collect-local action');
  const context: RequestContext = { ...identity, surface: input.operation.startsWith('admin.') ? 'local_admin' : 'local_cli', now: new Date() };
  const application = openApplicationWithinInstallation(runtime);
  let primary: unknown;
  try { await application.ready; return await application.dispatch.dispatch(context, input, undefined,
    sourcePath === undefined ? undefined : new LocalArtifactSource(sourcePath)); }
  catch (error) { primary = error; throw error; }
  finally { await closeApplication(application, primary); }
}

interface McpBinding { principal: string; audience: string; recipient: string; workspaceId: string;
  collaborationId?: string; visibleOperations: string[] }
function parseMcpBinding(value: unknown): McpBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid MCP binding');
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !['principal', 'audience', 'recipient', 'workspaceId', 'collaborationId', 'visibleOperations'].includes(key)) ||
      !['principal', 'audience', 'recipient', 'workspaceId'].every((key) => typeof entry[key] === 'string' && Boolean((entry[key] as string).trim())) ||
      (entry.collaborationId !== undefined && typeof entry.collaborationId !== 'string') ||
      !Array.isArray(entry.visibleOperations) || entry.visibleOperations.length === 0 ||
      !entry.visibleOperations.every((item) => typeof item === 'string' && Boolean(item.trim()))) {
    throw new TypeError('Invalid MCP binding');
  }
  return entry as unknown as McpBinding;
}

function readMcpBinding(root: string): McpBinding {
  const path = join(root, 'mcp-binding.json');
  if (lstatSync(path).isSymbolicLink()) throw new Error('MCP binding must be a regular file');
  assertPrivateDataDirectory(root, path);
  return parseMcpBinding(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function discoverMcpOperations(binding: McpBinding, context: RequestContext, store: SqliteStore): string[] {
  const scope = { workspaceId: binding.workspaceId,
    ...(binding.collaborationId ? { collaborationId: binding.collaborationId } : {}) };
  const grants = store.grantsFor(context.principal, context.audience);
  return binding.visibleOperations.filter((operation) => {
    try {
      const target = operation === 'collab.open' ? { workspaceId: binding.workspaceId } : scope;
      if (!operationPolicy(operation).surfaces.includes('external_mcp')) return false;
      authorize(context, operation, target, grants);
      return true;
    } catch { return false; }
  });
}

function configureMcp(runtime: InstallationRuntime, input: unknown): { configured: true; workspaceId: string; visibleOperations: string[] } {
  assertActiveInstallation(runtime);
  const root = runtime.dataDirectory;
  assertPrivateDataDirectory(root);
  const binding = parseMcpBinding(input);
  const local = { ...localIdentity(), surface: 'local_admin' as const, now: new Date() };
  const external: RequestContext = { principal: binding.principal, audience: binding.audience,
    recipient: binding.recipient, surface: 'external_mcp', now: new Date() };
  const store = new SqliteStore(join(root, 'state.sqlite'));
  return withOwnedClose(() => {
    authorize(local, 'admin.grant', { workspaceId: 'management' }, store.grantsFor(local.principal, local.audience));
    if (!store.getWorkspace(binding.workspaceId) ||
        (binding.collaborationId && !store.getCollaboration(binding.collaborationId, binding.workspaceId))) {
      throw new Error('NOT_AVAILABLE');
    }
    const visible = discoverMcpOperations(binding, external, store);
    if (visible.length !== binding.visibleOperations.length) throw new Error('NOT_AVAILABLE');
    const path = join(root, 'mcp-binding.json');
    const fd = openSync(path, 'wx', 0o600);
    withOwnedClose(() => { writeFileSync(fd, JSON.stringify(binding)); fsyncSync(fd); }, () => closeSync(fd));
    assertPrivateDataDirectory(root, path);
    return { configured: true as const, workspaceId: binding.workspaceId, visibleOperations: visible };
  }, () => store.close());
}

export async function serveMcp(argv: readonly string[]): Promise<void> {
  const parsed = args(argv);
  if (parsed.action !== 'mcp') throw new TypeError('MCP action required');
  const runtime = acquireInstallationRuntime(parsed.root);
  let application: ReturnType<typeof openApplicationWithinInstallation> | undefined;
  try {
  const binding = readMcpBinding(runtime.dataDirectory);
  const context: RequestContext = { principal: binding.principal, audience: binding.audience,
    recipient: binding.recipient, surface: 'external_mcp', now: new Date() };
  const grantStore = new SqliteStore(join(runtime.dataDirectory, 'state.sqlite'));
  const visible = withOwnedClose(() => discoverMcpOperations(binding, context, grantStore), () => grantStore.close());
  const origins = visible.includes('artifact.import_reference') ? readFileOriginsWithinInstallation(runtime) : [];
  const resolveFileTransfer = origins.length ? createPlatformFileDownloadResolver({ allowedOrigins: origins }) : undefined;
  const codexInvestigator=parsed.codexSelection?
    authorizeCodexSelection(runtime,localIdentity(),parsed.codexSelection,binding.workspaceId):undefined;
  const claudeInvestigator=parsed.claudeSelection?
    authorizeClaudeSelection(runtime,localIdentity(),parsed.claudeSelection,binding.workspaceId):undefined;
  application = openApplicationWithinInstallation(runtime,{...(codexInvestigator?{codexInvestigator}:{}),
    ...(claudeInvestigator?{claudeInvestigator}:{}),
    ...(parsed.codexManaged?{codexManaged:true}:{}),
    ...(codexInvestigator?{onCodexDiagnostic:createCliCodexDiagnosticSink()}:{})});
  const app = application;
  await app.ready;
  const handle = startExternalStdio({ dispatcher: app.dispatch, context,
      visibleOperations: visible, allowedWorkspaceId: binding.workspaceId,
      ...(resolveFileTransfer ? { resolveFileTransfer } : {}),
      ...(binding.collaborationId ? { allowedCollaborationId: binding.collaborationId } : {}) });
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    app.dispatch.stopAccepting();
    closing ??= (async () => {
      const failures: unknown[] = [];
      let appClose:Promise<void>|void=undefined;
      try { appClose=app.close(); } catch(error){failures.push(error);}
      let transportClose:Promise<void>|void=undefined;
      try { transportClose=handle.close(); } catch(error){failures.push(error);}
      const finished=await Promise.allSettled([appClose,transportClose]);
      failures.push(...finished.filter((result):result is PromiseRejectedResult=>result.status==='rejected')
        .map(result=>result.reason as unknown));
      process.removeListener('SIGINT', signalStop);
      process.removeListener('SIGTERM', signalStop);
      if (failures.length) { retainInstallationRuntime(runtime);
        throw new AggregateError(failures, 'MCP shutdown cleanup unconfirmed'); }
      try { runtime.release(); } catch (error) { retainInstallationRuntime(runtime); throw error; }
    })();
    return closing;
  };
  const reportCloseFailure = (error: unknown) => {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  };
  const signalStop = () => { void shutdown().catch(reportCloseFailure); };
  void handle.closed.then(shutdown).catch(reportCloseFailure);
  process.once('SIGINT', signalStop);
  process.once('SIGTERM', signalStop);
  } catch (error) {
    try { await application?.close(); }
    catch (closeError) { retainInstallationRuntime(runtime);
      throw new AggregateError([error, closeError], 'MCP startup cleanup unconfirmed', { cause: closeError }); }
    releaseAfterFailure(runtime, error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  if (argv[2] === 'serve-http') {
    try {
      const parsed = args(argv);
      void serveOAuthHttp(parsed.root, parsed.issuerPort, parsed.mcpPort, parsed.codexSelection,
        parsed.codexManaged, parsed.codexSelection?createCliCodexDiagnosticSink():undefined).catch((error: unknown) => {
        process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
        process.exitCode = 1;
      });
    } catch (error) {
      process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
      process.exitCode = 1;
    }
  } else if (argv[2] === 'host-conversation') {
    void serveHostConversation(argv).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
      process.exitCode = 1;
    });
  } else if (argv[0] === 'mcp-daily' || argv[0] === '--data-dir' && argv[2] === 'mcp-daily') {
    void main(argv).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
      process.exitCode = 1;
    });
  } else if (argv[2] === 'mcp') {
    void serveMcp(argv).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
      process.exitCode = 1;
    });
  } else {
    try {
      // An unsettled command is not a successful process. A true top-level
      // await also makes Node report a nonzero exit if all handles disappear.
      const result = await main(argv);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error: unknown) {
      process.stderr.write(`${JSON.stringify(localCliError(error))}\n`);
      process.exitCode = 1;
    }
  }
}
