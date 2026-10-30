import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspace, createWorkingCopy, parseWorkspaceId } from "../../src/core/identity/index.js";
import { openCollaboration } from "../../src/core/collaboration/identity.js";

test("same display name and root do not determine workspace identity", () => {
  const context = { authenticatedPrincipal: "local-operator", audience: "local_admin" } as const;
  const registration = { name: "repo", canonicalRoot: "C:/work/repo" };
  const first = createWorkspace(context, registration);
  const second = createWorkspace(context, registration);
  assert.notEqual(first.id, second.id);
  assert.equal(first.canonicalRoot, registration.canonicalRoot);
  assert.equal(first.registeredBy, context.authenticatedPrincipal);
});

test("working copy and collaboration retain explicit workspace identity", () => {
  const workspace = createWorkspace(
    { authenticatedPrincipal: "operator", audience: "local_admin" },
    { name: "repo", canonicalRoot: "C:/work/repo" },
  );
  const copy = createWorkingCopy(workspace.id, "C:/work/repo/worktree");
  const collaboration = openCollaboration(
    { authenticatedPrincipal: "participant", audience: "external_mcp", workspaceId: workspace.id },
    { workspaceId: workspace.id, purpose: "review cancellation" },
  );
  assert.equal(copy.workspaceId, workspace.id);
  assert.equal(collaboration.workspaceId, workspace.id);
  assert.notEqual(collaboration.id, workspace.id);
  assert.equal(collaboration.hostThreadId, null);
});

test("external open cannot register a root or select another workspace", () => {
  const workspace = createWorkspace(
    { authenticatedPrincipal: "operator", audience: "local_admin" },
    { name: "repo", canonicalRoot: "C:/work/repo" },
  );
  const context = { authenticatedPrincipal: "participant", audience: "external_mcp", workspaceId: workspace.id } as const;
  assert.throws(
    () => openCollaboration(context, { workspaceId: workspace.id, purpose: "review", canonicalRoot: "D:/other" } as never),
    /unknown|invalid|root/i,
  );
  assert.throws(
    () => createWorkspace({ authenticatedPrincipal: "participant", audience: "external_mcp" } as never, { name: "other", canonicalRoot: "D:/other" }),
    /local admin/i,
  );
  assert.throws(
    () => openCollaboration(context, { workspaceId: parseWorkspaceId("ws_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), purpose: "review" }),
    /workspace/i,
  );
});

test("provider session identifiers are not workspace identifiers", () => {
  assert.throws(() => parseWorkspaceId("thread_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), /workspace/i);
  assert.throws(() => parseWorkspaceId("ws_chatgpt-conversation"), /workspace/i);
});
