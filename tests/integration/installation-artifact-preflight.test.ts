import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ArtifactObjects } from '../../src/adapters/storage/objects.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite.js';
import { createManagedInstallation } from '../../src/cli/install.js';
import { acquireInstallationMaintenance } from '../../src/runtime/installation.js';
import { assertInstallationArtifactsConsistent, inspectInstallationArtifactDataset }
  from '../../src/runtime/installation-artifact-preflight.js';
import { seedBundleProvenance } from '../support/bundle-provenance.js';

const parent = process.platform === 'win32' ? homedir() : tmpdir();
const zipBytes = Buffer.from('UEsDBBQAAAAIAIQbPV20N7uzEgAAABAAAAARAAAAbmVzdGVkL3JlcG9ydC50eHQrrswryUgtyUxWKEotyC8qAQBQSwECFAAUAAAACACEGz1dtDe7sxIAAAAQAAAAEQAAAAAAAAAAAAAAgAEAAAAAbmVzdGVkL3JlcG9ydC50eHRQSwUGAAAAAAEAAQA/AAAAQQAAAAAA', 'base64');

async function fixture(run: (root: string, data: string, objects: ArtifactObjects,
  db: SqliteStore, file: string) => Promise<void>): Promise<void> {
  const base = mkdtempSync(join(parent, 'rcac-art-preflight-'));
  let db: SqliteStore | undefined;
  let primary: unknown;
  try {
    const root = join(base, 'installation');
    createManagedInstallation(root);
    const owner = acquireInstallationMaintenance(root);
    const data = owner.dataDirectory;
    owner.release();
    const file = join(data, 'state.sqlite');
    db = new SqliteStore(file);
    const objects = new ArtifactObjects(join(data, 'artifact-objects'));
    await run(root, data, objects, db, file);
  } catch (error) { primary = error; }
  let closeError: unknown;
  try { db?.close(); } catch (error) { closeError = error; }
  if (closeError !== undefined) throw new AggregateError(primary === undefined ? [closeError] : [primary, closeError],
    'Artifact fixture database close unconfirmed');
  let cleanup: unknown;
  try {
    assert.match(relative(resolve(parent), resolve(base)), /^rcac-art-preflight-[A-Za-z0-9_-]{6}$/);
    rmSync(base, { recursive: true, force: true });
  } catch (error) { cleanup = error; }
  if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], 'Artifact fixture failure and cleanup');
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
}

function check(root: string, expected: 'pass' | 'fail'): void {
  const owner = acquireInstallationMaintenance(root);
  try {
    if (expected === 'pass') assert.doesNotThrow(() => assertInstallationArtifactsConsistent(owner));
    else assert.throws(() => assertInstallationArtifactsConsistent(owner), /INSTALLATION_ARTIFACTS_UNSAFE/);
  } finally { owner.release(); }
}

async function published(db: SqliteStore, file: string, objects: ArtifactObjects, base: string): Promise<void> {
  db.insertWorkspace({ id: 'ws', name: 'Fixture', canonicalRoot: base, registeredBy: 'owner' });
  db.insertCollaboration({ id: 'col', workspaceId: 'ws', openedBy: 'owner', purpose: 'fixture', hostThreadId: null, state: 'open' });
  const { snapshotId } = await seedBundleProvenance(db, file, { workspaceId: 'ws', collaborationId: 'col',
    workingCopyId: 'copy', root: base, revisionIds: ['ctx1', 'ctx2'] });
  const first = { bundleId: 'v1', workspaceId: 'ws', collaborationId: 'col', contextRevision: 'ctx1',
    snapshotRefs: [snapshotId], expectedPaths: ['plan.md'] };
  objects.begin(first);
  objects.putText('v1', 'plan.md', '# first', 'text/markdown', 'text_set_mcp');
  db.saveBundle({ input: first });
  objects.finalize('v1', manifest => db.publishBundle(manifest));
  const second = { ...first, bundleId: 'v2', contextRevision: 'ctx2', parentBundleId: 'v1' };
  objects.begin(second);
  objects.putText('v2', 'plan.md', '# second', 'text/markdown', 'text_set_mcp');
  db.saveBundle({ input: second });
  objects.finalize('v2', manifest => db.publishBundle(manifest));
}

test('read-only maintenance accepts v1/v2 terminal marker lag and preserves every source byte', async () => {
  await fixture(async (root, data, objects, db, file) => {
    await published(db, file, objects, data);
    const marker1 = join(data, 'artifact-objects', 'staging', 'v1.json');
    const marker2 = join(data, 'artifact-objects', 'staging', 'v2.json');
    const before = readFileSync(marker1);
    check(root, 'pass');
    const readonly = new DatabaseSync(file, { readOnly: true });
    try { assert.doesNotThrow(() => inspectInstallationArtifactDataset(readonly, data)); }
    finally { readonly.close(); }
    assert.deepEqual(readFileSync(marker1), before);
    unlinkSync(marker1); // committed DB publication can precede marker update
    const lag = JSON.parse(readFileSync(marker2, 'utf8')) as Record<string, unknown>;
    lag.state = 'staging';
    delete lag.manifest;
    writeFileSync(marker2, JSON.stringify(lag));
    check(root, 'pass');
    assert.equal(existsSync(marker1), false);
    assert.equal(JSON.parse(readFileSync(marker2, 'utf8')).state, 'staging');
  });
});

test('published four-format marker preserves producer write order while manifest sorts paths', async () => {
  await fixture(async (root, data, objects, db, file) => {
    await published(db, file, objects, data);
    const input = { ...db.getBundle('v1')!.input, bundleId: 'mixed', parentBundleId: 'v2',
      expectedPaths: ['plan.md', 'assets/pixel.png', 'archive.zip', 'raw.bin'] };
    objects.begin(input);
    objects.putText('mixed', 'plan.md', '# mixed', 'text/markdown', 'text_set_mcp');
    objects.putBytes('mixed', 'assets/pixel.png', Buffer.from('89504e470d0a1a0a00000000', 'hex'),
      'image/png', 'mcp_file_set');
    objects.putBytes('mixed', 'archive.zip', zipBytes, 'application/zip', 'mcp_file_set');
    objects.putBytes('mixed', 'raw.bin', Buffer.from([0, 1, 255]), 'application/octet-stream', 'mcp_file_set');
    db.saveBundle({ input });
    const manifest = objects.finalize('mixed', value => db.publishBundle(value));
    const marker = join(data, 'artifact-objects', 'staging', 'mixed.json');
    const original = readFileSync(marker);
    const stored = JSON.parse(original.toString('utf8')) as { files: { normalizedRelativePath: string;
      sha256: string }[] };
    assert.notDeepEqual(stored.files.map(item => item.normalizedRelativePath),
      manifest.files.map(item => item.normalizedRelativePath));
    check(root, 'pass');
    assert.deepEqual(readFileSync(marker), original);
    const tampered = structuredClone(stored);
    [tampered.files[0]!.sha256, tampered.files[1]!.sha256] =
      [tampered.files[1]!.sha256, tampered.files[0]!.sha256];
    writeFileSync(marker, JSON.stringify(tampered));
    check(root, 'fail');
  });
});

test('read-only maintenance rejects unsettled, orphan, half-published, corrupt and conflicted bundles', async () => {
  await fixture(async (root, data, objects, db, file) => {
    await published(db, file, objects, data);
    const sql = new DatabaseSync(file);
    try {
      const row = sql.prepare('SELECT input_json FROM bundles WHERE id=?').get('v1') as { input_json: string };
      const unsettled = { ...(JSON.parse(row.input_json) as Record<string, unknown>), bundleId: 'open' };
      sql.prepare('INSERT INTO bundles(id,workspace_id,collaboration_id,input_json) VALUES (?,?,?,?)')
        .run('open', 'ws', 'col', JSON.stringify(unsettled));
      check(root, 'fail');
      sql.prepare('DELETE FROM bundles WHERE id=?').run('open');
      const marker = join(data, 'artifact-objects', 'staging', 'v1.json');
      const orphan = join(data, 'artifact-objects', 'staging', 'orphan.json');
      writeFileSync(orphan, readFileSync(marker));
      check(root, 'fail');
      unlinkSync(orphan);
      const fileRow = sql.prepare('SELECT sha256 FROM bundle_files WHERE bundle_id=?').get('v1') as { sha256: string };
      sql.prepare('DELETE FROM bundle_files WHERE bundle_id=?').run('v1');
      check(root, 'fail');
      const manifest = JSON.parse((sql.prepare('SELECT manifest_json FROM bundles WHERE id=?').get('v1') as
        { manifest_json: string }).manifest_json) as { files: { normalizedRelativePath: string; actualSizeBytes: number;
          sha256: string; mediaType: string; sourceReceipt: string }[] };
      const artifact = manifest.files[0]!;
      sql.prepare('INSERT INTO bundle_files(bundle_id,path,sha256,size_bytes,media_type,source_receipt) VALUES (?,?,?,?,?,?)')
        .run('v1', artifact.normalizedRelativePath, artifact.sha256, artifact.actualSizeBytes,
          artifact.mediaType, artifact.sourceReceipt);
      const object = objects.objectPath(fileRow.sha256);
      const original = readFileSync(object);
      writeFileSync(object, Buffer.from('corrupt'));
      check(root, 'fail');
      writeFileSync(object, original);
      const altered = JSON.parse(readFileSync(marker, 'utf8')) as { input: Record<string, unknown> };
      altered.input.workspaceId = 'other';
      writeFileSync(marker, JSON.stringify(altered));
      check(root, 'fail');
      assert.equal(createHash('sha256').update(readFileSync(object)).digest('hex'), fileRow.sha256);
    } finally { sql.close(); }
  });
});

test('aborted receipt accepts terminal marker lag and rejects unknown temporary files', async () => {
  await fixture(async (root, data, objects, db, file) => {
    await published(db, file, objects, data);
    const source = db.getBundle('v1')!.input;
    const input = { ...source, bundleId: 'aborted', expectedPaths: ['plan.md', 'missing.md'] };
    objects.begin(input);
    objects.putText('aborted', 'plan.md', '# partial', 'text/markdown', 'text_set_mcp');
    db.saveBundle({ input });
    const receipt = { ...objects.status('aborted'), state: 'aborted' as const };
    db.abortBundle('aborted', receipt);
    check(root, 'pass');
    objects.abort('aborted', input, receipt);
    check(root, 'pass');
    const marker = join(data, 'artifact-objects', 'staging', 'aborted.json');
    unlinkSync(marker);
    check(root, 'pass');
    const temp = join(data, 'artifact-objects', 'staging', 'unknown.tmp');
    writeFileSync(temp, 'partial');
    check(root, 'fail');
  });
});

test('controlled database close failure preserves aggregate and holds exclusive owner until child exit', async () => {
  await fixture(async root => {
    const installationUrl = new URL('../../src/runtime/installation.ts', import.meta.url).href;
    const preflightUrl = new URL('../../src/runtime/installation-artifact-preflight.ts', import.meta.url).href;
    const code = `
      import { DatabaseSync } from 'node:sqlite';
      import { acquireInstallationMaintenance, acquireInstallationRuntime } from ${JSON.stringify(installationUrl)};
      import { assertInstallationArtifactsConsistent } from ${JSON.stringify(preflightUrl)};
      const owner = acquireInstallationMaintenance(process.argv[1]);
      const original = DatabaseSync.prototype.close;
      let closes = 0, injected = 0;
      DatabaseSync.prototype.close = function () {
        original.call(this);
        if (++closes === 1) { injected++; throw new Error('controlled sqlite-close aftermath'); }
      };
      let aggregate = false, message = '';
      try { assertInstallationArtifactsConsistent(owner); }
      catch (error) { aggregate = error instanceof AggregateError; message = error?.message ?? ''; }
      let competing = '';
      try { acquireInstallationRuntime(process.argv[1]); competing = 'acquired'; }
      catch (error) { competing = error?.message ?? ''; }
      process.stdout.write(JSON.stringify({ injected, aggregate, message, competing }));`;
    const result = spawnSync(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', code, root],
      { cwd: resolve('.'), encoding: 'utf8', timeout: 20_000, maxBuffer: 4096 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.slice(0, 512));
    const observed = JSON.parse(result.stdout) as { injected: number; aggregate: boolean;
      message: string; competing: string };
    assert.deepEqual(observed, { injected: 1, aggregate: true,
      message: 'Installation artifact inspection close unconfirmed', competing: 'MAINTENANCE_GATE_BUSY' });
    assert.equal(result.stdout.includes(root), false);
    check(root, 'pass');
  });
});

test('SQL byte limits reject one oversized field and aggregate rows before fetching bodies', () => {
  for (const fields of [
    ['x'.repeat(16 * 1024 * 1024 + 1)],
    ['x'.repeat(8 * 1024 * 1024), 'x'.repeat(8 * 1024 * 1024)],
    ['{}'],
  ]) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE bundles(id TEXT,workspace_id TEXT,collaboration_id TEXT,parent_id TEXT,
        input_json TEXT,manifest_json TEXT,published_seq INTEGER,integrity_status TEXT,aborted_state_json TEXT);
        CREATE TABLE bundle_files(bundle_id TEXT,path TEXT,sha256 TEXT,size_bytes INTEGER,
          media_type TEXT,source_receipt TEXT,source_identity TEXT)`);
      for (const [index, field] of fields.entries()) {
        db.prepare('INSERT INTO bundles(id,workspace_id,collaboration_id,input_json) VALUES (?,?,?,?)')
          .run(`id${index}`, index === 0 && fields.length === 1 && field === '{}' ? 'x'.repeat(16 * 1024 * 1024 + 1) : 'ws',
            'col', field);
      }
      let bodiesFetched = 0;
      const instrumented = new Proxy(db, { get(target, property) {
        if (property === 'prepare') return (sql: string) => {
          if (/^SELECT id,workspace_id,collaboration_id,parent_id,input_json/.test(sql)) bodiesFetched++;
          return target.prepare(sql);
        };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as DatabaseSync;
      assert.throws(() => inspectInstallationArtifactDataset(instrumented, 'unused'), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'INSTALLATION_ARTIFACTS_UNSAFE');
        assert.deepEqual(error.cause, { component: 'installation_artifact_preflight', reason: 'limit' });
        return true;
      });
      assert.equal(bodiesFetched, 0, 'SQL body fetch must follow aggregate byte precheck');
    } finally { db.close(); }
  }
});

test('shared ZIP object across real bundle versions is read and inflated once; each media use is checked', async () => {
  await fixture(async (root, data, objects, db, file) => {
    await published(db, file, objects, data);
    const source = db.getBundle('v1')!.input;
    for (const [bundleId, contextRevision, parentBundleId] of [
      ['zip1', 'ctx1', 'v2'], ['zip2', 'ctx2', 'zip1'],
    ] as const) {
      const input = { ...source, bundleId, contextRevision, parentBundleId, expectedPaths: ['archive.zip'] };
      objects.begin(input);
      objects.putBytes(bundleId, 'archive.zip', zipBytes, 'application/zip', 'mcp_file_set');
      db.saveBundle({ input });
      objects.finalize(bundleId, manifest => db.publishBundle(manifest));
    }
    const hash = createHash('sha256').update(zipBytes).digest('hex');
    const object = objects.objectPath(hash);
    const originalOpen = fs.openSync, originalInflate = zlib.inflateRawSync;
    let opens = 0, inflates = 0;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === object) opens++;
      return originalOpen(...args);
    }) as typeof fs.openSync;
    zlib.inflateRawSync = ((...args: Parameters<typeof zlib.inflateRawSync>) => {
      inflates++;
      return originalInflate(...args);
    }) as typeof zlib.inflateRawSync;
    syncBuiltinESMExports();
    try { check(root, 'pass'); }
    finally { fs.openSync = originalOpen; zlib.inflateRawSync = originalInflate; syncBuiltinESMExports(); }
    assert.equal(opens, 1, 'same content hash must be read once');
    assert.equal(inflates, 1, 'same ZIP content hash must be inflated once');

    const sql = new DatabaseSync(file);
    try {
      const manifest = JSON.parse((sql.prepare('SELECT manifest_json FROM bundles WHERE id=?').get('zip2') as
        { manifest_json: string }).manifest_json) as { files: { mediaType: string }[] };
      manifest.files[0]!.mediaType = 'text/plain';
      const bytes = Buffer.from(JSON.stringify(manifest));
      const manifestObject = objects.objectPath(createHash('sha256').update(bytes).digest('hex'));
      mkdirSync(join(data, 'artifact-objects', 'objects', manifestObject.split(/[\\/]/).at(-2)!), { recursive: true });
      writeFileSync(manifestObject, bytes);
      sql.prepare('UPDATE bundles SET manifest_json=? WHERE id=?').run(JSON.stringify(manifest), 'zip2');
      sql.prepare('UPDATE bundle_files SET media_type=? WHERE bundle_id=?').run('text/plain', 'zip2');
      const marker = join(data, 'artifact-objects', 'staging', 'zip2.json');
      const stored = JSON.parse(readFileSync(marker, 'utf8')) as { files: { mediaType: string }[];
        manifest: { files: { mediaType: string }[] } };
      stored.files[0]!.mediaType = 'text/plain';
      stored.manifest.files[0]!.mediaType = 'text/plain';
      writeFileSync(marker, JSON.stringify(stored));
      check(root, 'fail');
    } finally { sql.close(); }
  });
});

test('declared unique object size beyond 2 GiB fails before touching absent objects', async () => {
  await fixture(async (root, _data, _objects, _db, file) => {
    const sql = new DatabaseSync(file);
    try {
      const files = Array.from({ length: 65 }, (_, index) => ({
        normalizedRelativePath: `file-${String(index).padStart(2, '0')}.bin`,
        actualSizeBytes: 32 * 1024 * 1024,
        sha256: (index + 1).toString(16).padStart(64, '0'), mediaType: 'application/octet-stream',
        sourceReceipt: 'synthetic_budget_probe',
      }));
      const input = { bundleId: 'budget', workspaceId: 'ws', collaborationId: 'col',
        contextRevision: 'ctx', snapshotRefs: ['snap'], expectedPaths: files.map(item => item.normalizedRelativePath) };
      const manifest = { ...input, expectedSetBasis: 'producer_declared', files,
        semanticStatus: 'not_reviewed' };
      sql.exec("INSERT INTO workspaces(id,name,canonical_root,registered_by) VALUES ('ws','A','fixture','owner')");
      sql.exec("INSERT INTO collaborations(id,workspace_id,opened_by,purpose,state) VALUES ('col','ws','owner','fixture','open')");
      sql.prepare(`INSERT INTO bundles(id,workspace_id,collaboration_id,input_json,manifest_json,published_seq,integrity_status)
        VALUES (?,?,?,?,?,1,'ok')`).run('budget', 'ws', 'col', JSON.stringify(input), JSON.stringify(manifest));
      const insert = sql.prepare(`INSERT INTO bundle_files(bundle_id,path,sha256,size_bytes,media_type,source_receipt)
        VALUES (?,?,?,?,?,?)`);
      for (const entry of files) insert.run('budget', entry.normalizedRelativePath, entry.sha256,
        entry.actualSizeBytes, entry.mediaType, entry.sourceReceipt);
      const owner = acquireInstallationMaintenance(root);
      try {
        assert.throws(() => assertInstallationArtifactsConsistent(owner), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, 'INSTALLATION_ARTIFACTS_UNSAFE');
          assert.deepEqual(error.cause, { component: 'installation_artifact_preflight', reason: 'limit' });
          return true;
        });
      } finally { owner.release(); }
    } finally { sql.close(); }
  });
});
