import {
  createCollaborationId,
  parseWorkspaceId,
  type CollaborationId,
  type WorkspaceId,
} from "../identity/index.js";

export interface CommandContext {
  readonly authenticatedPrincipal: string;
  readonly audience: "external_mcp" | "local_host" | "local_cli";
  readonly workspaceId: WorkspaceId;
}

export interface OpenInput {
  readonly workspaceId: WorkspaceId;
  readonly purpose: string;
}

export interface Collaboration {
  readonly id: CollaborationId;
  readonly workspaceId: WorkspaceId;
  readonly openedBy: string;
  readonly purpose: string;
  readonly hostThreadId: null;
  readonly state: "open";
}

export function openCollaboration(context: CommandContext, input: OpenInput): Collaboration {
  if (Object.keys(input).some((key) => key !== "workspaceId" && key !== "purpose")) {
    throw new TypeError("unknown open collaboration field");
  }
  if (!context.authenticatedPrincipal || !input.purpose.trim()) {
    throw new TypeError("principal and purpose required");
  }
  parseWorkspaceId(context.workspaceId);
  parseWorkspaceId(input.workspaceId);
  if (context.workspaceId !== input.workspaceId) {
    throw new TypeError("workspace mismatch");
  }
  return {
    id: createCollaborationId(),
    workspaceId: context.workspaceId,
    openedBy: context.authenticatedPrincipal,
    purpose: input.purpose,
    hostThreadId: null,
    state: "open",
  };
}
