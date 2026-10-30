import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import catalog from '../../../contracts/operation-catalog.json' with { type: 'json' };
import type { Command, DispatchService, TrustedFileTransfer } from '../../application/dispatch.js';
import type { RequestContext } from '../../core/policy/authorize.js';

/** Operations currently wired through DispatchService. Catalog entries alone do not imply implementation. */
const implementedExternalOperations = new Set([
  'collab.open', 'collab.get', 'collab.list',
  'context.propose', 'context.read', 'decision.propose',
  'repo.inspect', 'repo.list', 'repo.read', 'repo.search', 'repo.status', 'repo.diff',
  'investigate.submit', 'investigate.get', 'investigate.result', 'investigate.cancel',
  'artifact.begin', 'artifact.put_text', 'artifact.import_reference', 'artifact.status', 'artifact.finalize', 'artifact.abort',
]);

const scopeSchema = z.object({
  workspaceId: z.string().min(1),
  collaborationId: z.string().min(1).optional(),
}).strict();
const payloadSchema = z.record(z.string(), z.unknown());
const readInputSchema = z.object({ scope: scopeSchema, payload: payloadSchema }).strict();
const writeInputSchema = readInputSchema.extend({ idempotencyKey: z.string().min(1) });
const beginInputSchema = writeInputSchema.extend({ payload: z.object({
  bundleId: z.string(), contextRevision: z.string(), snapshotRefs: z.array(z.string()),
  parentBundleId: z.string().optional(), expectedPaths: z.array(z.string()).optional(),
}).strict() });
const putTextInputSchema = writeInputSchema.extend({ payload: z.object({
  bundleId: z.string(), path: z.string(), text: z.string(), mediaType: z.string(),
}).strict() });
const importPayloadSchema = z.object({ bundleId: z.string(), path: z.string() }).strict();
const bundleIdPayloadSchema = z.object({ bundleId: z.string() }).strict();
const bundleIdReadInputSchema = readInputSchema.extend({ payload: bundleIdPayloadSchema });
const bundleIdWriteInputSchema = writeInputSchema.extend({ payload: bundleIdPayloadSchema });
const platformFileSchema = z.object({
  download_url: z.string().url(), file_id: z.string().min(1),
  mime_type: z.string().optional(), file_name: z.string().optional(),
}).strict();
const fileInputSchema = writeInputSchema.extend({ payload: importPayloadSchema, file: platformFileSchema });
const repoBasePayload = { workingCopyId: z.string().min(1), snapshotId: z.string().min(1) };
const repoPagePayload = { maxEntries: z.number().int().optional(), cursor: z.string().min(1).optional() };
const repoReadPagePayload = { maxBytes: z.number().int().optional(), cursor: z.string().min(1).optional() };
const repoReadOutputSchema = z.object({
  snapshotId: z.string(), path: z.string(), content: z.string(), contentHash: z.string(),
  lineRange: z.object({ start: z.number().int(), end: z.number().int() }).strict(),
  byteRange: z.object({ start: z.number().int(), end: z.number().int() }).strict(),
  decoding: z.literal('utf-8'), completeness: z.enum(['complete', 'partial']),
  continuation: z.string().optional(), toolReceipt: z.string().optional(),
}).strict();
const contextContentSchema = z.object({
  goal: z.string(), constraints: z.array(z.string()), acceptedDecisions: z.array(z.string()),
  rejectedDecisions: z.array(z.string()), currentQuestions: z.array(z.string()),
  evidenceRefs: z.array(z.string()), expectedDeliverables: z.array(z.string()),
  unknowns: z.array(z.string()), recentChanges: z.array(z.string()),
}).strict();
const investigationInputSchema = z.object({
  contextRevisionId: z.string().min(1), snapshotRef: z.string().min(1), question: z.string().min(1),
  scope: z.object({ paths: z.array(z.string()), symbols: z.array(z.string()),
    relatedTests: z.array(z.string()) }).strict(),
  requestedOutputs: z.array(z.enum(['flow', 'evidence', 'gaps'])),
  parentInvestigationId: z.string().min(1).nullable().optional(),
}).strict();
const operationPayloads: Record<string, z.ZodObject<z.ZodRawShape>> = {
  'collab.open': z.object({ purpose: z.string() }).strict(),
  'collab.get': z.object({}).strict(),
  'collab.list': z.object({}).strict(),
  'context.read': z.object({ proposalId: z.string().min(1).optional(), revisionId: z.string().min(1).optional() }).strict(),
  'context.propose': z.object({ proposalId: z.string().min(1), parentRevisionId: z.string().nullable(),
    snapshotId: z.string().min(1), sourceRefs: z.array(z.string()), content: contextContentSchema }).strict(),
  'decision.propose': z.object({ proposalId: z.string().min(1).max(128),
    contextRevisionId: z.string().min(1).max(256), snapshotId: z.string().min(1).max(256),
    recommendation: z.enum(['accept','modify','reject']), reason: z.string().min(1).max(16384),
    bundleId: z.string().min(1).max(128).optional(),
    bundleManifestHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
  'repo.inspect': z.object(repoBasePayload).strict(),
  'repo.status': z.object(repoBasePayload).strict(),
  'repo.list': z.object({ ...repoBasePayload, ...repoPagePayload }).strict(),
  'repo.read': z.object({ ...repoBasePayload, path: z.string().min(1),
    ...repoReadPagePayload, maxLines: z.number().int().optional() }).strict(),
  'repo.search': z.object({ ...repoBasePayload, term: z.string().min(1),
    ...repoReadPagePayload, maxMatches: z.number().int().optional() }).strict(),
  'repo.diff': z.object({ ...repoBasePayload, beforeSnapshotId: z.string().min(1), ...repoPagePayload }).strict(),
  'investigate.get': z.object({ workingCopyId: z.string().min(1), requestId: z.string().min(1) }).strict(),
  'investigate.result': z.object({ workingCopyId: z.string().min(1), requestId: z.string().min(1) }).strict(),
  'investigate.cancel': z.object({ workingCopyId: z.string().min(1), requestId: z.string().min(1) }).strict(),
  'investigate.submit': z.object({ workingCopyId: z.string().min(1), input: investigationInputSchema }).strict(),
};
type ExternalToolInput = z.infer<typeof readInputSchema> & {
  idempotencyKey?: string;
  file?: z.infer<typeof platformFileSchema>;
};

export interface ExternalMcpServerOptions {
  dispatcher: Pick<DispatchService, 'dispatch'>;
  /** Created by a trusted transport after authenticating and binding the caller. */
  context: RequestContext;
  /** Already authorized discovery set for this connection; direct calls are still checked by dispatch. */
  visibleOperations: readonly string[];
  /** Local transport binding may limit this connection to one preauthorized workspace. */
  allowedWorkspaceId?: string;
  /** A collaboration-bound connection cannot list or open other collaborations. */
  allowedCollaborationId?: string;
  /** Platform file fields are parsed here; the resolver supplies a bounded, trusted transfer. */
  resolveFileTransfer?: (file: z.infer<typeof platformFileSchema>) => TrustedFileTransfer;
}

/** Builds one connection-bound MCP server. No request argument can replace its identity. */
export function createExternalMcpServer(options: ExternalMcpServerOptions): McpServer {
  if (options.context.surface !== 'external_mcp' || !options.context.principal ||
      !options.context.audience || !options.context.recipient) {
    throw new Error('Authenticated external MCP context required');
  }
  const boundContext: RequestContext = { ...options.context, now: new Date(options.context.now) };
  const server = new McpServer({ name: 'repo-conduit', version: '0.1.0' });
  const visible = new Set(options.visibleOperations);

  for (const entry of catalog.operations) {
    if (!entry.surfaces.includes('external_mcp') || !implementedExternalOperations.has(entry.name) ||
        !visible.has(entry.name)) continue;
    if (entry.name === 'artifact.import_reference' && !options.resolveFileTransfer) continue;
    const isRead = entry.effect === 'read';
    const isFileImport = entry.name === 'artifact.import_reference';
    const inputSchema = operationPayloads[entry.name] ?
      (entry.idempotency_required ? writeInputSchema : readInputSchema).extend({ payload: operationPayloads[entry.name] }) :
      entry.name === 'artifact.begin' ? beginInputSchema :
      entry.name === 'artifact.put_text' ? putTextInputSchema :
      isFileImport ? fileInputSchema :
      entry.name === 'artifact.status' ? bundleIdReadInputSchema :
      entry.name === 'artifact.finalize' || entry.name === 'artifact.abort' ? bundleIdWriteInputSchema :
      entry.idempotency_required ? writeInputSchema : readInputSchema;
    server.registerTool(entry.name, {
      description: entry.summary,
      inputSchema,
      ...(entry.name === 'repo.read' ? { outputSchema: repoReadOutputSchema } : {}),
      annotations: {
        readOnlyHint: isRead,
        destructiveHint: entry.name === 'artifact.abort',
        idempotentHint: isRead || entry.idempotency_required,
        openWorldHint: false,
      },
      ...(isFileImport ? { _meta: { 'openai/fileParams': ['file'] } } : {}),
    }, async (input: ExternalToolInput) => {
      if ((options.allowedWorkspaceId && input.scope.workspaceId !== options.allowedWorkspaceId) ||
          (options.allowedCollaborationId && (entry.name === 'collab.open' || entry.name === 'collab.list' ||
            input.scope.collaborationId !== options.allowedCollaborationId))) {
        return { isError: true, content: [{ type: 'text' as const, text: 'Request failed or resource unavailable' }] };
      }
      const command: Command = {
        operation: entry.name,
        scope: { workspaceId: input.scope.workspaceId,
          ...(input.scope.collaborationId === undefined ? {} : { collaborationId: input.scope.collaborationId }) },
        payload: input.payload,
        ...('idempotencyKey' in input && typeof input.idempotencyKey === 'string' ?
          { idempotencyKey: input.idempotencyKey } : {}),
      };
      try {
        const transfer = isFileImport ? options.resolveFileTransfer!(
          (input as z.infer<typeof fileInputSchema>).file) : undefined;
        const result = await options.dispatcher.dispatch(boundContext, command, transfer);
        const text = JSON.stringify(result) ?? 'null';
        return { content: [{ type: 'text' as const, text }],
          ...(entry.name === 'repo.read' ? { structuredContent: repoReadOutputSchema.parse(JSON.parse(text)) } : {}) };
      } catch {
        // Application errors may contain local paths or provider details. MCP callers get no such data.
        return { isError: true, content: [{ type: 'text' as const, text: 'Request failed or resource unavailable' }] };
      }
    });
  }
  return server;
}
