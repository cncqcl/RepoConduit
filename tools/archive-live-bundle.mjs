#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// This copies a locally authorized, already-published product bundle into a
// reviewable evidence tree. It never marks a LIVE case passed or invents a
// provider tool receipt; the live runner must supply that separately.
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Local diagnostic only: never print the CLI's raw stderr, paths, or exception.
let failureStage = 'arguments', failureReason = 'rejected', failureExitCode = null;
const within = (root, path) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const regular = (path) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid evidence file');
  return readFileSync(path);
};

function parseArgs(argv) {
  if (argv.length !== 6 || argv[0] !== '--data-dir' || argv[2] !== '--cli' ||
      argv[4] !== '--evidence-root' || ![argv[1], argv[3], argv[5]].every(isAbsolute))
    throw new Error('usage');
  const dataDir = realpathSync(resolve(argv[1]));
  const cli = realpathSync(resolve(argv[3]));
  const evidenceRoot = realpathSync(resolve(argv[5]));
  if (!lstatSync(cli).isFile() || !lstatSync(evidenceRoot).isDirectory() ||
      !existsSync(join(evidenceRoot, 'verification', 'RUNTIME_ACCEPTANCE.json')) ||
      within(dataDir, evidenceRoot) || within(evidenceRoot, dataDir)) throw new Error('invalid roots');
  return { dataDir, cli, evidenceRoot };
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const part of process.stdin) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.length;
    if (size > 8192) throw new Error('invalid request');
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['runId', 'role', 'scope', 'bundleId'].includes(key)) ||
      !['LIVE01', 'LIVE02'].includes(value.runId) ||
      !(value.runId === 'LIVE01' ? ['v1', 'v2'].includes(value.role) : value.role === 'independent') ||
      !value.scope || typeof value.scope !== 'object' || Array.isArray(value.scope) ||
      Object.keys(value.scope).sort().join(',') !== 'collaborationId,workspaceId' ||
      ![value.scope.workspaceId, value.scope.collaborationId, value.bundleId].every(
        (entry) => typeof entry === 'string' && entry.trim().length > 0))
    throw new Error('invalid request');
  return { ...value, scope: {
    workspaceId: value.scope.workspaceId,
    collaborationId: value.scope.collaborationId,
  } };
}

function productRequest(cli, dataDir, operation, scope, payload, idempotencyKey) {
  const command = { operation, scope, payload, ...(idempotencyKey ? { idempotencyKey } : {}) };
  const result = spawnSync(process.execPath, [cli, '--data-dir', dataDir, 'request'], {
    input: JSON.stringify(command), encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    failureReason = result.error ? (result.error.code === 'ETIMEDOUT' ? 'product_timeout' :
      'product_spawn_failed') : 'product_nonzero';
    failureExitCode = Number.isSafeInteger(result.status) ? result.status : null;
    throw new Error('product request failed');
  }
  try { return JSON.parse(result.stdout); }
  catch { failureReason = 'product_invalid_response'; throw new Error('invalid product response'); }
}

function validatedManifest(inspected, request) {
  if (!inspected || inspected.ready !== true || inspected.integrityStatus !== 'ok' ||
      !inspected.manifest || inspected.bundleId !== request.bundleId) throw new Error('bundle not ready');
  const manifest = inspected.manifest;
  if (manifest.bundleId !== request.bundleId || manifest.workspaceId !== request.scope.workspaceId ||
      manifest.collaborationId !== request.scope.collaborationId ||
      !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('bundle scope mismatch');
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (digest(bytes) !== inspected.manifestHash) throw new Error('manifest hash mismatch');
  return { manifest, bytes, manifestHash: inspected.manifestHash };
}

function archiveFiles(exportPath, archiveRoot, manifest, manifestBytes, request) {
  const folder = digest(Buffer.from(JSON.stringify([request.scope, request.bundleId, request.role])));
  let runRoot = archiveRoot;
  for (const part of ['verification', 'live', request.runId]) {
    runRoot = join(runRoot, part);
    if (!existsSync(runRoot)) {
      try { mkdirSync(runRoot); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    const stat = lstatSync(runRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        !within(archiveRoot, realpathSync(runRoot))) throw new Error('unsafe evidence directory');
  }
  const destination = join(runRoot, folder);
  const baseRef = `verification/live/${request.runId}/${folder}`;
  const files = new Map([['manifest.json', manifestBytes]]);
  const refs = [];
  for (const [index, file] of manifest.files.entries()) {
    const path = file?.normalizedRelativePath;
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        !Number.isSafeInteger(file.actualSizeBytes) || file.actualSizeBytes < 0 ||
        !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('invalid manifest file');
    const source = resolve(exportPath, ...path.split('/'));
    if (!within(exportPath, source) || !within(exportPath, realpathSync(source)))
      throw new Error('invalid exported path');
    const bytes = regular(source);
    if (bytes.length !== file.actualSizeBytes || digest(bytes) !== file.sha256)
      throw new Error('exported bytes mismatch');
    const name = `file-${String(index).padStart(4, '0')}`;
    files.set(name, bytes);
    refs.push({ normalized_relative_path: path, evidence_ref: `${baseRef}/${name}` });
  }
  const result = { role: request.role, manifest_ref: `${baseRef}/manifest.json`,
    manifest_hash: digest(manifestBytes), file_refs: refs };
  const verifyExisting = () => {
    if (!lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink() ||
        readdirSync(destination).sort().join('\0') !== [...files.keys()].sort().join('\0'))
      throw new Error('archive conflict');
    for (const [name, bytes] of files)
      if (!regular(join(destination, name)).equals(bytes)) throw new Error('archive conflict');
  };
  if (existsSync(destination)) { verifyExisting(); return result; }
  const pending = mkdtempSync(join(runRoot, '.pending-'));
  if (!within(runRoot, pending)) throw new Error('unsafe pending directory');
  try {
    for (const [name, bytes] of files) writeFileSync(join(pending, name), bytes, { flag: 'wx', mode: 0o600 });
    if (existsSync(destination)) { verifyExisting(); return result; }
    try { renameSync(pending, destination); }
    catch (error) {
      if (!existsSync(destination)) throw error;
      verifyExisting();
    }
    return result;
  } finally { if (existsSync(pending)) rmSync(pending, { recursive: true, force: true }); }
}

async function main() {
  const { dataDir, cli, evidenceRoot } = parseArgs(process.argv.slice(2));
  failureStage = 'input';
  const request = await readInput();
  failureStage = 'inspect';
  const inspected = productRequest(cli, dataDir, 'artifact.inspect', request.scope,
    { bundleId: request.bundleId });
  failureStage = 'manifest';
  const { manifest, bytes, manifestHash } = validatedManifest(inspected, request);
  const exportName = `live-evidence-${digest(Buffer.from(JSON.stringify([request.scope, request.bundleId]))).slice(0, 40)}`;
  const idempotencyKey = `live-evidence-${digest(Buffer.from(JSON.stringify([request.scope, request.bundleId, manifestHash])))}`;
  failureStage = 'export';
  const exported = productRequest(cli, dataDir, 'artifact.export', request.scope,
    { bundleId: request.bundleId, expectedManifestHash: manifestHash, exportName }, idempotencyKey);
  failureStage = 'export_path';
  const exportRoot = realpathSync(join(dataDir, 'exports'));
  const exportPath = realpathSync(exported?.path);
  if (!within(exportRoot, exportPath) || exportPath === exportRoot ||
      exported.manifestHash !== manifestHash || !lstatSync(exportPath).isDirectory())
    throw new Error('invalid product export');
  failureStage = 'reinspect';
  const after = productRequest(cli, dataDir, 'artifact.inspect', request.scope,
    { bundleId: request.bundleId });
  if (after.manifestHash !== manifestHash || after.ready !== true) throw new Error('bundle changed during archive');
  failureStage = 'archive';
  return archiveFiles(exportPath, evidenceRoot, manifest, bytes, request);
}

try { console.log(JSON.stringify(await main())); }
catch {
  console.error('Bundle evidence archive failed; inspect the local product and evidence directory.');
  console.error(JSON.stringify({ stage: failureStage, reason: failureReason, exitCode: failureExitCode }));
  process.exitCode = 1;
}
