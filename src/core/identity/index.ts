import { randomUUID } from "node:crypto";

declare const identityBrand: unique symbol;
type OpaqueId<Kind extends string> = string & { readonly [identityBrand]: Kind };

export type WorkspaceId = OpaqueId<"WorkspaceId">;
export type WorkingCopyId = OpaqueId<"WorkingCopyId">;
export type CollaborationId = OpaqueId<"CollaborationId">;

export interface LocalAdminContext {
  readonly authenticatedPrincipal: string;
  readonly audience: "local_admin";
}

export interface WorkspaceRegistration {
  readonly name: string;
  /** A verified canonical path supplied by the local path policy. */
  readonly canonicalRoot: string;
}

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly canonicalRoot: string;
  readonly registeredBy: string;
}

export interface WorkingCopy {
  readonly id: WorkingCopyId;
  readonly workspaceId: WorkspaceId;
  readonly canonicalRoot: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function newId<Kind extends string>(prefix: string): OpaqueId<Kind> {
  return `${prefix}_${randomUUID()}` as OpaqueId<Kind>;
}

export function parseWorkspaceId(value: string): WorkspaceId {
  if (!value.startsWith("ws_") || !UUID_V4.test(value.slice(3))) {
    throw new TypeError("invalid workspace identifier");
  }
  return value as WorkspaceId;
}

export function createWorkspace(context: LocalAdminContext, registration: WorkspaceRegistration): Workspace {
  if (context.audience !== "local_admin" || !context.authenticatedPrincipal) {
    throw new TypeError("local admin context required");
  }
  if (!registration.name.trim() || !registration.canonicalRoot.trim()) {
    throw new TypeError("workspace name and canonical root required");
  }
  return {
    id: newId<"WorkspaceId">("ws"),
    name: registration.name,
    canonicalRoot: registration.canonicalRoot,
    registeredBy: context.authenticatedPrincipal,
  };
}

export function createWorkingCopy(workspaceId: WorkspaceId, canonicalRoot: string): WorkingCopy {
  parseWorkspaceId(workspaceId);
  if (!canonicalRoot.trim()) {
    throw new TypeError("working copy canonical root required");
  }
  return { id: newId<"WorkingCopyId">("wc"), workspaceId, canonicalRoot };
}

export function createCollaborationId(): CollaborationId {
  return newId<"CollaborationId">("col");
}
