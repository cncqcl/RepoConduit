import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSnapshotFromFiles } from '../../src/adapters/repository/snapshots.js';
import { reconcileCreatedContainer, runStaticInvestigation, sandboxArgs } from '../../src/adapters/investigator/docker-worker.js';

const snapshot = createSnapshotFromFiles('copy-1', 'fixture', {
  'src/flow.ts': Buffer.from('export function processOrder() { return 42; }\n'),
  'src/other.ts': Buffer.from('no relevant symbol\n'),
});

test('sandbox creates an addressable container before starting it', () => {
  const args = sandboxArgs('owned-container', 'C:\\snapshot', `sha256:${'a'.repeat(64)}`, '/bin/grep', ['needle']);
  assert.equal(args[0], 'create');
  assert.deepEqual(args.slice(1, 3), ['--name', 'owned-container']);
  assert.ok(args.includes('--log-driver=none'));
});

test('static investigation rejects a mutable image reference and invalid scope', async () => {
  await assert.rejects(runStaticInvestigation({ snapshot, imageId: 'alpine:latest', paths: ['src/flow.ts'], patterns: ['processOrder'], maxWallSeconds: 5, maxOutputBytes: 4096 }, () => {}), /INVALID_ARGUMENT/);
  await assert.rejects(runStaticInvestigation({ snapshot, imageId: `sha256:${'a'.repeat(64)}`, paths: ['../secret'], patterns: ['processOrder'], maxWallSeconds: 5, maxOutputBytes: 4096 }, () => {}), /INVALID_ARGUMENT/);
  await assert.rejects(runStaticInvestigation({ snapshot, imageId: `sha256:${'a'.repeat(64)}`, paths: ['src/missing.ts'], patterns: ['processOrder'], maxWallSeconds: 5, maxOutputBytes: 4096 }, () => {}), /INVALID_ARGUMENT/);
});

test('worker requires a durable exact-ID recorder before materializing source bytes', async () => {
  let reserved = false;
  await assert.rejects(runStaticInvestigation({ snapshot, imageId: `sha256:${'a'.repeat(64)}`,
    paths: ['src/flow.ts'], patterns: ['processOrder'], maxWallSeconds: 5, maxOutputBytes: 4096 },
  () => { reserved = true; }), /INVALID_ARGUMENT/);
  assert.equal(reserved, false);
});

test('static investigation fails closed when image is unavailable', async () => {
  let name = '';
  let scratchRoot = '';
  try {
    await assert.rejects(runStaticInvestigation({ snapshot, imageId: `sha256:${'0'.repeat(64)}`, paths: ['src/flow.ts'], patterns: ['processOrder'], maxWallSeconds: 5, maxOutputBytes: 4096 },
      (candidate, root) => { name = candidate; scratchRoot = root; }, () => {}), error => {
      assert.match(String(error), /ISOLATION_TERMINATION_UNCONFIRMED/);
      assert.doesNotMatch(String(error), /C:\\Users\\|rcac-investigator-/);
      return true;
    });
    assert.equal(existsSync(join(scratchRoot, 'snapshot', 'src', 'flow.ts')), true,
      'unknown late create must retain its persisted mount until recovery');
  } finally {
    if (name && scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('durable name reservation precedes the first snapshot byte read', async () => {
  let reserved = false;
  let reads = 0;
  const observedSnapshot = createSnapshotFromFiles('copy-1', 'fixture', {
    'src/flow.ts': Buffer.from('export function processOrder() { return 42; }\n'),
  });
  const originalFile = observedSnapshot.file.bind(observedSnapshot);
  observedSnapshot.file = (path: string) => {
    assert.equal(reserved, true);
    reads++;
    return originalFile(path);
  };
  let name = '';
  let scratchRoot = '';
  await assert.rejects(runStaticInvestigation({ snapshot: observedSnapshot, imageId: `sha256:${'0'.repeat(64)}`,
    paths: ['src/flow.ts'], patterns: ['processOrder'], maxWallSeconds: 5, maxOutputBytes: 4096 },
  (candidate, root) => { name = candidate; scratchRoot = root; reserved = true; }, () => {}), /ISOLATION_TERMINATION_UNCONFIRMED/);
  assert.equal(reserved, true);
  assert.equal(reads, observedSnapshot.manifest.length);
  assert.match(name, /^rcac-investigator-/);
  rmSync(scratchRoot, { recursive: true, force: true });
});

test('static worker materializes only explicitly selected snapshot files', async () => {
  const scoped = createSnapshotFromFiles('copy-1', 'fixture', {
    'src/allowed.ts': Buffer.from('allowed marker\n'),
    'src/private.ts': Buffer.from('secret canary\n'),
  });
  const original = scoped.file.bind(scoped);
  const reads: string[] = [];
  scoped.file = (path: string) => {
    reads.push(path);
    if (path !== 'src/allowed.ts') throw new Error('UNAUTHORIZED_SNAPSHOT_READ');
    return original(path);
  };
  let name = '';
  let scratchRoot = '';
  try {
    await assert.rejects(runStaticInvestigation({ snapshot: scoped, imageId: `sha256:${'0'.repeat(64)}`,
      paths: ['src/allowed.ts'], patterns: ['marker'], maxWallSeconds: 5, maxOutputBytes: 4096 },
    (candidate, root) => { name = candidate; scratchRoot = root; }, () => {}), /ISOLATION_TERMINATION_UNCONFIRMED/);
    assert.deepEqual(reads, ['src/allowed.ts']);
  } finally {
    if (name && scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  }
});

const imageId = (() => {
  try { return execFileSync('docker', ['image', 'inspect', 'alpine:3.20', '--format', '{{.Id}}'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
})();

test('lost create ID is reconciled by its exact owned name in the real Docker daemon',
  { skip: !imageId && 'alpine:3.20 image is unavailable' }, async () => {
    const ownedName = `rcac-investigator-${randomUUID()}`;
    const unrelatedName = `rcac-investigator-${randomUUID()}`;
    const create = (name: string) => {
      const result = spawnSync('docker', ['create', '--name', name, imageId!, '/bin/true'],
        { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
    };
    try {
      create(ownedName);
      create(unrelatedName);
      await reconcileCreatedContainer(ownedName);
      const owned = spawnSync('docker', ['container', 'inspect', ownedName], { encoding: 'utf8', timeout: 10_000 });
      assert.notEqual(owned.status, 0, 'the orphan must be removed even without its ID');
      const unrelated = spawnSync('docker', ['container', 'inspect', unrelatedName], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(unrelated.status, 0, 'reconciliation must preserve another investigation');
      await assert.rejects(reconcileCreatedContainer(ownedName), /ISOLATION_TERMINATION_UNCONFIRMED/);
    } finally {
      spawnSync('docker', ['rm', '-f', ownedName, unrelatedName], { encoding: 'utf8', timeout: 10_000 });
    }
  });

test('an empty exact-name Docker listing stays unresolved because create may arrive late',
  { skip: !imageId && 'alpine:3.20 image is unavailable' }, async () => {
    const absentName = `rcac-investigator-${randomUUID()}`;
    try {
      await assert.rejects(reconcileCreatedContainer(absentName), /ISOLATION_TERMINATION_UNCONFIRMED/);
      const late = spawnSync('docker', ['create', '--name', absentName, imageId!, '/bin/true'],
        { encoding: 'utf8', timeout: 20_000 });
      assert.equal(late.status, 0, late.stderr || String(late.error));
      await reconcileCreatedContainer(absentName);
      assert.notEqual(spawnSync('docker', ['container', 'inspect', absentName], { encoding: 'utf8' }).status, 0);
    } finally { spawnSync('docker', ['rm', '-f', absentName], { encoding: 'utf8', timeout: 10_000 }); }
  });

test('actual Docker worker searches only frozen snapshot bytes', { skip: !imageId && 'alpine:3.20 image is unavailable' }, async () => {
  let associatedName = '';
  let scratchRoot = '';
  let persistedId = '';
  const run = runStaticInvestigation({ snapshot, imageId: imageId!, paths: ['src/flow.ts'],
    patterns: ['processOrder'], maxWallSeconds: 20, maxOutputBytes: 4096 }, (name, root) => {
    associatedName = name;
    scratchRoot = root;
  }, id => { persistedId = id; });
  if (process.platform === 'win32') {
    await assert.rejects(run, /RECOVERY_REQUIRED/);
    assert.equal(existsSync(scratchRoot), true, 'unsafe recursive cleanup retains scratch');
  } else {
    const result = await run;
    assert.equal(existsSync(scratchRoot), false, 'confirmed removal clears the materialized snapshot');
    assert.match(result.matches, /processOrder/);
    assert.doesNotMatch(result.matches, /no relevant symbol/);
    assert.equal(result.snapshotRef, snapshot.id);
    assert.equal(result.isolation, 'docker_readonly_network_none');
  }
  assert.match(associatedName, /^rcac-investigator-/);
  assert.match(persistedId, /^[0-9a-f]{64}$/);
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
});

test('Docker mount accepts a comma in the host path without disclosing it on failure',
  { skip: !imageId && 'alpine:3.20 image is unavailable' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'rcac,private-canary-'));
    const source = join(root, 'snapshot');
    try {
      mkdirSync(source);
      writeFileSync(join(source, 'source.txt'), 'SYNTHETIC_COMMA_CANARY\n');
      const args = sandboxArgs(`rcac-comma-${process.pid}`, source, imageId!, '/bin/grep',
        ['-F', 'SYNTHETIC_COMMA_CANARY', '--', '/snapshot/source.txt']);
      const created = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000 });
      assert.equal(created.status, 0, created.stderr || String(created.error));
      try {
        const result = spawnSync('docker', ['start', '-a', created.stdout.trim()], { encoding: 'utf8', timeout: 20_000 });
        assert.equal(result.status, 0, result.stderr || String(result.error));
        assert.match(result.stdout, /SYNTHETIC_COMMA_CANARY/);
      } finally { spawnSync('docker', ['rm', '-f', created.stdout.trim()], { encoding: 'utf8', timeout: 10_000 }); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test('Docker daemon logs cannot retain source output while attached output remains readable',
  { skip: !imageId && 'alpine:3.20 image is unavailable' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'rcac-log-canary-'));
    const source = join(root, 'snapshot');
    const name = `rcac-log-${process.pid}`;
    try {
      mkdirSync(source);
      writeFileSync(join(source, 'source.txt'), 'SYNTHETIC_LOG_CANARY\n');
      const args = sandboxArgs(name, source, imageId!, '/bin/cat', ['/snapshot/source.txt']);
      const created = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000 });
      assert.equal(created.status, 0, created.stderr || String(created.error));
      const started = spawnSync('docker', ['start', '-a', created.stdout.trim()], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(started.status, 0, started.stderr || String(started.error));
      assert.match(started.stdout, /SYNTHETIC_LOG_CANARY/);
      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 10_000 });
      assert.notEqual(logs.status, 0);
      assert.doesNotMatch(logs.stdout + logs.stderr, /SYNTHETIC_LOG_CANARY/);
    } finally {
      spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 10_000 });
      rmSync(root, { recursive: true, force: true });
    }
  });

test('actual Docker worker rejects output beyond configured budget', { skip: !imageId && 'alpine:3.20 image is unavailable' }, async () => {
  const ownedContainers = () => execFileSync('docker', ['ps', '-a', '--no-trunc', '--filter', 'name=rcac-investigator-', '--format', '{{.ID}}'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).sort();
  const before = ownedContainers();
  const large = createSnapshotFromFiles('copy-1', 'fixture', { 'large.txt': Buffer.from('MATCH\n'.repeat(1000)) });
  let scratchRoot = '';
  await assert.rejects(runStaticInvestigation({ snapshot: large, imageId: imageId!, paths: ['large.txt'],
    patterns: ['MATCH'], maxWallSeconds: 20, maxOutputBytes: 100 }, (_name, root) => { scratchRoot = root; }, () => {}),
  process.platform === 'win32' ? /RECOVERY_REQUIRED/ : /OUTPUT_LIMIT_EXCEEDED/);
  assert.deepEqual(ownedContainers(), before, 'output limit must leave no owned container behind');
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
});

test('worker refuses Docker create when durable association rejects the exact name',
  { skip: !imageId && 'alpine:3.20 image is unavailable' }, async () => {
    const before = execFileSync('docker', ['ps', '-a', '--filter', 'name=rcac-investigator-', '--format', '{{.Names}}'], { encoding: 'utf8' });
    await assert.rejects(runStaticInvestigation({ snapshot, imageId: imageId!, paths: ['src/flow.ts'],
      patterns: ['processOrder'], maxWallSeconds: 20, maxOutputBytes: 4096 }, name => {
      assert.match(name, /^rcac-investigator-/);
      throw new Error('DURABLE_STORE_UNAVAILABLE');
    }, () => {}), /DURABLE_STORE_UNAVAILABLE/);
    const after = execFileSync('docker', ['ps', '-a', '--filter', 'name=rcac-investigator-', '--format', '{{.Names}}'], { encoding: 'utf8' });
    assert.equal(after, before);
  });

test('actual Docker sandbox blocks host sibling read, source write, and network, while scratch works', { skip: !imageId && 'alpine:3.20 image is unavailable' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rcac-canary-'));
  try {
    const source = join(root, 'snapshot');
    mkdirSync(source);
    writeFileSync(join(source, 'source.txt'), 'source');
    writeFileSync(join(root, 'host-secret.txt'), 'canary secret');
    const script = 'command -v wget >/dev/null && test ! -e /host-secret.txt && ! touch /snapshot/source.txt 2>/dev/null && touch /scratch/canary && ! wget -q -T 2 -O /scratch/net http://1.1.1.1/';
    const args = sandboxArgs(`rcac-canary-${process.pid}`, source, imageId!, '/bin/sh', ['-c', script]);
    const created = spawnSync('docker', args, { encoding: 'utf8', timeout: 20000 });
    assert.equal(created.status, 0, created.stderr || String(created.error));
    try {
      const result = spawnSync('docker', ['start', '-a', created.stdout.trim()], { encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
    } finally { spawnSync('docker', ['rm', '-f', created.stdout.trim()], { encoding: 'utf8', timeout: 10_000 }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
