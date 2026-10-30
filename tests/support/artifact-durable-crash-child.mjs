import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';

const [phase, dbPath, objectRoot, snapshotId] = process.argv.slice(2);
const phases = new Set(['staging_write', 'object_fsync', 'object_rename', 'verify_read', 'manifest_rename']);
if (!phases.has(phase) || !dbPath || !objectRoot || !snapshotId) throw new Error('Invalid fixed crash fixture');
const staging = join(resolve(objectRoot), 'staging', 'v2.json');
const objects = join(resolve(objectRoot), 'objects');
const contentHash = createHash('sha256').update('version two').digest('hex');
const contentObject = join(objects, contentHash.slice(0, 2), contentHash);
const marker = JSON.parse(fs.readFileSync(staging, 'utf8'));
const manifest = { ...marker.input, expectedSetBasis: marker.expectedSetBasis,
  files: [...marker.files].sort((a, b) => a.normalizedRelativePath.localeCompare(b.normalizedRelativePath)),
  semanticStatus: 'not_reviewed' };
const manifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
const manifestObject = join(objects, manifestHash.slice(0, 2), manifestHash);
const selectedObject = phase === 'manifest_rename' ? manifestObject : contentObject;
const fdPaths = new Map();
const originals = { openSync: fs.openSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync,
  fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, readFileSync: fs.readFileSync };
let fired = false;
function isSelectedTemp(path) { return typeof path === 'string' && path.startsWith(selectedObject + '.') && path.endsWith('.tmp'); }
function pause() {
  if (fired) return;
  fired = true;
  fs.writeSync(1, `READY:${phase}\n`);
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
fs.openSync = function(path, ...args) {
  const fd = originals.openSync.call(fs, path, ...args);
  if (typeof path === 'string' && (path.startsWith(staging + '.') || isSelectedTemp(path))) fdPaths.set(fd, path);
  return fd;
};
fs.closeSync = function(fd) { fdPaths.delete(fd); return originals.closeSync.call(fs, fd); };
fs.writeFileSync = function(target, data, ...args) {
  const path = fdPaths.get(target);
  if (phase === 'staging_write' && path?.startsWith(staging + '.') && !fired) {
    const bytes = Buffer.from(data);
    originals.writeFileSync.call(fs, target, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), ...args);
    pause();
  }
  return originals.writeFileSync.call(fs, target, data, ...args);
};
fs.fsyncSync = function(fd) {
  const result = originals.fsyncSync.call(fs, fd);
  if (phase === 'object_fsync' && isSelectedTemp(fdPaths.get(fd))) pause();
  return result;
};
fs.renameSync = function(from, to) {
  const result = originals.renameSync.call(fs, from, to);
  if ((phase === 'object_rename' || phase === 'manifest_rename') &&
      isSelectedTemp(from) && to === selectedObject) pause();
  return result;
};
fs.readFileSync = function(path, ...args) {
  const result = originals.readFileSync.call(fs, path, ...args);
  if (phase === 'verify_read' && path === contentObject && !fired) pause();
  return result;
};
syncBuiltinESMExports();

const [{ ArtifactApplication }, { ArtifactObjects }, { SqliteStore }, { authorize }, { BundleLocks }] = await Promise.all([
  import('../../src/application/artifacts.ts'), import('../../src/adapters/storage/objects.ts'),
  import('../../src/adapters/storage/sqlite.ts'), import('../../src/core/policy/authorize.ts'),
  import('../../src/runtime/bundle-locks.ts'),
]);
const db = new SqliteStore(dbPath);
const locks = new BundleLocks();
const app = new ArtifactApplication({
  objects: new ArtifactObjects(objectRoot),
  validateBundleReferences: input => db.validateBundleReferences(input),
  authorize: ({ context, operation, workspaceId, collaborationId }) => authorize(context, operation,
    { workspaceId, collaborationId }, db.grantsFor(context.principal, context.audience)),
  collaborationBelongsToWorkspace: (ws, col) => db.collaborationBelongsToWorkspace(ws, col),
  getBundle: id => db.getBundle(id), saveBundle: record => db.saveBundle(record),
  publishBundle: manifest => db.publishBundle(manifest), abortBundle: (id, state) => db.abortBundle(id, state),
  lookupIdempotent: (scope, payload) => db.lookupIdempotent(scope, payload),
  withBundleLock: (id, action) => locks.withBundleLock(id, action),
  runIdempotent: (scope, payload, mutation) => db.runIdempotent(scope, payload, mutation),
});
const binding = { context: { principal: 'external', audience: 'mcp', recipient: 'external',
  surface: 'external_mcp', now: new Date() }, workspaceId: 'ws', collaborationId: 'col', bundleId: 'v2' };
if (phase === 'verify_read' || phase === 'manifest_rename') await app.finalize({ ...binding, idempotencyKey: 'finish-v2' });
else await app.putText({ ...binding, idempotencyKey: 'put-v2', path: 'v2.md', text: 'version two',
  mediaType: 'text/markdown', sourceReceipt: 'text_set_mcp' });
throw new Error(`Crash phase ${phase} not reached`);
