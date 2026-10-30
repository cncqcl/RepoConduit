import catalog from '../../../contracts/operation-catalog.json' with { type: 'json' };

export type Surface = 'external_mcp' | 'local_host' | 'local_cli' | 'local_admin';
export type Effect = 'read' | 'state_write' | 'agent_job' | 'job_control' | 'artifact_write' | 'artifact_transfer' | 'external_send' | 'local_export' | 'admin_write';

export interface RepositoryReadBinding {
  workspaceId: string;
  collaborationId: string;
  workingCopyId: string;
  snapshotId: string;
  path: string;
}

export interface RepositoryReadObservation {
  snapshotId: string; path: string; contentHash: string;
  byteRange: { start: number; end: number };
  lineRange: { start: number; end: number };
  content: string; decoding: 'utf-8'; completeness: 'complete' | 'partial';
}

export interface RepositoryReadReservation {
  complete(observed: RepositoryReadObservation): Promise<string> | string;
}

export interface RequestContext {
  principal: string;
  audience: string;
  surface: Surface;
  recipient: string;
  now: Date;
  /** Transport-verified permission ceiling. Missing for local trusted transports. */
  delegatedPermissions?: readonly string[];
  /** Trusted transport callback; checked after awaits before mutation or disclosure. Never supplied by a wire command. */
  assertFreshAuthority?: () => Promise<void>;
  /** Trusted request-level reservation, never supplied by an MCP command. */
  reserveRepositoryRead?: (read: RepositoryReadBinding) =>
    Promise<RepositoryReadReservation | void> | RepositoryReadReservation | void;
}

export interface ResourceScope {
  workspaceId: string;
  collaborationId?: string;
}

export interface Grant {
  id: string;
  principal: string;
  audience: string;
  workspaceId: string;
  collaborationId?: string;
  recipient?: string;
  permissions: readonly string[];
  /** Workspace-relative files, or directory prefixes ending in '/'. */
  dataPaths?: readonly string[];
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface Permit {
  grantId: string;
  operation: string;
  effect: Effect;
  scope: ResourceScope;
  principal: string;
  recipient: string;
  dataPaths?: readonly string[];
}

function validDataPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
    !path.includes('\\') && !path.includes('\0') && !path.includes(':') &&
    path.split('/').every((segment, index, segments) =>
      (segment.length > 0 || (index === segments.length - 1 && path.endsWith('/'))) &&
      segment !== '.' && segment !== '..');
}

/** Match a canonical workspace-relative file against an authorized file or directory prefix. */
export function isDataPathPermitted(path: string, dataPaths: readonly string[]): boolean {
  return validDataPath(path) && !path.endsWith('/') && dataPaths.some((allowed) =>
    validDataPath(allowed) && (allowed.endsWith('/') ? path.startsWith(allowed) : path === allowed));
}

export function validDataPaths(paths: unknown): paths is readonly string[] {
  return Array.isArray(paths) && paths.length > 0 && paths.every(validDataPath);
}

export class PolicyError extends Error {
  readonly code = 'NOT_AVAILABLE';
  constructor() {
    super('Resource or operation is not available');
  }
}

export function operationPolicy(name: string): { effect: Effect; requiredGrant: string; surfaces: Surface[]; idempotencyRequired: boolean } {
  const item = catalog.operations.find((entry) => entry.name === name);
  if (!item) throw new PolicyError();
  return {
    effect: item.effect as Effect,
    requiredGrant: item.required_grant,
    surfaces: item.surfaces as Surface[],
    idempotencyRequired: item.idempotency_required,
  };
}

/** Transport-derived identity is required; payload fields never supply authority. */
export function authorize(context: RequestContext, operation: string, scope: ResourceScope, grants: readonly Grant[]): Permit {
  const policy = operationPolicy(operation);
  if (!policy.surfaces.includes(context.surface) || !scope.workspaceId || !context.principal || !context.audience || !context.recipient ||
      (context.delegatedPermissions !== undefined && !context.delegatedPermissions.includes(policy.requiredGrant))) {
    throw new PolicyError();
  }
  const now = context.now.getTime();
  const matching = grants.filter((candidate) =>
    candidate.principal === context.principal &&
    candidate.audience === context.audience &&
    candidate.workspaceId === scope.workspaceId &&
    (!candidate.collaborationId || candidate.collaborationId === scope.collaborationId) &&
    (context.surface === 'external_mcp' ? candidate.recipient === context.recipient :
      (!candidate.recipient || candidate.recipient === context.recipient)) &&
    candidate.permissions.includes(policy.requiredGrant) &&
    (policy.requiredGrant !== 'data.read' || validDataPaths(candidate.dataPaths)) &&
    candidate.revokedAt === null &&
    (candidate.expiresAt === null || Date.parse(candidate.expiresAt) > now),
  );
  const grant = matching[0];
  if (!grant) throw new PolicyError();
  const dataPaths = policy.requiredGrant === 'data.read'
    ? [...new Set(matching.flatMap((candidate) => candidate.dataPaths ?? []))]
    : undefined;
  return { grantId: grant.id, operation, effect: policy.effect, scope, principal: context.principal, recipient: context.recipient,
    ...(dataPaths ? { dataPaths } : {}) };
}
