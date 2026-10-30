import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';

test('OAuth CLI saves one private operator configuration and serves loopback until stopped', async () => {
  const base = process.platform === 'win32' ? homedir() : tmpdir();
  const fixture = mkdtempSync(join(base, 'rcac-oauth-cli-'));
  const data = join(fixture, 'data');
  const workspaceRoot = join(fixture, 'workspace');
  mkdirSync(workspaceRoot);
  const cli = resolve('src/cli/main.ts');
  const run = (action: string, input?: unknown) => spawnSync(process.execPath,
    ['--import', 'tsx', cli, '--data-dir', data, action],
    { cwd: resolve('.'), input: input === undefined ? undefined : JSON.stringify(input),
      encoding: 'utf8', timeout: 20_000 });
  const runArgs = (...trailing: string[]) => spawnSync(process.execPath,
    ['--import', 'tsx', cli, '--data-dir', data, ...trailing],
    { cwd: resolve('.'), encoding: 'utf8', timeout: 20_000 });
  const password = 'A-unique-fixture-password-12345!';
  try {
    const initialized = run('init');
    assert.equal(initialized.status, 0);
    const localPrincipal = (JSON.parse(initialized.stdout) as { principal: string }).principal;
    const registered = run('request', { operation: 'admin.register_workspace',
      scope: { workspaceId: 'management' }, idempotencyKey: 'oauth-register',
      payload: { name: 'Fixture', root: workspaceRoot } });
    assert.equal(registered.status, 0, registered.stderr);
    const workspaceId = (JSON.parse(registered.stdout) as { id: string }).id;
    const resource = 'https://mcp.example.test/api/mcp';
    const issuer = 'https://issuer.example.test';
    const clientId = 'chatgpt-client';
    const principal = 'external-fixture';
    const grant = run('request', { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'oauth-grant', payload: { principal, audience: resource, recipient: clientId,
        workspaceId, permissions: ['collab.create', 'collab.read'], expiresAt: null } });
    assert.equal(grant.status, 0, grant.stderr);
    const localGrant = run('request', { operation: 'admin.grant', scope: { workspaceId: 'management' },
      idempotencyKey: 'oauth-local-grant', payload: { principal: localPrincipal,
        audience: 'local-os', recipient: localPrincipal, workspaceId,
        permissions: ['collab.create'], expiresAt: null } });
    assert.equal(localGrant.status, 0, localGrant.stderr);
    const opened = run('request', { operation: 'collab.open', scope: { workspaceId },
      idempotencyKey: 'oauth-existing-collab', payload: { purpose: 'fixed scope test' } });
    assert.equal(opened.status, 0, opened.stderr);
    const collaborationId = (JSON.parse(opened.stdout) as { id: string }).id;
    const config = { issuer, resource, clientId,
      redirectUris: ['https://chatgpt.example.test/callback'], scopes: ['collab.read'],
      operator: { subject: 'operator-1', password },
      binding: { issuer, clientId, subject: 'operator-1', principal, recipient: clientId, workspaceId,
        scopes: { 'collab.read': { delegatedPermissions: ['collab.create', 'collab.read'],
          visibleOperations: ['collab.open', 'collab.get'] } } } };
    const malformed = run('configure-oauth', { ...config, issuer: 'http://issuer.example.test' });
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stderr.includes(password), false);
    for (const bad of [
      'http://mcp.example.test/api/mcp',
      'https://user:pass@mcp.example.test/api/mcp',
      'https://mcp.example.test/api/mcp?token=secret',
      'https://mcp.example.test/api/mcp?',
      'https://mcp.example.test/api/mcp#fragment',
      'https://mcp.example.test/api/mcp#',
      'https://mcp.example.test/api/mcp/',
      'https://mcp.example.test/api/../mcp',
      'https://MCP.example.test/api/mcp',
      'https://mcp.example.test:443/api/mcp',
      'https://mcp.example.test/api/%zz',
      'https://mcp.example.test/%',
      'not a url',
    ]) {
      assert.equal(run('configure-oauth', { ...config, resource: bad }).status, 1,
        `rejected resource ${JSON.stringify(bad)}`);
    }
    assert.equal(run('configure-oauth', { ...config,
      issuer: 'https://issuer.example.test/issuer',
      binding: { ...config.binding, issuer: 'https://issuer.example.test/issuer' } }).status, 1);
    const untypeable = run('configure-oauth', { ...config,
      operator: { ...config.operator, password: '中'.repeat(1024) } });
    assert.equal(untypeable.status, 1);
    assert.equal(existsSync(join(data, 'oauth-config.json')), false);
    const unauthorized = run('configure-oauth', { ...config,
      binding: { ...config.binding, workspaceId: 'missing-workspace' } });
    assert.equal(unauthorized.status, 1);
    const impossibleBoundTool = run('configure-oauth', { ...config,
      binding: { ...config.binding, collaborationId } });
    assert.equal(impossibleBoundTool.status, 1);
    const impossibleBoundList = run('configure-oauth', { ...config,
      binding: { ...config.binding, collaborationId,
        scopes: { 'collab.read': { delegatedPermissions: ['collab.read'],
          visibleOperations: ['collab.list'] } } } });
    assert.equal(impossibleBoundList.status, 1);
    assert.equal(existsSync(join(data, 'oauth-config.json')), false);
    const configured = run('configure-oauth', config);
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(configured.stdout.includes(password), false);
    const path = join(data, 'oauth-config.json');
    assert.equal(lstatSync(path).isFile(), true);
    const saved = readFileSync(path, 'utf8');
    assert.equal(saved.includes(password), false);
    assert.equal(saved.includes('hashHex'), true);
    assert.equal((JSON.parse(saved) as { issuer: { resource: string } }).issuer.resource, resource);
    const original = JSON.parse(saved) as { issuer: { jwks: unknown; cookieKeys: unknown }; bindings: unknown;
      allowedFileOrigins?: string[] };
    assert.deepEqual(original.allowedFileOrigins, []);
    const update = (allowedFileOrigins: unknown, expectedAllowedFileOrigins: unknown = []) =>
      run('configure-file-origins', { allowedFileOrigins, expectedAllowedFileOrigins });
    for (const bad of ['https://files.example.test/', 'https://files.example.test/a/..',
      'https://FILES.example.test', 'https://files.example.test:443', 'http://files.example.test']) {
      assert.equal(update([bad]).status, 1);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original);
    }
    assert.equal(run('configure-file-origins', { allowedFileOrigins: ['https://files.example.test'],
      expectedAllowedFileOrigins: [], password }).status, 1);
    const updated = update(['https://files.example.test']);
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(JSON.parse(updated.stdout).restartRequired, true);
    assert.equal(updated.stdout.includes(password), false);
    const afterUpdate = JSON.parse(readFileSync(path, 'utf8')) as typeof original;
    assert.deepEqual(afterUpdate.allowedFileOrigins, ['https://files.example.test']);
    assert.deepEqual(afterUpdate.issuer, original.issuer);
    assert.deepEqual(afterUpdate.bindings, original.bindings);
    assert.equal(update([], []).status, 1, 'stale expected origins must conflict');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), afterUpdate);
    const disabled = update([], ['https://files.example.test']);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.deepEqual((JSON.parse(readFileSync(path, 'utf8')) as typeof original).allowedFileOrigins, []);
    const legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete legacy.allowedFileOrigins;
    writeFileSync(path, JSON.stringify(legacy));
    const upgraded = update(['https://files.example.test']);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.deepEqual((JSON.parse(readFileSync(path, 'utf8')) as typeof original).allowedFileOrigins,
      ['https://files.example.test']);
    const validConfig = readFileSync(path, 'utf8');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(validConfig) as object, allowedFileOrigins: null }));
    const rejectedSaved = readFileSync(path, 'utf8');
    assert.equal(update([], ['https://files.example.test']).status, 1);
    assert.equal(readFileSync(path, 'utf8'), rejectedSaved);
    writeFileSync(path, validConfig);
    if (process.platform !== 'win32') assert.equal(lstatSync(path).mode & 0o077, 0);
    const duplicate = run('configure-oauth', config);
    assert.equal(duplicate.status, 1);
    assert.equal(duplicate.stderr.includes(password), false);
    for (const bad of ['0', '-1', '65536', '1.5', 'abc', '80abc', ' 80', '+80', '01', '']) {
      assert.equal(runArgs('serve-http', '--issuer-port', bad).status, 1, `rejected port ${JSON.stringify(bad)}`);
    }
    assert.equal(runArgs('serve-http', '--issuer-port').status, 1);
    assert.equal(runArgs('serve-http', '--issuer-port', '80', 'unexpected').status, 1);
    for (const bad of ['0', '-1', '65536', '1.5', 'abc', '01', '']) {
      assert.equal(runArgs('serve-http', '--mcp-port', bad).status, 1, `rejected MCP port ${JSON.stringify(bad)}`);
    }
    assert.equal(runArgs('serve-http', '--mcp-port').status, 1);
    assert.equal(runArgs('serve-http', '--mcp-port', '80', '--mcp-port', '81').status, 1);
    assert.equal(runArgs('request', '--issuer-port', '8080').status, 1);
    assert.equal(runArgs('request', '--mcp-port', '8080').status, 1);
    assert.equal(runArgs('init', '--issuer-port', '8080').status, 1);
    assert.equal(readFileSync(path, 'utf8'), validConfig);
    const child = spawn(process.execPath, ['--import', 'tsx', cli, '--data-dir', data, 'serve-http'],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const line = await new Promise<string>((done, reject) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`HTTP CLI startup timed out: ${stderr}`)), 15_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('\n')) { clearTimeout(timer); done(stdout.split('\n')[0]!); }
        });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`HTTP CLI exited ${code}: ${stderr}`)); });
      });
      assert.equal(line.includes(password), false);
      const listening = JSON.parse(line) as { issuerUrl: string; mcpUrl: string };
      assert.match(listening.issuerUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(listening.mcpUrl, /^http:\/\/127\.0\.0\.1:\d+\//);
      assert.equal((await fetch(`${listening.issuerUrl}/.well-known/oauth-authorization-server`)).status, 200);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((done) => child.once('exit', () => done()));
      }
    }
    const freePort = await new Promise<number>((done, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (!address || typeof address === 'string') { probe.close(); reject(new Error('No numeric port')); return; }
        probe.close(error => error ? reject(error) : done(address.port));
      });
    });
    const fixed = spawn(process.execPath,
      ['--import', 'tsx', cli, '--data-dir', data, 'serve-http', '--issuer-port', String(freePort)],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const line = await new Promise<string>((done, reject) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`Fixed issuer startup timed out: ${stderr}`)), 15_000);
        fixed.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('\n')) { clearTimeout(timer); done(stdout.split('\n')[0]!); }
        });
        fixed.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        fixed.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixed issuer exited ${code}: ${stderr}`)); });
      });
      const listening = JSON.parse(line) as { issuerUrl: string; mcpUrl: string };
      assert.equal(listening.issuerUrl, `http://127.0.0.1:${freePort}`);
      assert.match(listening.mcpUrl, /^http:\/\/127\.0\.0\.1:\d+\//);
      assert.equal((await fetch(`${listening.issuerUrl}/.well-known/oauth-authorization-server`)).status, 200);
      assert.equal(readFileSync(path, 'utf8'), validConfig, 'startup port must not persist');
    } finally {
      if (fixed.exitCode === null && fixed.signalCode === null) {
        fixed.kill('SIGTERM');
        await new Promise<void>(done => fixed.once('exit', () => done()));
      }
    }
    const fixedMcp = spawn(process.execPath,
      ['--import', 'tsx', cli, '--data-dir', data, 'serve-http', '--mcp-port', String(freePort)],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const line = await new Promise<string>((done, reject) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`Fixed MCP startup timed out: ${stderr}`)), 15_000);
        fixedMcp.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('\n')) { clearTimeout(timer); done(stdout.split('\n')[0]!); }
        });
        fixedMcp.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        fixedMcp.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixed MCP exited ${code}: ${stderr}`)); });
      });
      const listening = JSON.parse(line) as { issuerUrl: string; mcpUrl: string };
      assert.equal(listening.mcpUrl, `http://127.0.0.1:${freePort}/mcp`);
      assert.match(listening.issuerUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal((await fetch(`${listening.issuerUrl}/.well-known/oauth-authorization-server`)).status, 200);
      assert.equal(readFileSync(path, 'utf8'), validConfig, 'MCP startup port must not persist');
    } finally {
      if (fixedMcp.exitCode === null && fixedMcp.signalCode === null) {
        fixedMcp.kill('SIGTERM');
        await new Promise<void>(done => fixedMcp.once('exit', () => done()));
      }
    }
    const reservedMcp = createServer();
    await new Promise<void>((done, reject) => {
      reservedMcp.once('error', reject);
      reservedMcp.listen(freePort, '127.0.0.1', done);
    });
    const secondPort = await new Promise<number>((done, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (!address || typeof address === 'string') { probe.close(); reject(new Error('No numeric port')); return; }
        probe.close(error => error ? reject(error) : done(address.port));
      });
    });
    const occupied = runArgs('serve-http', '--issuer-port', String(secondPort), '--mcp-port', String(freePort));
    assert.equal(occupied.status, 1, 'occupied MCP port must fail startup');
    assert.equal(occupied.stdout, '', 'no ready URLs may be published on partial startup');
    const releasedIssuer = createServer();
    await new Promise<void>((done, reject) => {
      releasedIssuer.once('error', reject);
      releasedIssuer.listen(secondPort, '127.0.0.1', done);
    });
    await new Promise<void>((done, reject) => releasedIssuer.close(error => error ? reject(error) : done()));
    await new Promise<void>((done, reject) => reservedMcp.close(error => error ? reject(error) : done()));
    const dual = spawn(process.execPath,
      ['--import', 'tsx', cli, '--data-dir', data, 'serve-http',
        '--issuer-port', String(secondPort), '--mcp-port', String(freePort)],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const line = await new Promise<string>((done, reject) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`Dual fixed startup timed out: ${stderr}`)), 15_000);
        dual.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('\n')) { clearTimeout(timer); done(stdout.split('\n')[0]!); }
        });
        dual.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        dual.once('exit', code => { clearTimeout(timer); reject(new Error(`Dual fixed exited ${code}: ${stderr}`)); });
      });
      const listening = JSON.parse(line) as { issuerUrl: string; mcpUrl: string };
      assert.equal(listening.issuerUrl, `http://127.0.0.1:${secondPort}`);
      assert.equal(listening.mcpUrl, `http://127.0.0.1:${freePort}/mcp`);
    } finally {
      if (dual.exitCode === null && dual.signalCode === null) {
        dual.kill('SIGTERM');
        await new Promise<void>(done => dual.once('exit', () => done()));
      }
    }
    const staleLock = join(data, 'oauth-config.lock');
    const lockOwner = spawn(process.execPath, ['-e',
      "require('node:fs').openSync(process.argv[1], 'wx', 0o600); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)",
      staleLock], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((done, reject) => {
        lockOwner.stdout.once('data', () => done());
        lockOwner.once('exit', code => reject(new Error(`Lock owner exited ${code}`)));
      });
    } finally {
      lockOwner.kill('SIGKILL');
      await new Promise<void>(done => lockOwner.once('exit', () => done()));
    }
    assert.equal(existsSync(staleLock), true);
    const recovered = update([], ['https://files.example.test']);
    assert.equal(recovered.status, 0, 'killed former lock owner must not block updates');
    assert.equal(update(['https://files.example.test'], []).status, 0);
    const dbOwner = spawn(process.execPath, ['-e',
      "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); " +
      "db.exec('BEGIN IMMEDIATE'); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)",
      join(data, 'state.sqlite')], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((done, reject) => {
        dbOwner.stdout.once('data', () => done());
        dbOwner.once('exit', code => reject(new Error(`Database lock owner exited ${code}`)));
      });
      const competing = update([], ['https://files.example.test']);
      assert.equal(competing.status, 1);
      assert.equal((JSON.parse(competing.stderr.trim().split('\n').at(-1)!) as { code: string }).code, 'CONFLICT');
      assert.deepEqual((JSON.parse(readFileSync(path, 'utf8')) as typeof original).allowedFileOrigins,
        ['https://files.example.test']);
    } finally {
      dbOwner.kill('SIGKILL');
      await new Promise<void>(done => dbOwner.once('exit', () => done()));
    }
    assert.equal(update([], ['https://files.example.test']).status, 0,
      'SQLite process death releases the update lock');
    assert.equal(update(['https://files.example.test'], []).status, 0);
    const beforeRevocation = readFileSync(path, 'utf8');
    const store = new SqliteStore(join(data, 'state.sqlite'));
    try {
      const admin = store.grantsFor(localPrincipal, 'local-os').find(entry =>
        entry.workspaceId === 'management' && entry.permissions.includes('admin.grant'));
      assert.ok(admin);
      store.revokeGrant(admin.id, new Date().toISOString());
    } finally { store.close(); }
    assert.equal(update([], ['https://files.example.test']).status, 1);
    assert.equal(readFileSync(path, 'utf8'), beforeRevocation);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
