import type { McpServer } from '@modelcontextprotocol/server';
import type { Command, DispatchService } from '../../application/dispatch.js';
import { validDataPaths, type RequestContext } from '../../core/policy/authorize.js';
import { createExternalMcpServer } from '../mcp/server.js';

/** Trusted scheduler state. None of these fields comes from the model's tool arguments. */
export interface InvestigatorReadTicket {
  requestId: string;
  attemptId: string;
  workerEpoch: number;
  workspaceId: string;
  collaborationId: string;
  workingCopyId: string;
  snapshotId: string;
  /** Exact canonical file paths from this request, including approved related tests. */
  paths: readonly string[];
}

export interface ScopedInvestigatorMcpOptions {
  context: RequestContext;
  ticket: InvestigatorReadTicket;
  dispatcher: Pick<DispatchService, 'dispatch'>;
  /** Read durable request/attempt/epoch/lease and revocation state at each authority checkpoint. */
  isAttemptActive(ticket: InvestigatorReadTicket): Promise<boolean> | boolean;
}

function validTicket(ticket: InvestigatorReadTicket): boolean {
  return [ticket.requestId, ticket.attemptId, ticket.workspaceId, ticket.collaborationId,
    ticket.workingCopyId, ticket.snapshotId].every(value => typeof value === 'string' && !!value.trim()) &&
    Number.isSafeInteger(ticket.workerEpoch) && ticket.workerEpoch > 0 &&
    validDataPaths(ticket.paths) && ticket.paths.every(path => !path.endsWith('/')) &&
    new Set(ticket.paths).size === ticket.paths.length;
}

/** One attempt gets only exact file reads; DispatchService still owns grant and snapshot authorization. */
export function createScopedInvestigatorMcpServer(options: ScopedInvestigatorMcpOptions): McpServer {
  if (!validTicket(options.ticket) || options.context.surface !== 'external_mcp') {
    throw new TypeError('Invalid investigator MCP binding');
  }
  const ticket: InvestigatorReadTicket = { ...options.ticket, paths: [...options.ticket.paths] };
  const permitted = new Set(ticket.paths);
  const scopedContext: RequestContext = {
    ...options.context,
    async assertFreshAuthority() {
      await options.context.assertFreshAuthority?.();
      if (await options.isAttemptActive(ticket) !== true) throw new Error('NOT_AVAILABLE');
    },
  };
  return createExternalMcpServer({
    context: scopedContext,
    visibleOperations: ['repo.read'],
    allowedWorkspaceId: ticket.workspaceId,
    allowedCollaborationId: ticket.collaborationId,
    dispatcher: {
      async dispatch(context: RequestContext, command: Command): Promise<unknown> {
        const payload = command.payload as Record<string, unknown>;
        if (command.operation !== 'repo.read' || command.scope.workspaceId !== ticket.workspaceId ||
            command.scope.collaborationId !== ticket.collaborationId ||
            payload.workingCopyId !== ticket.workingCopyId || payload.snapshotId !== ticket.snapshotId ||
            typeof payload.path !== 'string' || !permitted.has(payload.path)) {
          throw new Error('NOT_AVAILABLE');
        }
        const result = await options.dispatcher.dispatch(context, command);
        return result;
      },
    },
  });
}
