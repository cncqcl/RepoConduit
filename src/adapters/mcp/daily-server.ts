import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RequestContext } from '../../core/policy/authorize.js';
import type { DispatchService, TrustedFileTransfer } from '../../application/dispatch.js';
import type { DailyUseApplication } from '../../application/daily-use.js';
import { publishDailyDelivery } from '../../application/daily-delivery.js';
import { readDailyInvestigation, submitDailyInvestigation } from '../../application/daily-investigation.js';
import { PlatformFileDownloadError, type PlatformFileInput } from './platform-file-download.js';

export interface DailyMcpOptions {
  daily: DailyUseApplication;
  dispatcher: Pick<DispatchService, 'dispatch'>;
  context: RequestContext;
  resolveFileTransfer?: (file: PlatformFileInput) => TrustedFileTransfer;
  /** Trusted local runtime composition only. Never grants investigation permission by itself. */
  investigationsEnabled?: boolean;
}

/** Installation-scoped recipient; each call explicitly chooses a grant-checked topic. */
export function createDailyMcpServer(options: DailyMcpOptions): McpServer {
  if (options.context.surface !== 'external_mcp') throw new Error('Authenticated external context required');
  const server = new McpServer({ name: 'repo-conduit-daily', version: '0.1.0' });
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) ?? 'null' }] });
  type FileFailurePhase = 'file_reference_preflight' | 'delivery';
  const guarded = async (action: () => unknown, fileDelivery = false, phase?: () => FileFailurePhase) => {
    try { return result(await action()); }
    catch (error) {
      return { isError: true, ...result({ error: 'Request failed or resource unavailable',
        ...(fileDelivery ? { manualImportAvailable: true,
          failurePhase: phase?.() ?? 'delivery',
          failureReason: error instanceof PlatformFileDownloadError ? error.inputFailure ?? 'unclassified' : 'unclassified',
          ...(error instanceof PlatformFileDownloadError ? { downloadStage: error.stage } : {}),
          automaticAttemptsExhausted: error instanceof PlatformFileDownloadError && error.retryExhausted,
          nextAction: 'Download the original files from their original source. In local Codex, use rcac receive for the selected project and topic with a new recovery version. Preserve the failed delivery.' } : {}) }) };
    }
  };
  const annotations = (readOnlyHint: boolean) => ({ readOnlyHint, destructiveHint: false, openWorldHint: false, idempotentHint: true });
  server.registerTool('projects', { description: 'List projects currently shared with this connection. Never registers a local directory.',
    inputSchema: z.object({}).strict(), annotations: annotations(true) },
  () => guarded(() => options.daily.listProjects(options.context)));
  const project = z.string().min(1).describe('Exact project id returned by projects, or its unique authorized name. Call projects first. Ambiguous names or conflicting identifiers are rejected.');
  server.registerTool('topics', { description: 'List topics in an authorized project. Use returned handles, or open_topic to start from locally published frozen project material.',
    inputSchema: z.object({ project }).strict(), annotations: annotations(true) },
  input => guarded(() => options.daily.listProjectTopics(options.context, { project: input.project })));
  server.registerTool('open_topic', { description: 'Create or continue a named topic from the locally shared frozen project material. Does not read live files, change permissions, or accept the new question as a local decision.',
    inputSchema: z.object({ project, title: z.string().min(1).max(256),
      question: z.string().min(1).max(16384) }).strict(), annotations: annotations(false) },
  input => guarded(() => options.daily.openProjectTopic(options.context,
    { project: input.project, title: input.title, question: input.question })));
  server.registerTool('context', { description: 'Read the selected topic background and its exact evidence baseline.',
    inputSchema: z.object({ topic: z.string().min(1) }).strict(), annotations: annotations(true) },
  input => guarded(async () => {
    const topic = await options.daily.resolveTopic(options.context, { topicHandle: input.topic });
    const revision = await options.dispatcher.dispatch(options.context, { operation: 'context.read',
      scope: { workspaceId: topic.workspaceId, collaborationId: topic.collaborationId }, payload: { revisionId: topic.contextRevisionId } }) as Record<string, unknown>;
    return { ...revision, discussionQuestion: { text: topic.question,
      status: revision.inheritedFrom ? 'unaccepted' : 'local_prepared' } };
  }));
  server.registerTool('read_file', { description: 'Read a file only from the selected topic snapshot. Follow continuation for partial files.',
    inputSchema: z.object({ topic: z.string().min(1), path: z.string().min(1), cursor: z.string().optional(),
      maxBytes: z.number().int().min(1).max(262144).optional(), maxLines: z.number().int().min(1).max(2000).optional() }).strict(),
    annotations: annotations(true) }, input => guarded(async () => {
      const topic = await options.daily.resolveTopic(options.context, { topicHandle: input.topic });
      return options.dispatcher.dispatch(options.context, { operation: 'repo.read',
        scope: { workspaceId: topic.workspaceId, collaborationId: topic.collaborationId },
        payload: { workingCopyId: topic.workingCopyId, snapshotId: topic.snapshotId, path: input.path,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
          ...(input.maxLines === undefined ? {} : { maxLines: input.maxLines }) } });
    }));
  server.registerTool('read_original', { description: 'Retrieve complete original file bytes from the selected frozen topic as a standard MCP embedded resource. No chat history is required; if your client cannot consume this resource, report that limitation rather than rewriting the file.',
    inputSchema: z.object({ topic: z.string().min(1), path: z.string().min(1),
      maxBytes: z.number().int().min(1).max(32 * 1024 * 1024).optional() }).strict(), annotations: annotations(true) },
  async input => {
    try {
      const topic = await options.daily.resolveTopic(options.context, { topicHandle: input.topic });
      const original = await options.dispatcher.dispatch(options.context, { operation: 'repo.read_original',
        scope: { workspaceId: topic.workspaceId, collaborationId: topic.collaborationId },
        payload: { workingCopyId: topic.workingCopyId, snapshotId: topic.snapshotId, path: input.path,
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }) } }) as {
          data: string; snapshotId: string; path: string; contentHash: string; byteLength: number;
          mediaType: string; completeness: 'complete'; encoding: 'base64';
        };
      const { data, ...metadata } = original;
      return { content: [{ type: 'text' as const, text: JSON.stringify(metadata) },
        { type: 'resource' as const, resource: { uri: `rcac:snapshot:${encodeURIComponent(original.snapshotId)}:${encodeURIComponent(original.path)}`,
          mimeType: original.mediaType, blob: data } }] };
    } catch {
      return { isError: true, ...result({ error: 'Original file unavailable for this topic or client',
        nextAction: 'Keep the original file unchanged; ask local Codex for an authorized original-file export for manual attachment.' }) };
    }
  });
  const delivery = { topic: z.string().min(1), version: z.string().min(1).max(128), parentVersion: z.string().min(1).max(128).optional() };
  server.registerTool('deliver_text', { description: 'Publish a versioned set of text files to this topic inbox. Reuse the same version and exact files to reconcile an interrupted call. Does not authorize implementation.',
    inputSchema: z.object({ ...delivery, files: z.array(z.object({ path: z.string().min(1), text: z.string(),
      mediaType: z.string().default('text/markdown') }).strict()).min(1).max(256) }).strict(), annotations: annotations(false) },
  input => guarded(() => publishDailyDelivery(options.daily, options.dispatcher, options.context, {
    topicHandle: input.topic, version: input.version, files: input.files,
    ...(input.parentVersion === undefined ? {} : { parentVersion: input.parentVersion }) })));
  if (options.resolveFileTransfer) server.registerTool('deliver_files', {
    description: 'Receive original platform files into the topic inbox. Each transient GET retries within one total deadline. After failure, preserve this version and use local manual import; never regenerate originals.',
    inputSchema: z.object({ ...delivery, files: z.array(z.object({ download_url: z.string(), file_id: z.string(),
      mime_type: z.string().optional(), file_name: z.string().optional().describe('Optional platform metadata. Delivery requires a nonempty target relative filename; missing names are rejected, never inferred from a URL or file ID.') }).strict()).min(1).max(256) }).strict(),
    annotations: annotations(false), _meta: { 'openai/fileParams': ['files'] },
  }, input => {
    let phase: FileFailurePhase = 'file_reference_preflight';
    return guarded(() => {
      const files = input.files.map(file => {
        if (!file.file_name) throw new PlatformFileDownloadError('input', false, 'target_name_missing');
        return { path: file.file_name, mediaType: file.mime_type ?? 'application/octet-stream', transfer: options.resolveFileTransfer!(file) };
      });
      phase = 'delivery';
      return publishDailyDelivery(options.daily, options.dispatcher, options.context, {
        topicHandle: input.topic, version: input.version, files,
        ...(input.parentVersion === undefined ? {} : { parentVersion: input.parentVersion }),
      });
    }, true, () => phase);
  });
  if (options.investigationsEnabled === true) {
    const topic = z.string().min(1).describe('Exact topic handle returned by topics or open_topic. Never infer from a chat URL.');
    const investigation = z.string().min(1).max(128).describe('Investigation handle returned by investigate for this topic.');
    server.registerTool('investigate', {
      description: 'Request a bounded read-only local investigation of this topic frozen baseline. Requires explicit local project enablement. Reuse the same requestName and exact input to reconcile; never retry unknown execution as a new request. Runtime and budget are locally selected.',
      inputSchema: z.object({ topic, requestName: z.string().min(1).max(128), question: z.string().min(1).max(16384),
        scope: z.object({ paths: z.array(z.string()).max(64), symbols: z.array(z.string()).max(64),
          relatedTests: z.array(z.string()).max(64) }).strict(),
        requestedOutputs: z.array(z.enum(['flow', 'evidence', 'gaps'])).min(1).max(3),
        parentInvestigation: investigation.optional() }).strict(), annotations: annotations(false),
    }, input => guarded(() => submitDailyInvestigation(options, options.context, input)));
    for (const [name, operation, readOnly, description] of [
      ['investigation_status', 'investigate.get', true, 'Read the current durable investigation state for this topic; unknown or failed execution is not permission to restart.'],
      ['investigation_result', 'investigate.result', true, 'Read available investigation findings under current topic and data permissions. A pending request can have no result.'],
      ['cancel_investigation', 'investigate.cancel', false, 'Request cancellation of this topic investigation. Cancellation is complete only when the stored state confirms it; never assume a running worker has stopped.'],
    ] as const) server.registerTool(name, {
      description, inputSchema: z.object({ topic, investigation }).strict(), annotations: annotations(readOnly),
    }, input => guarded(() => readDailyInvestigation(options, options.context, operation, input)));
  }
  return server;
}
