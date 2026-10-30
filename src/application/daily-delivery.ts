import { createHash } from 'node:crypto';
import type { RequestContext } from '../core/policy/authorize.js';
import { validateArtifactPaths } from '../core/artifact/paths.js';
import { LocalArtifactSource } from '../adapters/transfers/local-source.js';
import type { DispatchService, TrustedFileTransfer } from './dispatch.js';
import type { DailyUseApplication } from './daily-use.js';

export function dailyBundleId(topicHandle: string, version: string): string {
  if (!version.trim() || version.length > 128) throw new TypeError('A short delivery version is required');
  return `bun_daily_${createHash('sha256').update(JSON.stringify([topicHandle, version])).digest('hex')}`;
}

/** Hide signed pagination from the person while retaining an explicit bounded result. */
export async function readDailyInbox(dispatcher: Pick<DispatchService, 'dispatch'>, context: RequestContext,
  scope: { workspaceId: string; collaborationId: string }): Promise<{ bundles: unknown[]; truncated: boolean }> {
  const bundles: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await dispatcher.dispatch(context, { operation: 'artifact.list', scope,
      payload: cursor === undefined ? {} : { cursor } }) as { bundles: unknown[]; nextCursor: string | null };
    if (!Array.isArray(response.bundles) || response.bundles.length > 10) throw new Error('Invalid inbox page');
    bundles.push(...response.bundles);
    if (response.nextCursor === null) return { bundles, truncated: false };
    if (typeof response.nextCursor !== 'string' || !response.nextCursor || seen.has(response.nextCursor)) throw new Error('Invalid inbox cursor');
    seen.add(response.nextCursor); cursor = response.nextCursor;
  }
  return { bundles, truncated: true };
}

export type DailyDeliveryFile = { path: string; mediaType: string } &
  ({ text: string; transfer?: never; sourcePath?: never } |
   { transfer: TrustedFileTransfer; text?: never; sourcePath?: never } |
   { sourcePath: string; text?: never; transfer?: never });

/** One orchestration for MCP delivery and local manual import. Chat history is not an input. */
export async function publishDailyDelivery(daily: DailyUseApplication,
  dispatcher: Pick<DispatchService, 'dispatch'>, context: RequestContext,
  input: { topicHandle: string; version: string; parentVersion?: string; files: DailyDeliveryFile[] }): Promise<unknown> {
  if (!input.files.length || input.files.length > 256) throw new TypeError('Select 1–256 files');
  validateArtifactPaths(input.files.map(file => file.path));
  const topic = await daily.resolveTopic(context, { topicHandle: input.topicHandle });
  const scope = { workspaceId: topic.workspaceId, collaborationId: topic.collaborationId };
  const bundleId = dailyBundleId(topic.topicHandle, input.version);
  const key = (phase: string, path = '') => `daily-${createHash('sha256').update(JSON.stringify([bundleId, phase, path])).digest('hex')}`;
  const call = (operation: string, payload: unknown, phase: string, path = '', transfer?: TrustedFileTransfer, source?: LocalArtifactSource) =>
    dispatcher.dispatch(context, { operation, scope, payload, idempotencyKey: key(phase, path) }, transfer, source);
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  await call('artifact.begin', { bundleId, contextRevision: topic.contextRevisionId, snapshotRefs: [topic.snapshotId],
    expectedPaths: files.map(file => file.path),
    ...(input.parentVersion === undefined ? {} : { parentBundleId: dailyBundleId(topic.topicHandle, input.parentVersion) }) }, 'begin');
  for (const file of files) {
    if (file.sourcePath !== undefined) {
      await call('artifact.collect_local', { bundleId, path: file.path, mediaType: file.mediaType },
        'manual', file.path, undefined, new LocalArtifactSource(file.sourcePath));
    } else if (file.transfer !== undefined) {
      await call('artifact.import_reference', { bundleId, path: file.path }, 'reference', file.path, file.transfer);
    } else {
      await call('artifact.put_text', { bundleId, path: file.path, text: file.text, mediaType: file.mediaType }, 'text', file.path);
    }
  }
  return call('artifact.finalize', { bundleId }, 'finalize');
}
