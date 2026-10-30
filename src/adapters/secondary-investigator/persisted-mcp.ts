import type { McpServer } from '@modelcontextprotocol/server';
import type { DispatchService } from '../../application/dispatch.js';
import type { SqliteInvestigationStore, InvestigationClaim, RunningReadBinding } from '../storage/investigation-sqlite.js';
import type { RepositoryReadBinding, RepositoryReadReservation } from '../../core/policy/authorize.js';
import { createScopedInvestigatorMcpServer, type InvestigatorReadTicket } from './scoped-mcp.js';

export interface PersistedInvestigatorMcpOptions {
  claim: InvestigationClaim;
  store: Pick<SqliteInvestigationStore, 'get' | 'assertRunningReadAuthority'> & {
    reserveRunningRead(claim: InvestigationClaim, binding: RunningReadBinding,
      read: RepositoryReadBinding, now: Date): RepositoryReadReservation | void;
  };
  workerGrantId: string;
  workerAudience: string;
  workerRecipient: string;
  dispatcher: Pick<DispatchService, 'dispatch'>;
}

/** Trusted runtime factory. The MCP caller never supplies an attempt, identity, or readable scope. */
export function createPersistedInvestigatorMcpServer(options: PersistedInvestigatorMcpOptions): McpServer {
  const claim = structuredClone(options.claim);
  const record = options.store.get(claim.requestId);
  if (!record || record.workspaceId !== claim.workspaceId) throw new Error('NOT_AVAILABLE');
  const paths = [...new Set([...record.scope.paths, ...record.scope.relatedTests])].sort();
  const binding: RunningReadBinding = {
    collaborationId: record.collaborationId, workingCopyId: record.workingCopyId,
    snapshotId: record.snapshotRef, paths,
    workerGrantId: options.workerGrantId, workerAudience: options.workerAudience,
    workerRecipient: options.workerRecipient,
  };
  options.store.assertRunningReadAuthority(claim, binding, new Date());
  const ticket: InvestigatorReadTicket = {
    requestId: record.id, attemptId: claim.attemptId, workerEpoch: claim.workerEpoch,
    workspaceId: record.workspaceId, collaborationId: record.collaborationId,
    workingCopyId: record.workingCopyId, snapshotId: record.snapshotRef, paths,
  };
  return createScopedInvestigatorMcpServer({
    ticket,
    context: { principal: claim.workerId, audience: options.workerAudience,
      recipient: options.workerRecipient, surface: 'external_mcp', now: new Date(),
      delegatedPermissions: ['data.read'],
      reserveRepositoryRead: (read) => options.store.reserveRunningRead(claim, binding, read, new Date()) },
    dispatcher: options.dispatcher,
    isAttemptActive: (observed) => {
      if (observed.requestId !== ticket.requestId || observed.attemptId !== ticket.attemptId ||
          observed.workerEpoch !== ticket.workerEpoch || observed.workspaceId !== ticket.workspaceId ||
          observed.collaborationId !== ticket.collaborationId ||
          observed.workingCopyId !== ticket.workingCopyId || observed.snapshotId !== ticket.snapshotId ||
          JSON.stringify(observed.paths) !== JSON.stringify(ticket.paths)) return false;
      try { options.store.assertRunningReadAuthority(claim, binding, new Date()); return true; }
      catch { return false; }
    },
  });
}
