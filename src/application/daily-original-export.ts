import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { authorize, isDataPathPermitted, type Grant, type RequestContext } from '../core/policy/authorize.js';
import { validateArtifactPaths } from '../core/artifact/paths.js';
import type { DailyUseApplication } from './daily-use.js';
import type { DispatchService } from './dispatch.js';

/** Local application export. The adapter supplies only the owned installation's export root. */
export async function exportDailyOriginals(daily: DailyUseApplication, dispatcher: Pick<DispatchService, 'dispatch'>,
  grants: (context: RequestContext) => readonly Grant[], context: RequestContext, exportRoot: string,
  input: { topicHandle: string; paths: string[] }): Promise<{ path: string; snapshotId: string; files: { path: string; sha256: string; byteLength: number }[] }> {
  if (!['local_cli', 'local_host'].includes(context.surface) || context.audience !== 'local-os' ||
      context.principal !== context.recipient || !input.paths.length || input.paths.length > 256) throw new Error('NOT_AVAILABLE');
  validateArtifactPaths(input.paths);
  const topic = await daily.resolveTopic(context, { topicHandle: input.topicHandle });
  const scope = { workspaceId: topic.workspaceId, collaborationId: topic.collaborationId };
  const permitted = async () => {
    await context.assertFreshAuthority?.();
    const current = { ...context, now: new Date() };
    const currentGrants = grants(current);
    authorize(current, 'artifact.export', scope, currentGrants);
    const read = authorize(current, 'repo.read_original', scope, currentGrants);
    if (input.paths.some(path => !isDataPathPermitted(path, read.dataPaths ?? []))) throw new Error('NOT_AVAILABLE');
  };
  await permitted();
  const originals: { path: string; sha256: string; byteLength: number; bytes: Buffer }[] = [];
  let total = 0;
  for (const path of input.paths) {
    const original = await dispatcher.dispatch(context, { operation: 'repo.read_original', scope,
      payload: { workingCopyId: topic.workingCopyId, snapshotId: topic.snapshotId, path } }) as {
      snapshotId: string; path: string; contentHash: string; byteLength: number; data: string;
    };
    await permitted();
    if (original.snapshotId !== topic.snapshotId || original.path !== path || typeof original.data !== 'string' ||
        original.data.length > 24 * 1024 * 1024 || !Number.isSafeInteger(original.byteLength) || original.byteLength < 0) throw new Error('INTEGRITY_ERROR');
    const bytes = Buffer.from(original.data, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (bytes.toString('base64') !== original.data || bytes.length !== original.byteLength || hash !== original.contentHash) throw new Error('INTEGRITY_ERROR');
    if ((total += bytes.length) > 128 * 1024 * 1024) throw new Error('LIMIT_EXCEEDED');
    originals.push({ path, sha256: hash, byteLength: bytes.length, bytes });
  }
  await permitted();
  if (!existsSync(exportRoot)) mkdirSync(exportRoot, { mode: 0o700 });
  if (!lstatSync(exportRoot).isDirectory() || lstatSync(exportRoot).isSymbolicLink()) throw new Error('NOT_AVAILABLE');
  const root = realpathSync(exportRoot);
  const destination = mkdtempSync(join(root, 'originals-'));
  for (const original of originals) {
    const target = join(destination, 'files', ...original.path.split('/'));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, original.bytes, { flag: 'wx', mode: 0o600 });
  }
  await permitted();
  const files = originals.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength }));
  // Completion is published last. Interrupted directories remain private and are never reported as ready.
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ schemaVersion: 1, snapshotId: topic.snapshotId,
    workspaceId: topic.workspaceId, collaborationId: topic.collaborationId, files,
    route: 'authorized_local_original_export', manualAttachmentRequired: true }), { flag: 'wx', mode: 0o600 });
  return { path: destination, snapshotId: topic.snapshotId, files };
}
