import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hostname, homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { SqliteStore } from '../adapters/storage/sqlite.js';
import { captureGitTree } from '../adapters/repository/snapshots.js';
import { DailyUseApplication } from '../application/daily-use.js';
import { dailyBundleId, publishDailyDelivery, readDailyInbox } from '../application/daily-delivery.js';
import { exportDailyOriginals } from '../application/daily-original-export.js';
import { openApplicationWithinInstallation } from '../runtime/application.js';
import { acquireInstallationRuntime, retainInstallationRuntime, type InstallationRuntime } from '../runtime/installation.js';
import { assertPrivateDataDirectory } from '../runtime/local-security.js';
import { createDailyMcpServer } from '../adapters/mcp/daily-server.js';
import { createPlatformFileDownloadResolver, inspectPlatformFileNetwork, validateFileOrigins } from '../adapters/mcp/platform-file-download.js';
import type { RequestContext } from '../core/policy/authorize.js';
import { authorize } from '../core/policy/authorize.js';
import { connectDailyTunnel, saveDailyTunnelProfile, validateDailyTunnelProfile } from './daily-tunnel.js';
import { addDailyFileOriginsWithinInstallation, dailyOriginConflict, enableDailyChatGPTFilesWithinInstallation, readDailyBinding } from './daily-binding.js';
import { createDailyCodexSelector, disableDailyInvestigation, enableDailyInvestigation,
  selectDailyCodexSource } from './daily-investigation.js';
import { prepareDefaultDailyContainer, resolveDailyDataDirectory } from './daily-data-directory.js';

const actions = new Set(['setup', 'add-file-origin', 'enable-chatgpt-files', 'check-file-network', 'connect', 'discuss', 'projects', 'topics', 'inbox', 'receive', 'export', 'source-export', 'publish-project', 'mcp-daily', 'use-codex', 'enable-investigation', 'disable-investigation']);
export function isDailyCommand(argv: readonly string[]): boolean {
  return actions.has(argv[0] ?? '') || argv[0] === '--data-dir' && actions.has(argv[2] ?? '');
}
function skillSource(): string {
  let path = dirname(fileURLToPath(import.meta.url));
  for (let n = 0; n < 4; n++, path = dirname(path)) {
    const candidate = join(path, 'skills', 'consult-external-agent');
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate;
  }
  throw new Error('Packaged Skill unavailable');
}
function skillBytes(root: string, prefix = '', depth = 0): string[] {
  if (depth > 4 || lstatSync(root).isSymbolicLink()) throw new Error('Unsafe Skill directory');
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.length > 64) throw new Error('Skill directory exceeds supported size');
  return entries.flatMap(entry => {
    const name = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Unsafe Skill entry');
    if (entry.isDirectory()) return skillBytes(join(root, entry.name), `${name}/`, depth + 1);
    if (!entry.isFile()) throw new Error('Unsafe Skill entry');
    return [`${name}:${createHash('sha256').update(readFileSync(join(root, entry.name))).digest('hex')}`];
  }).sort();
}
function mediaType(path: string): string {
  return ({ '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.html': 'text/html',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.zip': 'application/zip', '.pdf': 'application/pdf' } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function closeDailyResources(app: ReturnType<typeof openApplicationWithinInstallation> | undefined,
  store: SqliteStore | undefined, runtime: InstallationRuntime, primary: unknown, retain = false): Promise<void> {
  const errors: unknown[] = [];
  try { await app?.close(); } catch (error) { errors.push(error); }
  try { store?.close(); } catch (error) { errors.push(error); }
  if (errors.length || retain) retainInstallationRuntime(runtime);
  else { try { runtime.release(); } catch (error) { retainInstallationRuntime(runtime); errors.push(error); } }
  if (errors.length) throw new AggregateError(primary === undefined ? errors : [primary, ...errors], 'Daily-use cleanup unconfirmed');
}

function selectedDirectoryFiles(root: string): string[] {
  let entries = 0;
  const files: string[] = [];
  function visit(directory: string, depth: number): void {
    if (depth > 32 || lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe import directory');
    const opened = opendirSync(directory, { bufferSize: 1 });
    try {
      for (let entry = opened.readSync(); entry !== null; entry = opened.readSync()) {
        if (++entries > 1024) throw new Error('Import directory exceeds 1024 entries');
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Unsafe import entry');
        if (entry.isDirectory()) visit(path, depth + 1);
        else if (entry.isFile()) { files.push(path); if (files.length > 256) throw new Error('Import directory exceeds 256 files'); }
        else throw new Error('Unsafe import entry');
      }
    } finally { opened.closeSync(); }
  }
  visit(root, 0); return files;
}

export async function runDailyCommand(argv: readonly string[], initialize: (root: string) => Promise<unknown>): Promise<unknown> {
  const args = [...argv];
  if (args[0] === '--data-dir') { const [flag, value] = args.splice(0, 2); args.push(flag!, value!); }
  const action = args.shift()!;
  const allowed = new Set(['--data-dir', ...(action === 'setup' ? ['--skill-dir', '--file-origin', '--file-source', '--tunnel-client', '--tunnel-id', '--proxy'] :
    ['add-file-origin', 'check-file-network'].includes(action) ? ['--file-origin'] :
    action === 'connect' ? ['--dry-run'] :
    action === 'discuss' ? ['--project', '--topic', '--question', '--share', '--share-tracked'] :
    action === 'topics' ? ['--project'] : action === 'inbox' ? ['--project', '--topic'] :
    action === 'receive' ? ['--project', '--topic', '--version', '--parent-version', '--file', '--from-directory'] :
    action === 'source-export' ? ['--project', '--topic', '--file'] :
    action === 'publish-project' ? ['--project', '--topic'] :
    action === 'use-codex' ? ['--source-data-dir', '--source-project'] :
    action === 'enable-investigation' ? ['--project', '--max-wall-seconds', '--max-turns', '--max-tool-calls'] :
    action === 'disable-investigation' ? ['--project'] :
    action === 'export' ? ['--project', '--topic', '--version'] : [])]);
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (!allowed.has(flag)) throw new TypeError('Unknown daily-use option');
    const value = ['--share-tracked', '--dry-run'].includes(flag) ? 'true' : args[++index];
    if (!value || value.startsWith('--') || values.has(flag) && !['--file', '--share', '--file-origin'].includes(flag)) throw new TypeError('Invalid daily-use option');
    values.set(flag, [...values.get(flag) ?? [], value]);
  }
  const one = (key: string) => values.get(key)?.[0];
  const required = (key: string) => { const value = one(key); if (!value?.trim()) throw new TypeError(`Missing ${key}`); return value; };
  const absolute = (path: string) => { if (!isAbsolute(path)) throw new TypeError('Absolute path required'); return resolve(path); };
  const root = resolveDailyDataDirectory(homedir(), one('--data-dir'));
  if (values.has('--file-source') && one('--file-source') !== 'chatgpt') throw new TypeError('Unsupported file source');
  const fileSourcePolicy = values.has('--file-source') ? 'chatgpt-official-v1' as const : undefined;
  const principal = `${hostname()}\\${userInfo().username}`;
  const context: RequestContext = { principal, audience: 'local-os', recipient: principal, surface: 'local_cli', now: new Date() };
  let source: string | undefined;
  let target: string | undefined;
  const cli = fileURLToPath(new URL('./main.js', import.meta.url));
  const actualCli = existsSync(cli) ? cli : fileURLToPath(new URL('./main.ts', import.meta.url));
  const tunnelProfile = action === 'setup' && ['--tunnel-client', '--tunnel-id', '--proxy'].some(flag => values.has(flag))
    ? validateDailyTunnelProfile({ executable: required('--tunnel-client'), tunnelId: required('--tunnel-id'),
      ...(one('--proxy') ? { proxy: one('--proxy') } : {}) }) : undefined;
  if (action === 'setup') {
    source = skillSource(); target = join(absolute(one('--skill-dir') ?? join(homedir(), '.agents', 'skills')), 'consult-external-agent');
    if (existsSync(target) && JSON.stringify(skillBytes(source)) !== JSON.stringify(skillBytes(target))) {
      throw new Error('Existing different Skill preserved; choose another --skill-dir');
    }
    validateFileOrigins(values.get('--file-origin') ?? []);
    if (!values.has('--data-dir')) prepareDefaultDailyContainer(homedir(), root);
    if (!existsSync(root)) await initialize(root);
  }
  if (action === 'add-file-origin' && !values.has('--file-origin')) throw new TypeError('Missing --file-origin');
  if (action === 'check-file-network') {
    if ((values.get('--file-origin')?.length ?? 0) !== 1) throw new TypeError('Exactly one --file-origin required');
    if (existsSync(join(root, 'managed.json')) || existsSync(join(root, 'lifecycle.sqlite'))) {
      throw new Error('Read-only file network check requires a flat installation');
    }
    const binding = readDailyBinding(root);
    return inspectPlatformFileNetwork(required('--file-origin'), { allowedOrigins: binding.allowedFileOrigins,
      ...(binding.fileSourcePolicy ? { fileSourcePolicy: binding.fileSourcePolicy } : {}) });
  }
  const runtime = acquireInstallationRuntime(root);
  let app: ReturnType<typeof openApplicationWithinInstallation> | undefined;
  let store: SqliteStore | undefined;
  let primary: unknown;
  let retainRuntime = false;
  try {
    assertPrivateDataDirectory(runtime.dataDirectory);
    store = new SqliteStore(join(runtime.dataDirectory, 'state.sqlite'));
    if (action === 'setup') {
      authorize({ ...context, surface: 'local_admin' }, 'admin.grant', { workspaceId: 'management' }, store.grantsFor(principal, 'local-os'));
      const file = join(runtime.dataDirectory, 'daily-binding.json');
      if (!existsSync(file)) writeFileSync(file, JSON.stringify({ principal: `personal_${randomUUID()}`,
        audience: 'repo-conduit-daily', recipient: 'chatgpt-personal', allowedFileOrigins: values.get('--file-origin') ?? [],
        ...(fileSourcePolicy ? { fileSourcePolicy } : {}) }), { flag: 'wx', mode: 0o600 });
      const binding = readDailyBinding(runtime.dataDirectory);
      if (values.has('--file-origin') && JSON.stringify(binding.allowedFileOrigins) !== JSON.stringify(validateFileOrigins(values.get('--file-origin')))) {
        throw new Error('Existing file-origin policy preserved');
      }
      if (fileSourcePolicy && binding.fileSourcePolicy !== fileSourcePolicy) throw new Error('Existing file-origin policy preserved');
      if (tunnelProfile) saveDailyTunnelProfile(runtime.dataDirectory, tunnelProfile);
      if (!existsSync(target!)) { mkdirSync(dirname(target!), { recursive: true }); cpSync(source!, target!, { recursive: true, force: false, errorOnExist: true }); }
      return { configured: true, dataDirectory: root, skillDirectory: target,
        connection: { command: process.execPath, args: [...(actualCli.endsWith('.ts') ? ['--import', 'tsx'] : []), actualCli, 'mcp-daily', '--data-dir', root] },
        ...(tunnelProfile ? { tunnelConfigured: true } : {}),
        nextAction: tunnelProfile ? 'Run rcac connect with the existing restricted Tunnel key in CONTROL_PLANE_API_KEY.'
          : 'Connect this command once using your existing authorized MCP host or Tunnel. No projects are shared by setup.' };
    }
    if (action === 'add-file-origin' || action === 'enable-chatgpt-files') {
      const admin = { ...context, surface: 'local_admin' as const };
      const report = action === 'enable-chatgpt-files' ? enableDailyChatGPTFilesWithinInstallation(runtime, admin)
        : addDailyFileOriginsWithinInstallation(runtime, admin, values.get('--file-origin')!);
      retainRuntime = report.saveStatus === 'saved-but-cleanup-unconfirmed';
      return report;
    }
    if (action === 'use-codex') {
      const report = selectDailyCodexSource(runtime, context,
        realpathSync.native(absolute(required('--source-data-dir'))), required('--source-project'));
      retainRuntime = report.saveStatus === 'saved-but-cleanup-unconfirmed';
      return report;
    }
    const binding = readDailyBinding(runtime.dataDirectory);
    const external = { principal: binding.principal, audience: binding.audience, recipient: binding.recipient };
    if (action === 'connect') return await connectDailyTunnel(runtime.dataDirectory, runtime.installationDirectory, actualCli, values.has('--dry-run'));
    const owner = { principal, audience: 'local-os', recipient: principal };
    app = openApplicationWithinInstallation(runtime, action === 'mcp-daily' && binding.codexRuntimeSource
      ? { selectCodexInvestigator: createDailyCodexSelector(runtime, owner, binding.codexRuntimeSource), codexManaged: true }
      : {}); await app.ready;
    if (action === 'enable-investigation') {
      const number = (flag: string) => {
        const value = one(flag);
        if (value === undefined) return undefined;
        if (!/^[1-9][0-9]*$/u.test(value)) throw new TypeError(`Invalid ${flag}`);
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) throw new TypeError(`Invalid ${flag}`);
        return parsed;
      };
      const maxWallSeconds = number('--max-wall-seconds');
      const maxTurns = number('--max-turns');
      const maxToolCalls = number('--max-tool-calls');
      const requested = { ...(maxWallSeconds === undefined ? {} : { maxWallSeconds }),
        ...(maxTurns === undefined ? {} : { maxTurns }),
        ...(maxToolCalls === undefined ? {} : { maxToolCalls }) };
      return await enableDailyInvestigation(runtime, store, app.dispatch, context, required('--project'), requested);
    }
    if (action === 'disable-investigation')
      return await disableDailyInvestigation(runtime, store, app.dispatch, context, required('--project'));
    const daily = new DailyUseApplication(store, app.dispatch);
    if (action === 'mcp-daily') {
      let resolveClosed!: () => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      class ObservedTransport extends StdioServerTransport {
        override async close(): Promise<void> { try { await super.close(); } finally { resolveClosed(); } }
      }
      const server = serveStdio(() => createDailyMcpServer({ daily, dispatcher: app!.dispatch,
        context: { ...external, surface: 'external_mcp', now: new Date() },
        ...(binding.codexRuntimeSource ? { investigationsEnabled: true } : {}),
        ...(binding.allowedFileOrigins.length || binding.fileSourcePolicy ? { resolveFileTransfer: createPlatformFileDownloadResolver({ allowedOrigins: binding.allowedFileOrigins,
          ...(binding.fileSourcePolicy ? { fileSourcePolicy: binding.fileSourcePolicy } : {}),
          onRejectedOrigin(origin: string) {
            process.stderr.write(`${JSON.stringify({ event: 'unapproved_file_origin', source: 'untrusted_file_parameter',
              ...(origin.length <= 512 ? { origin } : { originOmitted: true }) })}\n`);
          } }) } : {}) }),
      { transport: new ObservedTransport() });
      const stop = () => { void server.close(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { await closed; } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await server.close(); }
      return { closed: true };
    }
    if (action === 'projects') return daily.listProjects(context);
    const projectRoot = realpathSync(absolute(required('--project')));
    if (action === 'discuss') {
      let paths = values.get('--share');
      if (values.has('--share-tracked')) {
        if (paths) throw new TypeError('Choose --share or --share-tracked');
        paths = (await captureGitTree(projectRoot, 'HEAD', { workingCopyId: 'disclosure-selection' })).manifest.map(file => file.path);
      }
      if (paths) await daily.prepareProject({ ...context, surface: 'local_admin' }, { root: projectRoot, dataPaths: paths, external });
      const topic = await daily.openTopic(context, { root: projectRoot, topic: required('--topic'), question: required('--question') });
      if (paths) await daily.publishProjectMaterial({ ...context, surface: 'local_admin' },
        { root: projectRoot, sourceTopicHandle: topic.topicHandle, external });
      return topic;
    }
    const workspace = store.getWorkspaceByRoot(projectRoot);
    if (!workspace) throw new Error('Project unavailable; use discuss with an explicit sharing scope first');
    const topics = await daily.listTopics(context, { projectId: workspace.id });
    if (action === 'topics') return topics;
    const matches = topics.filter(topic => topic.title === required('--topic'));
    if (matches.length !== 1) throw new Error('Topic unavailable or ambiguous');
    const topic = await daily.resolveTopic(context, { topicHandle: matches[0]!.topicHandle });
    const scope = { workspaceId: topic.workspaceId, collaborationId: topic.collaborationId };
    if (action === 'publish-project') return await daily.publishProjectMaterial({ ...context, surface: 'local_admin' },
      { root: projectRoot, sourceTopicHandle: topic.topicHandle, external });
    if (action === 'source-export') return await exportDailyOriginals(daily, app.dispatch,
      ctx => store!.grantsFor(ctx.principal, ctx.audience), context, join(runtime.dataDirectory, 'exports'),
      { topicHandle: topic.topicHandle, paths: values.get('--file') ?? [] });
    if (action === 'inbox') return await readDailyInbox(app.dispatch, context, scope);
    if (action === 'receive') {
      const directory = one('--from-directory');
      if (directory !== undefined && lstatSync(absolute(directory)).isSymbolicLink()) throw new Error('Unsafe import directory');
      const sourceRoot = directory === undefined ? undefined : realpathSync(absolute(directory));
      const files = values.get('--file') ?? (sourceRoot === undefined ? [] : selectedDirectoryFiles(sourceRoot));
      const parentVersion = one('--parent-version');
      return await publishDailyDelivery(daily, app.dispatch, context, { topicHandle: topic.topicHandle, version: required('--version'),
        ...(parentVersion === undefined ? {} : { parentVersion }),
        files: files.map(file => {
          const sourcePath = absolute(file);
          const path = sourceRoot === undefined ? basename(file) : relative(sourceRoot, realpathSync(sourcePath)).split(sep).join('/');
          return { sourcePath, path, mediaType: mediaType(file) };
        }) });
    }
    const bundleId = dailyBundleId(topic.topicHandle, required('--version'));
    const inspected = await app.dispatch.dispatch(context, { operation: 'artifact.inspect', scope, payload: { bundleId } }) as { manifestHash: string };
    return await app.dispatch.dispatch(context, { operation: 'artifact.export', scope, idempotencyKey: `daily-export-${bundleId}`,
      payload: { bundleId, expectedManifestHash: inspected.manifestHash, exportName: `daily-${bundleId.slice(10)}` } });
  } catch (error) {
    const mapped = ['add-file-origin', 'enable-chatgpt-files', 'use-codex'].includes(action) ? dailyOriginConflict(error) : error;
    primary = mapped;
    retainRuntime = retainRuntime || mapped instanceof AggregateError ||
      (mapped as { code?: unknown })?.code === 'UNKNOWN';
    throw mapped;
  }
  finally { await closeDailyResources(app, store, runtime, primary, retainRuntime); }
}
