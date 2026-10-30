import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { SqliteStore, type StoredCollaboration, type StoredWorkspace } from '../adapters/storage/sqlite.js';
import { authorize, PolicyError, validDataPaths, type Grant, type RequestContext } from '../core/policy/authorize.js';
import type { ContextRevision } from '../core/collaboration/context.js';
import type { DispatchService } from './dispatch.js';
import type { SnapshotReceipt } from './repository.js';

export type ProjectSummary = { id: string; name: string };
export type TopicSummary = { topicHandle: string; title: string; projectId: string; question: string };
export type TopicBinding = TopicSummary & { workspaceId: string; collaborationId: string;
  workingCopyId: string; snapshotId: string; contextRevisionId: string };
type ExternalRecipient = { principal: string; audience: string; recipient: string };

export const localPermissions = ['collab.create', 'collab.read', 'snapshot.create', 'context.propose', 'context.accept',
  'context.read', 'data.read', 'artifact.submit', 'artifact.read', 'artifact.collect', 'artifact.export', 'decision.record'];
export const externalPermissions = ['collab.read', 'context.read', 'data.read', 'artifact.submit', 'artifact.read'];
const marker = 'daily: ';
const unavailable = () => new PolicyError();
const key = (...parts: string[]) => `daily-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
const projectSummary = (workspace: StoredWorkspace): ProjectSummary => ({ id: workspace.id, name: workspace.name });
const topicTitle = (collaboration: StoredCollaboration): string => collaboration.purpose.slice(marker.length);

/** Installed daily use entry point. All state changes and scoped reads enter the single dispatcher. */
export class DailyUseApplication {
  constructor(private readonly store: SqliteStore, private readonly dispatcher: Pick<DispatchService, 'dispatch'>) {}

  private local(ctx: RequestContext): RequestContext {
    if (ctx.surface !== 'local_admin' && ctx.surface !== 'local_cli' && ctx.surface !== 'local_host' ||
        ctx.audience !== 'local-os' || !ctx.principal || ctx.recipient !== ctx.principal) throw unavailable();
    return ctx.surface === 'local_admin' ? { ...ctx, surface: 'local_cli' } : ctx;
  }

  private admin(ctx: RequestContext): RequestContext {
    if (ctx.surface !== 'local_admin' || ctx.audience !== 'local-os' || ctx.recipient !== ctx.principal) throw unavailable();
    authorize({ ...ctx, now: new Date() }, 'admin.register_workspace', { workspaceId: 'management' },
      this.store.grantsFor(ctx.principal, ctx.audience));
    return ctx;
  }

  private root(path: string): string {
    if (typeof path !== 'string' || !path.trim()) throw unavailable();
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw unavailable();
    return canonical;
  }

  private dispatch(ctx: RequestContext, operation: string, workspaceId: string, payload: unknown,
    idempotencyKey?: string, collaborationId?: string): Promise<unknown> {
    return this.dispatcher.dispatch(ctx, { operation, scope: { workspaceId, ...(collaborationId ? { collaborationId } : {}) },
      payload, ...(idempotencyKey ? { idempotencyKey } : {}) });
  }

  private grantsFor(ctx: RequestContext, workspaceId: string): Grant[] {
    return this.store.grantsFor(ctx.principal, ctx.audience).filter((grant) => grant.workspaceId === workspaceId);
  }

  private usable(ctx: RequestContext, workspaceId: string, operation: string, collaborationId?: string): boolean {
    try { authorize({ ...ctx, now: new Date() }, operation, { workspaceId,
      ...(collaborationId ? { collaborationId } : {}) }, this.grantsFor(ctx, workspaceId)); return true; }
    catch { return false; }
  }

  private async grantIfMissing(admin: RequestContext, target: ExternalRecipient, workspaceId: string,
    permissions: string[], dataPaths: string[]): Promise<void> {
    const previous = this.grantsFor({ ...admin, ...target }, workspaceId).filter((grant) =>
      grant.recipient === target.recipient && grant.collaborationId === undefined &&
      grant.permissions.length === permissions.length && permissions.every(permission => grant.permissions.includes(permission)));
    if (previous.length) {
      const active = previous.filter(grant => grant.revokedAt === null &&
        (grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.now()));
      if (active.length !== 1 || JSON.stringify([...active[0]!.dataPaths ?? []].sort()) !==
          JSON.stringify(dataPaths)) throw unavailable();
      return;
    }
    await this.dispatch(admin, 'admin.grant', 'management', {
      principal: target.principal, audience: target.audience, workspaceId, recipient: target.recipient,
      permissions, dataPaths, expiresAt: null,
    }, key('grant', workspaceId, target.principal, target.audience, target.recipient));
  }

  /** Explicit local choice to replace the daily disclosure for one project and recipient. */
  async replaceProjectShare(ctx: RequestContext, input: { workspaceId: string; external: ExternalRecipient;
    dataPaths: string[]; expectedLocalGrantId: string; expectedExternalGrantId: string }): Promise<{
      workspaceId: string; localGrantId: string; externalGrantId: string; dataPaths: string[] }> {
    const admin = this.admin(ctx);
    if (!input?.workspaceId || !input.external?.principal?.trim() || !input.external.audience?.trim() ||
        !input.external.recipient?.trim() || !validDataPaths(input.dataPaths) ||
        !input.expectedLocalGrantId || !input.expectedExternalGrantId) throw unavailable();
    const dataPaths = [...new Set(input.dataPaths)].sort();
    return await this.dispatch(admin, 'admin.replace_project_share', 'management', {
      workspaceId: input.workspaceId, external: input.external, dataPaths,
      expectedLocalGrantId: input.expectedLocalGrantId, expectedExternalGrantId: input.expectedExternalGrantId,
    }, key('replace-share', input.workspaceId, input.external.principal, input.external.audience,
      input.external.recipient, input.expectedLocalGrantId, input.expectedExternalGrantId, JSON.stringify(dataPaths))) as {
        workspaceId: string; localGrantId: string; externalGrantId: string; dataPaths: string[] };
  }

  async prepareProject(ctx: RequestContext, input: { root: string; name?: string; dataPaths: string[];
    external: ExternalRecipient }): Promise<ProjectSummary> {
    const admin = this.admin(ctx);
    const root = this.root(input.root);
    if (!validDataPaths(input.dataPaths) || !input.external?.principal?.trim() || !input.external.audience?.trim() ||
        !input.external.recipient?.trim()) throw unavailable();
    const dataPaths = [...new Set(input.dataPaths)].sort();
    const name = input.name?.trim() || basename(root);
    let workspace = this.store.getWorkspaceByRoot(root);
    if (!workspace) {
      workspace = await this.dispatch(admin, 'admin.register_workspace', 'management', { name, root },
        key('workspace', root)) as StoredWorkspace;
    }
    if (workspace.canonicalRoot !== root || workspace.registeredBy !== ctx.principal) throw unavailable();
    let copy = this.store.getWorkingCopyByRoot(workspace.id, root);
    if (!copy) copy = await this.dispatch(admin, 'admin.register_working_copy', 'management',
      { workspaceId: workspace.id, root }, key('copy', root)) as typeof copy;
    if (!copy) throw unavailable();
    const localTarget = { principal: ctx.principal, audience: ctx.audience, recipient: ctx.recipient };
    const activeDaily = (target: ExternalRecipient, permissions: string[]): Grant[] => this.grantsFor({ ...admin, ...target }, workspace.id)
      .filter(grant => grant.recipient === target.recipient && grant.collaborationId === undefined &&
        grant.permissions.length === permissions.length && permissions.every(permission => grant.permissions.includes(permission)) &&
        grant.revokedAt === null && (grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.now()));
    const localActive = activeDaily(localTarget, localPermissions);
    const externalActive = activeDaily(input.external, externalPermissions);
    if (localActive.length > 1 || externalActive.length > 1) throw unavailable();
    const differs = (grant: Grant) => JSON.stringify([...grant.dataPaths ?? []].sort()) !== JSON.stringify(dataPaths);
    if (localActive.length === 1 && externalActive.length === 1 &&
        (differs(localActive[0]!) || differs(externalActive[0]!))) {
      await this.replaceProjectShare(admin, { workspaceId: workspace.id, external: input.external, dataPaths,
        expectedLocalGrantId: localActive[0]!.id, expectedExternalGrantId: externalActive[0]!.id });
      return projectSummary(workspace);
    }
    if (localActive.some(differs) || externalActive.some(differs)) throw unavailable();
    await this.grantIfMissing(admin, localTarget,
      workspace.id, localPermissions, dataPaths);
    await this.grantIfMissing(admin, input.external, workspace.id, externalPermissions, dataPaths);
    return projectSummary(workspace);
  }

  async publishProjectMaterial(ctx: RequestContext, input: { root: string; sourceTopicHandle: string;
    external: ExternalRecipient }): Promise<{ materialId: string; projectId: string; sourceTopicHandle: string }> {
    const admin = this.admin(ctx); const root = this.root(input.root);
    const workspace = this.store.getWorkspaceByRoot(root);
    const source = await this.resolveTopic(this.local(ctx), { topicHandle: input.sourceTopicHandle });
    if (!workspace || workspace.registeredBy !== ctx.principal || source.workspaceId !== workspace.id ||
        !input.external.principal?.trim() || !input.external.audience?.trim() || !input.external.recipient?.trim()) throw unavailable();
    const target: RequestContext = { ...input.external, surface: 'external_mcp', now: new Date() };
    for (const operation of ['collab.get', 'context.read', 'repo.read']) {
      if (!this.usable(target, workspace.id, operation, source.collaborationId)) throw unavailable();
    }
    const scopePaths = authorize({ ...target, now: new Date() }, 'repo.read',
      { workspaceId: workspace.id, collaborationId: source.collaborationId },
      this.store.grantsFor(target.principal, target.audience)).dataPaths;
    const dataPaths = [...scopePaths ?? []].sort();
    const material = await this.dispatch(admin, 'admin.publish_project_material', 'management', {
      workspaceId: workspace.id, sourceCollaborationId: source.collaborationId,
      sourceContextRevisionId: source.contextRevisionId, external: input.external, dataPaths,
    }, key('material', workspace.id, source.contextRevisionId, target.principal, target.audience, target.recipient, JSON.stringify(dataPaths))) as
      { materialId: string; projectId: string; sourceTopicHandle: string };
    if (!this.usable(target, workspace.id, 'collab.open_from_template')) {
      const prior = this.grantsFor(target, workspace.id).filter(grant => grant.recipient === target.recipient &&
        grant.collaborationId === undefined && grant.permissions.includes('collab.create'));
      if (prior.length) throw unavailable();
      await this.dispatch(admin, 'admin.grant', 'management', { ...input.external, workspaceId: workspace.id,
        permissions: ['collab.create'], expiresAt: null }, key('web-create-grant', workspace.id,
      target.principal, target.audience, target.recipient));
      if (!this.usable(target, workspace.id, 'collab.open_from_template')) throw unavailable();
    }
    return material;
  }

  async openExternalTopic(ctx: RequestContext, input: { projectId: string; title: string; question: string }): Promise<TopicSummary> {
    if (ctx.surface !== 'external_mcp' || !input.title?.trim() || input.title.length > 256 ||
        !input.question?.trim() || Buffer.byteLength(input.question, 'utf8') > 16384 || !this.usable(ctx, input.projectId, 'collab.open_from_template')) throw unavailable();
    const title = input.title.trim();
    const existing = (await this.listTopics(ctx, { projectId: input.projectId })).filter(topic => topic.title === title);
    if (existing.length > 1) throw unavailable();
    if (existing.length === 1) return existing[0]!;
    const material = this.store.getCurrentProjectMaterial(input.projectId, ctx);
    if (!material) throw unavailable();
    return await this.dispatch(ctx, 'collab.open_from_template', input.projectId,
      { materialId: material.id, title, question: input.question.trim() },
      key('web-topic', input.projectId, ctx.principal, ctx.audience, ctx.recipient, title)) as TopicSummary;
  }

  private async current(ctx: RequestContext, collaboration: StoredCollaboration): Promise<ContextRevision | null> {
    return await this.dispatch(ctx, 'context.read', collaboration.workspaceId, {}, undefined,
      collaboration.id) as ContextRevision | null;
  }

  async openTopic(ctx: RequestContext, input: { root: string; topic: string; question: string;
    commitRef?: string }): Promise<TopicSummary> {
    const local = this.local(ctx);
    const root = this.root(input.root);
    const workspace = this.store.getWorkspaceByRoot(root);
    if (!workspace || workspace.registeredBy !== ctx.principal || !input.topic?.trim() || !input.question?.trim()) throw unavailable();
    const topic = input.topic.trim();
    if (!this.usable(local, workspace.id, 'collab.open')) throw unavailable();
    const named = (await this.listTopics(local, { projectId: workspace.id })).filter(item => item.title === topic);
    if (named.length > 1) throw unavailable();
    if (named.length === 1) return named[0]!;
    const copy = this.store.getWorkingCopyByRoot(workspace.id, root);
    if (!copy) throw unavailable();
    const collaboration = await this.dispatch(local, 'collab.open', workspace.id,
      { purpose: `${marker}${topic}` }, key('topic', workspace.id, topic)) as StoredCollaboration;
    const prior = await this.current(local, collaboration);
    if (prior) {
      if (!await this.store.getSnapshot(prior.snapshotId, workspace.id, collaboration.id)) throw unavailable();
      return { topicHandle: collaboration.id, title: topic, projectId: workspace.id, question: prior.content.goal };
    }
    const proposalId = `ctxp_${key('proposal', collaboration.id).slice(6)}`;
    const revisionId = `ctx_${key('revision', collaboration.id).slice(6)}`;
    const proposed = await this.dispatch(local, 'context.read', workspace.id, { proposalId }, undefined,
      collaboration.id) as { snapshotId: string; content: { goal: string } } | null;
    if (!proposed) {
      const snapshot = await this.dispatch(local, 'snapshot.capture', workspace.id,
        { workingCopyId: copy.id, ...(input.commitRef ? { commitRef: input.commitRef } : {}) },
        key('snapshot', collaboration.id), collaboration.id) as SnapshotReceipt;
      await this.dispatch(local, 'context.propose', workspace.id, { proposalId, parentRevisionId: null,
        snapshotId: snapshot.snapshotId, sourceRefs: [`snapshot:${snapshot.snapshotId}`], content: {
          goal: input.question.trim(), constraints: [], acceptedDecisions: [], rejectedDecisions: [],
          currentQuestions: [], evidenceRefs: [], expectedDeliverables: [], unknowns: [], recentChanges: [],
        } }, key('propose', collaboration.id), collaboration.id);
    } else if (!await this.store.getSnapshot(proposed.snapshotId, workspace.id, collaboration.id)) throw unavailable();
    const accepted = await this.dispatch(local, 'context.accept', workspace.id, { proposalId, revisionId },
      key('accept', collaboration.id), collaboration.id) as ContextRevision;
    return { topicHandle: collaboration.id, title: topic, projectId: workspace.id, question: accepted.content.goal };
  }

  listProjects(ctx: RequestContext): ProjectSummary[] {
    return this.store.listWorkspaces().filter((workspace) => this.usable(ctx, workspace.id, 'collab.list'))
      .map(projectSummary);
  }

  private resolveProjectReference(ctx: RequestContext, selector: string): string {
    if (typeof selector !== 'string' || !selector.trim()) throw unavailable();
    const byId = this.store.getWorkspace(selector);
    const visible = this.listProjects(ctx);
    if (byId) {
      if (!visible.some(project => project.id === selector) ||
          visible.some(project => project.id !== selector && project.name === selector)) throw unavailable();
      return selector;
    }
    const named = visible.filter(project => project.name === selector);
    if (named.length !== 1) throw unavailable();
    return named[0]!.id;
  }

  async listProjectTopics(ctx: RequestContext, input: { project: string }): Promise<TopicSummary[]> {
    await ctx.assertFreshAuthority?.();
    const projectId = this.resolveProjectReference(ctx, input.project);
    return await this.listTopics(ctx, { projectId });
  }

  async openProjectTopic(ctx: RequestContext, input: { project: string; title: string; question: string }): Promise<TopicSummary> {
    await ctx.assertFreshAuthority?.();
    const projectId = this.resolveProjectReference(ctx, input.project);
    return await this.openExternalTopic(ctx, { projectId, title: input.title, question: input.question });
  }

  async listTopics(ctx: RequestContext, input: { projectId: string }): Promise<TopicSummary[]> {
    if (!this.usable(ctx, input.projectId, 'collab.list')) return [];
    const topics: TopicSummary[] = [];
    for (const collaboration of this.store.listCollaborations(input.projectId)) {
      if (!collaboration.purpose.startsWith(marker) || !this.usable(ctx, input.projectId, 'collab.get', collaboration.id)) continue;
      try {
        const binding = await this.resolveTopic(ctx, { topicHandle: collaboration.id });
        topics.push({ topicHandle: binding.topicHandle, title: binding.title, projectId: binding.projectId,
          question: binding.question });
      } catch { /* Hidden or incomplete topics are not discoverable. */ }
    }
    return topics;
  }

  async resolveTopic(ctx: RequestContext, input: { topicHandle: string }): Promise<TopicBinding> {
    const collaboration = this.store.getCollaborationById(input.topicHandle);
    if (!collaboration || !collaboration.purpose.startsWith(marker)) throw unavailable();
    const scope = { workspaceId: collaboration.workspaceId, collaborationId: collaboration.id };
    if (!this.usable(ctx, scope.workspaceId, 'collab.get', scope.collaborationId)) throw unavailable();
    const revision = await this.current(ctx, collaboration);
    if (!revision || revision.workspaceId !== scope.workspaceId || revision.collaborationId !== scope.collaborationId)
      throw unavailable();
    const snapshot = await this.store.getSnapshot(revision.snapshotId, scope.workspaceId, scope.collaborationId);
    if (!snapshot || snapshot.snapshot.id !== revision.snapshotId) throw unavailable();
    await ctx.assertFreshAuthority?.();
    if (!this.usable(ctx, scope.workspaceId, 'collab.get', scope.collaborationId) ||
        !this.usable(ctx, scope.workspaceId, 'context.read', scope.collaborationId)) throw unavailable();
    return { topicHandle: collaboration.id, title: topicTitle(collaboration), projectId: scope.workspaceId,
      question: revision.inheritedFrom?.requestedQuestion.text ?? revision.content.goal, ...scope, workingCopyId: snapshot.workingCopyId,
      snapshotId: revision.snapshotId, contextRevisionId: revision.id };
  }
}
