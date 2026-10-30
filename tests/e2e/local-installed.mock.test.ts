import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { assertPrivateInstallationDirectory } from '../../src/runtime/local-security.js';

function reportFixtureFailure(phase: 'primary' | 'cleanup', error: unknown): void {
  try { writeSync(2, `installed-e2e-${phase}-failure ${inspect(error, { depth: null })}\n`); }
  catch { /* Diagnostics must not replace the original fixture error. */ }
}

function emptyZip(): Buffer {
  const name = Buffer.from('nested/report.txt');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length, 16);
  return Buffer.concat([local, name, central, name, end]);
}

/** Local installed-process E2E. This fixture has no account, external model, or investigator worker. */
async function installedRoundTrip(retainedArchive?: string, signal?: AbortSignal): Promise<void> {
    const repositoryRoot = resolve('.');
    const fixtureRoot = process.platform === 'win32' ? homedir() : tmpdir();
    const temporary = mkdtempSync(join(fixtureRoot, 'rcac-local-installed-'));
    const source = join(temporary, 'source');
    const install = join(temporary, 'installed');
    const data = join(temporary, 'data');
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, 'run this test through npm so the exact npm CLI is known');
    let client: Client | undefined;
    let mcpClosed: Promise<void> | undefined;
    let primaryError: unknown;
    let cleanupError: unknown;
    let archiveChildrenConfirmed = true;
    let diagnosticFailed = false;
    let fixtureRemoved = false;
    let stage = 'setup';
    let sequence = 0;
    const started = process.hrtime.bigint();
    let diagnosticFile: string | undefined;
    const diagnosticRoot = process.env.REPOCONDUIT_TEST_DIAGNOSTICS_DIR;
    if (diagnosticRoot !== undefined) {
      try {
        const root = resolve(diagnosticRoot);
        assert.ok(!lstatSync(root).isSymbolicLink());
        assertPrivateInstallationDirectory(root);
        diagnosticFile = join(root, `local-installed-${process.pid}.ndjson`);
        writeFileSync(diagnosticFile, '', { flag: 'wx', mode: 0o600, flush: true });
      } catch (error) { diagnosticFailed = true; reportFixtureFailure('primary', error); }
    }
    const event = (name: string, details: Record<string, unknown> = {}): void => {
      stage = name;
      if (!diagnosticFile) return;
      try {
        appendFileSync(diagnosticFile, JSON.stringify({ sequence: ++sequence, stage: name,
          atUtc: new Date().toISOString(), elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
          ...details }) + '\n', { encoding: 'utf8', flush: true });
      } catch { diagnosticFailed = true; }
    };
    event('fixture.created', { fixture: temporary, workerPid: process.pid });
    const diagnosticReady = (): void => {
      if (diagnosticFailed) throw new Error('Installed fixture diagnostics failed; fixture retained');
    };
    const abortDetails = (): Record<string, unknown> => {
      const reason = signal?.reason as { name?: unknown; code?: unknown; failureType?: unknown } | undefined;
      const safe = (value: unknown) => typeof value === 'string' ? value.slice(0, 80) : undefined;
      return { currentStage: stage, runnerAborted: true, errorName: safe(reason?.name),
        errorCode: safe(reason?.code), failureType: safe(reason?.failureType) };
    };
    let abortRecorded = false;
    const onAbort = () => { if (!abortRecorded) { abortRecorded = true; event('abort', abortDetails()); } };
    const cancelled = (): void => {
      if (!signal?.aborted) return;
      const currentStage = stage;
      onAbort();
      const error = new Error(`Installed fixture cancelled at ${currentStage}`);
      error.name = 'AbortError';
      throw error;
    };
    const beginWork = (name: string): void => {
      cancelled(); diagnosticReady(); event(`${name}.BEGIN`); diagnosticReady(); cancelled();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const waitForMcpExit = async (closed: Promise<void>): Promise<void> => {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Installed MCP child did not close')), 5_000);
        })]);
      } finally { if (timeout) clearTimeout(timeout); }
    };

    const processRun = (program: string, args: string[], cwd: string, input?: unknown,
      category = 'cli') => {
      beginWork(category);
      const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 60_000,
        input: input === undefined ? undefined : JSON.stringify(input) });
      event(`${category}.END`, { pid: result.pid, status: result.status, signal: result.signal,
        errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code });
      cancelled();
      assert.equal(result.error, undefined, `${category} child process error: ` +
        `${(result.error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'} ${result.stderr || result.stdout}`);
      assert.equal(result.status, 0, `${program} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
      return result.stdout;
    };
    const git = (...args: string[]) => {
      beginWork('git');
      try { const output = execFileSync('git', args, { cwd: source, encoding: 'utf8' });
        event('git.END', { status: 0 }); cancelled(); return output;
      } catch (error) { event('git.END', { status: (error as { status?: number }).status,
        errorCode: (error as NodeJS.ErrnoException).code }); throw error; }
    };

    try {
      diagnosticReady(); cancelled();
      mkdirSync(join(source, 'src'), { recursive: true });
      writeFileSync(join(source, 'src', 'flow.ts'), 'export function flow() { return "SYNTHETIC_FLOW_A"; }\n');
      writeFileSync(join(source, 'src', 'hidden.ts'), 'export const secret = "SYNTHETIC_NOT_DISCLOSED";\n');
      git('init', '-q');
      git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'user.name', 'Fixture');
      git('add', '.');
      git('commit', '-qm', 'synthetic base');

      let packageArchive: string;
      if (retainedArchive === undefined) {
        processRun(process.execPath, [npmCli, 'run', 'build'], repositoryRoot, undefined, 'build');
        const packed = JSON.parse(processRun(process.execPath,
          [npmCli, 'pack', '--json', '--pack-destination', temporary], repositoryRoot, undefined, 'pack')) as { filename: string }[];
        assert.equal(packed.length, 1);
        packageArchive = join(temporary, packed[0]!.filename);
      } else {
        assert.ok(isAbsolute(retainedArchive) && resolve(retainedArchive) === retainedArchive);
        const stat = lstatSync(retainedArchive);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
        const bytes = readFileSync(retainedArchive);
        packageArchive = join(temporary, 'retained-package.tgz');
        writeFileSync(packageArchive, bytes, { flag: 'wx', mode: 0o600 });
        console.log('retained-installed-archive', JSON.stringify({ bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') }));
      }
      processRun(process.execPath, [npmCli, 'install', '--offline', '--prefix', install, '--ignore-scripts',
        '--no-audit', '--no-fund', packageArchive], repositoryRoot, undefined, 'install');
      const installedCli = join(install, 'node_modules', 'repo-conduit', 'dist', 'src', 'cli', 'main.js');
      const installedArchiver = join(install, 'node_modules', 'repo-conduit', 'tools', 'archive-live-bundle.mjs');
      assert.ok(existsSync(installedCli));
      assert.ok(existsSync(installedArchiver));
      const cli = (action: 'init' | 'request' | 'configure-mcp', input?: unknown) => JSON.parse(processRun(
        process.execPath, [installedCli, '--data-dir', data, action], temporary, input,
        action === 'request' ? `cli.request.${(input as { operation?: string })?.operation ?? 'unknown'}` : `cli.${action}`)) as Record<string, unknown>;
      const request = (operation: string, workspaceId: string, collaborationId: string | undefined,
        payload: unknown, idempotencyKey?: string) => cli('request', { operation,
        scope: { workspaceId, ...(collaborationId ? { collaborationId } : {}) }, payload,
        ...(idempotencyKey ? { idempotencyKey } : {}) });
      const openMcp = async () => {
        beginWork('mcp.connect');
        const transport = new StdioClientTransport({ command: process.execPath,
          args: [installedCli, '--data-dir', data, 'mcp'], cwd: temporary, stderr: 'pipe' });
        const connected = new Client({ name: 'local-installed-e2e', version: '1.0.0' });
        let resolveClosed!: () => void;
        const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
        // The installed SDK chains an existing onclose in Protocol.connect().
        // Own the child before handshake, including a failed handshake.
        transport.onclose = () => resolveClosed();
        client = connected;
        mcpClosed = closed;
        try { await connected.connect(transport); event('mcp.connect.END', { pid: transport.pid }); }
        catch (error) { event('mcp.connect.END', { pid: transport.pid,
          errorName: (error as Error)?.name }); throw error; }
        cancelled();
        return connected;
      };
      const call = async (name: string, scope: { workspaceId: string; collaborationId: string },
        payload: unknown, idempotencyKey?: string) => {
        beginWork(`mcp.call.${name}`);
        assert.ok(client);
        const response = await client.callTool({ name, arguments: { scope, payload,
          ...(idempotencyKey ? { idempotencyKey } : {}) } });
        event(`mcp.call.${name}.END`, { isError: response.isError === true });
        cancelled();
        assert.equal(response.isError, undefined, `${name}: ${JSON.stringify(response.content)}`);
        return JSON.parse((response.content[0] as { text: string }).text) as Record<string, unknown>;
      };

      const initialized = cli('init');
      const principal = initialized.principal as string;
      assert.equal(initialized.initialized, true);
      beginWork('cli.request.overlapping-workspace');
      const overlapping = spawnSync(process.execPath, [installedCli, '--data-dir', data, 'request'],
        { cwd: temporary, encoding: 'utf8', timeout: 15_000, input: JSON.stringify({
          operation: 'admin.register_workspace', scope: { workspaceId: 'management' },
          idempotencyKey: 'overlapping-workspace', payload: { name: 'Unsafe', root: temporary },
        }) });
      event('cli.request.overlapping-workspace.END', { pid: overlapping.pid, status: overlapping.status,
        signal: overlapping.signal, errorCode: (overlapping.error as NodeJS.ErrnoException | undefined)?.code });
      cancelled(); assert.equal(overlapping.status, 1);
      const workspaceId = request('admin.register_workspace', 'management', undefined,
        { name: 'Synthetic installed fixture', root: source }, 'workspace').id as string;
      beginWork('cli.request.overlapping-copy');
      const overlappingCopy = spawnSync(process.execPath, [installedCli, '--data-dir', data, 'request'],
        { cwd: temporary, encoding: 'utf8', timeout: 15_000, input: JSON.stringify({
          operation: 'admin.register_working_copy', scope: { workspaceId: 'management' },
          idempotencyKey: 'overlapping-copy', payload: { workspaceId, root: data },
        }) });
      event('cli.request.overlapping-copy.END', { pid: overlappingCopy.pid, status: overlappingCopy.status,
        signal: overlappingCopy.signal, errorCode: (overlappingCopy.error as NodeJS.ErrnoException | undefined)?.code });
      cancelled(); assert.equal(overlappingCopy.status, 1);
      const workingCopyId = request('admin.register_working_copy', 'management', undefined,
        { workspaceId, root: source }, 'copy').id as string;
      const localGrant = ['collab.create', 'collab.read', 'snapshot.create', 'context.propose',
        'context.read', 'context.accept', 'decision.record', 'artifact.submit', 'artifact.collect',
        'artifact.read', 'artifact.export'];
      request('admin.grant', 'management', undefined, { principal, audience: 'local-os',
        recipient: principal, workspaceId, permissions: localGrant, expiresAt: null }, 'local-grant');
      const collaborationId = request('collab.open', workspaceId, undefined,
        { purpose: 'Review synthetic flow' }, 'issue').id as string;
      const scope = { workspaceId, collaborationId };
      const snapshotId = request('snapshot.capture', workspaceId, collaborationId,
        { workingCopyId }, 'snapshot').snapshotId as string;
      assert.ok(snapshotId);
      request('context.propose', workspaceId, collaborationId, { proposalId: 'proposal-v1',
        parentRevisionId: null, snapshotId, sourceRefs: ['local-fixture'], content: {
          goal: 'Review synthetic flow', constraints: ['Read src/flow.ts only'],
          acceptedDecisions: [], rejectedDecisions: [], currentQuestions: ['What does flow return?'],
          evidenceRefs: [], expectedDeliverables: ['report.md', 'details/summary.json'],
          unknowns: [], recentChanges: [],
        } }, 'proposal');
      const revisionId = request('context.accept', workspaceId, collaborationId,
        { proposalId: 'proposal-v1', revisionId: 'context-v1' }, 'accept').id as string;
      assert.equal(revisionId, 'context-v1');

      const external = { principal: 'synthetic-reviewer', audience: 'local-stdio-fixture',
        recipient: 'synthetic-reviewer', workspaceId, collaborationId,
        permissions: ['collab.read', 'context.read', 'data.read', 'artifact.submit', 'artifact.read'],
        dataPaths: ['src/flow.ts'], expiresAt: null };
      request('admin.grant', 'management', undefined, external, 'external-grant');
      const visibleOperations = ['collab.get', 'context.read', 'repo.read', 'artifact.begin',
        'artifact.put_text', 'artifact.status', 'artifact.finalize'];
      cli('configure-mcp', { principal: external.principal, audience: external.audience,
        recipient: external.recipient, workspaceId, collaborationId, visibleOperations });
      client = await openMcp();
      beginWork('mcp.call.listTools');
      const listedTools = await client.listTools();
      event('mcp.call.listTools.END'); cancelled();
      assert.deepEqual(listedTools.tools.map(tool => tool.name).sort(), [...visibleOperations].sort());
      assert.equal((await call('collab.get', scope, {})).id, collaborationId);
      assert.equal((await call('context.read', scope, {})).id, revisionId);
      const reading = await call('repo.read', scope, { workingCopyId, snapshotId, path: 'src/flow.ts' });
      assert.match(reading.content as string, /SYNTHETIC_FLOW_A/);
      beginWork('mcp.call.repo.read.forbidden');
      const forbidden = await client.callTool({ name: 'repo.read', arguments: { scope,
        payload: { workingCopyId, snapshotId, path: 'src/hidden.ts' } } });
      event('mcp.call.repo.read.forbidden.END', { isError: forbidden.isError === true }); cancelled();
      assert.equal(forbidden.isError, true);
      assert.doesNotMatch(JSON.stringify(forbidden), /SYNTHETIC_NOT_DISCLOSED/);

      const bundleId = 'bundle-v1';
      await call('artifact.begin', scope, { bundleId, contextRevision: revisionId,
        snapshotRefs: [snapshotId], expectedPaths: ['report.md', 'details/summary.json'] }, 'begin');
      await call('artifact.put_text', scope, { bundleId, path: 'report.md',
        text: '# Synthetic review\nThe flow returns SYNTHETIC_FLOW_A.\n',
        mediaType: 'text/markdown' }, 'report');
      const staged = await call('artifact.status', scope, { bundleId });
      assert.equal(staged.state, 'staging');
      assert.deepEqual(staged.missingPaths, ['details/summary.json']);
      await call('artifact.put_text', scope, { bundleId, path: 'details/summary.json',
        text: '{"answer":"SYNTHETIC_FLOW_A"}\n', mediaType: 'application/json' }, 'summary');
      const manifest = await call('artifact.finalize', scope, { bundleId }, 'publish');
      assert.equal((manifest.files as unknown[]).length, 2);
      const manifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
      event('mcp.close.BEGIN'); await client.close();
      assert.ok(mcpClosed);
      await waitForMcpExit(mcpClosed); event('mcp.close.END');
      client = undefined;
      mcpClosed = undefined;

      // New installed processes reopen the same private user data after the original MCP process exits.
      client = await openMcp();
      const published = await call('artifact.status', scope, { bundleId });
      assert.equal(published.state, 'published');
      assert.equal(published.integrityStatus, 'ok');
      assert.equal((published.files as unknown[]).length, 2);
      assert.equal((await call('context.read', scope, {})).id, revisionId);
      const review = request('decision.review', workspaceId, collaborationId,
        { reviewId: 'review-v1', bundleId, bundleManifestHash: manifestHash,
          snapshotId, contextRevisionId: revisionId }, 'review');
      const decisionInput = { decisionId: 'decision-v1', bundleId,
        bundleManifestHash: manifestHash, snapshotId, contextRevisionId: revisionId,
        reviewId: review.id, outcome: 'accept', reason: 'Synthetic baseline reviewed locally' };
      const decision = request('decision.record', workspaceId, collaborationId, decisionInput, 'decision');
      assert.equal(decision.implementationAuthorized, false);
      assert.deepEqual(request('decision.record', workspaceId, collaborationId, decisionInput, 'decision'), decision);

      const localBundle = 'local-binary-v1';
      request('artifact.begin', workspaceId, collaborationId, { bundleId: localBundle,
        contextRevision: revisionId, snapshotRefs: [snapshotId], expectedPaths: ['assets/raw.bin', 'assets/archive.zip'] }, 'local-begin');
      const selected = join(temporary, 'selected.bin');
      const original = Buffer.from([0, 255, 19, 128]);
      writeFileSync(selected, original);
      const localCommand = { operation: 'artifact.collect_local', scope,
        payload: { bundleId: localBundle, path: 'assets/raw.bin', mediaType: 'application/octet-stream' }, idempotencyKey: 'local-collect' };
      beginWork('cli.request.collect-local-direct');
      const direct = spawnSync(process.execPath, [installedCli, '--data-dir', data, 'request'],
        { cwd: temporary, encoding: 'utf8', timeout: 15_000, input: JSON.stringify(localCommand) });
      event('cli.request.collect-local-direct.END', { pid: direct.pid, status: direct.status,
        signal: direct.signal, errorCode: (direct.error as NodeJS.ErrnoException | undefined)?.code });
      cancelled(); assert.equal(direct.status, 1);
      const collect = () => JSON.parse(processRun(process.execPath,
        [installedCli, '--data-dir', data, 'collect-local', selected], temporary, localCommand)) as Record<string, unknown>;
      assert.equal(collect().sourceReceipt, 'manual_import');
      assert.equal(collect().sha256, createHash('sha256').update(original).digest('hex'));
      const selectedZip = join(temporary, 'selected.zip');
      const originalZip = emptyZip(); writeFileSync(selectedZip, originalZip);
      const zipCommand = { ...localCommand, idempotencyKey: 'local-zip',
        payload: { bundleId: localBundle, path: 'assets/archive.zip', mediaType: 'application/zip' } };
      const zipReceipt = JSON.parse(processRun(process.execPath,
        [installedCli, '--data-dir', data, 'collect-local', selectedZip], temporary, zipCommand)) as Record<string, unknown>;
      assert.equal(zipReceipt.sha256, createHash('sha256').update(originalZip).digest('hex'));
      const localManifest = request('artifact.finalize', workspaceId, collaborationId,
        { bundleId: localBundle }, 'local-finalize');
      const localHash = createHash('sha256').update(JSON.stringify(localManifest)).digest('hex');
      const exported = request('artifact.export', workspaceId, collaborationId,
        { bundleId: localBundle, expectedManifestHash: localHash, exportName: 'binary-review' }, 'local-export');
      assert.deepEqual(readFileSync(join(exported.path as string, 'assets', 'raw.bin')), original);
      assert.deepEqual(readFileSync(join(exported.path as string, 'assets', 'archive.zip')), originalZip);
      assert.deepEqual(request('artifact.export', workspaceId, collaborationId,
        { bundleId: localBundle, expectedManifestHash: localHash, exportName: 'binary-review' }, 'local-export'), exported);
      const evidenceRoot = join(temporary, 'evidence-repo');
      mkdirSync(join(evidenceRoot, 'verification'), { recursive: true });
      writeFileSync(join(evidenceRoot, 'verification', 'RUNTIME_ACCEPTANCE.json'), '{}');
      const archiveInput = { runId: 'LIVE01', role: 'v1', scope, bundleId: localBundle };
      const archive = (input: typeof archiveInput = archiveInput) => JSON.parse(processRun(process.execPath,
        [installedArchiver, '--data-dir', data, '--cli', installedCli,
          '--evidence-root', evidenceRoot], temporary, input, 'archive.cli')) as {
        role: string; manifest_ref: string; manifest_hash: string;
        file_refs: Array<{ normalized_relative_path: string; evidence_ref: string }>
      };
      const archived = archive();
      assert.equal(archived.role, 'v1');
      assert.equal(archived.manifest_hash, localHash);
      assert.deepEqual(archive(), archived);
      const exportCount = readdirSync(join(data, 'exports')).length;
      assert.deepEqual(archive({ ...archiveInput,
        scope: { collaborationId, workspaceId } }), archived);
      assert.equal(readdirSync(join(data, 'exports')).length, exportCount);
      const parallelInput = { ...archiveInput, role: 'v2' };
      const runConcurrent = () => new Promise<ReturnType<typeof archive>>((fulfill, reject) => {
        try { beginWork('archive.spawn'); } catch (error) { reject(error); return; }
        const child = spawn(process.execPath,
          [installedArchiver, '--data-dir', data, '--cli', installedCli,
            '--evidence-root', evidenceRoot], { cwd: temporary, stdio: ['pipe', 'pipe', 'pipe'] });
        event('archive.spawn.END', { pid: child.pid });
        let output = '', errorOutput = '', childError: Error | undefined;
        let timedOut = false, settled = false;
        const softDeadline = setTimeout(() => {
          timedOut = true;
          archiveChildrenConfirmed = false;
          child.kill();
        }, 90_000);
        const forceDeadline = setTimeout(() => { if (timedOut) child.kill('SIGKILL'); }, 93_000);
        const terminalDeadline = setTimeout(() => {
          if (settled) return;
          settled = true;
          archiveChildrenConfirmed = false;
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
          reject(new Error('Concurrent archive child terminal unconfirmed'));
        }, 95_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          const next = output.length + chunk.length;
          output = (output + chunk).slice(0, 1024 * 1024);
          if (next > 1024 * 1024 && !childError) {
            childError = new Error('Concurrent archive output exceeded 1 MiB');
            archiveChildrenConfirmed = false;
            child.kill();
          }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(0, 4096); });
        child.stdin.on('error', error => { childError = error; });
        child.on('error', error => { childError = error; });
        child.on('close', (code, childSignal) => {
          event('archive.close.END', { pid: child.pid, status: code, signal: childSignal,
            errorCode: (childError as NodeJS.ErrnoException | undefined)?.code });
          settled = true;
          clearTimeout(softDeadline); clearTimeout(forceDeadline); clearTimeout(terminalDeadline);
          if (timedOut) { reject(new Error('Concurrent archive child timed out')); return; }
          if (childError) { reject(childError); return; }
          if (code !== 0) { reject(new Error(`concurrent archive exited ${code}: ${errorOutput}`)); return; }
          try { fulfill(JSON.parse(output) as ReturnType<typeof archive>); }
          catch (error) { reject(error); }
        });
        try { child.stdin.end(JSON.stringify(parallelInput)); }
        catch (error) { childError = error as Error; archiveChildrenConfirmed = false; child.kill(); }
      });
      beginWork('archive.concurrent');
      const settled = await Promise.allSettled([runConcurrent(), runConcurrent()]);
      event('archive.concurrent.END'); cancelled();
      const failures = settled.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason),
        'Concurrent archive process failed');
      const parallel = settled.map(result => {
        assert.equal(result.status, 'fulfilled');
        return result.value;
      });
      assert.deepEqual(parallel[0], parallel[1]);
      assert.deepEqual(archive(parallelInput), parallel[0]);
      assert.deepEqual(readFileSync(join(evidenceRoot,
        ...archived.file_refs.find(file => file.normalized_relative_path === 'assets/raw.bin')!.evidence_ref.split('/'))), original);
      assert.deepEqual(readFileSync(join(evidenceRoot,
        ...archived.file_refs.find(file => file.normalized_relative_path === 'assets/archive.zip')!.evidence_ref.split('/'))), originalZip);
      assert.equal(JSON.parse(readFileSync(join(evidenceRoot,
        ...archived.manifest_ref.split('/')), 'utf8')).files[0].sourceReceipt, 'manual_import');
      const archivedRaw = join(evidenceRoot,
        ...archived.file_refs.find(file => file.normalized_relative_path === 'assets/raw.bin')!.evidence_ref.split('/'));
      writeFileSync(archivedRaw, 'tampered evidence');
      beginWork('archive.refused-overwrite');
      const refusedOverwrite = spawnSync(process.execPath,
        [installedArchiver, '--data-dir', data, '--cli', installedCli,
          '--evidence-root', evidenceRoot],
        { cwd: temporary, encoding: 'utf8', input: JSON.stringify(archiveInput), timeout: 60_000 });
      event('archive.refused-overwrite.END', { pid: refusedOverwrite.pid, status: refusedOverwrite.status,
        signal: refusedOverwrite.signal, errorCode: (refusedOverwrite.error as NodeJS.ErrnoException | undefined)?.code });
      cancelled(); assert.equal(refusedOverwrite.status, 1);
      assert.equal(readFileSync(archivedRaw, 'utf8'), 'tampered evidence');
      const localReview = request('decision.review', workspaceId, collaborationId,
        { reviewId: 'local-review', bundleId: localBundle, bundleManifestHash: localHash,
          snapshotId, contextRevisionId: revisionId }, 'local-review');
      const localDecision = request('decision.record', workspaceId, collaborationId,
        { decisionId: 'local-decision', bundleId: localBundle, bundleManifestHash: localHash,
          snapshotId, contextRevisionId: revisionId, reviewId: localReview.id,
          outcome: 'accept', reason: 'Synthetic binary and ZIP reviewed locally' }, 'local-decision');
      assert.equal(localDecision.implementationAuthorized, false);

      // A configured grant does not turn the current product into a running investigator.
      // The production composition refuses submission until an isolation profile is verified.
      request('admin.grant', 'management', undefined, { principal, audience: 'local-os',
        recipient: principal, workspaceId, collaborationId, permissions: ['investigation.request'],
        expiresAt: null }, 'investigation-grant');
      request('admin.grant', 'management', undefined, { principal, audience: 'local-os',
        recipient: principal, workspaceId, collaborationId, permissions: ['data.read'],
        dataPaths: ['src/flow.ts'], expiresAt: null }, 'investigation-read-grant');
      beginWork('cli.request.investigate-submit');
      const unsupported = spawnSync(process.execPath, [installedCli, '--data-dir', data, 'request'],
        { cwd: temporary, encoding: 'utf8', timeout: 15_000, input: JSON.stringify({
          operation: 'investigate.submit', scope,
          payload: { workingCopyId, input: { contextRevisionId: revisionId, snapshotRef: snapshotId,
            question: 'Trace the synthetic flow', scope: { paths: ['src/flow.ts'], symbols: ['flow'], relatedTests: [] },
            requestedOutputs: ['flow'], parentInvestigationId: null } }, idempotencyKey: 'investigate',
        }) });
      event('cli.request.investigate-submit.END', { pid: unsupported.pid, status: unsupported.status,
        signal: unsupported.signal, errorCode: (unsupported.error as NodeJS.ErrnoException | undefined)?.code });
      cancelled(); assert.equal(unsupported.status, 1);
      assert.match(unsupported.stderr, /"code":"ERROR"/);

      // The same packed version must reopen the unchanged private data after an actual local uninstall.
      assert.ok(client);
      event('mcp.close.BEGIN'); await client.close();
      assert.ok(mcpClosed);
      await waitForMcpExit(mcpClosed); event('mcp.close.END');
      client = undefined;
      mcpClosed = undefined;
      assert.ok(archiveChildrenConfirmed);
      const digests = [...new Set([manifestHash, localHash,
        ...(manifest.files as Array<{ sha256: string }>).map(file => file.sha256),
        ...(localManifest.files as Array<{ sha256: string }>).map(file => file.sha256)])].sort();
      for (const digest of digests) assert.match(digest, /^[a-f0-9]{64}$/);
      const objectPath = (digest: string) => join(data, 'artifact-objects', 'objects', digest.slice(0, 2), digest);
      const sqliteSidecars = ['state.sqlite-wal', 'state.sqlite-shm', 'state.sqlite-journal']
        .map(name => join(data, name));
      const presentSidecars = sqliteSidecars.filter(path => existsSync(path));
      const absentSidecars = sqliteSidecars.filter(path => !existsSync(path));
      const persistedPaths = [join(data, 'state.sqlite'), ...presentSidecars,
        join(data, 'mcp-binding.json'), ...digests.map(objectPath)];
      const persistedBytes = persistedPaths.map(path => readFileSync(path));
      const assertPersistedBytes = () => {
        persistedPaths.forEach((path, index) =>
          assert.equal(readFileSync(path).equals(persistedBytes[index]!), true,
            `Uninstall or reinstall changed persisted fixture file ${index}`));
        absentSidecars.forEach((path, index) =>
          assert.equal(existsSync(path), false, `Uninstall or reinstall created SQLite sidecar ${index}`));
      };
      processRun(process.execPath, [npmCli, 'uninstall', '--offline', '--prefix', install,
        '--ignore-scripts', '--no-audit', '--no-fund', 'repo-conduit'], repositoryRoot, undefined, 'uninstall');
      assert.equal(existsSync(installedCli), false);
      assert.equal(existsSync(installedArchiver), false);
      assertPersistedBytes();
      processRun(process.execPath, [npmCli, 'install', '--offline', '--prefix', install, '--ignore-scripts',
        '--no-audit', '--no-fund', packageArchive], repositoryRoot, undefined, 'reinstall');
      assert.ok(existsSync(installedCli));
      assert.ok(existsSync(installedArchiver));
      assertPersistedBytes();
      const originalInspection = request('artifact.inspect', workspaceId, collaborationId, { bundleId });
      assert.equal(originalInspection.manifestHash, manifestHash);
      assert.equal(originalInspection.integrityStatus, 'ok');
      assert.equal(originalInspection.ready, true);
      assert.deepEqual(originalInspection.manifest, manifest);
      const localInspection = request('artifact.inspect', workspaceId, collaborationId,
        { bundleId: localBundle });
      assert.equal(localInspection.manifestHash, localHash);
      assert.equal(localInspection.integrityStatus, 'ok');
      assert.equal(localInspection.ready, true);
      assert.deepEqual(localInspection.manifest, localManifest);
      assert.deepEqual(request('decision.get', workspaceId, collaborationId,
        { decisionId: 'local-decision' }), localDecision);
      const rawDigest = (localManifest.files as Array<{ normalizedRelativePath: string; sha256: string }>)
        .find(file => file.normalizedRelativePath === 'assets/raw.bin')!.sha256;
      const zipDigest = (localManifest.files as Array<{ normalizedRelativePath: string; sha256: string }>)
        .find(file => file.normalizedRelativePath === 'assets/archive.zip')!.sha256;
      assert.deepEqual(readFileSync(objectPath(rawDigest)), original);
      assert.deepEqual(readFileSync(objectPath(zipDigest)), originalZip);
    } catch (error) {
      primaryError = error;
      event('failure', { currentStage: stage, errorName: (error as Error)?.name,
        errorCode: (error as NodeJS.ErrnoException)?.code,
        ...(signal?.aborted ? abortDetails() : { failureType: 'primary' }) });
      // The full-suite runner may stop before the reporter's final error summary.
      reportFixtureFailure('primary', error);
    }
    finally {
      event('finally.BEGIN', { aborted: signal?.aborted === true });
      try {
        if (client) {
          event('mcp.close.BEGIN');
          await client.close();
          assert.ok(mcpClosed);
          await waitForMcpExit(mcpClosed);
          event('mcp.close.END');
        }
        assert.ok(archiveChildrenConfirmed, 'archive child or descendant termination is unconfirmed; fixture retained');
        const child = relative(resolve(fixtureRoot), resolve(temporary));
        assert.ok(child.startsWith('rcac-local-installed-') && !child.includes('..') && !child.includes('\\'));
        if (primaryError === undefined && !signal?.aborted && archiveChildrenConfirmed && !diagnosticFailed) {
          event('cleanup.BEGIN');
          if (!signal?.aborted && !diagnosticFailed) {
            rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
            fixtureRemoved = true;
            event('cleanup.END');
          } else { event('cleanup.RETAINED'); console.error('retained-installed-fixture', temporary); }
        } else { event('cleanup.RETAINED', { aborted: signal?.aborted === true,
          archiveChildrenConfirmed, diagnosticFailed }); console.error('retained-installed-fixture', temporary); }
      } catch (error) {
        cleanupError = error;
        event('cleanup.FAILURE', { errorName: (error as Error)?.name,
          errorCode: (error as NodeJS.ErrnoException)?.code });
        reportFixtureFailure('cleanup', error);
      }
      event('finally.END', { fixtureRemoved, diagnosticFailed });
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted && primaryError === undefined && cleanupError === undefined) {
      const error = new Error('Installed fixture cancelled'); error.name = 'AbortError'; throw error;
    }
    if (diagnosticFailed && primaryError === undefined && cleanupError === undefined)
      throw new Error(fixtureRemoved
        ? 'Installed fixture diagnostics failed; retention unavailable after completed cleanup'
        : 'Installed fixture diagnostics failed; fixture retained');
    if (primaryError !== undefined && cleanupError !== undefined) throw new AggregateError(
      [primaryError, cleanupError], 'Installed E2E failed and fixture cleanup also failed',
      { cause: primaryError });
    if (primaryError !== undefined) throw primaryError;
    if (cleanupError !== undefined) throw cleanupError;
}

// Whole-fixture composition includes build/pack/install and serial CLI/MCP work.
// Individual subprocess, permission-helper and cancellation deadlines are unchanged.
const installedRoundTripTimeoutMs = 480_000;
test('packed CLI and MCP SDK preserve a disclosed snapshot, bundle, and local decision across restart',
  { timeout: installedRoundTripTimeoutMs }, context => installedRoundTrip(undefined, context.signal));

// Explicit diagnostic variant; the normal test above always keeps its build/pack coverage.
test('retained package CLI and MCP SDK preserve a disclosed snapshot, bundle, and local decision across restart',
  { timeout: installedRoundTripTimeoutMs, skip: process.env.RCAC_TEST_INSTALLED_ARCHIVE === undefined &&
    'requires an explicitly selected retained package for installation diagnosis' },
  context => installedRoundTrip(process.env.RCAC_TEST_INSTALLED_ARCHIVE, context.signal));
