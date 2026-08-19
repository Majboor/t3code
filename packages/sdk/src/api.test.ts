import { ORCHESTRATION_WS_METHODS, ProjectId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { createT3Api } from "./api/index.ts";
import { connect } from "./client.ts";
import type { T3RpcClient, T3Transport } from "./transport.ts";

interface RecordedCall {
  readonly method: string;
  readonly input: Record<string, unknown>;
}

/**
 * Stands in for a connection. Every contract method answers with a canned
 * value, so a test can assert on the payload the SDK built without a server or
 * any Effect machinery: unary methods answer with the value itself, streaming
 * ones with an array of items.
 */
function makeStub(responses: Readonly<Record<string, unknown>> = {}): {
  readonly transport: T3Transport;
  readonly calls: ReadonlyArray<RecordedCall>;
} {
  const calls: RecordedCall[] = [];
  const client = new Proxy(
    {},
    {
      get: (_target, method) => (input: Record<string, unknown>) => {
        calls.push({ method: String(method), input });
        return responses[String(method)];
      },
    },
  ) as T3RpcClient;

  const canned = (execute: (client: T3RpcClient) => unknown): unknown => execute(client) as unknown;
  const cannedEvents = (execute: (client: T3RpcClient) => unknown): ReadonlyArray<unknown> =>
    (canned(execute) as ReadonlyArray<unknown> | undefined) ?? [];

  const transport: T3Transport = {
    request: (execute) => Promise.resolve(canned(execute) as never),
    first: (execute) => {
      const events = cannedEvents(execute);
      return events.length > 0
        ? Promise.resolve(events[0] as never)
        : Promise.reject(new Error("Server closed the stream before sending anything."));
    },
    drain: (execute, onEvent) => {
      for (const event of cannedEvents(execute)) {
        onEvent(event as never);
      }
      return Promise.resolve();
    },
    subscribe: (execute, onEvent) => {
      for (const event of cannedEvents(execute)) {
        onEvent(event as never);
      }
      return () => undefined;
    },
  };

  return { transport, calls };
}

const shellSnapshot = {
  kind: "snapshot",
  snapshot: {
    snapshotSequence: 3,
    projects: [{ id: "project-1", title: "Payments" }],
    threads: [{ id: "thread-1", projectId: "project-1" }],
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

const threadSnapshot = {
  kind: "snapshot",
  snapshot: {
    snapshotSequence: 7,
    thread: {
      id: "thread-1",
      messages: [{ id: "message-1", role: "user", text: "hi" }],
      checkpoints: [{ turnId: "turn-1", checkpointTurnCount: 1 }],
      activities: [{ id: "activity-1", kind: "tool" }],
      proposedPlans: [],
    },
  },
};

describe("workspace projects", () => {
  it("registers a project as a project.create command and answers with its id", async () => {
    const { transport, calls } = makeStub({
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: { sequence: 1 },
    });

    const projectId = await createT3Api(transport).workspace.registerProject({
      workspaceRoot: "/srv/app",
      title: "Payments",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(ORCHESTRATION_WS_METHODS.dispatchCommand);
    expect(calls[0]?.input).toMatchObject({
      type: "project.create",
      projectId,
      title: "Payments",
      workspaceRoot: "/srv/app",
    });
    expect(calls[0]?.input["commandId"]).toEqual(expect.any(String));
    expect(Date.parse(String(calls[0]?.input["createdAt"]))).not.toBeNaN();
  });

  it("keeps a caller-supplied project id rather than minting one", async () => {
    const { transport } = makeStub({
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: { sequence: 1 },
    });
    const chosen = ProjectId.make("project-chosen");

    const projectId = await createT3Api(transport).workspace.registerProject({
      workspaceRoot: "/srv/app",
      title: "Payments",
      projectId: chosen,
    });

    expect(projectId).toBe(chosen);
  });

  it("passes file reads through untouched", async () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.projectsReadFile]: { relativePath: "src/index.ts", contents: "export {};" },
    });

    const result = await createT3Api(transport).workspace.readFile({
      cwd: "/srv/app",
      relativePath: "src/index.ts",
    });

    expect(calls[0]).toEqual({
      method: WS_METHODS.projectsReadFile,
      input: { cwd: "/srv/app", relativePath: "src/index.ts" },
    });
    expect(result.contents).toBe("export {};");
  });

  it("reads the shell snapshot from the first item of the subscription", async () => {
    const { transport, calls } = makeStub({
      [ORCHESTRATION_WS_METHODS.subscribeShell]: [shellSnapshot],
    });

    const projects = await createT3Api(transport).workspace.listProjects();

    expect(calls[0]?.method).toBe(ORCHESTRATION_WS_METHODS.subscribeShell);
    expect(projects).toHaveLength(1);
  });

  it("refuses a shell stream that starts with an event instead of a snapshot", async () => {
    const { transport } = makeStub({
      [ORCHESTRATION_WS_METHODS.subscribeShell]: [{ kind: "project-removed", sequence: 4 }],
    });

    await expect(createT3Api(transport).workspace.getSnapshot()).rejects.toThrow(
      /before the snapshot/,
    );
  });
});

describe("threads", () => {
  const threadId = ThreadId.make("thread-1");

  it("starts a turn as a user message with the default modes", async () => {
    const { transport, calls } = makeStub({
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: { sequence: 12 },
    });

    const result = await createT3Api(transport).threads.startTurn({
      threadId,
      prompt: "Add a health check endpoint",
    });

    const input = calls[0]?.input ?? {};
    expect(input).toMatchObject({
      type: "thread.turn.start",
      threadId,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    expect(input["message"]).toMatchObject({
      messageId: result.messageId,
      role: "user",
      text: "Add a health check endpoint",
      attachments: [],
    });
    expect(result).toMatchObject({ threadId, commandId: input["commandId"], sequence: 12 });
  });

  it("honours an explicit runtime mode, interaction mode, and title seed", async () => {
    const { transport, calls } = makeStub({
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: { sequence: 1 },
    });

    await createT3Api(transport).threads.startTurn({
      threadId,
      prompt: "Draft a plan",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      titleSeed: "Planning",
    });

    expect(calls[0]?.input).toMatchObject({
      runtimeMode: "approval-required",
      interactionMode: "plan",
      titleSeed: "Planning",
    });
  });

  it("interrupts without naming a turn when the caller does not know one", async () => {
    const { transport, calls } = makeStub({
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: { sequence: 2 },
    });

    await createT3Api(transport).threads.interruptTurn({ threadId });

    expect(calls[0]?.input).toMatchObject({ type: "thread.turn.interrupt", threadId });
    expect(calls[0]?.input["turnId"]).toBeUndefined();
  });

  it("answers an approval with the decision it was given", async () => {
    const { transport, calls } = makeStub({
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: { sequence: 3 },
    });

    await createT3Api(transport).threads.respondToApproval({
      threadId,
      requestId: "request-1" as never,
      decision: "acceptForSession",
    });

    expect(calls[0]?.input).toMatchObject({
      type: "thread.approval.respond",
      threadId,
      requestId: "request-1",
      decision: "acceptForSession",
    });
  });

  it("reads messages and turns out of the thread snapshot", async () => {
    const { transport } = makeStub({
      [ORCHESTRATION_WS_METHODS.subscribeThread]: [threadSnapshot],
    });
    const api = createT3Api(transport);

    expect(await api.threads.listMessages(threadId)).toHaveLength(1);
    expect(await api.threads.listTurns(threadId)).toHaveLength(1);
    expect(await api.threads.listActivity(threadId)).toHaveLength(1);
  });

  it("refuses a thread stream that starts with an event instead of a snapshot", async () => {
    const { transport } = makeStub({
      [ORCHESTRATION_WS_METHODS.subscribeThread]: [{ kind: "event", event: {} }],
    });

    await expect(createT3Api(transport).threads.get(threadId)).rejects.toThrow(
      /before the snapshot/,
    );
  });
});

describe("changes", () => {
  it("passes a merge through and answers with the server's verdict", async () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.gitMergeBranch]: { status: "conflicts", conflictPaths: ["src/index.ts"] },
    });

    const result = await createT3Api(transport).changes.mergeBranch({
      cwd: "/srv/app",
      branch: "feature",
      mode: "rebase",
    });

    expect(calls[0]).toEqual({
      method: WS_METHODS.gitMergeBranch,
      input: { cwd: "/srv/app", branch: "feature", mode: "rebase" },
    });
    expect(result.status).toBe("conflicts");
  });

  it("reports progress and returns the result the action stream finished with", async () => {
    const finished = { action: "commit_push" };
    const { transport } = makeStub({
      [WS_METHODS.gitRunStackedAction]: [
        { kind: "phase_started", phase: "commit" },
        { kind: "action_finished", result: finished },
      ],
    });
    const progress: Array<string> = [];

    const result = await createT3Api(transport).changes.runStackedAction(
      { actionId: "action-1", cwd: "/srv/app", action: "commit_push" },
      { onProgress: (event) => progress.push(event.kind) },
    );

    expect(progress).toEqual(["phase_started", "action_finished"]);
    expect(result).toBe(finished);
  });

  it("fails when the action stream ends without a result", async () => {
    const { transport } = makeStub({
      [WS_METHODS.gitRunStackedAction]: [{ kind: "action_failed", message: "hook failed" }],
    });

    await expect(
      createT3Api(transport).changes.runStackedAction({
        actionId: "action-1",
        cwd: "/srv/app",
        action: "commit",
      }),
    ).rejects.toThrow(/without a final result/);
  });
});

describe("history and server", () => {
  it("narrows shared activity down to prompts", async () => {
    const { transport } = makeStub({
      [WS_METHODS.collaborationActivityList]: {
        activities: [
          { id: "a", kind: "prompted" },
          { id: "b", kind: "joined" },
          { id: "c", kind: "prompted" },
        ],
      },
    });

    const prompts = await createT3Api(transport).history.listPrompts({
      tenantId: "tenant-1" as never,
      workspaceId: "workspace-1" as never,
    });

    expect(prompts.map((activity) => activity.id)).toEqual(["a", "c"]);
  });

  it("wraps a settings patch the way the contract expects", async () => {
    const { transport, calls } = makeStub({ [WS_METHODS.serverUpdateSettings]: {} });

    await createT3Api(transport).server.updateSettings({ theme: "dark" } as never);

    expect(calls[0]).toEqual({
      method: WS_METHODS.serverUpdateSettings,
      input: { patch: { theme: "dark" } },
    });
  });

  it("subscribes to terminal output without an input payload", () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.subscribeTerminalEvents]: [{ type: "data" }],
    });
    const seen: Array<unknown> = [];

    const stop = createT3Api(transport).terminals.watch((event) => seen.push(event));

    expect(calls[0]).toEqual({ method: WS_METHODS.subscribeTerminalEvents, input: {} });
    expect(seen).toHaveLength(1);
    expect(() => stop()).not.toThrow();
  });
});

describe("provider sharing", () => {
  const scope = { tenantId: "tenant-1" as never, workspaceId: "workspace-1" as never };

  it("reads the overview in one call", async () => {
    const overview = { viewerUserId: "user-1", canManage: true, viewerAccounts: [] };
    const { transport, calls } = makeStub({
      [WS_METHODS.providerSharingOverviewGet]: overview,
    });

    const result = await createT3Api(transport).providerSharing.getOverview(scope);

    expect(calls[0]).toEqual({ method: WS_METHODS.providerSharingOverviewGet, input: scope });
    expect(result).toBe(overview);
  });

  it("shares an account without naming its owner", async () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.providerSharingShareUpdate]: { share: {} },
    });

    await createT3Api(transport).providerSharing.updateShare({
      ...scope,
      provider: "claude",
      accountId: "account-1" as never,
      enabled: true,
    });

    expect(calls[0]?.input).toEqual({
      ...scope,
      provider: "claude",
      accountId: "account-1",
      enabled: true,
    });
    expect(calls[0]?.input["ownerUserId"]).toBeUndefined();
  });

  it("clears the pinned account when a policy goes back to own", async () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.providerSharingPolicyUpdate]: { policy: {} },
    });

    await createT3Api(transport).providerSharing.updatePolicy({
      ...scope,
      provider: "codex",
      mode: "own",
      sharedOwnerUserId: null,
      sharedAccountId: null,
    });

    expect(calls[0]?.input).toMatchObject({ sharedOwnerUserId: null, sharedAccountId: null });
  });

  it("grants a member the workspace credential", async () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.providerSharingMemberUpdate]: { grant: {} },
    });

    await createT3Api(transport).providerSharing.updateMember({
      ...scope,
      userId: "user-2" as never,
      provider: "claude",
      access: "workspace",
    });

    expect(calls[0]).toEqual({
      method: WS_METHODS.providerSharingMemberUpdate,
      input: { ...scope, userId: "user-2", provider: "claude", access: "workspace" },
    });
  });
});

describe("provider usage requests", () => {
  const scope = { tenantId: "tenant-1" as never, workspaceId: "workspace-1" as never };

  it("asks without naming the requester", async () => {
    const request = { id: "request-1", status: "pending" };
    const { transport, calls } = makeStub({
      [WS_METHODS.providerUsageRequestCreate]: { request },
    });

    const result = await createT3Api(transport).providerUsage.createRequest({
      ...scope,
      provider: "claude",
      reason: "no-account",
      note: "just for the migration" as never,
    });

    expect(calls[0]).toEqual({
      method: WS_METHODS.providerUsageRequestCreate,
      input: { ...scope, provider: "claude", reason: "no-account", note: "just for the migration" },
    });
    expect(calls[0]?.input["requesterUserId"]).toBeUndefined();
    expect(result).toEqual({ request });
  });

  it("lists a workspace's requests alongside whether the caller may answer", async () => {
    const listed = { requests: [], canRespond: false };
    const { transport, calls } = makeStub({
      [WS_METHODS.providerUsageRequestList]: listed,
    });

    const result = await createT3Api(transport).providerUsage.listRequests(scope);

    expect(calls[0]).toEqual({ method: WS_METHODS.providerUsageRequestList, input: scope });
    expect(result).toBe(listed);
  });

  it("grants a request with the account that will be contributed", async () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.providerUsageRequestRespond]: { request: {} },
    });

    await createT3Api(transport).providerUsage.respondToRequest({
      ...scope,
      requestId: "request-1" as never,
      decision: "grant",
      accountId: "account-1" as never,
    });

    expect(calls[0]).toEqual({
      method: WS_METHODS.providerUsageRequestRespond,
      input: { ...scope, requestId: "request-1", decision: "grant", accountId: "account-1" },
    });
  });

  it("declines without naming an account", async () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.providerUsageRequestRespond]: { request: {} },
    });

    await createT3Api(transport).providerUsage.respondToRequest({
      ...scope,
      requestId: "request-1" as never,
      decision: "decline",
    });

    expect(calls[0]?.input["accountId"]).toBeUndefined();
  });

  it("withdraws a request by id", async () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.providerUsageRequestWithdraw]: { request: {} },
    });

    await createT3Api(transport).providerUsage.withdrawRequest({
      ...scope,
      requestId: "request-1" as never,
    });

    expect(calls[0]).toEqual({
      method: WS_METHODS.providerUsageRequestWithdraw,
      input: { ...scope, requestId: "request-1" },
    });
  });
});

describe("share links", () => {
  const scope = { tenantId: "tenant-1" as never, workspaceId: "workspace-1" as never };

  it("mints a file link with both halves of its target", async () => {
    const link = { id: "link-1", token: "tok-1", scope: "file" };
    const { transport, calls } = makeStub({ [WS_METHODS.shareLinksCreate]: { link } });

    const result = await createT3Api(transport).shareLinks.create({
      ...scope,
      scope: "file",
      projectId: "project-1" as never,
      filePath: "src/index.ts" as never,
    });

    expect(calls[0]).toEqual({
      method: WS_METHODS.shareLinksCreate,
      input: { ...scope, scope: "file", projectId: "project-1", filePath: "src/index.ts" },
    });
    expect(result).toEqual({ link });
  });

  it("never asks for a token or an author — the server mints both", async () => {
    const { transport, calls } = makeStub({ [WS_METHODS.shareLinksCreate]: { link: {} } });

    await createT3Api(transport).shareLinks.create({
      ...scope,
      scope: "workspace",
      label: "For the design review" as never,
    });

    expect(calls[0]?.input["token"]).toBeUndefined();
    expect(calls[0]?.input["createdByUserId"]).toBeUndefined();
  });

  it("lists a whole workspace when no project narrows it", async () => {
    const listed = { links: [] };
    const { transport, calls } = makeStub({ [WS_METHODS.shareLinksList]: listed });

    const result = await createT3Api(transport).shareLinks.list(scope);

    expect(calls[0]).toEqual({ method: WS_METHODS.shareLinksList, input: scope });
    expect(result).toBe(listed);
  });

  it("revokes by id rather than by token", async () => {
    const { transport, calls } = makeStub({ [WS_METHODS.shareLinksRevoke]: { link: {} } });

    await createT3Api(transport).shareLinks.revoke({ ...scope, linkId: "link-1" as never });

    expect(calls[0]).toEqual({
      method: WS_METHODS.shareLinksRevoke,
      input: { ...scope, linkId: "link-1" },
    });
  });
});

describe("cloud sync", () => {
  const scope = {
    tenantId: "tenant-1" as never,
    workspaceId: "workspace-1" as never,
    projectId: "project-1" as never,
  };

  it("reads a status that may legitimately be null", async () => {
    const { transport, calls } = makeStub({ [WS_METHODS.cloudSyncStatusGet]: { sync: null } });

    const result = await createT3Api(transport).cloudSync.getStatus(scope);

    expect(calls[0]).toEqual({ method: WS_METHODS.cloudSyncStatusGet, input: scope });
    expect(result).toEqual({ sync: null });
  });

  it("sends the chosen mode, because there is no default for it", async () => {
    const sync = { projectId: "project-1", mode: "mirror", status: "scanning" };
    const { transport, calls } = makeStub({ [WS_METHODS.cloudSyncStart]: { sync } });

    const result = await createT3Api(transport).cloudSync.start({ ...scope, mode: "mirror" });

    expect(calls[0]).toEqual({
      method: WS_METHODS.cloudSyncStart,
      input: { ...scope, mode: "mirror" },
    });
    expect(result).toEqual({ sync });
  });

  it("carries the project scope on pause and stop without inventing a mode", async () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.cloudSyncPause]: { sync: {} },
      [WS_METHODS.cloudSyncStop]: { sync: {} },
    });
    const api = createT3Api(transport);

    await api.cloudSync.pause(scope);
    await api.cloudSync.stop(scope);

    expect(calls[0]).toEqual({ method: WS_METHODS.cloudSyncPause, input: scope });
    expect(calls[1]).toEqual({ method: WS_METHODS.cloudSyncStop, input: scope });
    expect(calls[0]?.input["mode"]).toBeUndefined();
  });

  it("pages conflicts by cursor rather than by offset", async () => {
    const listed = { conflicts: [], nextCursor: null };
    const { transport, calls } = makeStub({ [WS_METHODS.cloudSyncConflictsList]: listed });

    const result = await createT3Api(transport).cloudSync.listConflicts({
      ...scope,
      afterId: "conflict-9" as never,
      limit: 50,
    });

    expect(calls[0]).toEqual({
      method: WS_METHODS.cloudSyncConflictsList,
      input: { ...scope, afterId: "conflict-9", limit: 50 },
    });
    expect(calls[0]?.input["offset"]).toBeUndefined();
    expect(result).toBe(listed);
  });

  it("resolves a conflict without naming a winning side", async () => {
    const { transport, calls } = makeStub({
      [WS_METHODS.cloudSyncConflictsResolve]: { conflict: {}, sync: {} },
    });

    await createT3Api(transport).cloudSync.resolveConflict({
      ...scope,
      conflictId: "conflict-1" as never,
    });

    expect(calls[0]).toEqual({
      method: WS_METHODS.cloudSyncConflictsResolve,
      input: { ...scope, conflictId: "conflict-1" },
    });
    // Choosing a side here would make the server delete one of two files it was
    // asked to keep, so the contract has no such field and neither does this.
    expect(calls[0]?.input["keep"]).toBeUndefined();
  });
});

describe("connect", () => {
  it("refuses to connect without credentials or a token", async () => {
    await expect(connect({ baseUrl: "http://127.0.0.1:13773" })).rejects.toThrow(
      /credentials.*token/,
    );
  });
});
