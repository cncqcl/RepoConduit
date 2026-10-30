import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, type StoredWorkspace } from '../adapters/storage/sqlite.js';
import type { DispatchService } from '../application/dispatch.js';
import type { Grant, RequestContext } from '../core/policy/authorize.js';
import { parseProfileConfiguration, type StaticReadonlyBudget } from '../core/investigation/trusted-profile.js';
import type { InstallationRuntime } from '../runtime/installation.js';
import { assertActiveInstallation } from '../runtime/installation.js';
import { assertPrivateDataDirectory } from '../runtime/local-security.js';
import { loadAuthorizedWindowsRuntimeSource } from '../runtime/windows-investigation-runtime-config.js';
import type { PersonalCodexInvestigatorConfiguration } from '../runtime/codex-owned-investigation.js';
import { readDailyBinding, setDailyCodexRuntimeSourceWithinInstallation,
  type DailyCodexRuntimeSource } from './daily-binding.js';

type LocalIdentity = Pick<RequestContext, 'principal' | 'audience' | 'recipient'>;
type Dispatch = Pick<DispatchService, 'dispatch'>;
const unavailable = () => new Error('NOT_AVAILABLE');
const permissions = ['investigation.request', 'investigation.read', 'investigation.cancel'];
const defaultBudget: StaticReadonlyBudget = { maxWallSeconds: 120, maxTurns: 3, maxToolCalls: 12 };
const key = (...parts: string[]) => `daily-invest-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
const active = (grant: Grant) => grant.revokedAt === null &&
  (grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.now());
const relevant = (grant: Grant, workspaceId: string, identity: LocalIdentity) =>
  grant.workspaceId === workspaceId && grant.principal === identity.principal &&
  grant.audience === identity.audience &&
  (grant.recipient === identity.recipient || identity.audience === 'local-os' && grant.recipient === undefined) &&
  grant.permissions.some(permission => permissions.includes(permission));
const dedicated = (grant: Grant, identity: LocalIdentity) => grant.recipient === identity.recipient &&
  grant.collaborationId === undefined && grant.dataPaths === undefined &&
  grant.permissions.length === permissions.length && permissions.every(permission => grant.permissions.includes(permission));

export function selectDailyInvestigationProject(store: SqliteStore, project: string): StoredWorkspace {
  if (typeof project !== 'string' || !project.trim()) throw unavailable();
  if (isAbsolute(project)) {
    const workspace = store.getWorkspaceByRoot(realpathSync(project));
    if (!workspace) throw unavailable();
    return workspace;
  }
  const matches = store.listWorkspaces().filter(workspace => workspace.name === project);
  if (matches.length !== 1) throw unavailable();
  return matches[0]!;
}

function localAdmin(context: RequestContext): RequestContext {
  if (context.surface !== 'local_cli' && context.surface !== 'local_admin' ||
      context.audience !== 'local-os' || context.recipient !== context.principal) throw unavailable();
  return { ...context, surface: 'local_admin', now: new Date() };
}

function sourceProfile(sourceRoot: string, project: string): DailyCodexRuntimeSource {
  if (!isAbsolute(sourceRoot) || resolve(sourceRoot) !== sourceRoot ||
      realpathSync.native(sourceRoot) !== sourceRoot) throw unavailable();
  assertPrivateDataDirectory(sourceRoot);
  const db = new DatabaseSync(join(sourceRoot, 'state.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT id,name,canonical_root FROM workspaces').all() as
      { id: string; name: string; canonical_root: string }[];
    const matches = isAbsolute(project)
      ? rows.filter(workspace => workspace.canonical_root === realpathSync(project))
      : rows.filter(workspace => workspace.name === project);
    if (matches.length !== 1) throw unavailable();
    const workspace = matches[0]!;
    const head = db.prepare(`SELECT r.revision_json FROM profile_heads h JOIN profile_revisions r
      ON r.id=h.revision_id WHERE h.workspace_id=?`).get(workspace.id) as { revision_json: string } | undefined;
    const profile = head ? JSON.parse(head.revision_json) as { id?: unknown; presetRef?: unknown } : null;
    if (typeof profile?.id !== 'string' || profile.presetRef !== 'static_readonly_v1') throw unavailable();
    return { dataDirectory: sourceRoot, workspaceId: workspace.id, profileRevision: profile.id };
  } finally { db.close(); }
}

/** Trusted local selection only. Runtime config and both profile authorities are checked before saving. */
export function selectDailyCodexSource(runtime: InstallationRuntime, context: RequestContext,
  sourceDirectory: string, sourceProject: string) {
  assertActiveInstallation(runtime);
  const admin = localAdmin(context);
  const source = sourceProfile(sourceDirectory, sourceProject);
  loadAuthorizedWindowsRuntimeSource(source.dataDirectory, source, source,
    { principal: admin.principal, audience: admin.audience, recipient: admin.recipient });
  const report = setDailyCodexRuntimeSourceWithinInstallation(runtime, admin, source);
  return { configured: true, sourceProject, restartRequired: report.restartRequired, saveStatus: report.saveStatus };
}

/** Resolve current target profile on every new request; never accept native selection from MCP arguments. */
export function createDailyCodexSelector(runtime: InstallationRuntime, identity: LocalIdentity,
  source: DailyCodexRuntimeSource): (workspaceId: string) => PersonalCodexInvestigatorConfiguration | null {
  assertActiveInstallation(runtime);
  return workspaceId => {
    try {
      const db = new DatabaseSync(join(runtime.dataDirectory, 'state.sqlite'), { readOnly: true });
      let profileRevision: string;
      try {
        const head = db.prepare(`SELECT r.revision_json FROM profile_heads h JOIN profile_revisions r
          ON r.id=h.revision_id WHERE h.workspace_id=?`).get(workspaceId) as { revision_json: string } | undefined;
        const current = head ? JSON.parse(head.revision_json) as { id?: unknown; presetRef?: unknown } : null;
        if (typeof current?.id !== 'string' || current.presetRef !== 'static_readonly_v1') return null;
        profileRevision = current.id;
      } finally { db.close(); }
      loadAuthorizedWindowsRuntimeSource(runtime.dataDirectory,
        { workspaceId, profileRevision }, source, identity);
      return { workspaceId, profileRevision, runtimeSource: source };
    } catch { return null; }
  };
}

function actorGrants(store: SqliteStore, identity: LocalIdentity, workspaceId: string): Grant[] {
  return store.grantsFor(identity.principal, identity.audience)
    .filter(grant => relevant(grant, workspaceId, identity));
}

function group(store: SqliteStore, identity: LocalIdentity, workspaceId: string): Grant | null {
  const current = actorGrants(store, identity, workspaceId).filter(active);
  if (current.some(grant => !dedicated(grant, identity)) || current.length > 1) throw unavailable();
  return current[0] ?? null;
}

function bindingStillSelected(root: string, expected: ReturnType<typeof readDailyBinding>): void {
  const current = readDailyBinding(root);
  if (current.principal !== expected.principal || current.audience !== expected.audience ||
      current.recipient !== expected.recipient ||
      JSON.stringify(current.codexRuntimeSource) !== JSON.stringify(expected.codexRuntimeSource)) throw unavailable();
}

async function ensureGrant(store: SqliteStore, dispatch: Dispatch, admin: RequestContext,
  workspaceId: string, identity: LocalIdentity): Promise<void> {
  if (group(store, identity, workspaceId)) return;
  const history = actorGrants(store, identity, workspaceId).map(grant => grant.id).sort();
  await dispatch.dispatch(admin, { operation: 'admin.grant', scope: { workspaceId: 'management' },
    idempotencyKey: key('grant', workspaceId, identity.principal, identity.audience,
      identity.recipient, ...history), payload: { ...identity, workspaceId, permissions, expiresAt: null } });
  if (!group(store, identity, workspaceId)) throw unavailable();
}

export async function enableDailyInvestigation(runtime: InstallationRuntime, store: SqliteStore,
  dispatch: Dispatch, context: RequestContext, project: string,
  requestedBudget: Partial<StaticReadonlyBudget> = {}) {
  assertActiveInstallation(runtime);
  const admin = localAdmin(context);
  const binding = readDailyBinding(runtime.dataDirectory);
  if (!binding.codexRuntimeSource) throw unavailable();
  const workspace = selectDailyInvestigationProject(store, project);
  const current = store.getCurrentProfileRevision(workspace.id);
  const budget = { ...(current?.budget ?? defaultBudget), ...requestedBudget };
  // The parser enforces both the trusted profile budget ceilings and closed payload keys.
  parseProfileConfiguration({ workspaceId: workspace.id, expectedRevisionId: current?.id ?? null,
    presetRef: 'static_readonly_v1', budget });
  const source = binding.codexRuntimeSource;
  loadAuthorizedWindowsRuntimeSource(source.dataDirectory, source, source,
    { principal: admin.principal, audience: admin.audience, recipient: admin.recipient });
  if (current && current.presetRef !== 'static_readonly_v1') throw unavailable();
  if (workspace.id === source.workspaceId && current?.id === source.profileRevision &&
      JSON.stringify(current.budget) !== JSON.stringify(budget)) throw unavailable();
  const desired = current && JSON.stringify(current.budget) === JSON.stringify(budget) ? current :
    await dispatch.dispatch(admin, { operation: 'admin.configure_profile', scope: { workspaceId: 'management' },
      idempotencyKey: key('profile', workspace.id, current?.id ?? 'first', JSON.stringify(budget)),
      payload: { workspaceId: workspace.id, expectedRevisionId: current?.id ?? null,
        presetRef: 'static_readonly_v1', budget } }) as { id: string; budget: StaticReadonlyBudget };
  loadAuthorizedWindowsRuntimeSource(runtime.dataDirectory,
    { workspaceId: workspace.id, profileRevision: desired.id }, source,
    { principal: admin.principal, audience: admin.audience, recipient: admin.recipient });
  const local = { principal: context.principal, audience: context.audience, recipient: context.recipient };
  const external = { principal: binding.principal, audience: binding.audience, recipient: binding.recipient };
  group(store, local, workspace.id); group(store, external, workspace.id);
  await ensureGrant(store, dispatch, admin, workspace.id, local);
  await ensureGrant(store, dispatch, admin, workspace.id, external);
  // Awaited writes may have raced another trusted local change. Report only the final observed state.
  bindingStillSelected(runtime.dataDirectory, binding);
  const finalProfile = store.getCurrentProfileRevision(workspace.id);
  if (finalProfile?.id !== desired.id ||
      JSON.stringify(finalProfile.budget) !== JSON.stringify(desired.budget)) throw unavailable();
  loadAuthorizedWindowsRuntimeSource(runtime.dataDirectory,
    { workspaceId: workspace.id, profileRevision: desired.id }, source,
    { principal: admin.principal, audience: admin.audience, recipient: admin.recipient });
  if (!group(store, local, workspace.id) || !group(store, external, workspace.id)) throw unavailable();
  return { configured: true, project: workspace.name, budget: desired.budget, investigationEnabled: true };
}

export async function disableDailyInvestigation(runtime: InstallationRuntime, store: SqliteStore,
  dispatch: Dispatch, context: RequestContext, project: string) {
  assertActiveInstallation(runtime);
  const admin = localAdmin(context);
  const workspace = selectDailyInvestigationProject(store, project);
  const binding = readDailyBinding(runtime.dataDirectory);
  const local = { principal: context.principal, audience: context.audience, recipient: context.recipient };
  const external = { principal: binding.principal, audience: binding.audience, recipient: binding.recipient };
  const selected = [group(store, local, workspace.id), group(store, external, workspace.id)].filter(
    (grant): grant is Grant => grant !== null);
  for (const grant of selected) await dispatch.dispatch(admin, { operation: 'admin.revoke',
    scope: { workspaceId: 'management' }, idempotencyKey: key('revoke', grant.id),
    payload: { grantId: grant.id } });
  bindingStillSelected(runtime.dataDirectory, binding);
  if (actorGrants(store, local, workspace.id).some(active) ||
      actorGrants(store, external, workspace.id).some(active)) throw unavailable();
  return { configured: true, project: workspace.name, investigationEnabled: false };
}
