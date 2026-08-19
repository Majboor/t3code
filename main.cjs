//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let node_child_process = require("node:child_process");
node_child_process = __toESM(node_child_process);
let node_crypto = require("node:crypto");
node_crypto = __toESM(node_crypto);
let node_fs = require("node:fs");
node_fs = __toESM(node_fs);
let node_os = require("node:os");
node_os = __toESM(node_os);
let node_path = require("node:path");
node_path = __toESM(node_path);
let electron = require("electron");
let electron_updater = require("electron-updater");
let effect = require("effect");
let effect_Schema = require("effect/Schema");
effect_Schema = __toESM(effect_Schema);
let effect_SchemaTransformation = require("effect/SchemaTransformation");
effect_SchemaTransformation = __toESM(effect_SchemaTransformation);
let effect_unstable_rpc_Rpc = require("effect/unstable/rpc/Rpc");
effect_unstable_rpc_Rpc = __toESM(effect_unstable_rpc_Rpc);
let effect_unstable_rpc_RpcGroup = require("effect/unstable/rpc/RpcGroup");
effect_unstable_rpc_RpcGroup = __toESM(effect_unstable_rpc_RpcGroup);
require("effect/Predicate");
let effect_Effect = require("effect/Effect");
effect_Effect = __toESM(effect_Effect);
let node_net = require("node:net");
node_net = __toESM(node_net);

//#region ../../packages/shared/src/logging.ts
var RotatingFileSink = class {
	filePath;
	maxBytes;
	maxFiles;
	throwOnError;
	currentSize = 0;
	constructor(options) {
		if (options.maxBytes < 1) throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
		if (options.maxFiles < 1) throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
		this.filePath = options.filePath;
		this.maxBytes = options.maxBytes;
		this.maxFiles = options.maxFiles;
		this.throwOnError = options.throwOnError ?? false;
		node_fs.default.mkdirSync(node_path.default.dirname(this.filePath), { recursive: true });
		this.pruneOverflowBackups();
		this.currentSize = this.readCurrentSize();
	}
	write(chunk) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		if (buffer.length === 0) return;
		try {
			if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) this.rotate();
			node_fs.default.appendFileSync(this.filePath, buffer);
			this.currentSize += buffer.length;
			if (this.currentSize > this.maxBytes) this.rotate();
		} catch {
			this.currentSize = this.readCurrentSize();
			if (this.throwOnError) throw new Error(`Failed to write log chunk to ${this.filePath}`);
		}
	}
	rotate() {
		try {
			const oldest = this.withSuffix(this.maxFiles);
			if (node_fs.default.existsSync(oldest)) node_fs.default.rmSync(oldest, { force: true });
			for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
				const source = this.withSuffix(index);
				const target = this.withSuffix(index + 1);
				if (node_fs.default.existsSync(source)) node_fs.default.renameSync(source, target);
			}
			if (node_fs.default.existsSync(this.filePath)) node_fs.default.renameSync(this.filePath, this.withSuffix(1));
			this.currentSize = 0;
		} catch {
			this.currentSize = this.readCurrentSize();
			if (this.throwOnError) throw new Error(`Failed to rotate log file ${this.filePath}`);
		}
	}
	pruneOverflowBackups() {
		try {
			const dir = node_path.default.dirname(this.filePath);
			const baseName = node_path.default.basename(this.filePath);
			for (const entry of node_fs.default.readdirSync(dir)) {
				if (!entry.startsWith(`${baseName}.`)) continue;
				const suffix = Number(entry.slice(baseName.length + 1));
				if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
				node_fs.default.rmSync(node_path.default.join(dir, entry), { force: true });
			}
		} catch {
			if (this.throwOnError) throw new Error(`Failed to prune log backups for ${this.filePath}`);
		}
	}
	readCurrentSize() {
		try {
			return node_fs.default.statSync(this.filePath).size;
		} catch {
			return 0;
		}
	}
	withSuffix(index) {
		return `${this.filePath}.${index}`;
	}
};

//#endregion
//#region ../../packages/contracts/src/baseSchemas.ts
const TrimmedString = effect.Schema.Trim;
const TrimmedNonEmptyString = TrimmedString.check(effect.Schema.isNonEmpty());
const NonNegativeInt = effect.Schema.Int.check(effect.Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = effect.Schema.Int.check(effect.Schema.isGreaterThanOrEqualTo(1));
const IsoDateTime = effect.Schema.String;
/**
* Construct a branded identifier. Enforces non-empty trimmed strings
*/
const makeEntityId = (brand) => {
	return TrimmedNonEmptyString.pipe(effect.Schema.brand(brand));
};
const ThreadId = makeEntityId("ThreadId");
const ProjectId = makeEntityId("ProjectId");
const EnvironmentId = makeEntityId("EnvironmentId");
const CommandId = makeEntityId("CommandId");
const EventId = makeEntityId("EventId");
const ProductEventId = makeEntityId("ProductEventId");
const MessageId = makeEntityId("MessageId");
const TurnId = makeEntityId("TurnId");
const AuthSessionId = makeEntityId("AuthSessionId");
const UserId = makeEntityId("UserId");
const OrganizationId = makeEntityId("OrganizationId");
const OrganizationTeamId = makeEntityId("OrganizationTeamId");
const OrganizationDepartmentId = makeEntityId("OrganizationDepartmentId");
const OrganizationAccessGrantId = makeEntityId("OrganizationAccessGrantId");
const OrganizationAccessReviewId = makeEntityId("OrganizationAccessReviewId");
const OrganizationAuditEventId = makeEntityId("OrganizationAuditEventId");
const TenantId = makeEntityId("TenantId");
const MembershipId = makeEntityId("MembershipId");
const WorkspaceId = makeEntityId("WorkspaceId");
const TenantRuntimeId = makeEntityId("TenantRuntimeId");
const ProviderAccountId = makeEntityId("ProviderAccountId");
const ProviderSessionId = makeEntityId("ProviderSessionId");
const InviteId = makeEntityId("InviteId");
const CollaborationActivityId = makeEntityId("CollaborationActivityId");
const CollaborationApprovalId = makeEntityId("CollaborationApprovalId");
const ProviderItemId = makeEntityId("ProviderItemId");
const RuntimeSessionId = makeEntityId("RuntimeSessionId");
const RuntimeItemId = makeEntityId("RuntimeItemId");
const RuntimeRequestId = makeEntityId("RuntimeRequestId");
const RuntimeTaskId = makeEntityId("RuntimeTaskId");
const ApprovalRequestId = makeEntityId("ApprovalRequestId");
const CheckpointRef = makeEntityId("CheckpointRef");

//#endregion
//#region ../../packages/contracts/src/model.ts
const CodexReasoningEffort = effect.Schema.Literals([
	"xhigh",
	"high",
	"medium",
	"low"
]);
const ClaudeAgentEffort = effect.Schema.Literals([
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultrathink"
]);
const CodexModelOptions = effect.Schema.Struct({
	reasoningEffort: effect.Schema.optional(CodexReasoningEffort),
	fastMode: effect.Schema.optional(effect.Schema.Boolean)
});
const ClaudeModelOptions = effect.Schema.Struct({
	thinking: effect.Schema.optional(effect.Schema.Boolean),
	effort: effect.Schema.optional(ClaudeAgentEffort),
	fastMode: effect.Schema.optional(effect.Schema.Boolean),
	contextWindow: effect.Schema.optional(effect.Schema.String)
});
const ProviderModelOptions = effect.Schema.Struct({
	codex: effect.Schema.optional(CodexModelOptions),
	claudeAgent: effect.Schema.optional(ClaudeModelOptions)
});
const EffortOption = effect.Schema.Struct({
	value: TrimmedNonEmptyString,
	label: TrimmedNonEmptyString,
	isDefault: effect.Schema.optional(effect.Schema.Boolean)
});
const ContextWindowOption = effect.Schema.Struct({
	value: TrimmedNonEmptyString,
	label: TrimmedNonEmptyString,
	isDefault: effect.Schema.optional(effect.Schema.Boolean)
});
const ModelCapabilities = effect.Schema.Struct({
	reasoningEffortLevels: effect.Schema.Array(EffortOption),
	supportsFastMode: effect.Schema.Boolean,
	supportsThinkingToggle: effect.Schema.Boolean,
	contextWindowOptions: effect.Schema.Array(ContextWindowOption),
	promptInjectedEffortLevels: effect.Schema.Array(TrimmedNonEmptyString)
});
const DEFAULT_MODEL_BY_PROVIDER = {
	codex: "gpt-5.4",
	claudeAgent: "claude-sonnet-4-6"
};
const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;
/** Per-provider text generation model defaults. */
const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER = {
	codex: "gpt-5.4-mini",
	claudeAgent: "claude-haiku-4-5"
};

//#endregion
//#region ../../packages/contracts/src/environment.ts
const ExecutionEnvironmentPlatformOs = effect.Schema.Literals([
	"darwin",
	"linux",
	"windows",
	"unknown"
]);
const ExecutionEnvironmentPlatformArch = effect.Schema.Literals([
	"arm64",
	"x64",
	"other"
]);
const ExecutionEnvironmentPlatform = effect.Schema.Struct({
	os: ExecutionEnvironmentPlatformOs,
	arch: ExecutionEnvironmentPlatformArch
});
const ExecutionEnvironmentCapabilities = effect.Schema.Struct({ repositoryIdentity: effect.Schema.Boolean.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(false))) });
const ExecutionEnvironmentDescriptor = effect.Schema.Struct({
	environmentId: EnvironmentId,
	label: TrimmedNonEmptyString,
	platform: ExecutionEnvironmentPlatform,
	serverVersion: TrimmedNonEmptyString,
	capabilities: ExecutionEnvironmentCapabilities
});
const EnvironmentConnectionState = effect.Schema.Literals([
	"connecting",
	"connected",
	"disconnected",
	"error"
]);
const RepositoryIdentityLocator = effect.Schema.Struct({
	source: effect.Schema.Literal("git-remote"),
	remoteName: TrimmedNonEmptyString,
	remoteUrl: TrimmedNonEmptyString
});
const RepositoryIdentity = effect.Schema.Struct({
	canonicalKey: TrimmedNonEmptyString,
	locator: RepositoryIdentityLocator,
	rootPath: effect.Schema.optionalKey(TrimmedNonEmptyString),
	displayName: effect.Schema.optionalKey(TrimmedNonEmptyString),
	provider: effect.Schema.optionalKey(TrimmedNonEmptyString),
	owner: effect.Schema.optionalKey(TrimmedNonEmptyString),
	name: effect.Schema.optionalKey(TrimmedNonEmptyString)
});
const ScopedProjectRef = effect.Schema.Struct({
	environmentId: EnvironmentId,
	projectId: ProjectId
});
const ScopedThreadRef = effect.Schema.Struct({
	environmentId: EnvironmentId,
	threadId: ThreadId
});
const ScopedThreadSessionRef = effect.Schema.Struct({
	environmentId: EnvironmentId,
	threadId: ThreadId
});

//#endregion
//#region ../../packages/contracts/src/orchestration.ts
const ORCHESTRATION_WS_METHODS = {
	dispatchCommand: "orchestration.dispatchCommand",
	getTurnDiff: "orchestration.getTurnDiff",
	getFullThreadDiff: "orchestration.getFullThreadDiff",
	replayEvents: "orchestration.replayEvents",
	subscribeShell: "orchestration.subscribeShell",
	subscribeThread: "orchestration.subscribeThread"
};
const ProviderKind = effect.Schema.Literals(["codex", "claudeAgent"]);
const ProviderApprovalPolicy = effect.Schema.Literals([
	"untrusted",
	"on-failure",
	"on-request",
	"never"
]);
const ProviderSandboxMode = effect.Schema.Literals([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
const CodexModelSelection = effect.Schema.Struct({
	provider: effect.Schema.Literal("codex"),
	model: TrimmedNonEmptyString,
	options: effect.Schema.optionalKey(CodexModelOptions)
});
const ClaudeModelSelection = effect.Schema.Struct({
	provider: effect.Schema.Literal("claudeAgent"),
	model: TrimmedNonEmptyString,
	options: effect.Schema.optionalKey(ClaudeModelOptions)
});
const ModelSelection = effect.Schema.Union([CodexModelSelection, ClaudeModelSelection]);
const RuntimeMode = effect.Schema.Literals([
	"approval-required",
	"auto-accept-edits",
	"full-access"
]);
const DEFAULT_RUNTIME_MODE = "full-access";
const ProviderInteractionMode = effect.Schema.Literals(["default", "plan"]);
const DEFAULT_PROVIDER_INTERACTION_MODE = "default";
const ProviderRequestKind = effect.Schema.Literals([
	"command",
	"file-read",
	"file-change"
]);
const AssistantDeliveryMode = effect.Schema.Literals(["buffered", "streaming"]);
const ProviderApprovalDecision = effect.Schema.Literals([
	"accept",
	"acceptForSession",
	"decline",
	"cancel"
]);
const ProviderUserInputAnswers = effect.Schema.Record(effect.Schema.String, effect.Schema.Unknown);
const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 12e4;
const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14e6;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
const ChatAttachmentId = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS), effect.Schema.isPattern(/^[a-z0-9_-]+$/i));
const ChatImageAttachment = effect.Schema.Struct({
	type: effect.Schema.Literal("image"),
	id: ChatAttachmentId,
	name: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(255)),
	mimeType: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(100), effect.Schema.isPattern(/^image\//i)),
	sizeBytes: NonNegativeInt.check(effect.Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES))
});
const UploadChatImageAttachment = effect.Schema.Struct({
	type: effect.Schema.Literal("image"),
	name: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(255)),
	mimeType: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(100), effect.Schema.isPattern(/^image\//i)),
	sizeBytes: NonNegativeInt.check(effect.Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
	dataUrl: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS))
});
const ChatAttachment = effect.Schema.Union([ChatImageAttachment]);
const UploadChatAttachment = effect.Schema.Union([UploadChatImageAttachment]);
const ProjectScriptIcon = effect.Schema.Literals([
	"play",
	"test",
	"lint",
	"configure",
	"build",
	"debug"
]);
const ProjectScript = effect.Schema.Struct({
	id: TrimmedNonEmptyString,
	name: TrimmedNonEmptyString,
	command: TrimmedNonEmptyString,
	icon: ProjectScriptIcon,
	runOnWorktreeCreate: effect.Schema.Boolean
});
const OrchestrationProjectOwnership = effect.Schema.Struct({
	tenantId: TenantId,
	tenantDisplayName: TrimmedNonEmptyString,
	workspaceId: WorkspaceId,
	workspaceTitle: TrimmedNonEmptyString,
	organizationId: effect.Schema.NullOr(OrganizationId),
	organizationDisplayName: effect.Schema.NullOr(TrimmedNonEmptyString),
	ownerUserId: effect.Schema.NullOr(UserId),
	ownerDisplayName: effect.Schema.NullOr(TrimmedNonEmptyString)
});
const OptionalProjectOwnership = effect.Schema.optional(OrchestrationProjectOwnership);
const OrchestrationProject = effect.Schema.Struct({
	id: ProjectId,
	title: TrimmedNonEmptyString,
	workspaceRoot: TrimmedNonEmptyString,
	ownership: OptionalProjectOwnership,
	repositoryIdentity: effect.Schema.optional(effect.Schema.NullOr(RepositoryIdentity)),
	defaultModelSelection: effect.Schema.NullOr(ModelSelection),
	scripts: effect.Schema.Array(ProjectScript),
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime,
	deletedAt: effect.Schema.NullOr(IsoDateTime)
});
const OrchestrationMessageRole = effect.Schema.Literals([
	"user",
	"assistant",
	"system"
]);
const OrchestrationMessage = effect.Schema.Struct({
	id: MessageId,
	role: OrchestrationMessageRole,
	authorUserId: effect.Schema.NullOr(UserId).pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(null))),
	text: effect.Schema.String,
	attachments: effect.Schema.optional(effect.Schema.Array(ChatAttachment)),
	turnId: effect.Schema.NullOr(TurnId),
	streaming: effect.Schema.Boolean,
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime
});
const OrchestrationProposedPlanId = TrimmedNonEmptyString;
const OrchestrationProposedPlan = effect.Schema.Struct({
	id: OrchestrationProposedPlanId,
	turnId: effect.Schema.NullOr(TurnId),
	planMarkdown: TrimmedNonEmptyString,
	implementedAt: effect.Schema.NullOr(IsoDateTime).pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(null))),
	implementationThreadId: effect.Schema.NullOr(ThreadId).pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(null))),
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime
});
const SourceProposedPlanReference = effect.Schema.Struct({
	threadId: ThreadId,
	planId: OrchestrationProposedPlanId
});
const OrchestrationSessionStatus = effect.Schema.Literals([
	"idle",
	"starting",
	"running",
	"ready",
	"interrupted",
	"stopped",
	"error"
]);
const OrchestrationSession = effect.Schema.Struct({
	threadId: ThreadId,
	status: OrchestrationSessionStatus,
	providerName: effect.Schema.NullOr(TrimmedNonEmptyString),
	runtimeMode: RuntimeMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_RUNTIME_MODE))),
	activeTurnId: effect.Schema.NullOr(TurnId),
	lastError: effect.Schema.NullOr(TrimmedNonEmptyString),
	updatedAt: IsoDateTime
});
const OrchestrationCheckpointFile = effect.Schema.Struct({
	path: TrimmedNonEmptyString,
	kind: TrimmedNonEmptyString,
	additions: NonNegativeInt,
	deletions: NonNegativeInt
});
const OrchestrationCheckpointStatus = effect.Schema.Literals([
	"ready",
	"missing",
	"error"
]);
const OrchestrationCheckpointSummary = effect.Schema.Struct({
	turnId: TurnId,
	checkpointTurnCount: NonNegativeInt,
	checkpointRef: CheckpointRef,
	status: OrchestrationCheckpointStatus,
	files: effect.Schema.Array(OrchestrationCheckpointFile),
	assistantMessageId: effect.Schema.NullOr(MessageId),
	completedAt: IsoDateTime
});
const OrchestrationThreadActivityTone = effect.Schema.Literals([
	"info",
	"tool",
	"approval",
	"error"
]);
const OrchestrationThreadActivity = effect.Schema.Struct({
	id: EventId,
	tone: OrchestrationThreadActivityTone,
	kind: TrimmedNonEmptyString,
	summary: TrimmedNonEmptyString,
	payload: effect.Schema.Unknown,
	turnId: effect.Schema.NullOr(TurnId),
	sequence: effect.Schema.optional(NonNegativeInt),
	createdAt: IsoDateTime
});
const OrchestrationLatestTurnState = effect.Schema.Literals([
	"running",
	"interrupted",
	"completed",
	"error"
]);
const OrchestrationLatestTurn = effect.Schema.Struct({
	turnId: TurnId,
	state: OrchestrationLatestTurnState,
	requestedAt: IsoDateTime,
	startedAt: effect.Schema.NullOr(IsoDateTime),
	completedAt: effect.Schema.NullOr(IsoDateTime),
	assistantMessageId: effect.Schema.NullOr(MessageId),
	sourceProposedPlan: effect.Schema.optional(SourceProposedPlanReference)
});
const OrchestrationThread = effect.Schema.Struct({
	id: ThreadId,
	projectId: ProjectId,
	title: TrimmedNonEmptyString,
	modelSelection: ModelSelection,
	runtimeMode: RuntimeMode,
	interactionMode: ProviderInteractionMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE))),
	branch: effect.Schema.NullOr(TrimmedNonEmptyString),
	worktreePath: effect.Schema.NullOr(TrimmedNonEmptyString),
	latestTurn: effect.Schema.NullOr(OrchestrationLatestTurn),
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime,
	favorite: effect.Schema.optionalKey(effect.Schema.Boolean),
	archivedAt: effect.Schema.NullOr(IsoDateTime).pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(null))),
	deletedAt: effect.Schema.NullOr(IsoDateTime),
	messages: effect.Schema.Array(OrchestrationMessage),
	proposedPlans: effect.Schema.Array(OrchestrationProposedPlan).pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed([]))),
	activities: effect.Schema.Array(OrchestrationThreadActivity),
	checkpoints: effect.Schema.Array(OrchestrationCheckpointSummary),
	session: effect.Schema.NullOr(OrchestrationSession)
});
const OrchestrationReadModel = effect.Schema.Struct({
	snapshotSequence: NonNegativeInt,
	projects: effect.Schema.Array(OrchestrationProject),
	threads: effect.Schema.Array(OrchestrationThread),
	updatedAt: IsoDateTime
});
const OrchestrationProjectShell = effect.Schema.Struct({
	id: ProjectId,
	title: TrimmedNonEmptyString,
	workspaceRoot: TrimmedNonEmptyString,
	ownership: OptionalProjectOwnership,
	repositoryIdentity: effect.Schema.optional(effect.Schema.NullOr(RepositoryIdentity)),
	defaultModelSelection: effect.Schema.NullOr(ModelSelection),
	scripts: effect.Schema.Array(ProjectScript),
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime
});
const OrchestrationThreadShell = effect.Schema.Struct({
	id: ThreadId,
	projectId: ProjectId,
	title: TrimmedNonEmptyString,
	modelSelection: ModelSelection,
	runtimeMode: RuntimeMode,
	interactionMode: ProviderInteractionMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE))),
	branch: effect.Schema.NullOr(TrimmedNonEmptyString),
	worktreePath: effect.Schema.NullOr(TrimmedNonEmptyString),
	latestTurn: effect.Schema.NullOr(OrchestrationLatestTurn),
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime,
	favorite: effect.Schema.optionalKey(effect.Schema.Boolean),
	archivedAt: effect.Schema.NullOr(IsoDateTime).pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(null))),
	session: effect.Schema.NullOr(OrchestrationSession),
	latestUserMessageAt: effect.Schema.NullOr(IsoDateTime),
	hasPendingApprovals: effect.Schema.Boolean,
	hasPendingUserInput: effect.Schema.Boolean,
	hasActionableProposedPlan: effect.Schema.Boolean
});
const OrchestrationShellSnapshot = effect.Schema.Struct({
	snapshotSequence: NonNegativeInt,
	projects: effect.Schema.Array(OrchestrationProjectShell),
	threads: effect.Schema.Array(OrchestrationThreadShell),
	updatedAt: IsoDateTime
});
const OrchestrationShellStreamEvent = effect.Schema.Union([
	effect.Schema.Struct({
		kind: effect.Schema.Literal("project-upserted"),
		sequence: NonNegativeInt,
		project: OrchestrationProjectShell
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("project-removed"),
		sequence: NonNegativeInt,
		projectId: ProjectId
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("thread-upserted"),
		sequence: NonNegativeInt,
		thread: OrchestrationThreadShell
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("thread-removed"),
		sequence: NonNegativeInt,
		threadId: ThreadId
	})
]);
const OrchestrationShellStreamItem = effect.Schema.Union([effect.Schema.Struct({
	kind: effect.Schema.Literal("snapshot"),
	snapshot: OrchestrationShellSnapshot
}), OrchestrationShellStreamEvent]);
const OrchestrationSubscribeThreadInput = effect.Schema.Struct({ threadId: ThreadId });
const OrchestrationThreadDetailSnapshot = effect.Schema.Struct({
	snapshotSequence: NonNegativeInt,
	thread: OrchestrationThread
});
const ProjectCreateCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("project.create"),
	commandId: CommandId,
	projectId: ProjectId,
	title: TrimmedNonEmptyString,
	workspaceRoot: TrimmedNonEmptyString,
	ownership: OptionalProjectOwnership,
	createWorkspaceRootIfMissing: effect.Schema.optional(effect.Schema.Boolean),
	defaultModelSelection: effect.Schema.optional(effect.Schema.NullOr(ModelSelection)),
	createdAt: IsoDateTime
});
const ProjectMetaUpdateCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("project.meta.update"),
	commandId: CommandId,
	projectId: ProjectId,
	title: effect.Schema.optional(TrimmedNonEmptyString),
	workspaceRoot: effect.Schema.optional(TrimmedNonEmptyString),
	ownership: OptionalProjectOwnership,
	defaultModelSelection: effect.Schema.optional(effect.Schema.NullOr(ModelSelection)),
	scripts: effect.Schema.optional(effect.Schema.Array(ProjectScript))
});
const ProjectDeleteCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("project.delete"),
	commandId: CommandId,
	projectId: ProjectId
});
const ThreadCreateCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.create"),
	commandId: CommandId,
	threadId: ThreadId,
	projectId: ProjectId,
	title: TrimmedNonEmptyString,
	modelSelection: ModelSelection,
	runtimeMode: RuntimeMode,
	interactionMode: ProviderInteractionMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE))),
	branch: effect.Schema.NullOr(TrimmedNonEmptyString),
	worktreePath: effect.Schema.NullOr(TrimmedNonEmptyString),
	createdAt: IsoDateTime
});
const ThreadDeleteCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.delete"),
	commandId: CommandId,
	threadId: ThreadId
});
const ThreadArchiveCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.archive"),
	commandId: CommandId,
	threadId: ThreadId
});
const ThreadUnarchiveCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.unarchive"),
	commandId: CommandId,
	threadId: ThreadId
});
const ThreadMetaUpdateCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.meta.update"),
	commandId: CommandId,
	threadId: ThreadId,
	title: effect.Schema.optional(TrimmedNonEmptyString),
	modelSelection: effect.Schema.optional(ModelSelection),
	branch: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyString)),
	worktreePath: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyString)),
	favorite: effect.Schema.optional(effect.Schema.Boolean)
});
const ThreadRuntimeModeSetCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.runtime-mode.set"),
	commandId: CommandId,
	threadId: ThreadId,
	runtimeMode: RuntimeMode,
	createdAt: IsoDateTime
});
const ThreadInteractionModeSetCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.interaction-mode.set"),
	commandId: CommandId,
	threadId: ThreadId,
	interactionMode: ProviderInteractionMode,
	createdAt: IsoDateTime
});
const ThreadTurnStartBootstrapCreateThread = effect.Schema.Struct({
	projectId: ProjectId,
	title: TrimmedNonEmptyString,
	modelSelection: ModelSelection,
	runtimeMode: RuntimeMode,
	interactionMode: ProviderInteractionMode,
	branch: effect.Schema.NullOr(TrimmedNonEmptyString),
	worktreePath: effect.Schema.NullOr(TrimmedNonEmptyString),
	createdAt: IsoDateTime
});
const ThreadTurnStartBootstrapPrepareWorktree = effect.Schema.Struct({
	projectCwd: TrimmedNonEmptyString,
	baseBranch: TrimmedNonEmptyString,
	branch: effect.Schema.optional(TrimmedNonEmptyString)
});
const ThreadTurnStartBootstrap = effect.Schema.Struct({
	createThread: effect.Schema.optional(ThreadTurnStartBootstrapCreateThread),
	prepareWorktree: effect.Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
	runSetupScript: effect.Schema.optional(effect.Schema.Boolean)
});
const ThreadTurnStartCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.turn.start"),
	commandId: CommandId,
	threadId: ThreadId,
	message: effect.Schema.Struct({
		messageId: MessageId,
		role: effect.Schema.Literal("user"),
		authorUserId: effect.Schema.NullOr(UserId).pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(null))),
		text: effect.Schema.String,
		attachments: effect.Schema.Array(ChatAttachment)
	}),
	modelSelection: effect.Schema.optional(ModelSelection),
	titleSeed: effect.Schema.optional(TrimmedNonEmptyString),
	runtimeMode: RuntimeMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_RUNTIME_MODE))),
	interactionMode: ProviderInteractionMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE))),
	bootstrap: effect.Schema.optional(ThreadTurnStartBootstrap),
	sourceProposedPlan: effect.Schema.optional(SourceProposedPlanReference),
	createdAt: IsoDateTime
});
const ClientThreadTurnStartCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.turn.start"),
	commandId: CommandId,
	threadId: ThreadId,
	message: effect.Schema.Struct({
		messageId: MessageId,
		role: effect.Schema.Literal("user"),
		text: effect.Schema.String,
		attachments: effect.Schema.Array(UploadChatAttachment)
	}),
	modelSelection: effect.Schema.optional(ModelSelection),
	titleSeed: effect.Schema.optional(TrimmedNonEmptyString),
	runtimeMode: RuntimeMode,
	interactionMode: ProviderInteractionMode,
	bootstrap: effect.Schema.optional(ThreadTurnStartBootstrap),
	sourceProposedPlan: effect.Schema.optional(SourceProposedPlanReference),
	createdAt: IsoDateTime
});
const ThreadTurnInterruptCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.turn.interrupt"),
	commandId: CommandId,
	threadId: ThreadId,
	turnId: effect.Schema.optional(TurnId),
	createdAt: IsoDateTime
});
const ThreadApprovalRespondCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.approval.respond"),
	commandId: CommandId,
	threadId: ThreadId,
	requestId: ApprovalRequestId,
	decision: ProviderApprovalDecision,
	createdAt: IsoDateTime
});
const ThreadUserInputRespondCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.user-input.respond"),
	commandId: CommandId,
	threadId: ThreadId,
	requestId: ApprovalRequestId,
	answers: ProviderUserInputAnswers,
	createdAt: IsoDateTime
});
const ThreadCheckpointRevertCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.checkpoint.revert"),
	commandId: CommandId,
	threadId: ThreadId,
	turnCount: NonNegativeInt,
	createdAt: IsoDateTime
});
const ThreadSessionStopCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.session.stop"),
	commandId: CommandId,
	threadId: ThreadId,
	createdAt: IsoDateTime
});
const DispatchableClientOrchestrationCommand = effect.Schema.Union([
	ProjectCreateCommand,
	ProjectMetaUpdateCommand,
	ProjectDeleteCommand,
	ThreadCreateCommand,
	ThreadDeleteCommand,
	ThreadArchiveCommand,
	ThreadUnarchiveCommand,
	ThreadMetaUpdateCommand,
	ThreadRuntimeModeSetCommand,
	ThreadInteractionModeSetCommand,
	ThreadTurnStartCommand,
	ThreadTurnInterruptCommand,
	ThreadApprovalRespondCommand,
	ThreadUserInputRespondCommand,
	ThreadCheckpointRevertCommand,
	ThreadSessionStopCommand
]);
const ClientOrchestrationCommand = effect.Schema.Union([
	ProjectCreateCommand,
	ProjectMetaUpdateCommand,
	ProjectDeleteCommand,
	ThreadCreateCommand,
	ThreadDeleteCommand,
	ThreadArchiveCommand,
	ThreadUnarchiveCommand,
	ThreadMetaUpdateCommand,
	ThreadRuntimeModeSetCommand,
	ThreadInteractionModeSetCommand,
	ClientThreadTurnStartCommand,
	ThreadTurnInterruptCommand,
	ThreadApprovalRespondCommand,
	ThreadUserInputRespondCommand,
	ThreadCheckpointRevertCommand,
	ThreadSessionStopCommand
]);
const ThreadSessionSetCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.session.set"),
	commandId: CommandId,
	threadId: ThreadId,
	session: OrchestrationSession,
	createdAt: IsoDateTime
});
const ThreadMessageAssistantDeltaCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.message.assistant.delta"),
	commandId: CommandId,
	threadId: ThreadId,
	messageId: MessageId,
	delta: effect.Schema.String,
	turnId: effect.Schema.optional(TurnId),
	createdAt: IsoDateTime
});
const ThreadMessageAssistantCompleteCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.message.assistant.complete"),
	commandId: CommandId,
	threadId: ThreadId,
	messageId: MessageId,
	turnId: effect.Schema.optional(TurnId),
	createdAt: IsoDateTime
});
const ThreadProposedPlanUpsertCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.proposed-plan.upsert"),
	commandId: CommandId,
	threadId: ThreadId,
	proposedPlan: OrchestrationProposedPlan,
	createdAt: IsoDateTime
});
const ThreadTurnDiffCompleteCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.turn.diff.complete"),
	commandId: CommandId,
	threadId: ThreadId,
	turnId: TurnId,
	completedAt: IsoDateTime,
	checkpointRef: CheckpointRef,
	status: OrchestrationCheckpointStatus,
	files: effect.Schema.Array(OrchestrationCheckpointFile),
	assistantMessageId: effect.Schema.optional(MessageId),
	checkpointTurnCount: NonNegativeInt,
	createdAt: IsoDateTime
});
const ThreadActivityAppendCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.activity.append"),
	commandId: CommandId,
	threadId: ThreadId,
	activity: OrchestrationThreadActivity,
	createdAt: IsoDateTime
});
const ThreadRevertCompleteCommand = effect.Schema.Struct({
	type: effect.Schema.Literal("thread.revert.complete"),
	commandId: CommandId,
	threadId: ThreadId,
	turnCount: NonNegativeInt,
	createdAt: IsoDateTime
});
const InternalOrchestrationCommand = effect.Schema.Union([
	ThreadSessionSetCommand,
	ThreadMessageAssistantDeltaCommand,
	ThreadMessageAssistantCompleteCommand,
	ThreadProposedPlanUpsertCommand,
	ThreadTurnDiffCompleteCommand,
	ThreadActivityAppendCommand,
	ThreadRevertCompleteCommand
]);
const OrchestrationCommand = effect.Schema.Union([DispatchableClientOrchestrationCommand, InternalOrchestrationCommand]);
const OrchestrationEventType = effect.Schema.Literals([
	"project.created",
	"project.meta-updated",
	"project.deleted",
	"thread.created",
	"thread.deleted",
	"thread.archived",
	"thread.unarchived",
	"thread.meta-updated",
	"thread.runtime-mode-set",
	"thread.interaction-mode-set",
	"thread.message-sent",
	"thread.turn-start-requested",
	"thread.turn-interrupt-requested",
	"thread.approval-response-requested",
	"thread.user-input-response-requested",
	"thread.checkpoint-revert-requested",
	"thread.reverted",
	"thread.session-stop-requested",
	"thread.session-set",
	"thread.proposed-plan-upserted",
	"thread.turn-diff-completed",
	"thread.activity-appended"
]);
const OrchestrationAggregateKind = effect.Schema.Literals(["project", "thread"]);
const OrchestrationActorKind = effect.Schema.Literals([
	"client",
	"server",
	"provider"
]);
const ProjectCreatedPayload = effect.Schema.Struct({
	projectId: ProjectId,
	title: TrimmedNonEmptyString,
	workspaceRoot: TrimmedNonEmptyString,
	ownership: OptionalProjectOwnership,
	repositoryIdentity: effect.Schema.optional(effect.Schema.NullOr(RepositoryIdentity)),
	defaultModelSelection: effect.Schema.NullOr(ModelSelection),
	scripts: effect.Schema.Array(ProjectScript),
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime
});
const ProjectMetaUpdatedPayload = effect.Schema.Struct({
	projectId: ProjectId,
	title: effect.Schema.optional(TrimmedNonEmptyString),
	workspaceRoot: effect.Schema.optional(TrimmedNonEmptyString),
	ownership: OptionalProjectOwnership,
	repositoryIdentity: effect.Schema.optional(effect.Schema.NullOr(RepositoryIdentity)),
	defaultModelSelection: effect.Schema.optional(effect.Schema.NullOr(ModelSelection)),
	scripts: effect.Schema.optional(effect.Schema.Array(ProjectScript)),
	updatedAt: IsoDateTime
});
const ProjectDeletedPayload = effect.Schema.Struct({
	projectId: ProjectId,
	deletedAt: IsoDateTime
});
const ThreadCreatedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	projectId: ProjectId,
	title: TrimmedNonEmptyString,
	modelSelection: ModelSelection,
	runtimeMode: RuntimeMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_RUNTIME_MODE))),
	interactionMode: ProviderInteractionMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE))),
	branch: effect.Schema.NullOr(TrimmedNonEmptyString),
	worktreePath: effect.Schema.NullOr(TrimmedNonEmptyString),
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime
});
const ThreadDeletedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	deletedAt: IsoDateTime
});
const ThreadArchivedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	archivedAt: IsoDateTime,
	updatedAt: IsoDateTime
});
const ThreadUnarchivedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	updatedAt: IsoDateTime
});
const ThreadMetaUpdatedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	title: effect.Schema.optional(TrimmedNonEmptyString),
	modelSelection: effect.Schema.optional(ModelSelection),
	branch: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyString)),
	worktreePath: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyString)),
	favorite: effect.Schema.optional(effect.Schema.Boolean),
	updatedAt: IsoDateTime
});
const ThreadRuntimeModeSetPayload = effect.Schema.Struct({
	threadId: ThreadId,
	runtimeMode: RuntimeMode,
	updatedAt: IsoDateTime
});
const ThreadInteractionModeSetPayload = effect.Schema.Struct({
	threadId: ThreadId,
	interactionMode: ProviderInteractionMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE))),
	updatedAt: IsoDateTime
});
const ThreadMessageSentPayload = effect.Schema.Struct({
	threadId: ThreadId,
	messageId: MessageId,
	role: OrchestrationMessageRole,
	authorUserId: effect.Schema.NullOr(UserId).pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(null))),
	text: effect.Schema.String,
	attachments: effect.Schema.optional(effect.Schema.Array(ChatAttachment)),
	turnId: effect.Schema.NullOr(TurnId),
	streaming: effect.Schema.Boolean,
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime
});
const ThreadTurnStartRequestedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	messageId: MessageId,
	modelSelection: effect.Schema.optional(ModelSelection),
	titleSeed: effect.Schema.optional(TrimmedNonEmptyString),
	runtimeMode: RuntimeMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_RUNTIME_MODE))),
	interactionMode: ProviderInteractionMode.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE))),
	sourceProposedPlan: effect.Schema.optional(SourceProposedPlanReference),
	createdAt: IsoDateTime
});
const ThreadTurnInterruptRequestedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	turnId: effect.Schema.optional(TurnId),
	createdAt: IsoDateTime
});
const ThreadApprovalResponseRequestedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	requestId: ApprovalRequestId,
	decision: ProviderApprovalDecision,
	createdAt: IsoDateTime
});
const ThreadUserInputResponseRequestedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	requestId: ApprovalRequestId,
	answers: ProviderUserInputAnswers,
	createdAt: IsoDateTime
});
const ThreadCheckpointRevertRequestedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	turnCount: NonNegativeInt,
	createdAt: IsoDateTime
});
const ThreadRevertedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	turnCount: NonNegativeInt
});
const ThreadSessionStopRequestedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	createdAt: IsoDateTime
});
const ThreadSessionSetPayload = effect.Schema.Struct({
	threadId: ThreadId,
	session: OrchestrationSession
});
const ThreadProposedPlanUpsertedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	proposedPlan: OrchestrationProposedPlan
});
const ThreadTurnDiffCompletedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	turnId: TurnId,
	checkpointTurnCount: NonNegativeInt,
	checkpointRef: CheckpointRef,
	status: OrchestrationCheckpointStatus,
	files: effect.Schema.Array(OrchestrationCheckpointFile),
	assistantMessageId: effect.Schema.NullOr(MessageId),
	completedAt: IsoDateTime
});
const ThreadActivityAppendedPayload = effect.Schema.Struct({
	threadId: ThreadId,
	activity: OrchestrationThreadActivity
});
const OrchestrationEventMetadata = effect.Schema.Struct({
	providerTurnId: effect.Schema.optional(TrimmedNonEmptyString),
	providerItemId: effect.Schema.optional(ProviderItemId),
	adapterKey: effect.Schema.optional(TrimmedNonEmptyString),
	requestId: effect.Schema.optional(ApprovalRequestId),
	ingestedAt: effect.Schema.optional(IsoDateTime)
});
const EventBaseFields = {
	sequence: NonNegativeInt,
	eventId: EventId,
	aggregateKind: OrchestrationAggregateKind,
	aggregateId: effect.Schema.Union([ProjectId, ThreadId]),
	occurredAt: IsoDateTime,
	commandId: effect.Schema.NullOr(CommandId),
	causationEventId: effect.Schema.NullOr(EventId),
	correlationId: effect.Schema.NullOr(CommandId),
	metadata: OrchestrationEventMetadata
};
const OrchestrationEvent = effect.Schema.Union([
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("project.created"),
		payload: ProjectCreatedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("project.meta-updated"),
		payload: ProjectMetaUpdatedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("project.deleted"),
		payload: ProjectDeletedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.created"),
		payload: ThreadCreatedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.deleted"),
		payload: ThreadDeletedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.archived"),
		payload: ThreadArchivedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.unarchived"),
		payload: ThreadUnarchivedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.meta-updated"),
		payload: ThreadMetaUpdatedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.runtime-mode-set"),
		payload: ThreadRuntimeModeSetPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.interaction-mode-set"),
		payload: ThreadInteractionModeSetPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.message-sent"),
		payload: ThreadMessageSentPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.turn-start-requested"),
		payload: ThreadTurnStartRequestedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.turn-interrupt-requested"),
		payload: ThreadTurnInterruptRequestedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.approval-response-requested"),
		payload: ThreadApprovalResponseRequestedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.user-input-response-requested"),
		payload: ThreadUserInputResponseRequestedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.checkpoint-revert-requested"),
		payload: ThreadCheckpointRevertRequestedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.reverted"),
		payload: ThreadRevertedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.session-stop-requested"),
		payload: ThreadSessionStopRequestedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.session-set"),
		payload: ThreadSessionSetPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.proposed-plan-upserted"),
		payload: ThreadProposedPlanUpsertedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.turn-diff-completed"),
		payload: ThreadTurnDiffCompletedPayload
	}),
	effect.Schema.Struct({
		...EventBaseFields,
		type: effect.Schema.Literal("thread.activity-appended"),
		payload: ThreadActivityAppendedPayload
	})
]);
const OrchestrationThreadStreamItem = effect.Schema.Union([effect.Schema.Struct({
	kind: effect.Schema.Literal("snapshot"),
	snapshot: OrchestrationThreadDetailSnapshot
}), effect.Schema.Struct({
	kind: effect.Schema.Literal("event"),
	event: OrchestrationEvent
})]);
const OrchestrationCommandReceiptStatus = effect.Schema.Literals(["accepted", "rejected"]);
const TurnCountRange = effect.Schema.Struct({
	fromTurnCount: NonNegativeInt,
	toTurnCount: NonNegativeInt
}).check(effect.Schema.makeFilter((input) => input.fromTurnCount <= input.toTurnCount || new effect.SchemaIssue.InvalidValue(effect.Option.some(input.fromTurnCount), { message: "fromTurnCount must be less than or equal to toTurnCount" }), { identifier: "OrchestrationTurnDiffRange" }));
const ThreadTurnDiff = TurnCountRange.mapFields(effect.Struct.assign({
	threadId: ThreadId,
	diff: effect.Schema.String
}), { unsafePreserveChecks: true });
const ProviderSessionRuntimeStatus = effect.Schema.Literals([
	"starting",
	"running",
	"stopped",
	"error"
]);
effect.Schema.Literals([
	"running",
	"completed",
	"interrupted",
	"error"
]);
effect.Schema.Struct({
	threadId: ThreadId,
	turnId: TurnId,
	checkpointTurnCount: NonNegativeInt,
	checkpointRef: CheckpointRef,
	status: OrchestrationCheckpointStatus,
	files: effect.Schema.Array(OrchestrationCheckpointFile),
	assistantMessageId: effect.Schema.NullOr(MessageId),
	completedAt: IsoDateTime
});
const ProjectionPendingApprovalStatus = effect.Schema.Literals(["pending", "resolved"]);
const ProjectionPendingApprovalDecision = effect.Schema.NullOr(ProviderApprovalDecision);
const DispatchResult = effect.Schema.Struct({ sequence: NonNegativeInt });
const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(effect.Struct.assign({ threadId: ThreadId }), { unsafePreserveChecks: true });
const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
const OrchestrationGetFullThreadDiffInput = effect.Schema.Struct({
	threadId: ThreadId,
	toTurnCount: NonNegativeInt
});
const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
const OrchestrationReplayEventsInput = effect.Schema.Struct({ fromSequenceExclusive: NonNegativeInt });
const OrchestrationReplayEventsResult = effect.Schema.Array(OrchestrationEvent);
const OrchestrationRpcSchemas = {
	dispatchCommand: {
		input: ClientOrchestrationCommand,
		output: DispatchResult
	},
	getTurnDiff: {
		input: OrchestrationGetTurnDiffInput,
		output: OrchestrationGetTurnDiffResult
	},
	getFullThreadDiff: {
		input: OrchestrationGetFullThreadDiffInput,
		output: OrchestrationGetFullThreadDiffResult
	},
	replayEvents: {
		input: OrchestrationReplayEventsInput,
		output: OrchestrationReplayEventsResult
	},
	subscribeThread: {
		input: OrchestrationSubscribeThreadInput,
		output: OrchestrationThreadStreamItem
	},
	subscribeShell: {
		input: effect.Schema.Struct({}),
		output: OrchestrationShellStreamItem
	}
};
var OrchestrationGetSnapshotError = class extends effect.Schema.TaggedErrorClass()("OrchestrationGetSnapshotError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
var OrchestrationDispatchCommandError = class extends effect.Schema.TaggedErrorClass()("OrchestrationDispatchCommandError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
/**
* `project.create` is refused when an active project already owns the workspace
* root. The RPC boundary flattens command-invariant failures into an untyped
* cause chain, so the existing project id rides along inside the failure text
* instead of a typed field: this marker is what makes it machine-readable, and
* `parseWorkspaceRootAlreadyClaimedProjectId` is the only sanctioned reader.
*/
const WORKSPACE_ROOT_ALREADY_CLAIMED_MARKER = "workspace-root-already-claimed";
const WORKSPACE_ROOT_ALREADY_CLAIMED_PATTERN = new RegExp(`\\[${WORKSPACE_ROOT_ALREADY_CLAIMED_MARKER}:([^\\]]+)\\]`);
var OrchestrationGetTurnDiffError = class extends effect.Schema.TaggedErrorClass()("OrchestrationGetTurnDiffError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
var OrchestrationGetFullThreadDiffError = class extends effect.Schema.TaggedErrorClass()("OrchestrationGetFullThreadDiffError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
var OrchestrationReplayEventsError = class extends effect.Schema.TaggedErrorClass()("OrchestrationReplayEventsError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};

//#endregion
//#region ../../packages/contracts/src/terminal.ts
const DEFAULT_TERMINAL_ID = "default";
const TrimmedNonEmptyStringSchema$2 = TrimmedNonEmptyString;
const TerminalColsSchema = effect.Schema.Int.check(effect.Schema.isGreaterThanOrEqualTo(20)).check(effect.Schema.isLessThanOrEqualTo(400));
const TerminalRowsSchema = effect.Schema.Int.check(effect.Schema.isGreaterThanOrEqualTo(5)).check(effect.Schema.isLessThanOrEqualTo(200));
const TerminalIdSchema = TrimmedNonEmptyStringSchema$2.check(effect.Schema.isMaxLength(128));
const TerminalEnvKeySchema = effect.Schema.String.check(effect.Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).check(effect.Schema.isMaxLength(128));
const TerminalEnvValueSchema = effect.Schema.String.check(effect.Schema.isMaxLength(8192));
const TerminalEnvSchema = effect.Schema.Record(TerminalEnvKeySchema, TerminalEnvValueSchema).check(effect.Schema.isMaxProperties(128));
const TerminalIdWithDefaultSchema = TerminalIdSchema.pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_TERMINAL_ID)));
const TerminalThreadInput = effect.Schema.Struct({ threadId: TrimmedNonEmptyStringSchema$2 });
const TerminalSessionInput = effect.Schema.Struct({
	...TerminalThreadInput.fields,
	terminalId: TerminalIdWithDefaultSchema
});
const TerminalOpenInput = effect.Schema.Struct({
	...TerminalSessionInput.fields,
	cwd: TrimmedNonEmptyStringSchema$2,
	worktreePath: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyStringSchema$2)),
	cols: effect.Schema.optional(TerminalColsSchema),
	rows: effect.Schema.optional(TerminalRowsSchema),
	env: effect.Schema.optional(TerminalEnvSchema)
});
const TerminalWriteInput = effect.Schema.Struct({
	...TerminalSessionInput.fields,
	data: effect.Schema.String.check(effect.Schema.isNonEmpty()).check(effect.Schema.isMaxLength(65536))
});
const TerminalResizeInput = effect.Schema.Struct({
	...TerminalSessionInput.fields,
	cols: TerminalColsSchema,
	rows: TerminalRowsSchema
});
const TerminalClearInput = TerminalSessionInput;
const TerminalRestartInput = effect.Schema.Struct({
	...TerminalSessionInput.fields,
	cwd: TrimmedNonEmptyStringSchema$2,
	worktreePath: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyStringSchema$2)),
	cols: TerminalColsSchema,
	rows: TerminalRowsSchema,
	env: effect.Schema.optional(TerminalEnvSchema)
});
const TerminalCloseInput = effect.Schema.Struct({
	...TerminalThreadInput.fields,
	terminalId: effect.Schema.optional(TerminalIdSchema),
	deleteHistory: effect.Schema.optional(effect.Schema.Boolean)
});
const TerminalSessionStatus = effect.Schema.Literals([
	"starting",
	"running",
	"exited",
	"error"
]);
const TerminalSessionSnapshot = effect.Schema.Struct({
	threadId: effect.Schema.String.check(effect.Schema.isNonEmpty()),
	terminalId: effect.Schema.String.check(effect.Schema.isNonEmpty()),
	cwd: effect.Schema.String.check(effect.Schema.isNonEmpty()),
	worktreePath: effect.Schema.NullOr(TrimmedNonEmptyStringSchema$2),
	status: TerminalSessionStatus,
	pid: effect.Schema.NullOr(effect.Schema.Int.check(effect.Schema.isGreaterThan(0))),
	history: effect.Schema.String,
	exitCode: effect.Schema.NullOr(effect.Schema.Int),
	exitSignal: effect.Schema.NullOr(effect.Schema.Int),
	updatedAt: effect.Schema.String
});
const TerminalEventBaseSchema = effect.Schema.Struct({
	threadId: effect.Schema.String.check(effect.Schema.isNonEmpty()),
	terminalId: effect.Schema.String.check(effect.Schema.isNonEmpty()),
	createdAt: effect.Schema.String
});
const TerminalStartedEvent = effect.Schema.Struct({
	...TerminalEventBaseSchema.fields,
	type: effect.Schema.Literal("started"),
	snapshot: TerminalSessionSnapshot
});
const TerminalOutputEvent = effect.Schema.Struct({
	...TerminalEventBaseSchema.fields,
	type: effect.Schema.Literal("output"),
	data: effect.Schema.String
});
const TerminalExitedEvent = effect.Schema.Struct({
	...TerminalEventBaseSchema.fields,
	type: effect.Schema.Literal("exited"),
	exitCode: effect.Schema.NullOr(effect.Schema.Int),
	exitSignal: effect.Schema.NullOr(effect.Schema.Int)
});
const TerminalErrorEvent = effect.Schema.Struct({
	...TerminalEventBaseSchema.fields,
	type: effect.Schema.Literal("error"),
	message: effect.Schema.String.check(effect.Schema.isNonEmpty())
});
const TerminalClearedEvent = effect.Schema.Struct({
	...TerminalEventBaseSchema.fields,
	type: effect.Schema.Literal("cleared")
});
const TerminalRestartedEvent = effect.Schema.Struct({
	...TerminalEventBaseSchema.fields,
	type: effect.Schema.Literal("restarted"),
	snapshot: TerminalSessionSnapshot
});
const TerminalActivityEvent = effect.Schema.Struct({
	...TerminalEventBaseSchema.fields,
	type: effect.Schema.Literal("activity"),
	hasRunningSubprocess: effect.Schema.Boolean
});
const TerminalEvent = effect.Schema.Union([
	TerminalStartedEvent,
	TerminalOutputEvent,
	TerminalExitedEvent,
	TerminalErrorEvent,
	TerminalClearedEvent,
	TerminalRestartedEvent,
	TerminalActivityEvent
]);
var TerminalCwdError = class extends effect.Schema.TaggedErrorClass()("TerminalCwdError", {
	cwd: effect.Schema.String,
	reason: effect.Schema.Literals([
		"notFound",
		"notDirectory",
		"statFailed"
	]),
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {
	get message() {
		if (this.reason === "notDirectory") return `Terminal cwd is not a directory: ${this.cwd}`;
		if (this.reason === "notFound") return `Terminal cwd does not exist: ${this.cwd}`;
		const causeMessage = this.cause && typeof this.cause === "object" && "message" in this.cause ? this.cause.message : void 0;
		return causeMessage ? `Failed to access terminal cwd: ${this.cwd} (${causeMessage})` : `Failed to access terminal cwd: ${this.cwd}`;
	}
};
var TerminalHistoryError = class extends effect.Schema.TaggedErrorClass()("TerminalHistoryError", {
	operation: effect.Schema.Literals([
		"read",
		"truncate",
		"migrate"
	]),
	threadId: effect.Schema.String,
	terminalId: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {
	get message() {
		return `Failed to ${this.operation} terminal history for thread: ${this.threadId}, terminal: ${this.terminalId}`;
	}
};
var TerminalSessionLookupError = class extends effect.Schema.TaggedErrorClass()("TerminalSessionLookupError", {
	threadId: effect.Schema.String,
	terminalId: effect.Schema.String
}) {
	get message() {
		return `Unknown terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
	}
};
var TerminalNotRunningError = class extends effect.Schema.TaggedErrorClass()("TerminalNotRunningError", {
	threadId: effect.Schema.String,
	terminalId: effect.Schema.String
}) {
	get message() {
		return `Terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
	}
};
const TerminalError = effect.Schema.Union([
	TerminalCwdError,
	TerminalHistoryError,
	TerminalSessionLookupError,
	TerminalNotRunningError
]);

//#endregion
//#region ../../packages/contracts/src/tenancy.ts
const PortNumber = PositiveInt.check(effect.Schema.isLessThanOrEqualTo(65535));
const TenantKind = effect.Schema.Literals([
	"personal",
	"shared",
	"corporate",
	"support"
]);
const WorkspaceKind = effect.Schema.Literals([
	"personal",
	"shared",
	"corporate",
	"support"
]);
const TenantRole = effect.Schema.Literals([
	"owner",
	"admin",
	"developer",
	"pm",
	"support",
	"viewer",
	"platform-operator"
]);
const TenantPermission = effect.Schema.Literals([
	"tenant.read",
	"tenant.update",
	"tenant.quarantine",
	"workspace.view",
	"workspace.edit",
	"workspace.invite",
	"project.view",
	"project.create",
	"project.edit",
	"session.view",
	"session.create",
	"session.prompt",
	"file.read",
	"file.write",
	"file.upload",
	"provider.use",
	"provider.connect",
	"provider.manage",
	"runtime.manage",
	"membership.manage",
	"organization.manage",
	"audit.view",
	"support.assist",
	"platform.operate"
]);
const TenantRuntimeStatus = effect.Schema.Literals([
	"stopped",
	"starting",
	"running",
	"stopping",
	"quarantined"
]);
const TenantRuntimeIsolationStrategy = effect.Schema.Literals([
	"systemd-per-tenant",
	"container-per-tenant",
	"process-per-tenant"
]);
const TenantRuntimeIsolation = effect.Schema.Struct({
	runtimeId: TenantRuntimeId,
	tenantId: TenantId,
	strategy: TenantRuntimeIsolationStrategy,
	linuxUser: TrimmedNonEmptyString,
	baseDir: TrimmedNonEmptyString,
	dataDir: TrimmedNonEmptyString,
	secretsDir: TrimmedNonEmptyString,
	attachmentsDir: TrimmedNonEmptyString,
	worktreesDir: TrimmedNonEmptyString,
	runsDir: TrimmedNonEmptyString,
	providerHomesDir: TrimmedNonEmptyString,
	internalHost: TrimmedNonEmptyString,
	internalPort: PortNumber,
	status: TenantRuntimeStatus,
	idleShutdownAfterMs: PositiveInt,
	lastStartedAt: effect.Schema.NullOr(IsoDateTime),
	lastStoppedAt: effect.Schema.NullOr(IsoDateTime)
});
const Tenant = effect.Schema.Struct({
	id: TenantId,
	slug: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString,
	kind: TenantKind,
	organizationId: effect.Schema.NullOr(OrganizationId),
	runtimeId: TenantRuntimeId,
	createdAt: IsoDateTime,
	archivedAt: effect.Schema.NullOr(IsoDateTime)
});
const UserProfile = effect.Schema.Struct({
	id: UserId,
	email: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString,
	avatarUrl: effect.Schema.optional(TrimmedNonEmptyString),
	createdAt: IsoDateTime,
	disabledAt: effect.Schema.NullOr(IsoDateTime)
});
const Organization = effect.Schema.Struct({
	id: OrganizationId,
	slug: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString,
	createdAt: IsoDateTime,
	archivedAt: effect.Schema.NullOr(IsoDateTime)
});
const OrganizationRole = effect.Schema.Literals([
	"owner",
	"admin",
	"manager",
	"developer",
	"pm",
	"support",
	"auditor",
	"viewer"
]);
const OrganizationPermission = effect.Schema.Literals([
	"organization.read",
	"organization.update",
	"employee.invite",
	"employee.update",
	"employee.disable",
	"team.manage",
	"department.manage",
	"access.grant",
	"access.revoke",
	"access.review",
	"audit.view"
]);
const OrganizationTeam = effect.Schema.Struct({
	id: OrganizationTeamId,
	organizationId: OrganizationId,
	slug: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString,
	createdAt: IsoDateTime,
	archivedAt: effect.Schema.NullOr(IsoDateTime)
});
const OrganizationDepartment = effect.Schema.Struct({
	id: OrganizationDepartmentId,
	organizationId: OrganizationId,
	slug: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString,
	createdAt: IsoDateTime,
	archivedAt: effect.Schema.NullOr(IsoDateTime)
});
const TenantMembership = effect.Schema.Struct({
	id: MembershipId,
	tenantId: TenantId,
	userId: UserId,
	organizationId: effect.Schema.NullOr(OrganizationId),
	roles: effect.Schema.NonEmptyArray(TenantRole),
	organizationRoles: effect.Schema.optional(effect.Schema.NonEmptyArray(OrganizationRole)),
	teamIds: effect.Schema.optional(effect.Schema.Array(OrganizationTeamId)),
	departmentId: effect.Schema.optional(effect.Schema.NullOr(OrganizationDepartmentId)),
	createdAt: IsoDateTime,
	disabledAt: effect.Schema.NullOr(IsoDateTime)
});
const OrganizationEmployeeStatus = effect.Schema.Literals([
	"invited",
	"active",
	"disabled"
]);
const OrganizationEmployee = effect.Schema.Struct({
	membership: TenantMembership,
	email: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString,
	status: OrganizationEmployeeStatus
});
const OrganizationAccessScope = effect.Schema.Union([
	effect.Schema.Struct({ type: effect.Schema.Literal("global") }),
	effect.Schema.Struct({
		type: effect.Schema.Literal("organization"),
		organizationId: OrganizationId
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("tenant"),
		tenantId: TenantId
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("workspace"),
		workspaceId: WorkspaceId
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("project"),
		projectId: ProjectId
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("team"),
		teamId: OrganizationTeamId
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("department"),
		departmentId: OrganizationDepartmentId
	})
]);
const OrganizationAccessGrant = effect.Schema.Struct({
	id: OrganizationAccessGrantId,
	organizationId: OrganizationId,
	membershipId: MembershipId,
	scope: OrganizationAccessScope,
	roles: effect.Schema.NonEmptyArray(TenantRole),
	grantedByUserId: UserId,
	createdAt: IsoDateTime,
	revokedAt: effect.Schema.NullOr(IsoDateTime)
});
const OrganizationAuditEventKind = effect.Schema.Literals([
	"organization-created",
	"employee-invited",
	"employee-updated",
	"employee-disabled",
	"team-created",
	"department-created",
	"access-granted",
	"access-revoked",
	"access-review-created",
	"access-review-completed",
	"provider-account-created",
	"provider-account-connect-confirmed",
	"provider-account-connect-failed",
	"provider-account-status-checked",
	"provider-account-disconnected",
	"provider-account-launch-used"
]);
const OrganizationAuditEvent = effect.Schema.Struct({
	id: OrganizationAuditEventId,
	organizationId: OrganizationId,
	actorUserId: UserId,
	kind: OrganizationAuditEventKind,
	summary: TrimmedNonEmptyString,
	createdAt: IsoDateTime
});
const OrganizationAccessReviewStatus = effect.Schema.Literals(["open", "completed"]);
const OrganizationAccessReview = effect.Schema.Struct({
	id: OrganizationAccessReviewId,
	organizationId: OrganizationId,
	requestedByUserId: UserId,
	status: OrganizationAccessReviewStatus,
	membershipIds: effect.Schema.Array(MembershipId),
	createdAt: IsoDateTime,
	completedAt: effect.Schema.NullOr(IsoDateTime)
});
const WorkspaceAccessMode = effect.Schema.Literals([
	"private",
	"invite-only",
	"organization"
]);
const Workspace = effect.Schema.Struct({
	id: WorkspaceId,
	tenantId: TenantId,
	organizationId: effect.Schema.NullOr(OrganizationId),
	ownerUserId: UserId,
	kind: WorkspaceKind,
	accessMode: WorkspaceAccessMode,
	title: TrimmedNonEmptyString,
	createdAt: IsoDateTime,
	archivedAt: effect.Schema.NullOr(IsoDateTime)
});
const WorkspaceCreateInput = effect.Schema.Struct({
	tenantId: TenantId,
	title: TrimmedNonEmptyString,
	kind: effect.Schema.optionalKey(WorkspaceKind),
	accessMode: effect.Schema.optionalKey(WorkspaceAccessMode)
});
const WorkspaceCreateResult = effect.Schema.Struct({ workspace: Workspace });
const TenantInviteScope = effect.Schema.Literals([
	"tenant",
	"workspace",
	"project"
]);
const TenantInvite = effect.Schema.Struct({
	id: InviteId,
	tenantId: TenantId,
	workspaceId: effect.Schema.NullOr(WorkspaceId),
	invitedByUserId: UserId,
	email: TrimmedNonEmptyString,
	scope: TenantInviteScope,
	roles: effect.Schema.NonEmptyArray(TenantRole),
	createdAt: IsoDateTime,
	expiresAt: IsoDateTime,
	acceptedAt: effect.Schema.NullOr(IsoDateTime),
	acceptedByUserId: effect.Schema.NullOr(UserId),
	revokedAt: effect.Schema.NullOr(IsoDateTime)
});
const ProviderAccountOwner = effect.Schema.Union([
	effect.Schema.Struct({
		type: effect.Schema.Literal("user"),
		userId: UserId
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("tenant"),
		tenantId: TenantId
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("organization"),
		organizationId: OrganizationId
	})
]);
const ProviderAccountSharing = effect.Schema.Literals(["private", "tenant-shared"]);
const ProviderAccountConnectScope = effect.Schema.Literals(["personal", "organization"]);
const ProviderAccount = effect.Schema.Struct({
	id: ProviderAccountId,
	provider: ProviderKind,
	tenantId: TenantId,
	owner: ProviderAccountOwner,
	sharing: ProviderAccountSharing,
	authHomeDir: TrimmedNonEmptyString,
	configDir: TrimmedNonEmptyString,
	secretsDir: TrimmedNonEmptyString,
	createdAt: IsoDateTime,
	disabledAt: effect.Schema.NullOr(IsoDateTime)
});
const ProviderAccountConnectionStatus = effect.Schema.Literals(["connected", "disabled"]);
const ProviderAccountSummary = effect.Schema.Struct({
	id: ProviderAccountId,
	provider: ProviderKind,
	tenantId: TenantId,
	owner: ProviderAccountOwner,
	sharing: ProviderAccountSharing,
	status: ProviderAccountConnectionStatus,
	createdAt: IsoDateTime,
	disabledAt: effect.Schema.NullOr(IsoDateTime),
	activeSessionCount: NonNegativeInt
});
const ProviderSessionIsolation = effect.Schema.Struct({
	id: ProviderSessionId,
	tenantId: TenantId,
	userId: UserId,
	providerAccountId: ProviderAccountId,
	provider: ProviderKind,
	providerHomeDir: TrimmedNonEmptyString,
	cwd: TrimmedNonEmptyString,
	createdAt: IsoDateTime,
	endedAt: effect.Schema.NullOr(IsoDateTime)
});
var ProviderAccountError = class extends effect.Schema.TaggedErrorClass()("ProviderAccountError", {
	message: TrimmedNonEmptyString,
	code: effect.Schema.Literals([
		"unauthenticated",
		"forbidden",
		"not-found",
		"not-authenticated",
		"rate-limited"
	]),
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
const ProviderAccountListInput = effect.Schema.Struct({});
const ProviderAccountListResult = effect.Schema.Struct({ accounts: effect.Schema.Array(ProviderAccountSummary) });
const ProviderAccountConnectInput = effect.Schema.Struct({
	provider: ProviderKind,
	accountScope: effect.Schema.optionalKey(ProviderAccountConnectScope)
});
const ProviderAccountConnectInstructions = effect.Schema.Struct({
	provider: ProviderKind,
	authCommand: TrimmedNonEmptyString,
	statusCommand: TrimmedNonEmptyString,
	verificationHint: TrimmedNonEmptyString,
	steps: effect.Schema.NonEmptyArray(TrimmedNonEmptyString)
});
const ProviderAccountConnectResult = effect.Schema.Struct({ instructions: ProviderAccountConnectInstructions });
const ProviderAccountOpenAuthTerminalInput = effect.Schema.Struct({
	provider: ProviderKind,
	threadId: ThreadId,
	terminalId: effect.Schema.optional(TrimmedNonEmptyString),
	accountScope: effect.Schema.optionalKey(ProviderAccountConnectScope)
});
const ProviderAccountOpenAuthTerminalResult = effect.Schema.Struct({
	instructions: ProviderAccountConnectInstructions,
	terminal: TerminalSessionSnapshot
});
const ProviderAccountConfirmInput = effect.Schema.Struct({
	provider: ProviderKind,
	threadId: ThreadId,
	statusOutput: effect.Schema.String.check(effect.Schema.isMaxLength(1e4)),
	accountScope: effect.Schema.optionalKey(ProviderAccountConnectScope)
});
const ProviderAccountConfirmResult = effect.Schema.Struct({ account: ProviderAccountSummary });
const ProviderAccountDisconnectInput = effect.Schema.Struct({ providerAccountId: ProviderAccountId });
const ProviderAccountDisconnectResult = effect.Schema.Struct({ account: ProviderAccountSummary });
const TenantSessionContext = effect.Schema.Struct({
	authSessionId: AuthSessionId,
	userId: UserId,
	tenantId: TenantId,
	organizationId: effect.Schema.NullOr(OrganizationId),
	membershipIds: effect.Schema.Array(MembershipId),
	roles: effect.Schema.NonEmptyArray(TenantRole),
	activeWorkspaceId: effect.Schema.NullOr(WorkspaceId),
	issuedAt: IsoDateTime,
	expiresAt: IsoDateTime
});
const TenantAccessDecision = effect.Schema.Struct({
	allowed: effect.Schema.Boolean,
	permission: TenantPermission,
	reason: TrimmedNonEmptyString
});
const AuthTenantSessionMapping = effect.Schema.Struct({
	authSessionId: AuthSessionId,
	userId: UserId,
	tenantId: TenantId,
	organizationId: effect.Schema.NullOr(OrganizationId),
	membershipIds: effect.Schema.Array(MembershipId),
	createdAt: IsoDateTime,
	expiresAt: IsoDateTime
});
const PublicAccessLimits = effect.Schema.Struct({
	maxWebSocketConnectionsPerIp: PositiveInt,
	maxWebSocketConnectionsPerUser: PositiveInt,
	maxWebSocketConnectionsPerTenant: PositiveInt,
	maxRpcRequestsPerMinutePerUser: PositiveInt,
	maxRpcRequestsPerMinutePerTenant: PositiveInt,
	maxRpcRequestBytes: PositiveInt,
	maxFileUploadBytes: PositiveInt,
	maxFileReadBytes: PositiveInt,
	maxDirectoryEntries: PositiveInt,
	maxDiffBytes: PositiveInt,
	maxActiveTurnsPerUser: PositiveInt,
	maxActiveTurnsPerTenant: PositiveInt,
	maxActiveProviderSessionsPerUser: PositiveInt,
	maxActiveProviderSessionsPerTenant: PositiveInt,
	maxProviderConnectFailuresPerUser: PositiveInt,
	providerConnectFailureWindowMs: PositiveInt,
	providerConnectLockoutMs: PositiveInt,
	maxActiveTenantRuntimesPerMachine: PositiveInt,
	maxRuntimeIdleMs: PositiveInt,
	maxRuntimeWallClockMs: PositiveInt
});
const TenantUsageCounters = effect.Schema.Struct({
	webSocketConnectionsForIp: NonNegativeInt,
	webSocketConnectionsForUser: NonNegativeInt,
	webSocketConnectionsForTenant: NonNegativeInt,
	rpcRequestsThisMinuteForUser: NonNegativeInt,
	rpcRequestsThisMinuteForTenant: NonNegativeInt,
	activeTurnsForUser: NonNegativeInt,
	activeTurnsForTenant: NonNegativeInt,
	activeProviderSessionsForUser: NonNegativeInt,
	activeProviderSessionsForTenant: NonNegativeInt,
	providerConnectFailuresForUser: NonNegativeInt,
	activeTenantRuntimesForMachine: NonNegativeInt
});
const TenantLimitCheck = effect.Schema.Struct({
	allowed: effect.Schema.Boolean,
	limit: TrimmedNonEmptyString,
	current: NonNegativeInt,
	maximum: PositiveInt
});
const CollaborationPresenceStatus = effect.Schema.Literals([
	"active",
	"idle",
	"offline"
]);
const CollaborationPresence = effect.Schema.Struct({
	userId: UserId,
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	threadId: effect.Schema.NullOr(ThreadId),
	displayName: TrimmedNonEmptyString,
	avatarInitials: effect.Schema.optional(TrimmedNonEmptyString),
	status: CollaborationPresenceStatus,
	lastSeenAt: IsoDateTime
});
const CollaborationActivityKind = effect.Schema.Literals([
	"joined",
	"left",
	"prompted",
	"edited",
	"invited",
	"accepted-invite",
	"revoked-invite"
]);
const CollaborationActivity = effect.Schema.Struct({
	id: CollaborationActivityId,
	tenantId: TenantId,
	workspaceId: effect.Schema.NullOr(WorkspaceId),
	threadId: effect.Schema.NullOr(ThreadId),
	userId: UserId,
	kind: CollaborationActivityKind,
	summary: TrimmedNonEmptyString,
	hiddenAt: effect.Schema.NullOr(IsoDateTime),
	createdAt: IsoDateTime
});
const CollaborationActivityVisibilityInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	activityId: CollaborationActivityId,
	hidden: effect.Schema.Boolean
});
const CollaborationActivityVisibilityResult = effect.Schema.Struct({ activity: CollaborationActivity });
var CollaborationError = class extends effect.Schema.TaggedErrorClass()("CollaborationError", {
	message: TrimmedNonEmptyString,
	code: effect.Schema.Literals([
		"invalid-invite",
		"invite-expired",
		"invite-revoked",
		"invite-accepted",
		"invalid-membership-rule",
		"approval-not-found",
		"approval-already-decided",
		"not-an-approver",
		"branch-claim-not-found"
	]),
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
const CollaborationPresenceUpsertInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	threadId: effect.Schema.NullOr(ThreadId),
	status: CollaborationPresenceStatus
});
const CollaborationPresenceUpsertResult = effect.Schema.Struct({ presence: CollaborationPresence });
const CollaborationPresenceListInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	threadId: effect.Schema.optional(effect.Schema.NullOr(ThreadId))
});
const CollaborationPresenceListResult = effect.Schema.Struct({ users: effect.Schema.Array(CollaborationPresence) });
const CollaborationInviteCreateInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: effect.Schema.NullOr(WorkspaceId),
	email: TrimmedNonEmptyString,
	scope: TenantInviteScope,
	roles: effect.Schema.NonEmptyArray(TenantRole),
	expiresAt: IsoDateTime
});
const CollaborationInviteCreateResult = effect.Schema.Struct({
	invite: TenantInvite,
	acceptUrlPath: TrimmedNonEmptyString,
	accountSetupUrlPath: effect.Schema.optionalKey(TrimmedNonEmptyString)
});
const CollaborationInviteListInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: effect.Schema.optional(effect.Schema.NullOr(WorkspaceId))
});
const CollaborationInviteListResult = effect.Schema.Struct({ invites: effect.Schema.Array(TenantInvite) });
const CollaborationInviteAcceptInput = effect.Schema.Struct({ inviteId: InviteId });
const CollaborationInviteAcceptResult = effect.Schema.Struct({
	invite: TenantInvite,
	membership: TenantMembership
});
const CollaborationInviteRevokeInput = effect.Schema.Struct({
	tenantId: TenantId,
	inviteId: InviteId
});
const CollaborationInviteRevokeResult = effect.Schema.Struct({ invite: TenantInvite });
const CollaborationSharedPromptRecordInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	threadId: ThreadId,
	prompt: TrimmedNonEmptyString
});
const CollaborationSharedPromptRecordResult = effect.Schema.Struct({ activity: CollaborationActivity });
const CollaborationActivityListInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	threadId: effect.Schema.optional(effect.Schema.NullOr(ThreadId)),
	limit: effect.Schema.optional(PositiveInt)
});
const CollaborationActivityListResult = effect.Schema.Struct({ activities: effect.Schema.Array(CollaborationActivity) });
/**
* How a workspace treats a prompt from someone who is not an approver.
* `open` runs it straight away, `blocking` holds it until an approver says yes,
* and `staged` lets it run on the author's own branch so the shared branch only
* moves once the work is merged.
*/
const CollaborationApprovalMode = effect.Schema.Literals([
	"open",
	"blocking",
	"staged"
]);
const CollaborationWorkspaceSettings = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	leadUserId: effect.Schema.NullOr(UserId),
	approvalMode: CollaborationApprovalMode,
	approverUserIds: effect.Schema.Array(UserId),
	updatedAt: IsoDateTime
});
const CollaborationSettingsGetInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId
});
const CollaborationSettingsUpdateInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	approvalMode: effect.Schema.optional(CollaborationApprovalMode),
	approverUserIds: effect.Schema.optional(effect.Schema.Array(UserId))
});
const CollaborationSettingsResult = effect.Schema.Struct({
	settings: CollaborationWorkspaceSettings,
	canManage: effect.Schema.Boolean
});
const CollaborationApprovalStatus = effect.Schema.Literals([
	"pending",
	"approved",
	"rejected"
]);
const CollaborationPromptApproval = effect.Schema.Struct({
	id: CollaborationApprovalId,
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	threadId: effect.Schema.NullOr(ThreadId),
	requestedByUserId: UserId,
	requestedByName: TrimmedNonEmptyString,
	prompt: TrimmedNonEmptyString,
	mode: CollaborationApprovalMode,
	status: CollaborationApprovalStatus,
	decidedByUserId: effect.Schema.NullOr(UserId),
	decidedAt: effect.Schema.NullOr(IsoDateTime),
	note: effect.Schema.NullOr(TrimmedNonEmptyString),
	consumedAt: effect.Schema.NullOr(IsoDateTime),
	createdAt: IsoDateTime
});
const CollaborationApprovalSubmitInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	threadId: effect.Schema.optional(effect.Schema.NullOr(ThreadId)),
	prompt: TrimmedNonEmptyString
});
const CollaborationApprovalSubmitResult = effect.Schema.Struct({
	approval: effect.Schema.NullOr(CollaborationPromptApproval),
	mayRun: effect.Schema.Boolean
});
const CollaborationApprovalListInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	status: effect.Schema.optional(CollaborationApprovalStatus),
	limit: effect.Schema.optional(PositiveInt)
});
const CollaborationApprovalListResult = effect.Schema.Struct({
	approvals: effect.Schema.Array(CollaborationPromptApproval),
	canDecide: effect.Schema.Boolean
});
const CollaborationApprovalDecideInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	approvalId: CollaborationApprovalId,
	decision: effect.Schema.Literals(["approved", "rejected"]),
	note: effect.Schema.optional(TrimmedNonEmptyString)
});
const CollaborationApprovalDecideResult = effect.Schema.Struct({ approval: CollaborationPromptApproval });
/**
* A personal filter, not a workspace mode: turning collaboration off hides
* other people's prompts and files from your own view and nobody else's.
*/
const CollaborationViewPreferences = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	userId: UserId,
	showOthersPrompts: effect.Schema.Boolean,
	showOthersFiles: effect.Schema.Boolean,
	updatedAt: IsoDateTime
});
const CollaborationViewGetInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId
});
const CollaborationViewUpdateInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	showOthersPrompts: effect.Schema.optional(effect.Schema.Boolean),
	showOthersFiles: effect.Schema.optional(effect.Schema.Boolean)
});
const CollaborationViewResult = effect.Schema.Struct({ preferences: CollaborationViewPreferences });
/** One person's own branch and worktree inside a shared workspace. */
const CollaborationBranchClaim = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	userId: UserId,
	displayName: TrimmedNonEmptyString,
	branch: TrimmedNonEmptyString,
	baseBranch: TrimmedNonEmptyString,
	worktreePath: TrimmedNonEmptyString,
	createdAt: IsoDateTime
});
const CollaborationBranchClaimInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	branch: TrimmedNonEmptyString,
	baseBranch: TrimmedNonEmptyString,
	worktreePath: TrimmedNonEmptyString
});
const CollaborationBranchClaimResult = effect.Schema.Struct({ claim: CollaborationBranchClaim });
const CollaborationBranchListInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId
});
const CollaborationBranchListResult = effect.Schema.Struct({
	claims: effect.Schema.Array(CollaborationBranchClaim),
	mine: effect.Schema.NullOr(CollaborationBranchClaim),
	viewerDisplayName: TrimmedNonEmptyString
});
const CollaborationBranchReleaseInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId
});
const CollaborationBranchReleaseResult = effect.Schema.Struct({ released: effect.Schema.Boolean });
/** Who last touched a file, so the tree can colour it by author. */
const CollaborationFileTouch = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	userId: UserId,
	displayName: TrimmedNonEmptyString,
	path: TrimmedNonEmptyString,
	touchedAt: IsoDateTime
});
const CollaborationFileTouchInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	paths: effect.Schema.Array(TrimmedNonEmptyString)
});
const CollaborationFileTouchResult = effect.Schema.Struct({ touches: effect.Schema.Array(CollaborationFileTouch) });
const CollaborationFileTouchListInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId
});
/**
* A person in a shared workspace, assembled from their membership, the last
* presence they reported and the invite that let them in. Carries everything
* the UI needs to draw them: a name, initials and a colour.
*/
const CollaborationMember = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	userId: UserId,
	displayName: TrimmedNonEmptyString,
	email: effect.Schema.NullOr(TrimmedNonEmptyString),
	avatarInitials: TrimmedNonEmptyString,
	color: TrimmedNonEmptyString,
	colorIsCustom: effect.Schema.Boolean,
	roles: effect.Schema.Array(TenantRole),
	isLead: effect.Schema.Boolean,
	isApprover: effect.Schema.Boolean,
	status: CollaborationPresenceStatus,
	lastSeenAt: effect.Schema.NullOr(IsoDateTime),
	joinedAt: effect.Schema.NullOr(IsoDateTime),
	sharesProfile: effect.Schema.Boolean,
	sharesUsage: effect.Schema.Boolean,
	promptCount: effect.Schema.NullOr(NonNegativeInt),
	pendingApprovalCount: effect.Schema.NullOr(NonNegativeInt),
	tokensUsed: effect.Schema.NullOr(NonNegativeInt)
});
const CollaborationMemberListInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId
});
const CollaborationMemberListResult = effect.Schema.Struct({
	members: effect.Schema.Array(CollaborationMember),
	canManage: effect.Schema.Boolean,
	viewerUserId: UserId
});
const CollaborationMemberUpdateInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	userId: UserId,
	color: effect.Schema.optional(TrimmedNonEmptyString),
	displayName: effect.Schema.optional(TrimmedNonEmptyString),
	isApprover: effect.Schema.optional(effect.Schema.Boolean),
	readOnly: effect.Schema.optional(effect.Schema.Boolean)
});
const CollaborationMemberRemoveInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	userId: UserId
});
const CollaborationMemberResult = effect.Schema.Struct({ member: CollaborationMember });
const CollaborationMemberRemoveResult = effect.Schema.Struct({ removed: effect.Schema.Boolean });
const CollaborationUsageRecordInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	threadId: ThreadId,
	totalTokens: NonNegativeInt,
	inputTokens: effect.Schema.optional(NonNegativeInt),
	cachedInputTokens: effect.Schema.optional(NonNegativeInt),
	outputTokens: effect.Schema.optional(NonNegativeInt),
	reasoningOutputTokens: effect.Schema.optional(NonNegativeInt),
	turnId: effect.Schema.optional(TurnId),
	provider: effect.Schema.optional(ProviderKind),
	model: effect.Schema.optional(TrimmedNonEmptyString)
});
/**
* A window over the usage series. Both bounds are ISO-8601 UTC instants;
* `since` is inclusive and `until` exclusive, so consecutive windows tile
* without double-counting the instant they meet.
*/
const CollaborationUsageQueryInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	since: effect.Schema.optional(IsoDateTime),
	until: effect.Schema.optional(IsoDateTime)
});
/** The token split every row of the usage report carries. */
const CollaborationUsageTotals = effect.Schema.Struct({
	inputTokens: NonNegativeInt,
	cachedInputTokens: NonNegativeInt,
	outputTokens: NonNegativeInt,
	reasoningOutputTokens: NonNegativeInt,
	totalTokens: NonNegativeInt
});
/**
* What the tokens are guessed to have cost, from a rate table the server keeps.
*
* Named an estimate throughout because that is what it is: rates change, this
* table is a snapshot, discounts and plan pricing are invisible here, and a
* model the table has never heard of is not priced at all. `unpricedTokens`
* says how much of the window is missing from the figure, and `unpricedModels`
* names what is missing — a zero-priced model would otherwise read as free.
*
* There is deliberately no "quota remaining" or "resets in N days" field. That
* lives in the provider's own billing API, behind the credentials of whoever
* owns the account; T3 sees token reports, not entitlements, and inventing a
* number for it would be a guess dressed up as a fact.
*/
const CollaborationUsageCostEstimate = effect.Schema.Struct({
	currency: effect.Schema.Literal("USD"),
	estimatedInputCost: effect.Schema.Number,
	estimatedOutputCost: effect.Schema.Number,
	estimatedTotalCost: effect.Schema.Number,
	unpricedTokens: NonNegativeInt,
	unpricedModels: effect.Schema.Array(TrimmedNonEmptyString)
});
/** One member's share of the window. Only members who share usage appear. */
const CollaborationUsageLeaderboardEntry = effect.Schema.Struct({
	userId: UserId,
	displayName: TrimmedNonEmptyString,
	totals: CollaborationUsageTotals,
	estimatedCost: CollaborationUsageCostEstimate,
	isViewer: effect.Schema.Boolean
});
/** One UTC calendar day of the window; days with no usage are still present. */
const CollaborationUsageDayBucket = effect.Schema.Struct({
	day: TrimmedNonEmptyString,
	totals: CollaborationUsageTotals,
	estimatedCost: CollaborationUsageCostEstimate
});
/**
* Usage summed by hour of day across the whole window, for a peak-hours view.
* Always 24 entries, `hour` 0-23, in UTC — the server has no way to know which
* timezone the reader is in, so the UI relabels these.
*/
const CollaborationUsageHourBucket = effect.Schema.Struct({
	hour: NonNegativeInt,
	totals: CollaborationUsageTotals
});
/** The window split by runtime. `provider` is null for unattributable samples. */
const CollaborationUsageProviderBreakdown = effect.Schema.Struct({
	provider: effect.Schema.NullOr(ProviderKind),
	totals: CollaborationUsageTotals,
	estimatedCost: CollaborationUsageCostEstimate
});
/** The window split by model, so an unpriced or expensive model is findable. */
const CollaborationUsageModelBreakdown = effect.Schema.Struct({
	provider: effect.Schema.NullOr(ProviderKind),
	model: effect.Schema.NullOr(TrimmedNonEmptyString),
	totals: CollaborationUsageTotals,
	estimatedCost: CollaborationUsageCostEstimate,
	isPriced: effect.Schema.Boolean
});
const CollaborationUsageQueryResult = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	since: IsoDateTime,
	until: IsoDateTime,
	totals: CollaborationUsageTotals,
	estimatedCost: CollaborationUsageCostEstimate,
	leaderboard: effect.Schema.Array(CollaborationUsageLeaderboardEntry),
	byDay: effect.Schema.Array(CollaborationUsageDayBucket),
	byHourOfDay: effect.Schema.Array(CollaborationUsageHourBucket),
	byProvider: effect.Schema.Array(CollaborationUsageProviderBreakdown),
	byModel: effect.Schema.Array(CollaborationUsageModelBreakdown),
	hiddenMemberCount: NonNegativeInt,
	viewerUserId: UserId
});
/**
* What a workspace is allowed to see about someone, agreed to when they join.
* Joining a shared workspace hands over more than access, so it is asked for
* once, up front, rather than assumed.
*/
const CollaborationConsent = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	userId: UserId,
	shareProfile: effect.Schema.Boolean,
	shareUsage: effect.Schema.Boolean,
	decidedAt: IsoDateTime
});
/**
* What currently applies to this person, whether or not they ever chose it.
*
* `consent` on the result below stays null until someone actually decides, so
* "never asked" is still tellable from "asked and said yes". A settings toggle
* needs both: this says where to draw the switch, `isDecided` says whether to
* describe it as their choice or as the workspace default.
*/
const CollaborationConsentEffective = effect.Schema.Struct({
	shareProfile: effect.Schema.Boolean,
	shareUsage: effect.Schema.Boolean,
	isDecided: effect.Schema.Boolean
});
const CollaborationConsentGetInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId
});
const CollaborationConsentUpdateInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	shareProfile: effect.Schema.Boolean,
	shareUsage: effect.Schema.Boolean
});
const CollaborationConsentResult = effect.Schema.Struct({
	consent: effect.Schema.NullOr(CollaborationConsent),
	effective: CollaborationConsentEffective
});
const CollaborationStreamInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	threadId: effect.Schema.optional(effect.Schema.NullOr(ThreadId))
});
const CollaborationStreamEvent = effect.Schema.Union([
	effect.Schema.Struct({
		type: effect.Schema.Literal("presence-upserted"),
		presence: CollaborationPresence
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("invite-created"),
		invite: TenantInvite
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("invite-accepted"),
		invite: TenantInvite,
		membership: TenantMembership
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("invite-revoked"),
		invite: TenantInvite
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("activity-appended"),
		activity: CollaborationActivity
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("settings-updated"),
		settings: CollaborationWorkspaceSettings
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("approval-requested"),
		approval: CollaborationPromptApproval
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("approval-decided"),
		approval: CollaborationPromptApproval
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("branch-claimed"),
		claim: CollaborationBranchClaim
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("branch-released"),
		tenantId: TenantId,
		workspaceId: WorkspaceId,
		userId: UserId
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("files-touched"),
		touches: effect.Schema.Array(CollaborationFileTouch)
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("activity-visibility-changed"),
		activity: CollaborationActivity
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("member-updated"),
		member: CollaborationMember
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("member-removed"),
		tenantId: TenantId,
		workspaceId: WorkspaceId,
		userId: UserId
	})
]);
var OrganizationError = class extends effect.Schema.TaggedErrorClass()("OrganizationError", {
	message: TrimmedNonEmptyString,
	code: effect.Schema.Literals([
		"organization-not-found",
		"membership-not-found",
		"team-not-found",
		"department-not-found",
		"invalid-invite",
		"invite-expired",
		"invite-revoked",
		"invite-accepted",
		"invalid-role",
		"invalid-scope",
		"employee-disabled",
		"access-grant-not-found",
		"access-grant-already-revoked",
		"access-review-not-found",
		"access-review-already-completed"
	]),
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
const OrganizationCreateInput = effect.Schema.Struct({
	slug: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString
});
const OrganizationCreateResult = effect.Schema.Struct({
	organization: Organization,
	tenant: Tenant,
	ownerMembership: TenantMembership
});
const OrganizationListResult = effect.Schema.Struct({
	organizations: effect.Schema.Array(Organization),
	tenants: effect.Schema.Array(Tenant),
	workspaces: effect.Schema.optionalKey(effect.Schema.Array(Workspace)),
	employees: effect.Schema.Array(OrganizationEmployee),
	invites: effect.Schema.Array(TenantInvite),
	memberships: effect.Schema.Array(TenantMembership),
	teams: effect.Schema.Array(OrganizationTeam),
	departments: effect.Schema.Array(OrganizationDepartment),
	grants: effect.Schema.Array(OrganizationAccessGrant),
	reviews: effect.Schema.Array(OrganizationAccessReview)
});
const OrganizationEmployeeInviteInput = effect.Schema.Struct({
	organizationId: OrganizationId,
	tenantId: TenantId,
	email: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString,
	roles: effect.Schema.NonEmptyArray(TenantRole),
	organizationRoles: effect.Schema.NonEmptyArray(OrganizationRole),
	teamIds: effect.Schema.optional(effect.Schema.Array(OrganizationTeamId)),
	departmentId: effect.Schema.optional(effect.Schema.NullOr(OrganizationDepartmentId)),
	expiresAt: IsoDateTime
});
const OrganizationEmployeeInviteResult = effect.Schema.Struct({
	invite: TenantInvite,
	employee: OrganizationEmployee,
	accountSetupUrlPath: effect.Schema.optionalKey(TrimmedNonEmptyString)
});
const OrganizationEmployeeInviteAcceptInput = effect.Schema.Struct({ inviteId: InviteId });
const OrganizationEmployeeInviteAcceptResult = effect.Schema.Struct({
	invite: TenantInvite,
	employee: OrganizationEmployee,
	membership: TenantMembership
});
const OrganizationEmployeeListInput = effect.Schema.Struct({ organizationId: OrganizationId });
const OrganizationEmployeeListResult = effect.Schema.Struct({ employees: effect.Schema.Array(OrganizationEmployee) });
const OrganizationEmployeeUpdateInput = effect.Schema.Struct({
	organizationId: OrganizationId,
	membershipId: MembershipId,
	roles: effect.Schema.optional(effect.Schema.NonEmptyArray(TenantRole)),
	organizationRoles: effect.Schema.optional(effect.Schema.NonEmptyArray(OrganizationRole)),
	teamIds: effect.Schema.optional(effect.Schema.Array(OrganizationTeamId)),
	departmentId: effect.Schema.optional(effect.Schema.NullOr(OrganizationDepartmentId))
});
const OrganizationEmployeeUpdateResult = effect.Schema.Struct({ employee: OrganizationEmployee });
const OrganizationEmployeeDisableInput = effect.Schema.Struct({
	organizationId: OrganizationId,
	membershipId: MembershipId
});
const OrganizationTeamCreateInput = effect.Schema.Struct({
	organizationId: OrganizationId,
	slug: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString
});
const OrganizationTeamCreateResult = effect.Schema.Struct({ team: OrganizationTeam });
const OrganizationDepartmentCreateInput = effect.Schema.Struct({
	organizationId: OrganizationId,
	slug: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString
});
const OrganizationDepartmentCreateResult = effect.Schema.Struct({ department: OrganizationDepartment });
const OrganizationAccessGrantInput = effect.Schema.Struct({
	organizationId: OrganizationId,
	membershipId: MembershipId,
	scope: OrganizationAccessScope,
	roles: effect.Schema.NonEmptyArray(TenantRole)
});
const OrganizationAccessGrantResult = effect.Schema.Struct({ grant: OrganizationAccessGrant });
const OrganizationAccessRevokeInput = effect.Schema.Struct({
	organizationId: OrganizationId,
	grantId: OrganizationAccessGrantId
});
const OrganizationAccessRevokeResult = effect.Schema.Struct({ grant: OrganizationAccessGrant });
const OrganizationAccessReviewCreateInput = effect.Schema.Struct({
	organizationId: OrganizationId,
	membershipIds: effect.Schema.Array(MembershipId)
});
const OrganizationAccessReviewCreateResult = effect.Schema.Struct({ review: OrganizationAccessReview });
const OrganizationAccessReviewCompleteInput = effect.Schema.Struct({
	organizationId: OrganizationId,
	reviewId: OrganizationAccessReviewId
});
const OrganizationAccessReviewCompleteResult = effect.Schema.Struct({ review: OrganizationAccessReview });
const OrganizationAuditListInput = effect.Schema.Struct({
	organizationId: OrganizationId,
	limit: effect.Schema.optional(PositiveInt)
});
const OrganizationAuditListResult = effect.Schema.Struct({ events: effect.Schema.Array(OrganizationAuditEvent) });

//#endregion
//#region ../../packages/contracts/src/auth.ts
/**
* Declares the server's overall authentication posture.
*
* This is a high-level policy label that tells clients how the environment is
* expected to be accessed, not a transport detail and not an exhaustive list
* of every accepted credential.
*
* Typical usage:
* - rendered in auth/pairing UI so the user understands what kind of
*   environment they are connecting to
* - used by clients to decide whether silent desktop bootstrap is expected or
*   whether an explicit pairing flow should be shown
*
* Meanings:
* - `desktop-managed-local`: local desktop-managed environment with narrow
*   trusted bootstrap, intended to avoid login prompts on the same machine
* - `loopback-browser`: standalone local server intended for browser pairing on
*   the same machine
* - `remote-reachable`: environment intended to be reached from other devices
*   or networks, where explicit pairing/auth is expected
* - `unsafe-no-auth`: intentionally unauthenticated mode; this is an explicit
*   unsafe escape hatch, not a normal deployment mode
*/
const ServerAuthPolicy = effect.Schema.Literals([
	"desktop-managed-local",
	"loopback-browser",
	"remote-reachable",
	"unsafe-no-auth"
]);
/**
* A credential type that can be exchanged for a real authenticated session.
*
* Bootstrap methods are for establishing trust at the start of a connection or
* pairing flow. They are not the long-lived credential used for ordinary
* authenticated HTTP / WebSocket traffic after pairing succeeds.
*
* Current methods:
* - `desktop-bootstrap`: a trusted local desktop handoff, used so the desktop
*   shell can pair the renderer without a login screen
* - `one-time-token`: a short-lived pairing token, suitable for manual pairing
*   flows such as `/pair?token=...`
*/
const ServerAuthBootstrapMethod = effect.Schema.Literals(["desktop-bootstrap", "one-time-token"]);
/**
* A credential type accepted for steady-state authenticated requests after a
* client has already paired.
*
* These methods are used by the server-wide auth layer for privileged HTTP and
* WebSocket access. They are distinct from bootstrap methods so clients can
* reason clearly about "pair first, then use session auth".
*
* Current methods:
* - `browser-session-cookie`: cookie-backed browser session, used by the web
*   app after bootstrap/pairing
* - `bearer-session-token`: token-based session suitable for non-cookie or
*   non-browser clients
*/
const ServerAuthSessionMethod = effect.Schema.Literals(["browser-session-cookie", "bearer-session-token"]);
const AuthSessionRole = effect.Schema.Literals(["owner", "client"]);
const SupabasePublicAuthConfig = effect.Schema.Struct({
	projectUrl: TrimmedNonEmptyString,
	anonKey: TrimmedNonEmptyString,
	audience: effect.Schema.optionalKey(TrimmedNonEmptyString)
});
const LocalPasswordAuthConfig = effect.Schema.Struct({ enabled: effect.Schema.Literal(true) });
/**
* Server-advertised auth capabilities for a specific execution environment.
*
* Clients should treat this as the authoritative description of how that
* environment expects to be paired and how authenticated requests should be
* made afterward.
*
* Field meanings:
* - `policy`: high-level auth posture for the environment
* - `bootstrapMethods`: pairing/bootstrap methods the server is currently
*   willing to accept
* - `sessionMethods`: authenticated request/session methods the server supports
*   once pairing is complete
* - `sessionCookieName`: cookie name clients should expect when
*   `browser-session-cookie` is in use
*
* This descriptor is intentionally capability-oriented. It lets clients choose
* the right UX without embedding server-specific auth logic or assuming a
* single access method.
*/
const ServerAuthDescriptor = effect.Schema.Struct({
	policy: ServerAuthPolicy,
	bootstrapMethods: effect.Schema.Array(ServerAuthBootstrapMethod),
	sessionMethods: effect.Schema.Array(ServerAuthSessionMethod),
	sessionCookieName: TrimmedNonEmptyString,
	supabase: effect.Schema.optionalKey(SupabasePublicAuthConfig),
	localPassword: effect.Schema.optionalKey(LocalPasswordAuthConfig)
});
const AuthBootstrapInput = effect.Schema.Struct({ credential: TrimmedNonEmptyString });
const AuthBootstrapResult = effect.Schema.Struct({
	authenticated: effect.Schema.Literal(true),
	role: AuthSessionRole,
	sessionMethod: ServerAuthSessionMethod,
	expiresAt: effect.Schema.DateTimeUtc
});
const AuthPasswordMode = effect.Schema.Literals(["login", "signup"]);
const AuthPasswordInput = effect.Schema.Struct({
	email: TrimmedNonEmptyString,
	password: TrimmedNonEmptyString,
	mode: AuthPasswordMode,
	displayName: effect.Schema.optionalKey(TrimmedNonEmptyString)
});
const AuthBearerBootstrapResult = effect.Schema.Struct({
	authenticated: effect.Schema.Literal(true),
	role: AuthSessionRole,
	sessionMethod: effect.Schema.Literal("bearer-session-token"),
	expiresAt: effect.Schema.DateTimeUtc,
	sessionToken: TrimmedNonEmptyString
});
const AuthWebSocketTokenResult = effect.Schema.Struct({
	token: TrimmedNonEmptyString,
	expiresAt: effect.Schema.DateTimeUtc
});
const AuthPairingCredentialResult = effect.Schema.Struct({
	id: TrimmedNonEmptyString,
	credential: TrimmedNonEmptyString,
	label: effect.Schema.optionalKey(TrimmedNonEmptyString),
	expiresAt: effect.Schema.DateTimeUtc
});
const AuthPairingLink = effect.Schema.Struct({
	id: TrimmedNonEmptyString,
	credential: TrimmedNonEmptyString,
	role: AuthSessionRole,
	subject: TrimmedNonEmptyString,
	label: effect.Schema.optionalKey(TrimmedNonEmptyString),
	createdAt: effect.Schema.DateTimeUtc,
	expiresAt: effect.Schema.DateTimeUtc
});
const AuthClientMetadataDeviceType = effect.Schema.Literals([
	"desktop",
	"mobile",
	"tablet",
	"bot",
	"unknown"
]);
const AuthClientMetadata = effect.Schema.Struct({
	label: effect.Schema.optionalKey(TrimmedNonEmptyString),
	ipAddress: effect.Schema.optionalKey(TrimmedNonEmptyString),
	userAgent: effect.Schema.optionalKey(TrimmedNonEmptyString),
	deviceType: AuthClientMetadataDeviceType,
	os: effect.Schema.optionalKey(TrimmedNonEmptyString),
	browser: effect.Schema.optionalKey(TrimmedNonEmptyString)
});
const AuthClientSession = effect.Schema.Struct({
	sessionId: AuthSessionId,
	subject: TrimmedNonEmptyString,
	role: AuthSessionRole,
	method: ServerAuthSessionMethod,
	client: AuthClientMetadata,
	issuedAt: effect.Schema.DateTimeUtc,
	expiresAt: effect.Schema.DateTimeUtc,
	lastConnectedAt: effect.Schema.NullOr(effect.Schema.DateTimeUtc),
	connected: effect.Schema.Boolean,
	current: effect.Schema.Boolean
});
const AuthAccessSnapshot = effect.Schema.Struct({
	pairingLinks: effect.Schema.Array(AuthPairingLink),
	clientSessions: effect.Schema.Array(AuthClientSession)
});
const AuthAccessStreamSnapshotEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	revision: effect.Schema.Number,
	type: effect.Schema.Literal("snapshot"),
	payload: AuthAccessSnapshot
});
const AuthAccessStreamPairingLinkUpsertedEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	revision: effect.Schema.Number,
	type: effect.Schema.Literal("pairingLinkUpserted"),
	payload: AuthPairingLink
});
const AuthAccessStreamPairingLinkRemovedEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	revision: effect.Schema.Number,
	type: effect.Schema.Literal("pairingLinkRemoved"),
	payload: effect.Schema.Struct({ id: TrimmedNonEmptyString })
});
const AuthAccessStreamClientUpsertedEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	revision: effect.Schema.Number,
	type: effect.Schema.Literal("clientUpserted"),
	payload: AuthClientSession
});
const AuthAccessStreamClientRemovedEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	revision: effect.Schema.Number,
	type: effect.Schema.Literal("clientRemoved"),
	payload: effect.Schema.Struct({ sessionId: AuthSessionId })
});
const AuthAccessStreamEvent = effect.Schema.Union([
	AuthAccessStreamSnapshotEvent,
	AuthAccessStreamPairingLinkUpsertedEvent,
	AuthAccessStreamPairingLinkRemovedEvent,
	AuthAccessStreamClientUpsertedEvent,
	AuthAccessStreamClientRemovedEvent
]);
const AuthRevokePairingLinkInput = effect.Schema.Struct({ id: TrimmedNonEmptyString });
const AuthRevokeClientSessionInput = effect.Schema.Struct({ sessionId: AuthSessionId });
const AuthCreatePairingCredentialInput = effect.Schema.Struct({ label: effect.Schema.optionalKey(TrimmedNonEmptyString) });
const AuthSessionState = effect.Schema.Struct({
	authenticated: effect.Schema.Boolean,
	auth: ServerAuthDescriptor,
	role: effect.Schema.optionalKey(AuthSessionRole),
	sessionMethod: effect.Schema.optionalKey(ServerAuthSessionMethod),
	expiresAt: effect.Schema.optionalKey(effect.Schema.DateTimeUtc),
	tenantStatus: effect.Schema.optionalKey(effect.Schema.Literals([
		"none",
		"pending-membership",
		"active"
	])),
	tenantSession: effect.Schema.optionalKey(TenantSessionContext)
});
const AUTH_AVATAR_MAX_DECODED_BYTES = 256 * 1024;
const AuthUserProfile = effect.Schema.Struct({
	userId: UserId,
	subject: TrimmedNonEmptyString,
	displayName: TrimmedNonEmptyString,
	avatarInitials: TrimmedNonEmptyString,
	avatarDataUrl: effect.Schema.optional(TrimmedNonEmptyString),
	role: AuthSessionRole,
	sessionId: AuthSessionId,
	sessionMethod: ServerAuthSessionMethod,
	client: AuthClientMetadata,
	expiresAt: effect.Schema.optionalKey(effect.Schema.DateTimeUtc),
	tenantStatus: effect.Schema.Literals([
		"none",
		"pending-membership",
		"active"
	]),
	tenantSession: effect.Schema.optionalKey(TenantSessionContext)
});
/**
* The update is a full replacement of the stored profile, so omitting
* `avatarDataUrl` is how a user drops their uploaded image back to initials.
*/
const AuthUpdateUserProfileInput = effect.Schema.Struct({
	displayName: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(120)),
	avatarInitials: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(4)),
	avatarDataUrl: effect.Schema.optional(effect.Schema.String)
});
const AuthOnboardingStep = effect.Schema.Literals([
	"paired",
	"accept-invite",
	"connect-provider",
	"create-workspace"
]);
const AuthOnboardingState = effect.Schema.Struct({
	authenticated: effect.Schema.Literal(true),
	profile: AuthUserProfile,
	nextStep: AuthOnboardingStep
});

//#endregion
//#region ../../packages/contracts/src/editor.ts
const EditorLaunchStyle = effect.Schema.Literals([
	"direct-path",
	"goto",
	"line-column"
]);
const EDITORS = [
	{
		id: "cursor",
		label: "Cursor",
		commands: ["cursor"],
		launchStyle: "goto"
	},
	{
		id: "trae",
		label: "Trae",
		commands: ["trae"],
		launchStyle: "goto"
	},
	{
		id: "kiro",
		label: "Kiro",
		commands: ["kiro"],
		baseArgs: ["ide"],
		launchStyle: "goto"
	},
	{
		id: "vscode",
		label: "VS Code",
		commands: ["code"],
		launchStyle: "goto"
	},
	{
		id: "vscode-insiders",
		label: "VS Code Insiders",
		commands: ["code-insiders"],
		launchStyle: "goto"
	},
	{
		id: "vscodium",
		label: "VSCodium",
		commands: ["codium"],
		launchStyle: "goto"
	},
	{
		id: "zed",
		label: "Zed",
		commands: ["zed", "zeditor"],
		launchStyle: "direct-path"
	},
	{
		id: "antigravity",
		label: "Antigravity",
		commands: ["agy"],
		launchStyle: "goto"
	},
	{
		id: "idea",
		label: "IntelliJ IDEA",
		commands: ["idea"],
		launchStyle: "line-column"
	},
	{
		id: "file-manager",
		label: "File Manager",
		commands: null,
		launchStyle: "direct-path"
	}
];
const EditorId = effect.Schema.Literals(EDITORS.map((e) => e.id));
const OpenInEditorInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyString,
	editor: EditorId
});
var OpenError = class extends effect.Schema.TaggedErrorClass()("OpenError", {
	message: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};

//#endregion
//#region ../../packages/contracts/src/settings.ts
const TimestampFormat = effect_Schema.Literals([
	"locale",
	"12-hour",
	"24-hour"
]);
const DEFAULT_TIMESTAMP_FORMAT = "locale";
const DesktopLayoutMode = TrimmedNonEmptyString;
const DEFAULT_DESKTOP_LAYOUT_MODE = "vibe";
const SidebarProjectSortOrder = effect_Schema.Literals([
	"updated_at",
	"created_at",
	"manual"
]);
const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER = "updated_at";
const SidebarThreadSortOrder = effect_Schema.Literals(["updated_at", "created_at"]);
const DEFAULT_SIDEBAR_THREAD_SORT_ORDER = "updated_at";
const SidebarProjectGroupingMode = effect_Schema.Literals([
	"repository",
	"repository_path",
	"separate"
]);
const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE = "repository";
const ClientSettingsSchema = effect_Schema.Struct({
	confirmThreadArchive: effect_Schema.Boolean.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(false))),
	confirmThreadDelete: effect_Schema.Boolean.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(true))),
	desktopLayoutMode: DesktopLayoutMode.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_DESKTOP_LAYOUT_MODE))),
	desktopLayoutModesJson: effect_Schema.String.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(""))),
	desktopLayoutAutoOpenToast: effect_Schema.Boolean.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(true))),
	diffWordWrap: effect_Schema.Boolean.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(false))),
	sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE))),
	sidebarProjectGroupingOverrides: effect_Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode).pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed({}))),
	sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER))),
	sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER))),
	timestampFormat: TimestampFormat.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)))
});
const DEFAULT_CLIENT_SETTINGS = effect_Schema.decodeSync(ClientSettingsSchema)({});
const ThreadEnvMode = effect_Schema.Literals(["local", "worktree"]);
const makeBinaryPathSetting = (fallback) => TrimmedString.pipe(effect_Schema.decodeTo(effect_Schema.String, effect_SchemaTransformation.transformOrFail({
	decode: (value) => effect.Effect.succeed(value || fallback),
	encode: (value) => effect.Effect.succeed(value)
})), effect_Schema.withDecodingDefault(effect.Effect.succeed(fallback)));
const CodexSettings = effect_Schema.Struct({
	enabled: effect_Schema.Boolean.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(true))),
	binaryPath: makeBinaryPathSetting("codex"),
	homePath: TrimmedString.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(""))),
	customModels: effect_Schema.Array(effect_Schema.String).pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed([])))
});
const ClaudeSettings = effect_Schema.Struct({
	enabled: effect_Schema.Boolean.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(true))),
	binaryPath: makeBinaryPathSetting("claude"),
	customModels: effect_Schema.Array(effect_Schema.String).pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed([]))),
	launchArgs: effect_Schema.String.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed("")))
});
const ObservabilitySettings = effect_Schema.Struct({
	otlpTracesUrl: TrimmedString.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(""))),
	otlpMetricsUrl: TrimmedString.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed("")))
});
const ServerSettings = effect_Schema.Struct({
	enableAssistantStreaming: effect_Schema.Boolean.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(false))),
	defaultThreadEnvMode: ThreadEnvMode.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed("local"))),
	addProjectBaseDirectory: TrimmedString.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed(""))),
	textGenerationModelSelection: ModelSelection.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed({
		provider: "codex",
		model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex
	}))),
	providers: effect_Schema.Struct({
		codex: CodexSettings.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed({}))),
		claudeAgent: ClaudeSettings.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed({})))
	}).pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed({}))),
	observability: ObservabilitySettings.pipe(effect_Schema.withDecodingDefault(effect.Effect.succeed({})))
});
const DEFAULT_SERVER_SETTINGS = effect_Schema.decodeSync(ServerSettings)({});
var ServerSettingsError = class extends effect_Schema.TaggedErrorClass()("ServerSettingsError", {
	settingsPath: effect_Schema.String,
	detail: effect_Schema.String,
	cause: effect_Schema.optional(effect_Schema.Defect)
}) {
	get message() {
		return `Server settings error at ${this.settingsPath}: ${this.detail}`;
	}
};
const DEFAULT_UNIFIED_SETTINGS = {
	...DEFAULT_SERVER_SETTINGS,
	...DEFAULT_CLIENT_SETTINGS
};
const CodexModelOptionsPatch = effect_Schema.Struct({
	reasoningEffort: effect_Schema.optionalKey(CodexModelOptions.fields.reasoningEffort),
	fastMode: effect_Schema.optionalKey(CodexModelOptions.fields.fastMode)
});
const ClaudeModelOptionsPatch = effect_Schema.Struct({
	thinking: effect_Schema.optionalKey(ClaudeModelOptions.fields.thinking),
	effort: effect_Schema.optionalKey(ClaudeModelOptions.fields.effort),
	fastMode: effect_Schema.optionalKey(ClaudeModelOptions.fields.fastMode),
	contextWindow: effect_Schema.optionalKey(ClaudeModelOptions.fields.contextWindow)
});
const ModelSelectionPatch = effect_Schema.Union([effect_Schema.Struct({
	provider: effect_Schema.optionalKey(effect_Schema.Literal("codex")),
	model: effect_Schema.optionalKey(TrimmedNonEmptyString),
	options: effect_Schema.optionalKey(CodexModelOptionsPatch)
}), effect_Schema.Struct({
	provider: effect_Schema.optionalKey(effect_Schema.Literal("claudeAgent")),
	model: effect_Schema.optionalKey(TrimmedNonEmptyString),
	options: effect_Schema.optionalKey(ClaudeModelOptionsPatch)
})]);
const CodexSettingsPatch = effect_Schema.Struct({
	enabled: effect_Schema.optionalKey(effect_Schema.Boolean),
	binaryPath: effect_Schema.optionalKey(effect_Schema.String),
	homePath: effect_Schema.optionalKey(effect_Schema.String),
	customModels: effect_Schema.optionalKey(effect_Schema.Array(effect_Schema.String))
});
const ClaudeSettingsPatch = effect_Schema.Struct({
	enabled: effect_Schema.optionalKey(effect_Schema.Boolean),
	binaryPath: effect_Schema.optionalKey(effect_Schema.String),
	customModels: effect_Schema.optionalKey(effect_Schema.Array(effect_Schema.String)),
	launchArgs: effect_Schema.optionalKey(effect_Schema.String)
});
const ServerSettingsPatch = effect_Schema.Struct({
	enableAssistantStreaming: effect_Schema.optionalKey(effect_Schema.Boolean),
	defaultThreadEnvMode: effect_Schema.optionalKey(ThreadEnvMode),
	addProjectBaseDirectory: effect_Schema.optionalKey(effect_Schema.String),
	textGenerationModelSelection: effect_Schema.optionalKey(ModelSelectionPatch),
	observability: effect_Schema.optionalKey(effect_Schema.Struct({
		otlpTracesUrl: effect_Schema.optionalKey(effect_Schema.String),
		otlpMetricsUrl: effect_Schema.optionalKey(effect_Schema.String)
	})),
	providers: effect_Schema.optionalKey(effect_Schema.Struct({
		codex: effect_Schema.optionalKey(CodexSettingsPatch),
		claudeAgent: effect_Schema.optionalKey(ClaudeSettingsPatch)
	}))
});

//#endregion
//#region ../../packages/contracts/src/provider.ts
const ProviderSessionStatus = effect.Schema.Literals([
	"connecting",
	"ready",
	"running",
	"error",
	"closed"
]);
const ProviderLaunchEnvKey = effect.Schema.String.check(effect.Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).check(effect.Schema.isMaxLength(128));
const ProviderLaunchEnvValue = effect.Schema.String.check(effect.Schema.isMaxLength(8192));
const ProviderLaunchEnv = effect.Schema.Record(ProviderLaunchEnvKey, ProviderLaunchEnvValue).check(effect.Schema.isMaxProperties(128));
const ProviderLaunchEnvironment = effect.Schema.Struct({ env: ProviderLaunchEnv });
const ProviderSession = effect.Schema.Struct({
	provider: ProviderKind,
	status: ProviderSessionStatus,
	runtimeMode: RuntimeMode,
	cwd: effect.Schema.optional(TrimmedNonEmptyString),
	model: effect.Schema.optional(TrimmedNonEmptyString),
	threadId: ThreadId,
	resumeCursor: effect.Schema.optional(effect.Schema.Unknown),
	activeTurnId: effect.Schema.optional(TurnId),
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime,
	lastError: effect.Schema.optional(TrimmedNonEmptyString)
});
const ProviderSessionStartInput = effect.Schema.Struct({
	threadId: ThreadId,
	provider: effect.Schema.optional(ProviderKind),
	cwd: effect.Schema.optional(TrimmedNonEmptyString),
	modelSelection: effect.Schema.optional(ModelSelection),
	resumeCursor: effect.Schema.optional(effect.Schema.Unknown),
	approvalPolicy: effect.Schema.optional(ProviderApprovalPolicy),
	sandboxMode: effect.Schema.optional(ProviderSandboxMode),
	providerLaunchEnvironment: effect.Schema.optional(ProviderLaunchEnvironment),
	runtimeMode: RuntimeMode
});
const ProviderSendTurnInput = effect.Schema.Struct({
	threadId: ThreadId,
	input: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS))),
	attachments: effect.Schema.optional(effect.Schema.Array(ChatAttachment).check(effect.Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS))),
	modelSelection: effect.Schema.optional(ModelSelection),
	interactionMode: effect.Schema.optional(ProviderInteractionMode)
});
const ProviderTurnStartResult = effect.Schema.Struct({
	threadId: ThreadId,
	turnId: TurnId,
	resumeCursor: effect.Schema.optional(effect.Schema.Unknown)
});
const ProviderInterruptTurnInput = effect.Schema.Struct({
	threadId: ThreadId,
	turnId: effect.Schema.optional(TurnId)
});
const ProviderStopSessionInput = effect.Schema.Struct({ threadId: ThreadId });
const ProviderRespondToRequestInput = effect.Schema.Struct({
	threadId: ThreadId,
	requestId: ApprovalRequestId,
	decision: ProviderApprovalDecision
});
const ProviderRespondToUserInputInput = effect.Schema.Struct({
	threadId: ThreadId,
	requestId: ApprovalRequestId,
	answers: ProviderUserInputAnswers
});
const ProviderEventKind = effect.Schema.Literals([
	"session",
	"notification",
	"request",
	"error"
]);
const ProviderEvent = effect.Schema.Struct({
	id: EventId,
	kind: ProviderEventKind,
	provider: ProviderKind,
	threadId: ThreadId,
	createdAt: IsoDateTime,
	method: TrimmedNonEmptyString,
	message: effect.Schema.optional(TrimmedNonEmptyString),
	turnId: effect.Schema.optional(TurnId),
	itemId: effect.Schema.optional(ProviderItemId),
	requestId: effect.Schema.optional(ApprovalRequestId),
	requestKind: effect.Schema.optional(ProviderRequestKind),
	textDelta: effect.Schema.optional(effect.Schema.String),
	payload: effect.Schema.optional(effect.Schema.Unknown)
});

//#endregion
//#region ../../packages/contracts/src/providerRuntime.ts
const TrimmedNonEmptyStringSchema$1 = TrimmedNonEmptyString;
const UnknownRecordSchema = effect.Schema.Record(effect.Schema.String, effect.Schema.Unknown);
const RuntimeEventRawSource = effect.Schema.Literals([
	"codex.app-server.notification",
	"codex.app-server.request",
	"codex.eventmsg",
	"claude.sdk.message",
	"claude.sdk.permission",
	"codex.sdk.thread-event"
]);
const RuntimeEventRaw = effect.Schema.Struct({
	source: RuntimeEventRawSource,
	method: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	messageType: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	payload: effect.Schema.Unknown
});
const ProviderRequestId = TrimmedNonEmptyStringSchema$1;
const ProviderRefs = effect.Schema.Struct({
	providerTurnId: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	providerItemId: effect.Schema.optional(ProviderItemId),
	providerRequestId: effect.Schema.optional(ProviderRequestId)
});
const RuntimeSessionState = effect.Schema.Literals([
	"starting",
	"ready",
	"running",
	"waiting",
	"stopped",
	"error"
]);
const RuntimeThreadState = effect.Schema.Literals([
	"active",
	"idle",
	"archived",
	"closed",
	"compacted",
	"error"
]);
const RuntimeTurnState = effect.Schema.Literals([
	"completed",
	"failed",
	"interrupted",
	"cancelled"
]);
const RuntimePlanStepStatus = effect.Schema.Literals([
	"pending",
	"inProgress",
	"completed"
]);
const RuntimeItemStatus = effect.Schema.Literals([
	"inProgress",
	"completed",
	"failed",
	"declined"
]);
const RuntimeContentStreamKind = effect.Schema.Literals([
	"assistant_text",
	"reasoning_text",
	"reasoning_summary_text",
	"plan_text",
	"command_output",
	"file_change_output",
	"unknown"
]);
const RuntimeSessionExitKind = effect.Schema.Literals(["graceful", "error"]);
const RuntimeErrorClass = effect.Schema.Literals([
	"provider_error",
	"transport_error",
	"permission_error",
	"validation_error",
	"unknown"
]);
const TOOL_LIFECYCLE_ITEM_TYPES = [
	"command_execution",
	"file_change",
	"mcp_tool_call",
	"dynamic_tool_call",
	"collab_agent_tool_call",
	"web_search",
	"image_view"
];
const ToolLifecycleItemType = effect.Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);
const CanonicalItemType = effect.Schema.Literals([
	"user_message",
	"assistant_message",
	"reasoning",
	"plan",
	...TOOL_LIFECYCLE_ITEM_TYPES,
	"review_entered",
	"review_exited",
	"context_compaction",
	"error",
	"unknown"
]);
const CanonicalRequestType = effect.Schema.Literals([
	"command_execution_approval",
	"file_read_approval",
	"file_change_approval",
	"apply_patch_approval",
	"exec_command_approval",
	"tool_user_input",
	"dynamic_tool_call",
	"auth_tokens_refresh",
	"unknown"
]);
effect.Schema.Literals([
	"session.started",
	"session.configured",
	"session.state.changed",
	"session.exited",
	"thread.started",
	"thread.state.changed",
	"thread.metadata.updated",
	"thread.token-usage.updated",
	"thread.realtime.started",
	"thread.realtime.item-added",
	"thread.realtime.audio.delta",
	"thread.realtime.error",
	"thread.realtime.closed",
	"turn.started",
	"turn.completed",
	"turn.aborted",
	"turn.plan.updated",
	"turn.proposed.delta",
	"turn.proposed.completed",
	"turn.diff.updated",
	"item.started",
	"item.updated",
	"item.completed",
	"content.delta",
	"request.opened",
	"request.resolved",
	"user-input.requested",
	"user-input.resolved",
	"task.started",
	"task.progress",
	"task.completed",
	"hook.started",
	"hook.progress",
	"hook.completed",
	"tool.progress",
	"tool.summary",
	"auth.status",
	"account.updated",
	"account.rate-limits.updated",
	"mcp.status.updated",
	"mcp.oauth.completed",
	"model.rerouted",
	"config.warning",
	"deprecation.notice",
	"files.persisted",
	"runtime.warning",
	"runtime.error"
]);
const SessionStartedType = effect.Schema.Literal("session.started");
const SessionConfiguredType = effect.Schema.Literal("session.configured");
const SessionStateChangedType = effect.Schema.Literal("session.state.changed");
const SessionExitedType = effect.Schema.Literal("session.exited");
const ThreadStartedType = effect.Schema.Literal("thread.started");
const ThreadStateChangedType = effect.Schema.Literal("thread.state.changed");
const ThreadMetadataUpdatedType = effect.Schema.Literal("thread.metadata.updated");
const ThreadTokenUsageUpdatedType = effect.Schema.Literal("thread.token-usage.updated");
const ThreadRealtimeStartedType = effect.Schema.Literal("thread.realtime.started");
const ThreadRealtimeItemAddedType = effect.Schema.Literal("thread.realtime.item-added");
const ThreadRealtimeAudioDeltaType = effect.Schema.Literal("thread.realtime.audio.delta");
const ThreadRealtimeErrorType = effect.Schema.Literal("thread.realtime.error");
const ThreadRealtimeClosedType = effect.Schema.Literal("thread.realtime.closed");
const TurnStartedType = effect.Schema.Literal("turn.started");
const TurnCompletedType = effect.Schema.Literal("turn.completed");
const TurnAbortedType = effect.Schema.Literal("turn.aborted");
const TurnPlanUpdatedType = effect.Schema.Literal("turn.plan.updated");
const TurnProposedDeltaType = effect.Schema.Literal("turn.proposed.delta");
const TurnProposedCompletedType = effect.Schema.Literal("turn.proposed.completed");
const TurnDiffUpdatedType = effect.Schema.Literal("turn.diff.updated");
const ItemStartedType = effect.Schema.Literal("item.started");
const ItemUpdatedType = effect.Schema.Literal("item.updated");
const ItemCompletedType = effect.Schema.Literal("item.completed");
const ContentDeltaType = effect.Schema.Literal("content.delta");
const RequestOpenedType = effect.Schema.Literal("request.opened");
const RequestResolvedType = effect.Schema.Literal("request.resolved");
const UserInputRequestedType = effect.Schema.Literal("user-input.requested");
const UserInputResolvedType = effect.Schema.Literal("user-input.resolved");
const TaskStartedType = effect.Schema.Literal("task.started");
const TaskProgressType = effect.Schema.Literal("task.progress");
const TaskCompletedType = effect.Schema.Literal("task.completed");
const HookStartedType = effect.Schema.Literal("hook.started");
const HookProgressType = effect.Schema.Literal("hook.progress");
const HookCompletedType = effect.Schema.Literal("hook.completed");
const ToolProgressType = effect.Schema.Literal("tool.progress");
const ToolSummaryType = effect.Schema.Literal("tool.summary");
const AuthStatusType = effect.Schema.Literal("auth.status");
const AccountUpdatedType = effect.Schema.Literal("account.updated");
const AccountRateLimitsUpdatedType = effect.Schema.Literal("account.rate-limits.updated");
const McpStatusUpdatedType = effect.Schema.Literal("mcp.status.updated");
const McpOauthCompletedType = effect.Schema.Literal("mcp.oauth.completed");
const ModelReroutedType = effect.Schema.Literal("model.rerouted");
const ConfigWarningType = effect.Schema.Literal("config.warning");
const DeprecationNoticeType = effect.Schema.Literal("deprecation.notice");
const FilesPersistedType = effect.Schema.Literal("files.persisted");
const RuntimeWarningType = effect.Schema.Literal("runtime.warning");
const RuntimeErrorType = effect.Schema.Literal("runtime.error");
const ProviderRuntimeEventBase = effect.Schema.Struct({
	eventId: EventId,
	provider: ProviderKind,
	threadId: ThreadId,
	createdAt: IsoDateTime,
	turnId: effect.Schema.optional(TurnId),
	itemId: effect.Schema.optional(RuntimeItemId),
	requestId: effect.Schema.optional(RuntimeRequestId),
	providerRefs: effect.Schema.optional(ProviderRefs),
	raw: effect.Schema.optional(RuntimeEventRaw)
});
const SessionStartedPayload = effect.Schema.Struct({
	message: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	resume: effect.Schema.optional(effect.Schema.Unknown)
});
const SessionConfiguredPayload = effect.Schema.Struct({ config: UnknownRecordSchema });
const SessionStateChangedPayload = effect.Schema.Struct({
	state: RuntimeSessionState,
	reason: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	detail: effect.Schema.optional(effect.Schema.Unknown)
});
const SessionExitedPayload = effect.Schema.Struct({
	reason: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	recoverable: effect.Schema.optional(effect.Schema.Boolean),
	exitKind: effect.Schema.optional(RuntimeSessionExitKind)
});
const ThreadStartedPayload = effect.Schema.Struct({ providerThreadId: effect.Schema.optional(TrimmedNonEmptyStringSchema$1) });
const ThreadStateChangedPayload = effect.Schema.Struct({
	state: RuntimeThreadState,
	detail: effect.Schema.optional(effect.Schema.Unknown)
});
const ThreadMetadataUpdatedPayload = effect.Schema.Struct({
	name: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	metadata: effect.Schema.optional(UnknownRecordSchema)
});
const ThreadTokenUsageSnapshot = effect.Schema.Struct({
	usedTokens: NonNegativeInt,
	totalProcessedTokens: effect.Schema.optional(NonNegativeInt),
	maxTokens: effect.Schema.optional(PositiveInt),
	inputTokens: effect.Schema.optional(NonNegativeInt),
	cachedInputTokens: effect.Schema.optional(NonNegativeInt),
	outputTokens: effect.Schema.optional(NonNegativeInt),
	reasoningOutputTokens: effect.Schema.optional(NonNegativeInt),
	lastUsedTokens: effect.Schema.optional(NonNegativeInt),
	lastInputTokens: effect.Schema.optional(NonNegativeInt),
	lastCachedInputTokens: effect.Schema.optional(NonNegativeInt),
	lastOutputTokens: effect.Schema.optional(NonNegativeInt),
	lastReasoningOutputTokens: effect.Schema.optional(NonNegativeInt),
	toolUses: effect.Schema.optional(NonNegativeInt),
	durationMs: effect.Schema.optional(NonNegativeInt),
	compactsAutomatically: effect.Schema.optional(effect.Schema.Boolean)
});
const ThreadTokenUsageUpdatedPayload = effect.Schema.Struct({ usage: ThreadTokenUsageSnapshot });
const ThreadRealtimeStartedPayload = effect.Schema.Struct({ realtimeSessionId: effect.Schema.optional(TrimmedNonEmptyStringSchema$1) });
const ThreadRealtimeItemAddedPayload = effect.Schema.Struct({ item: effect.Schema.Unknown });
const ThreadRealtimeAudioDeltaPayload = effect.Schema.Struct({ audio: effect.Schema.Unknown });
const ThreadRealtimeErrorPayload = effect.Schema.Struct({ message: TrimmedNonEmptyStringSchema$1 });
const ThreadRealtimeClosedPayload = effect.Schema.Struct({ reason: effect.Schema.optional(TrimmedNonEmptyStringSchema$1) });
const TurnStartedPayload = effect.Schema.Struct({
	model: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	effort: effect.Schema.optional(TrimmedNonEmptyStringSchema$1)
});
const TurnCompletedPayload = effect.Schema.Struct({
	state: RuntimeTurnState,
	stopReason: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyStringSchema$1)),
	usage: effect.Schema.optional(effect.Schema.Unknown),
	modelUsage: effect.Schema.optional(UnknownRecordSchema),
	totalCostUsd: effect.Schema.optional(effect.Schema.Number),
	errorMessage: effect.Schema.optional(TrimmedNonEmptyStringSchema$1)
});
const TurnAbortedPayload = effect.Schema.Struct({ reason: TrimmedNonEmptyStringSchema$1 });
const RuntimePlanStep = effect.Schema.Struct({
	step: TrimmedNonEmptyStringSchema$1,
	status: RuntimePlanStepStatus
});
const TurnPlanUpdatedPayload = effect.Schema.Struct({
	explanation: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyStringSchema$1)),
	plan: effect.Schema.Array(RuntimePlanStep)
});
const TurnProposedDeltaPayload = effect.Schema.Struct({ delta: effect.Schema.String });
const TurnProposedCompletedPayload = effect.Schema.Struct({ planMarkdown: TrimmedNonEmptyStringSchema$1 });
const TurnDiffUpdatedPayload = effect.Schema.Struct({ unifiedDiff: effect.Schema.String });
const ItemLifecyclePayload = effect.Schema.Struct({
	itemType: CanonicalItemType,
	status: effect.Schema.optional(RuntimeItemStatus),
	title: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	detail: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	data: effect.Schema.optional(effect.Schema.Unknown)
});
const ContentDeltaPayload = effect.Schema.Struct({
	streamKind: RuntimeContentStreamKind,
	delta: effect.Schema.String,
	contentIndex: effect.Schema.optional(effect.Schema.Int),
	summaryIndex: effect.Schema.optional(effect.Schema.Int)
});
const RequestOpenedPayload = effect.Schema.Struct({
	requestType: CanonicalRequestType,
	detail: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	args: effect.Schema.optional(effect.Schema.Unknown)
});
const RequestResolvedPayload = effect.Schema.Struct({
	requestType: CanonicalRequestType,
	decision: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	resolution: effect.Schema.optional(effect.Schema.Unknown)
});
const UserInputQuestionOption = effect.Schema.Struct({
	label: TrimmedNonEmptyStringSchema$1,
	description: TrimmedNonEmptyStringSchema$1
});
const UserInputQuestion = effect.Schema.Struct({
	id: TrimmedNonEmptyStringSchema$1,
	header: TrimmedNonEmptyStringSchema$1,
	question: TrimmedNonEmptyStringSchema$1,
	options: effect.Schema.Array(UserInputQuestionOption),
	multiSelect: effect.Schema.optional(effect.Schema.Boolean).pipe(effect.Schema.withConstructorDefault(effect.Effect.succeed(false)))
});
const UserInputRequestedPayload = effect.Schema.Struct({ questions: effect.Schema.Array(UserInputQuestion) });
const UserInputResolvedPayload = effect.Schema.Struct({ answers: UnknownRecordSchema });
const TaskStartedPayload = effect.Schema.Struct({
	taskId: RuntimeTaskId,
	description: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	taskType: effect.Schema.optional(TrimmedNonEmptyStringSchema$1)
});
const TaskProgressPayload = effect.Schema.Struct({
	taskId: RuntimeTaskId,
	description: TrimmedNonEmptyStringSchema$1,
	summary: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	usage: effect.Schema.optional(effect.Schema.Unknown),
	lastToolName: effect.Schema.optional(TrimmedNonEmptyStringSchema$1)
});
const TaskCompletedPayload = effect.Schema.Struct({
	taskId: RuntimeTaskId,
	status: effect.Schema.Literals([
		"completed",
		"failed",
		"stopped"
	]),
	summary: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	usage: effect.Schema.optional(effect.Schema.Unknown)
});
const HookStartedPayload = effect.Schema.Struct({
	hookId: TrimmedNonEmptyStringSchema$1,
	hookName: TrimmedNonEmptyStringSchema$1,
	hookEvent: TrimmedNonEmptyStringSchema$1
});
const HookProgressPayload = effect.Schema.Struct({
	hookId: TrimmedNonEmptyStringSchema$1,
	output: effect.Schema.optional(effect.Schema.String),
	stdout: effect.Schema.optional(effect.Schema.String),
	stderr: effect.Schema.optional(effect.Schema.String)
});
const HookCompletedPayload = effect.Schema.Struct({
	hookId: TrimmedNonEmptyStringSchema$1,
	outcome: effect.Schema.Literals([
		"success",
		"error",
		"cancelled"
	]),
	output: effect.Schema.optional(effect.Schema.String),
	stdout: effect.Schema.optional(effect.Schema.String),
	stderr: effect.Schema.optional(effect.Schema.String),
	exitCode: effect.Schema.optional(effect.Schema.Int)
});
const ToolProgressPayload = effect.Schema.Struct({
	toolUseId: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	toolName: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	summary: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	elapsedSeconds: effect.Schema.optional(effect.Schema.Number)
});
const ToolSummaryPayload = effect.Schema.Struct({
	summary: TrimmedNonEmptyStringSchema$1,
	precedingToolUseIds: effect.Schema.optional(effect.Schema.Array(TrimmedNonEmptyStringSchema$1))
});
const AuthStatusPayload = effect.Schema.Struct({
	isAuthenticating: effect.Schema.optional(effect.Schema.Boolean),
	output: effect.Schema.optional(effect.Schema.Array(effect.Schema.String)),
	error: effect.Schema.optional(TrimmedNonEmptyStringSchema$1)
});
const AccountUpdatedPayload = effect.Schema.Struct({ account: effect.Schema.Unknown });
const AccountRateLimitsUpdatedPayload = effect.Schema.Struct({ rateLimits: effect.Schema.Unknown });
const McpStatusUpdatedPayload = effect.Schema.Struct({ status: effect.Schema.Unknown });
const McpOauthCompletedPayload = effect.Schema.Struct({
	success: effect.Schema.Boolean,
	name: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	error: effect.Schema.optional(TrimmedNonEmptyStringSchema$1)
});
const ModelReroutedPayload = effect.Schema.Struct({
	fromModel: TrimmedNonEmptyStringSchema$1,
	toModel: TrimmedNonEmptyStringSchema$1,
	reason: TrimmedNonEmptyStringSchema$1
});
const ConfigWarningPayload = effect.Schema.Struct({
	summary: TrimmedNonEmptyStringSchema$1,
	details: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	path: effect.Schema.optional(TrimmedNonEmptyStringSchema$1),
	range: effect.Schema.optional(effect.Schema.Unknown)
});
const DeprecationNoticePayload = effect.Schema.Struct({
	summary: TrimmedNonEmptyStringSchema$1,
	details: effect.Schema.optional(TrimmedNonEmptyStringSchema$1)
});
const FilesPersistedPayload = effect.Schema.Struct({
	files: effect.Schema.Array(effect.Schema.Struct({
		filename: TrimmedNonEmptyStringSchema$1,
		fileId: TrimmedNonEmptyStringSchema$1
	})),
	failed: effect.Schema.optional(effect.Schema.Array(effect.Schema.Struct({
		filename: TrimmedNonEmptyStringSchema$1,
		error: TrimmedNonEmptyStringSchema$1
	})))
});
const RuntimeWarningPayload = effect.Schema.Struct({
	message: TrimmedNonEmptyStringSchema$1,
	detail: effect.Schema.optional(effect.Schema.Unknown)
});
const RuntimeErrorPayload = effect.Schema.Struct({
	message: TrimmedNonEmptyStringSchema$1,
	class: effect.Schema.optional(RuntimeErrorClass),
	detail: effect.Schema.optional(effect.Schema.Unknown)
});
const ProviderRuntimeSessionStartedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: SessionStartedType,
	payload: SessionStartedPayload
});
const ProviderRuntimeSessionConfiguredEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: SessionConfiguredType,
	payload: SessionConfiguredPayload
});
const ProviderRuntimeSessionStateChangedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: SessionStateChangedType,
	payload: SessionStateChangedPayload
});
const ProviderRuntimeSessionExitedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: SessionExitedType,
	payload: SessionExitedPayload
});
const ProviderRuntimeThreadStartedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ThreadStartedType,
	payload: ThreadStartedPayload
});
const ProviderRuntimeThreadStateChangedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ThreadStateChangedType,
	payload: ThreadStateChangedPayload
});
const ProviderRuntimeThreadMetadataUpdatedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ThreadMetadataUpdatedType,
	payload: ThreadMetadataUpdatedPayload
});
const ProviderRuntimeThreadTokenUsageUpdatedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ThreadTokenUsageUpdatedType,
	payload: ThreadTokenUsageUpdatedPayload
});
const ProviderRuntimeThreadRealtimeStartedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ThreadRealtimeStartedType,
	payload: ThreadRealtimeStartedPayload
});
const ProviderRuntimeThreadRealtimeItemAddedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ThreadRealtimeItemAddedType,
	payload: ThreadRealtimeItemAddedPayload
});
const ProviderRuntimeThreadRealtimeAudioDeltaEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ThreadRealtimeAudioDeltaType,
	payload: ThreadRealtimeAudioDeltaPayload
});
const ProviderRuntimeThreadRealtimeErrorEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ThreadRealtimeErrorType,
	payload: ThreadRealtimeErrorPayload
});
const ProviderRuntimeThreadRealtimeClosedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ThreadRealtimeClosedType,
	payload: ThreadRealtimeClosedPayload
});
const ProviderRuntimeTurnStartedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: TurnStartedType,
	payload: TurnStartedPayload
});
const ProviderRuntimeTurnCompletedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: TurnCompletedType,
	payload: TurnCompletedPayload
});
const ProviderRuntimeTurnAbortedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: TurnAbortedType,
	payload: TurnAbortedPayload
});
const ProviderRuntimeTurnPlanUpdatedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: TurnPlanUpdatedType,
	payload: TurnPlanUpdatedPayload
});
const ProviderRuntimeTurnProposedDeltaEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: TurnProposedDeltaType,
	payload: TurnProposedDeltaPayload
});
const ProviderRuntimeTurnProposedCompletedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: TurnProposedCompletedType,
	payload: TurnProposedCompletedPayload
});
const ProviderRuntimeTurnDiffUpdatedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: TurnDiffUpdatedType,
	payload: TurnDiffUpdatedPayload
});
const ProviderRuntimeItemStartedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ItemStartedType,
	payload: ItemLifecyclePayload
});
const ProviderRuntimeItemUpdatedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ItemUpdatedType,
	payload: ItemLifecyclePayload
});
const ProviderRuntimeItemCompletedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ItemCompletedType,
	payload: ItemLifecyclePayload
});
const ProviderRuntimeContentDeltaEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ContentDeltaType,
	payload: ContentDeltaPayload
});
const ProviderRuntimeRequestOpenedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: RequestOpenedType,
	payload: RequestOpenedPayload
});
const ProviderRuntimeRequestResolvedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: RequestResolvedType,
	payload: RequestResolvedPayload
});
const ProviderRuntimeUserInputRequestedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: UserInputRequestedType,
	payload: UserInputRequestedPayload
});
const ProviderRuntimeUserInputResolvedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: UserInputResolvedType,
	payload: UserInputResolvedPayload
});
const ProviderRuntimeTaskStartedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: TaskStartedType,
	payload: TaskStartedPayload
});
const ProviderRuntimeTaskProgressEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: TaskProgressType,
	payload: TaskProgressPayload
});
const ProviderRuntimeTaskCompletedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: TaskCompletedType,
	payload: TaskCompletedPayload
});
const ProviderRuntimeHookStartedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: HookStartedType,
	payload: HookStartedPayload
});
const ProviderRuntimeHookProgressEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: HookProgressType,
	payload: HookProgressPayload
});
const ProviderRuntimeHookCompletedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: HookCompletedType,
	payload: HookCompletedPayload
});
const ProviderRuntimeToolProgressEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ToolProgressType,
	payload: ToolProgressPayload
});
const ProviderRuntimeToolSummaryEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ToolSummaryType,
	payload: ToolSummaryPayload
});
const ProviderRuntimeAuthStatusEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: AuthStatusType,
	payload: AuthStatusPayload
});
const ProviderRuntimeAccountUpdatedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: AccountUpdatedType,
	payload: AccountUpdatedPayload
});
const ProviderRuntimeAccountRateLimitsUpdatedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: AccountRateLimitsUpdatedType,
	payload: AccountRateLimitsUpdatedPayload
});
const ProviderRuntimeMcpStatusUpdatedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: McpStatusUpdatedType,
	payload: McpStatusUpdatedPayload
});
const ProviderRuntimeMcpOauthCompletedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: McpOauthCompletedType,
	payload: McpOauthCompletedPayload
});
const ProviderRuntimeModelReroutedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ModelReroutedType,
	payload: ModelReroutedPayload
});
const ProviderRuntimeConfigWarningEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: ConfigWarningType,
	payload: ConfigWarningPayload
});
const ProviderRuntimeDeprecationNoticeEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: DeprecationNoticeType,
	payload: DeprecationNoticePayload
});
const ProviderRuntimeFilesPersistedEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: FilesPersistedType,
	payload: FilesPersistedPayload
});
const ProviderRuntimeWarningEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: RuntimeWarningType,
	payload: RuntimeWarningPayload
});
const ProviderRuntimeErrorEvent = effect.Schema.Struct({
	...ProviderRuntimeEventBase.fields,
	type: RuntimeErrorType,
	payload: RuntimeErrorPayload
});
const ProviderRuntimeEventV2 = effect.Schema.Union([
	ProviderRuntimeSessionStartedEvent,
	ProviderRuntimeSessionConfiguredEvent,
	ProviderRuntimeSessionStateChangedEvent,
	ProviderRuntimeSessionExitedEvent,
	ProviderRuntimeThreadStartedEvent,
	ProviderRuntimeThreadStateChangedEvent,
	ProviderRuntimeThreadMetadataUpdatedEvent,
	ProviderRuntimeThreadTokenUsageUpdatedEvent,
	ProviderRuntimeThreadRealtimeStartedEvent,
	ProviderRuntimeThreadRealtimeItemAddedEvent,
	ProviderRuntimeThreadRealtimeAudioDeltaEvent,
	ProviderRuntimeThreadRealtimeErrorEvent,
	ProviderRuntimeThreadRealtimeClosedEvent,
	ProviderRuntimeTurnStartedEvent,
	ProviderRuntimeTurnCompletedEvent,
	ProviderRuntimeTurnAbortedEvent,
	ProviderRuntimeTurnPlanUpdatedEvent,
	ProviderRuntimeTurnProposedDeltaEvent,
	ProviderRuntimeTurnProposedCompletedEvent,
	ProviderRuntimeTurnDiffUpdatedEvent,
	ProviderRuntimeItemStartedEvent,
	ProviderRuntimeItemUpdatedEvent,
	ProviderRuntimeItemCompletedEvent,
	ProviderRuntimeContentDeltaEvent,
	ProviderRuntimeRequestOpenedEvent,
	ProviderRuntimeRequestResolvedEvent,
	ProviderRuntimeUserInputRequestedEvent,
	ProviderRuntimeUserInputResolvedEvent,
	ProviderRuntimeTaskStartedEvent,
	ProviderRuntimeTaskProgressEvent,
	ProviderRuntimeTaskCompletedEvent,
	ProviderRuntimeHookStartedEvent,
	ProviderRuntimeHookProgressEvent,
	ProviderRuntimeHookCompletedEvent,
	ProviderRuntimeToolProgressEvent,
	ProviderRuntimeToolSummaryEvent,
	ProviderRuntimeAuthStatusEvent,
	ProviderRuntimeAccountUpdatedEvent,
	ProviderRuntimeAccountRateLimitsUpdatedEvent,
	ProviderRuntimeMcpStatusUpdatedEvent,
	ProviderRuntimeMcpOauthCompletedEvent,
	ProviderRuntimeModelReroutedEvent,
	ProviderRuntimeConfigWarningEvent,
	ProviderRuntimeDeprecationNoticeEvent,
	ProviderRuntimeFilesPersistedEvent,
	ProviderRuntimeWarningEvent,
	ProviderRuntimeErrorEvent
]);
effect.Schema.Literals([
	"command",
	"file-read",
	"file-change",
	"other"
]);

//#endregion
//#region ../../packages/contracts/src/providerSharing.ts
/**
* The providers the on-disk provider-auth store knows about, named the way the
* store names its directories (`provider-auth/<slug>/codex`, `.../claude`).
*
* Deliberately not `ProviderKind` from `orchestration.ts`, which spells the
* second one `claudeAgent`: that literal is the orchestration runtime's name
* for an agent, and it is persisted in threads and events. These two travel
* together but change for different reasons — a new agent runtime does not
* imply a new credential directory — so they stay separate rather than one
* being derived from the other. Anything crossing between them must map
* explicitly, which is the point.
*/
const ProviderAuthKind = effect.Schema.Literals(["codex", "claude"]);
/** What a single member runs on: their own credential, or the workspace's. */
const ProviderAccessMode = effect.Schema.Literals(["own", "workspace"]);
/** What members get by default when no grant names them individually. */
const ProviderPolicyMode = effect.Schema.Literals(["own", "shared"]);
/**
* One credential a user has connected. `label` is how a person tells two of
* their own accounts apart; the token, cookie or auth.json behind it never
* leaves the server, so nothing on this struct — or any struct in this file —
* carries credential material.
*/
const ProviderConnectedAccount = effect.Schema.Struct({
	accountId: ProviderAccountId,
	provider: ProviderAuthKind,
	label: TrimmedNonEmptyString,
	createdAt: IsoDateTime,
	isDefault: effect.Schema.Boolean
});
/**
* An owner's decision to let one workspace run turns on one of their accounts.
*
* Keyed by workspace rather than tenant because a tenant is a billing and
* identity boundary while a workspace is the unit people actually work in:
* someone contributing their personal Claude account to one team's workspace
* has said nothing about the other workspaces in the same tenant. Widening the
* key to the tenant would silently hand every workspace the credential.
*
* `enabled: false` is kept rather than deleted so the switch survives a policy
* still pointing at this account — the off switch has to be able to win.
*/
const ProviderAccountShare = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	ownerUserId: UserId,
	provider: ProviderAuthKind,
	accountId: ProviderAccountId,
	enabled: effect.Schema.Boolean,
	updatedAt: IsoDateTime
});
/**
* The workspace-wide default for one provider, and which contributed account
* `shared` mode actually runs on. Both pointers are null under `own` mode, and
* a `shared` policy whose named account has been unshared or disconnected is
* not repaired here — resolution falls back at turn time instead, so a
* momentary disconnect does not quietly rewrite an admin's choice.
*/
const ProviderWorkspacePolicy = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	provider: ProviderAuthKind,
	mode: ProviderPolicyMode,
	sharedOwnerUserId: effect.Schema.NullOr(UserId),
	sharedAccountId: effect.Schema.NullOr(ProviderAccountId),
	updatedAt: IsoDateTime
});
/** An admin's per-member override of the workspace default. */
const ProviderMemberGrant = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	userId: UserId,
	provider: ProviderAuthKind,
	access: ProviderAccessMode,
	updatedAt: IsoDateTime
});
/**
* One roster row per connected account in the workspace, so an admin can pick
* the account a `shared` policy runs on without having to ask each owner what
* they have. It joins the account index to the member list, which is why it
* carries `displayName` — the roster is the only place both are known.
*
* Admin-only, and labels only: knowing that Ana has a "work" Codex account is
* what an admin needs to choose one; the credential itself is never part of
* the answer, and no field here can be widened into one.
*/
const ProviderWorkspaceAccount = effect.Schema.Struct({
	userId: UserId,
	displayName: TrimmedNonEmptyString,
	provider: ProviderAuthKind,
	accountId: ProviderAccountId,
	label: TrimmedNonEmptyString,
	createdAt: IsoDateTime,
	isShared: effect.Schema.Boolean,
	isWorkspaceDefault: effect.Schema.Boolean
});
var ProviderSharingError = class extends effect.Schema.TaggedErrorClass()("ProviderSharingError", {
	message: TrimmedNonEmptyString,
	code: effect.Schema.Literals([
		"forbidden",
		"workspace-not-found",
		"member-not-found",
		"account-not-found",
		"account-not-shared",
		"invalid-policy"
	]),
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
const ProviderSharingOverviewGetInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId
});
/**
* One read that powers the whole panel. Split into viewer-scoped and
* workspace-scoped halves because every member may see what applies to them,
* while the last three fields are an admin view of other people's accounts and
* come back empty — not omitted — for everyone else, so the client renders the
* same shape either way and never infers permission from a missing field.
*/
const ProviderSharingOverviewResult = effect.Schema.Struct({
	viewerUserId: UserId,
	canManage: effect.Schema.Boolean,
	viewerAccounts: effect.Schema.Array(ProviderConnectedAccount),
	viewerShares: effect.Schema.Array(ProviderAccountShare),
	viewerGrants: effect.Schema.Array(ProviderMemberGrant),
	policies: effect.Schema.Array(ProviderWorkspacePolicy),
	grants: effect.Schema.Array(ProviderMemberGrant),
	workspaceAccounts: effect.Schema.Array(ProviderWorkspaceAccount)
});
/**
* No `ownerUserId`: the caller is always the owner. Letting the input name a
* different one would make contributing someone else's credential a matter of
* editing a field.
*/
const ProviderSharingShareUpdateInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	provider: ProviderAuthKind,
	accountId: ProviderAccountId,
	enabled: effect.Schema.Boolean
});
const ProviderSharingShareUpdateResult = effect.Schema.Struct({ share: ProviderAccountShare });
/**
* The two pointers are optional-and-nullable rather than plain optional: an
* explicit null clears the pinned account when switching back to `own`, which
* an absent field cannot express against a stored row.
*/
const ProviderSharingPolicyUpdateInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	provider: ProviderAuthKind,
	mode: ProviderPolicyMode,
	sharedOwnerUserId: effect.Schema.optional(effect.Schema.NullOr(UserId)),
	sharedAccountId: effect.Schema.optional(effect.Schema.NullOr(ProviderAccountId))
});
const ProviderSharingPolicyUpdateResult = effect.Schema.Struct({ policy: ProviderWorkspacePolicy });
const ProviderSharingMemberUpdateInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	userId: UserId,
	provider: ProviderAuthKind,
	access: ProviderAccessMode
});
const ProviderSharingMemberUpdateResult = effect.Schema.Struct({ grant: ProviderMemberGrant });

//#endregion
//#region ../../packages/contracts/src/providerUsage.ts
/**
* Asking a workspace for provider usage: the other half of
* `providerSharing.ts`. Sharing lets someone who has a credential offer it;
* this lets someone who has none — or is about to run out — say so, and be
* answered. Without it the only path is the refusal message, which can do
* nothing but tell people to go and buy their own subscription.
*
* Everything here is a request and a decision. No credential material, no
* account contents: granting a request is expressed by writing the sharing
* tables, and this file only records that the answer was yes.
*/
/**
* Branded here rather than in `baseSchemas.ts` because these ids never appear
* outside this exchange — the same reason `PackId` lives in `pack.ts`.
*/
const ProviderUsageRequestId = TrimmedNonEmptyString.pipe(effect.Schema.brand("ProviderUsageRequestId"));
/**
* `withdrawn` is the requester taking it back and is deliberately distinct
* from `declined`: a panel that showed "declined" for a request nobody ever
* looked at would accuse a colleague of refusing.
*/
const ProviderUsageRequestStatus = effect.Schema.Literals([
	"pending",
	"granted",
	"declined",
	"withdrawn"
]);
/**
* Why the person is asking, as it was true at the moment they asked.
*
* `asked` is the catch-all: someone who could run turns but wants the
* workspace's account anyway.
*/
const ProviderUsageRequestReason = effect.Schema.Literals([
	"no-account",
	"limit-reached",
	"asked"
]);
/** grant contributes an account; decline closes the request without one. */
const ProviderUsageRequestDecision = effect.Schema.Literals(["grant", "decline"]);
/**
* One person asking one workspace for usage of one provider.
*
* `reason` is stored rather than derived because it is a fact about the moment
* of asking, not about now. Someone who asks with `no-account` and then
* connects one, or asks with `limit-reached` at the end of a billing period,
* would have the panel re-derive `asked` and quietly rewrite why they were
* asking — turning an urgent request into a casual one, or the reverse. The
* panel explains the request in the requester's own terms or not at all.
*
* `requesterDisplayName` is denormalised for the same reason a roster row
* carries one: the responder has to be told who is asking, and a request
* outlives the membership row that could otherwise supply the name.
*
* Which account a grant actually contributed is deliberately *not* here.
* Unlike the reason, that is live state — an owner may switch the share off or
* disconnect the account a minute later — so it is read from
* `ProviderAccountShare` at the time of asking rather than frozen into an
* answer that would go stale.
*/
const ProviderUsageRequest = effect.Schema.Struct({
	id: ProviderUsageRequestId,
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	requesterUserId: UserId,
	requesterDisplayName: TrimmedNonEmptyString,
	provider: ProviderAuthKind,
	reason: ProviderUsageRequestReason,
	note: effect.Schema.NullOr(TrimmedNonEmptyString),
	status: ProviderUsageRequestStatus,
	createdAt: IsoDateTime,
	respondedAt: effect.Schema.NullOr(IsoDateTime),
	respondedByUserId: effect.Schema.NullOr(UserId)
});
/**
* Separate from `ProviderSharingError` rather than widening it. That error's
* vocabulary is about accounts and policies — what may be contributed and by
* whom — while these codes are the lifecycle of a request, which the sharing
* calls can never raise and should not have to narrow past. Shaped after
* `CollaborationError`, whose approval codes this exchange mirrors.
*/
var ProviderUsageError = class extends effect.Schema.TaggedErrorClass()("ProviderUsageError", {
	message: TrimmedNonEmptyString,
	code: effect.Schema.Literals([
		"forbidden",
		"workspace-not-found",
		"request-not-found",
		"request-already-decided",
		"request-already-pending",
		"not-a-contributor",
		"account-not-found"
	]),
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
/**
* No `requesterUserId`: the session is the requester. Letting the input name
* one would let anybody file a request in someone else's name, and the panel
* treats a request as that person's word.
*/
const ProviderUsageRequestCreateInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	provider: ProviderAuthKind,
	reason: ProviderUsageRequestReason,
	note: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyString))
});
const ProviderUsageRequestCreateResult = effect.Schema.Struct({ request: ProviderUsageRequest });
const ProviderUsageRequestListInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId
});
/**
* Everyone sees their own requests; someone with a connected account for a
* provider also sees the workspace's pending ones for it.
*
* `canRespond` is returned rather than inferred from a non-empty `requests`,
* because both halves are legitimately empty: a contributor with nothing
* waiting and a requester with nothing asked look identical otherwise, and the
* panel has to tell "no one needs you" from "you cannot help".
*/
const ProviderUsageRequestListResult = effect.Schema.Struct({
	requests: effect.Schema.Array(ProviderUsageRequest),
	canRespond: effect.Schema.Boolean
});
/**
* `accountId` is optional because `decline` has nothing to name. A `grant`
* without one is the service's to reject, not the schema's: the schema cannot
* see the decision and the account together without splitting this into two
* methods, which would put the same authorisation check in two places.
*/
const ProviderUsageRequestRespondInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	requestId: ProviderUsageRequestId,
	decision: ProviderUsageRequestDecision,
	accountId: effect.Schema.optional(ProviderAccountId)
});
const ProviderUsageRequestRespondResult = effect.Schema.Struct({ request: ProviderUsageRequest });
const ProviderUsageRequestWithdrawInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	requestId: ProviderUsageRequestId
});
const ProviderUsageRequestWithdrawResult = effect.Schema.Struct({ request: ProviderUsageRequest });

//#endregion
//#region ../../packages/contracts/src/shareLinks.ts
/**
* Public share links: access for someone who has no account here.
*
* Invites (`tenancy.ts`) are the other half and cannot cover this. An invite
* names a person, needs them to sign up, and only ever grants a workspace. A
* share link is addressed to nobody, survives being forwarded, and is the only
* way to hand over a single file or a single project without first making the
* recipient a member.
*
* That reach is exactly what makes these dangerous, and it shapes every
* decision below: the token *is* the credential, so it is minted from 32 bytes
* of CSPRNG output rather than from any id, and the three scopes are separate
* literals rather than a flag so that widening a file link into a workspace
* link is a different call and not a changed field.
*/
/**
* Branded here rather than in `baseSchemas.ts` because these ids never leave
* this exchange — the same reason `ProviderUsageRequestId` lives in
* `providerUsage.ts`.
*/
const ShareLinkId = TrimmedNonEmptyString.pipe(effect.Schema.brand("ShareLinkId"));
const ShareLinkViewId = TrimmedNonEmptyString.pipe(effect.Schema.brand("ShareLinkViewId"));
/**
* The secret in the URL. Branded apart from every other string so that a token
* cannot be passed where an id is wanted — or, far worse, an id where a token
* is wanted, which would make links guessable from a list of ids.
*
* Never log it, never put it in an analytics property, never let it into an
* error message: anyone holding this string has whatever the link grants.
*/
const ShareLinkToken = TrimmedNonEmptyString.pipe(effect.Schema.brand("ShareLinkToken"));
/**
* What a link opens.
*
* `file` and `project` are read-only views. `workspace` is categorically
* different — it is an invitation to collaborate, and following it makes the
* visitor a member — so it is a third literal rather than a `canJoin` boolean
* on the other two. A boolean would let a file link acquire join rights by a
* single mistaken write; a scope change cannot happen without rewriting the
* targeting columns too.
*/
const ShareLinkScope = effect.Schema.Literals([
	"file",
	"project",
	"workspace"
]);
/**
* One link. `projectId` and `filePath` are the target and are nullable because
* which of them is meaningful depends on the scope: a workspace link has
* neither, a project link has a project, a file link has both. The schema
* cannot express that dependency without splitting this into three structs
* that every reader would then have to re-join, so the invariant is the
* service's to enforce on write and `ShareLinkError`'s `invalid-target` to
* report.
*
* `revokedAt` and `expiresAt` are kept as timestamps rather than collapsed to
* an `active` boolean: a revoked link stays visible in the owner's list, and
* "this link stopped working on Tuesday" is the answer someone actually needs
* when a recipient reports a 404.
*
* `viewCount` and `lastViewedAt` are a running summary for the list view. The
* per-click detail lives in `ShareLinkView` — see the note there for why both
* exist.
*/
const ShareLink = effect.Schema.Struct({
	id: ShareLinkId,
	token: ShareLinkToken,
	scope: ShareLinkScope,
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	projectId: effect.Schema.NullOr(ProjectId),
	filePath: effect.Schema.NullOr(TrimmedNonEmptyString),
	createdByUserId: UserId,
	label: effect.Schema.NullOr(TrimmedNonEmptyString),
	createdAt: IsoDateTime,
	expiresAt: effect.Schema.NullOr(IsoDateTime),
	revokedAt: effect.Schema.NullOr(IsoDateTime),
	lastViewedAt: effect.Schema.NullOr(IsoDateTime),
	viewCount: NonNegativeInt
});
/**
* One click. Append-only, and deliberately duplicated by the running
* `viewCount` on the link itself.
*
* This is the same split `collaboration_member_usage` and
* `collaboration_usage_samples` already make, for the same reason (migration
* 050 spells it out): a running total answers "how much" cheaply enough to
* render in a list of twenty links, and can answer nothing else. When it was
* viewed, how often, by whom — the notch UI and the analytics page need all
* three, and a counter has thrown every one of them away by the time it is
* read. So the counter stays for the list and the series stays for the detail;
* neither is derived from the other at read time.
*
* `viewerUserId` is null for the ordinary case, an unauthenticated visitor —
* that is the entire point of a public link. `viewerFingerprint` is a salted
* hash the server computes, never a raw IP address: this table is read by a
* product analytics page, and an analytics page must not be a place where
* visitor IPs accumulate.
*/
const ShareLinkView = effect.Schema.Struct({
	id: ShareLinkViewId,
	linkId: ShareLinkId,
	viewedAt: IsoDateTime,
	viewerUserId: effect.Schema.NullOr(UserId),
	viewerFingerprint: effect.Schema.NullOr(TrimmedNonEmptyString)
});
/**
* `expired` and `revoked` are distinct codes even though both mean "this link
* no longer works", because the visitor's next move differs: an expired link
* can be reissued by whoever sent it, a revoked one was switched off on
* purpose and asking again is the wrong advice.
*
* `not-found` covers a token that matches nothing, and it must also be what an
* unauthorised *lookup* returns. Answering "forbidden" for a real token and
* "not-found" for a fake one would turn this error into an oracle that
* confirms a guessed token exists.
*/
var ShareLinkError = class extends effect.Schema.TaggedErrorClass()("ShareLinkError", {
	message: TrimmedNonEmptyString,
	code: effect.Schema.Literals([
		"forbidden",
		"not-found",
		"expired",
		"revoked",
		"invalid-target"
	]),
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
/**
* No `token` and no `createdByUserId`: both are the server's to mint. A
* caller-supplied token would let anyone install a memorable one, and a
* caller-supplied author would let anyone create links in someone else's name.
*/
const ShareLinkCreateInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	scope: ShareLinkScope,
	projectId: effect.Schema.optional(effect.Schema.NullOr(ProjectId)),
	filePath: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyString)),
	label: effect.Schema.optional(effect.Schema.NullOr(TrimmedNonEmptyString)),
	expiresAt: effect.Schema.optional(effect.Schema.NullOr(IsoDateTime))
});
const ShareLinkCreateResult = effect.Schema.Struct({ link: ShareLink });
/**
* `projectId` narrows the listing to one project's links; omitting it lists
* the whole workspace, including the workspace-scoped links that belong to no
* project. Two reads, one method, because the caller is the same panel either
* way and the authorisation check is identical.
*/
const ShareLinkListInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	projectId: effect.Schema.optional(effect.Schema.NullOr(ProjectId))
});
const ShareLinkListResult = effect.Schema.Struct({ links: effect.Schema.Array(ShareLink) });
/**
* Revoking is addressed by id, not by token. The person switching a link off
* is reading their own list, where ids are what they have; requiring the token
* would mean the management UI had to hold every secret it displays in order
* to be able to turn one off.
*/
const ShareLinkRevokeInput = effect.Schema.Struct({
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	linkId: ShareLinkId
});
/** The revoked row, so the list updates from the reply instead of refetching. */
const ShareLinkRevokeResult = effect.Schema.Struct({ link: ShareLink });

//#endregion
//#region ../../packages/contracts/src/cloudSync.ts
/**
* Syncing a project between a laptop and a cloud copy.
*
* `docs/cloud-sync-spec.md` is the contract and this file is its type-level
* half; where the two disagree the document wins. The single rule it exists to
* enforce — *a sync never destroys work* — is what shapes the schemas here, and
* two consequences are worth naming before anything else:
*
* Agreement is a content hash, never a clock. A laptop and a server disagree
* about the time by seconds at least, so "whose write was later" is a guess,
* and a wrong guess silently deletes the loser's morning. Every decision is
* made against a *base revision* — the hash both sides last agreed on for a
* path — which is why `CloudSyncFile` is the load-bearing type in this file and
* `ProjectCloudSync` is only a progress bar.
*
* Resolving a conflict is never a choice between two versions. Both survive;
* `CloudSyncConflict` records where the second one was put, and nothing in this
* contract offers a "keep mine" flag, because such a flag is a delete with
* better manners.
*/
/**
* Branded here rather than in `baseSchemas.ts` for the reason `ShareLinkId`
* gives: this id never leaves this exchange.
*/
const CloudSyncConflictId = TrimmedNonEmptyString.pipe(effect.Schema.brand("CloudSyncConflictId"));
/**
* A content hash, branded apart from every other string so that a path can
* never be passed where a hash is wanted. The two are both project-relative
* strings of similar length, and confusing them would make every comparison in
* the reconciler return "unchanged" — a silent no-op sync, the hardest kind of
* failure to notice.
*/
const CloudSyncHash = TrimmedNonEmptyString.pipe(effect.Schema.brand("CloudSyncHash"));
const CLOUD_SYNC_PATH_MAX_LENGTH = 1024;
/**
* A project-relative path.
*
* Deliberately not `TrimmedNonEmptyString`, which every other path-ish field in
* this package uses. Trim rewrites its input, and a rewritten path is a file
* written somewhere other than where it came from — on macOS and Linux a
* trailing space is a legal, ordinary part of a filename. Under rule 1 a sync
* that refuses a path is a nuisance and a sync that relocates one is data loss,
* so this validates and never edits.
*/
const CloudSyncPath = effect.Schema.String.check(effect.Schema.isNonEmpty()).check(effect.Schema.isMaxLength(CLOUD_SYNC_PATH_MAX_LENGTH));
/**
* Which bargain the person struck, chosen once when they first share a project.
*
* Two literals rather than a `continuous` boolean, because these are not one
* mechanism with a switch. `handoff` makes the cloud canonical and stops
* watching the laptop; `mirror` replicates both ways forever. A boolean would
* let a flip of one bit change which copy is authoritative, and that is the
* decision the whole feature turns on.
*
* Neither mode ever deletes the local directory. "Move it to the cloud" is
* product wording for `handoff`, not an `mv`.
*/
const CloudSyncMode = effect.Schema.Literals(["handoff", "mirror"]);
/**
* What the sync is doing right now.
*
* `scanning` and `transferring` are separate because they fail differently and
* a person reads them differently: a scan that takes a minute on a large tree
* is normal, a transfer stuck at the same byte for a minute is not.
*
* `paused` is a state and not the absence of one — stopping a mirror leaves
* both copies intact and diverging, and the UI has to be able to say that
* rather than showing an idle sync that is quietly no longer running.
*/
const CloudSyncStatus = effect.Schema.Literals([
	"idle",
	"scanning",
	"transferring",
	"paused",
	"error"
]);
/**
* One project's sync, and everything the sync button needs to render.
*
* `filesTotal`, `filesDone`, `bytesTotal` and `bytesDone` describe **the
* current pass only**. They are reset the moment a pass begins, and they are
* not lifetime totals: after two passes over a hundred files, `filesDone` is at
* most a hundred, never two hundred. A counter that only ever climbs makes a
* progress bar that can never reach its end, and someone will spend an hour
* looking for the leak.
*
* `lastAgreedAt` is the durable one. It survives every pass, and it is the only
* field that answers the question a person actually asks — "is my work
* safe?" — so nothing short of a completed agreement moves it.
*
* `activelyChanging` exists to stop a true statement from reading as a bug. A
* mirror over a tree someone is typing into will not converge, and without this
* flag the UI has no way to distinguish "still working, because you are still
* working" from "stuck".
*/
const ProjectCloudSync = effect.Schema.Struct({
	projectId: ProjectId,
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	mode: CloudSyncMode,
	status: CloudSyncStatus,
	lastAgreedAt: effect.Schema.NullOr(IsoDateTime),
	lastError: effect.Schema.NullOr(TrimmedNonEmptyString),
	filesTotal: NonNegativeInt,
	filesDone: NonNegativeInt,
	bytesTotal: NonNegativeInt,
	bytesDone: NonNegativeInt,
	activelyChanging: effect.Schema.Boolean,
	conflictCount: NonNegativeInt,
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime
});
/**
* How often the laptop is expected to say "still here", and how long that
* statement is believed afterwards.
*
* A quick tunnel dies without telling anyone — a closed lid, a dropped Wi-Fi
* connection, a `cloudflared` that was killed — so a registered address is only
* ever a claim about the past. Rather than trusting it, the laptop re-states it
* on a heartbeat and the cloud stops believing it after three missed beats.
*
* Ninety seconds, and not less, because the two ways of being wrong are not
* symmetrical. Believing a dead address for a minute costs a visitor one click
* that fails loudly and instantly, and they are still on the cloud page that
* offered it. Disbelieving a live one tells them "the person sharing this closed
* their laptop", which is the sentence that makes somebody give up and go away —
* and a single garbage-collection pause or a train tunnel would trigger it.
* Three intervals is the ordinary "missed one, missed two, now I believe it".
*
* Ninety seconds, and not more, because the same clock answers "the laptop went
* away mid-sync". Every second added here is a second spent telling a visitor a
* transfer is still running when the machine behind it shut hours ago.
*/
const CLOUD_SYNC_LIVE_COPY_HEARTBEAT_MS = 3e4;
const CLOUD_SYNC_LIVE_COPY_STALE_AFTER_MS = 3 * CLOUD_SYNC_LIVE_COPY_HEARTBEAT_MS;
const CLOUD_SYNC_COPY_URL_MAX_LENGTH = 512;
/**
* An address a visitor's browser will be sent to: a quick tunnel's, or the
* cloud's own.
*
* Both ends of the handoff are checked against this. One of them is registered
* by whichever machine holds the local copy and the other is registered by
* whichever machine finished a pass, so in both directions this is a URL that
* arrived over the wire and will end up in a `Location` header. `javascript:`,
* `data:` and a URL carrying `user:password@` are all refused here rather than
* at the point of use, because the point of use is a redirect.
*
* Plain `http` survives only for a loopback host, which is what a developer's
* cloud is. Everything reachable by anyone else has to be `https`, since the
* whole exchange is a private project moving between two machines.
*/
const CloudSyncCopyUrl = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(CLOUD_SYNC_COPY_URL_MAX_LENGTH));
const LOOPBACK_HOSTS = new Set([
	"127.0.0.1",
	"[::1]",
	"localhost"
]);
function isSafeCloudSyncCopyUrl(candidate) {
	if (candidate.length === 0 || candidate.length > CLOUD_SYNC_COPY_URL_MAX_LENGTH) return false;
	let url;
	try {
		url = new URL(candidate);
	} catch {
		return false;
	}
	if (url.username !== "" || url.password !== "") return false;
	return url.protocol === "https:" || url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}
/**
* Where a live copy of this project is reachable right now, and when the machine
* holding it last said so.
*
* Advisory and perishable, and it is never the identity of anything. The link a
* person hands out is always the cloud URL; this is transport that happens to be
* ready sooner. `confirmedAt` is what makes it safe to hold at all — see the
* heartbeat constants above — and a reader that ignores it is handing visitors
* an address that may have died with a laptop lid.
*/
const CloudSyncLiveCopy = effect.Schema.Struct({
	url: CloudSyncCopyUrl,
	confirmedAt: IsoDateTime,
	staleAfterMs: NonNegativeInt
});
/**
* What a visitor arriving at the cloud URL should be shown. The spec's four
* cases, plus the one that precedes all of them.
*
* These say what a visitor can *do*, which is why they are not the sync's
* `status`: `scanning`, `transferring` and a `paused` first pass all leave the
* same two options open — wait, or go through to the live copy — and the reason
* the bar is not moving belongs in `sync`, which travels alongside.
*
* `sharer-away` is the one that has to be earned rather than guessed. It means
* the heartbeat stopped, and nothing else: a first pass that is genuinely slow
* over a slow link keeps saying so, and never degrades into this.
*/
const CloudSyncVisitorState = effect.Schema.Literals([
	"not-syncing",
	"first-pass",
	"first-pass-live",
	"sharer-away",
	"synced"
]);
/**
* `turnsAllowed` is stated rather than derived, because the spec's requirement —
* refuse turns until the first pass completes — is one rule, and a rule
* re-derived in every client is a rule that will eventually be derived wrongly
* in one of them. An agent let loose on a half-uploaded tree reads a truncated
* file, decides the code is broken, and confidently "fixes" it.
*/
const CloudSyncVisitorView = effect.Schema.Struct({
	state: CloudSyncVisitorState,
	sync: effect.Schema.NullOr(ProjectCloudSync),
	liveCopy: effect.Schema.NullOr(CloudSyncLiveCopy),
	turnsAllowed: effect.Schema.Boolean
});
/**
* The base revision for one path: what both sides last agreed this file was.
*
* This is the heart of the feature. For every path the reconciler compares
* three things — local, remote, and this — and the whole table of outcomes in
* the spec is written in terms of that comparison. Without a base, "both sides
* differ" is unanswerable and the only remaining tiebreak is a clock.
*
* `deletedAt` is not an internal detail and must never be collapsed into a
* missing row. The reconciler reads three distinct states per path:
*
*   - a row with `deletedAt` null — we agreed on this content;
*   - a row with `deletedAt` set — we agreed this path is *gone*;
*   - no row at all — we have never seen this path.
*
* The last two look identical from a distance and behave oppositely. A file the
* server has never seen is never removed, whatever its index says (rule 4);
* a file both sides agreed to delete may be. Merge them and the first sync
* after a reinstall deletes a project.
*
* `hash` stays populated on a tombstone, holding the content that was agreed
* before the agreed deletion. That is what makes "an edit beats a delete"
* (rule 3) resolvable later without a second table, and it is why this field is
* not nullable.
*/
const CloudSyncFile = effect.Schema.Struct({
	projectId: ProjectId,
	path: CloudSyncPath,
	hash: CloudSyncHash,
	sizeBytes: NonNegativeInt,
	updatedAt: IsoDateTime,
	deletedAt: effect.Schema.NullOr(IsoDateTime)
});
/**
* One path where both sides changed to different content.
*
* There is no winner field, and adding one would be a bug. The remote version
* keeps the path so that collaborators in the browser stay consistent with each
* other, and the local divergent version is written beside it at
* `conflictedCopyPath` — never overwritten, never tidied away on a schedule.
*
* `resolvedAt` means a person dealt with it, not that the system picked
* something. It exists so the badge can stop nagging while the row survives for
* anyone asking later what happened to their file.
*/
const CloudSyncConflict = effect.Schema.Struct({
	id: CloudSyncConflictId,
	projectId: ProjectId,
	path: CloudSyncPath,
	conflictedCopyPath: CloudSyncPath,
	detectedAt: IsoDateTime,
	resolvedAt: effect.Schema.NullOr(IsoDateTime)
});
/**
* `not-found` is "this project has no sync", which is what `pause`, `stop` and
* `status.get` hit on a project nobody ever shared. `conflict-not-found` is a
* conflict id that matches nothing, kept separate because the caller's next
* move differs entirely: one means start a sync, the other means the list on
* screen is stale and should be refetched.
*
* `mode-locked` refuses to reinterpret a running sync. Switching `handoff` to
* `mirror` in place would change which copy is canonical underneath a transfer
* already in flight, so the change has to be `stop` and then `start` — two
* calls, and a moment where the UI can say what is about to happen.
*/
var CloudSyncError = class extends effect.Schema.TaggedErrorClass()("CloudSyncError", {
	message: TrimmedNonEmptyString,
	code: effect.Schema.Literals([
		"forbidden",
		"not-found",
		"conflict-not-found",
		"mode-locked",
		"unusable-url",
		"storage"
	]),
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
/**
* Every call carries the tenant and workspace beside the project. The project
* id alone would be enough to find the row and is not enough to prove the
* caller may see it — and this feature moves whole trees between machines, so a
* mis-scoped read is the expensive kind.
*/
const CloudSyncProjectScope = {
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	projectId: ProjectId
};
const CloudSyncStatusGetInput = effect.Schema.Struct(CloudSyncProjectScope);
/**
* `sync` is nullable rather than the call failing with `not-found`. "This
* project has never been synced" is the ordinary first answer for every project
* in the list, and a panel that has to catch an error to render its default
* state will eventually render an error instead.
*/
const CloudSyncStatusResult = effect.Schema.Struct({ sync: effect.Schema.NullOr(ProjectCloudSync) });
/**
* The mode is required and has no default. This is the one question the person
* is asked, the two answers differ in which copy becomes canonical, and a
* default here would answer it on their behalf.
*/
const CloudSyncStartInput = effect.Schema.Struct({
	...CloudSyncProjectScope,
	mode: CloudSyncMode
});
/** The started sync, so the caller renders from the reply rather than refetching. */
const CloudSyncStartResult = effect.Schema.Struct({ sync: ProjectCloudSync });
const CloudSyncPauseInput = effect.Schema.Struct(CloudSyncProjectScope);
const CloudSyncPauseResult = effect.Schema.Struct({ sync: ProjectCloudSync });
const CloudSyncStopInput = effect.Schema.Struct(CloudSyncProjectScope);
/**
* Stopping returns the final row rather than nothing. Both copies survive a
* stop and start diverging from that moment, and the timestamp on this row is
* how the UI can later say when they parted company.
*/
const CloudSyncStopResult = effect.Schema.Struct({ sync: ProjectCloudSync });
const CLOUD_SYNC_CONFLICTS_MAX_LIMIT = 200;
/**
* Two people editing one mirrored project offline pile conflicted copies up, so
* this list is bounded and paged from the start. `afterId` is a keyset cursor
* over the same order the rows come back in, not an offset: an offset re-reads
* everything it skips, and it silently repeats or drops rows when a new
* conflict is detected between two pages — which, in a list of things that are
* appearing right now, is the normal case rather than the edge one.
*/
const CloudSyncConflictListInput = effect.Schema.Struct({
	...CloudSyncProjectScope,
	includeResolved: effect.Schema.optional(effect.Schema.Boolean),
	afterId: effect.Schema.optional(CloudSyncConflictId),
	limit: effect.Schema.optional(PositiveInt.check(effect.Schema.isLessThanOrEqualTo(CLOUD_SYNC_CONFLICTS_MAX_LIMIT)))
});
/**
* `nextCursor` rather than a total. Counting every conflict to render "page 3
* of 40" costs a full scan of a table that only ever grows, and the badge on
* the sync button already has the number that matters — `conflictCount`, which
* the store keeps as a running summary.
*/
const CloudSyncConflictListResult = effect.Schema.Struct({
	conflicts: effect.Schema.Array(CloudSyncConflict),
	nextCursor: effect.Schema.NullOr(CloudSyncConflictId)
});
/**
* No `keep: "local" | "remote"`. Both versions are already on disk by the time
* a conflict is listed, and this call only records that a person has dealt with
* it. Accepting a side here would make the server delete one of two files it
* was asked to preserve, which is the exact failure the whole feature is built
* to avoid.
*/
const CloudSyncConflictResolveInput = effect.Schema.Struct({
	...CloudSyncProjectScope,
	conflictId: CloudSyncConflictId
});
/**
* The resolved conflict and the sync it belongs to, because resolving one
* changes the badge as well as the row, and returning both saves the panel a
* second call it would otherwise make against a count that had already moved.
*/
const CloudSyncConflictResolveResult = effect.Schema.Struct({
	conflict: CloudSyncConflict,
	sync: ProjectCloudSync
});
/**
* "A live copy of this project is reachable at <url>, as of now."
*
* A null `url` is not a no-op and not a mistake: it is the laptop saying "I am
* still here, there is nothing to publish". Sharing must work with no
* `cloudflared` installed and behind an auth policy the tunnel refuses to
* publish, and in both of those cases the sync goes ahead — so the heartbeat has
* to be able to carry the absence of a live copy as easily as its presence.
* Sending null is also how a laptop withdraws an address it is about to stop
* serving.
*/
const CloudSyncLiveCopyRegisterInput = effect.Schema.Struct({
	...CloudSyncProjectScope,
	url: effect.Schema.NullOr(CloudSyncCopyUrl)
});
/**
* The sync comes back with every heartbeat, which is what tells the laptop the
* first pass completed without a second call — and tells it even when the pass
* was finished by something other than the process holding the tunnel.
*/
const CloudSyncLiveCopyRegisterResult = effect.Schema.Struct({
	sync: ProjectCloudSync,
	liveCopy: effect.Schema.NullOr(CloudSyncLiveCopy)
});
const CloudSyncVisitInput = effect.Schema.Struct(CloudSyncProjectScope);
/**
* "This project's canonical copy is at <url>; send anyone who lands here on."
*
* Registered by the laptop *against its own server* once the first pass
* completes, which is the mirror image of the call above and the reason both
* exist. The tunnel published this machine, so this machine is the only one that
* can catch a visitor still sitting on it — and the address it sends them to was
* always the one in their inbox.
*/
const CloudSyncHandoffRegisterInput = effect.Schema.Struct({
	...CloudSyncProjectScope,
	canonicalUrl: CloudSyncCopyUrl
});

//#endregion
//#region ../../packages/contracts/src/keybindings.ts
const MAX_KEYBINDING_VALUE_LENGTH = 64;
const MAX_KEYBINDING_WHEN_LENGTH = 256;
const MAX_SCRIPT_ID_LENGTH = 24;
const MAX_KEYBINDINGS_COUNT = 256;
const THREAD_JUMP_KEYBINDING_COMMANDS = [
	"thread.jump.1",
	"thread.jump.2",
	"thread.jump.3",
	"thread.jump.4",
	"thread.jump.5",
	"thread.jump.6",
	"thread.jump.7",
	"thread.jump.8",
	"thread.jump.9"
];
const THREAD_KEYBINDING_COMMANDS = [
	"thread.previous",
	"thread.next",
	...THREAD_JUMP_KEYBINDING_COMMANDS
];
const STATIC_KEYBINDING_COMMANDS = [
	"terminal.toggle",
	"terminal.split",
	"terminal.new",
	"terminal.close",
	"diff.toggle",
	"projects.toggle",
	"commandPalette.toggle",
	"chat.new",
	"chat.newLocal",
	"editor.openFavorite",
	...THREAD_KEYBINDING_COMMANDS
];
const SCRIPT_RUN_COMMAND_PATTERN = effect.Schema.TemplateLiteral([
	effect.Schema.Literal("script."),
	effect.Schema.NonEmptyString.check(effect.Schema.isMaxLength(MAX_SCRIPT_ID_LENGTH), effect.Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)),
	effect.Schema.Literal(".run")
]);
const KeybindingCommand = effect.Schema.Union([effect.Schema.Literals(STATIC_KEYBINDING_COMMANDS), SCRIPT_RUN_COMMAND_PATTERN]);
const KeybindingValue = TrimmedString.check(effect.Schema.isMinLength(1), effect.Schema.isMaxLength(MAX_KEYBINDING_VALUE_LENGTH));
const KeybindingWhen = TrimmedString.check(effect.Schema.isMinLength(1), effect.Schema.isMaxLength(MAX_KEYBINDING_WHEN_LENGTH));
const KeybindingRule = effect.Schema.Struct({
	key: KeybindingValue,
	command: KeybindingCommand,
	when: effect.Schema.optional(KeybindingWhen)
});
const KeybindingsConfig = effect.Schema.Array(KeybindingRule).check(effect.Schema.isMaxLength(MAX_KEYBINDINGS_COUNT));
const KeybindingShortcut = effect.Schema.Struct({
	key: KeybindingValue,
	metaKey: effect.Schema.Boolean,
	ctrlKey: effect.Schema.Boolean,
	shiftKey: effect.Schema.Boolean,
	altKey: effect.Schema.Boolean,
	modKey: effect.Schema.Boolean
});
const KeybindingWhenNodeRef = effect.Schema.suspend(() => KeybindingWhenNode);
const KeybindingWhenNode = effect.Schema.Union([
	effect.Schema.Struct({
		type: effect.Schema.Literal("identifier"),
		name: effect.Schema.NonEmptyString
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("not"),
		node: KeybindingWhenNodeRef
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("and"),
		left: KeybindingWhenNodeRef,
		right: KeybindingWhenNodeRef
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("or"),
		left: KeybindingWhenNodeRef,
		right: KeybindingWhenNodeRef
	})
]);
const ResolvedKeybindingRule = effect.Schema.Struct({
	command: KeybindingCommand,
	shortcut: KeybindingShortcut,
	whenAst: effect.Schema.optional(KeybindingWhenNode)
}).annotate({ parseOptions: { onExcessProperty: "ignore" } });
const ResolvedKeybindingsConfig = effect.Schema.Array(ResolvedKeybindingRule).check(effect.Schema.isMaxLength(MAX_KEYBINDINGS_COUNT));
var KeybindingsConfigError = class extends effect.Schema.TaggedErrorClass()("KeybindingsConfigParseError", {
	configPath: effect.Schema.String,
	detail: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {
	get message() {
		return `Unable to parse keybindings config at ${this.configPath}: ${this.detail}`;
	}
};

//#endregion
//#region ../../packages/contracts/src/server.ts
const KeybindingsMalformedConfigIssue = effect.Schema.Struct({
	kind: effect.Schema.Literal("keybindings.malformed-config"),
	message: TrimmedNonEmptyString
});
const KeybindingsInvalidEntryIssue = effect.Schema.Struct({
	kind: effect.Schema.Literal("keybindings.invalid-entry"),
	message: TrimmedNonEmptyString,
	index: effect.Schema.Number
});
const ServerConfigIssue = effect.Schema.Union([KeybindingsMalformedConfigIssue, KeybindingsInvalidEntryIssue]);
const ServerConfigIssues = effect.Schema.Array(ServerConfigIssue);
const ServerProviderState = effect.Schema.Literals([
	"ready",
	"warning",
	"error",
	"disabled"
]);
const ServerProviderAuthStatus = effect.Schema.Literals([
	"authenticated",
	"unauthenticated",
	"unknown"
]);
const ServerProviderAuth = effect.Schema.Struct({
	status: ServerProviderAuthStatus,
	type: effect.Schema.optional(TrimmedNonEmptyString),
	label: effect.Schema.optional(TrimmedNonEmptyString)
});
const ServerProviderModel = effect.Schema.Struct({
	slug: TrimmedNonEmptyString,
	name: TrimmedNonEmptyString,
	isCustom: effect.Schema.Boolean,
	capabilities: effect.Schema.NullOr(ModelCapabilities)
});
const ServerProviderSlashCommandInput = effect.Schema.Struct({ hint: TrimmedNonEmptyString });
const ServerProviderSlashCommand = effect.Schema.Struct({
	name: TrimmedNonEmptyString,
	description: effect.Schema.optional(TrimmedNonEmptyString),
	input: effect.Schema.optional(ServerProviderSlashCommandInput)
});
const ServerProviderSkill = effect.Schema.Struct({
	name: TrimmedNonEmptyString,
	description: effect.Schema.optional(TrimmedNonEmptyString),
	path: TrimmedNonEmptyString,
	scope: effect.Schema.optional(TrimmedNonEmptyString),
	enabled: effect.Schema.Boolean,
	displayName: effect.Schema.optional(TrimmedNonEmptyString),
	shortDescription: effect.Schema.optional(TrimmedNonEmptyString)
});
const ServerProvider = effect.Schema.Struct({
	provider: ProviderKind,
	enabled: effect.Schema.Boolean,
	installed: effect.Schema.Boolean,
	version: effect.Schema.NullOr(TrimmedNonEmptyString),
	status: ServerProviderState,
	auth: ServerProviderAuth,
	checkedAt: IsoDateTime,
	message: effect.Schema.optional(TrimmedNonEmptyString),
	models: effect.Schema.Array(ServerProviderModel),
	slashCommands: effect.Schema.Array(ServerProviderSlashCommand).pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed([]))),
	skills: effect.Schema.Array(ServerProviderSkill).pipe(effect.Schema.withDecodingDefault(effect.Effect.succeed([])))
});
const ServerProviders = effect.Schema.Array(ServerProvider);
const ServerObservability = effect.Schema.Struct({
	logsDirectoryPath: TrimmedNonEmptyString,
	localTracingEnabled: effect.Schema.Boolean,
	otlpTracesUrl: effect.Schema.optional(TrimmedNonEmptyString),
	otlpTracesEnabled: effect.Schema.Boolean,
	otlpMetricsUrl: effect.Schema.optional(TrimmedNonEmptyString),
	otlpMetricsEnabled: effect.Schema.Boolean
});
const ServerConfig = effect.Schema.Struct({
	environment: ExecutionEnvironmentDescriptor,
	auth: ServerAuthDescriptor,
	cwd: TrimmedNonEmptyString,
	keybindingsConfigPath: TrimmedNonEmptyString,
	keybindings: ResolvedKeybindingsConfig,
	issues: ServerConfigIssues,
	providers: ServerProviders,
	availableEditors: effect.Schema.Array(EditorId),
	observability: ServerObservability,
	settings: ServerSettings
});
const ServerUpsertKeybindingInput = KeybindingRule;
const ServerUpsertKeybindingResult = effect.Schema.Struct({
	keybindings: ResolvedKeybindingsConfig,
	issues: ServerConfigIssues
});
const ServerConfigUpdatedPayload = effect.Schema.Struct({
	issues: ServerConfigIssues,
	providers: ServerProviders,
	settings: effect.Schema.optional(ServerSettings)
});
const ServerConfigKeybindingsUpdatedPayload = effect.Schema.Struct({ issues: ServerConfigIssues });
const ServerConfigProviderStatusesPayload = effect.Schema.Struct({ providers: ServerProviders });
const ServerConfigSettingsUpdatedPayload = effect.Schema.Struct({ settings: ServerSettings });
const ServerConfigStreamSnapshotEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	type: effect.Schema.Literal("snapshot"),
	config: ServerConfig
});
const ServerConfigStreamKeybindingsUpdatedEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	type: effect.Schema.Literal("keybindingsUpdated"),
	payload: ServerConfigKeybindingsUpdatedPayload
});
const ServerConfigStreamProviderStatusesEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	type: effect.Schema.Literal("providerStatuses"),
	payload: ServerConfigProviderStatusesPayload
});
const ServerConfigStreamSettingsUpdatedEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	type: effect.Schema.Literal("settingsUpdated"),
	payload: ServerConfigSettingsUpdatedPayload
});
const ServerConfigStreamEvent = effect.Schema.Union([
	ServerConfigStreamSnapshotEvent,
	ServerConfigStreamKeybindingsUpdatedEvent,
	ServerConfigStreamProviderStatusesEvent,
	ServerConfigStreamSettingsUpdatedEvent
]);
const ServerLifecycleReadyPayload = effect.Schema.Struct({
	at: IsoDateTime,
	environment: ExecutionEnvironmentDescriptor
});
const ServerLifecycleWelcomePayload = effect.Schema.Struct({
	environment: ExecutionEnvironmentDescriptor,
	cwd: TrimmedNonEmptyString,
	projectName: TrimmedNonEmptyString,
	bootstrapProjectId: effect.Schema.optional(ProjectId),
	bootstrapThreadId: effect.Schema.optional(ThreadId)
});
const ServerLifecycleStreamWelcomeEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	sequence: NonNegativeInt,
	type: effect.Schema.Literal("welcome"),
	payload: ServerLifecycleWelcomePayload
});
const ServerLifecycleStreamReadyEvent = effect.Schema.Struct({
	version: effect.Schema.Literal(1),
	sequence: NonNegativeInt,
	type: effect.Schema.Literal("ready"),
	payload: ServerLifecycleReadyPayload
});
const ServerLifecycleStreamEvent = effect.Schema.Union([ServerLifecycleStreamWelcomeEvent, ServerLifecycleStreamReadyEvent]);
const ServerProviderUpdatedPayload = effect.Schema.Struct({ providers: ServerProviders });

//#endregion
//#region ../../packages/contracts/src/git.ts
const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const GIT_LIST_BRANCHES_MAX_LIMIT = 200;
const GitStackedAction = effect.Schema.Literals([
	"commit",
	"push",
	"create_pr",
	"commit_push",
	"commit_push_pr"
]);
const GitActionProgressPhase = effect.Schema.Literals([
	"branch",
	"commit",
	"push",
	"pr"
]);
const GitActionProgressKind = effect.Schema.Literals([
	"action_started",
	"phase_started",
	"hook_started",
	"hook_output",
	"hook_finished",
	"action_finished",
	"action_failed"
]);
const GitActionProgressStream = effect.Schema.Literals(["stdout", "stderr"]);
const GitCommitStepStatus = effect.Schema.Literals([
	"created",
	"skipped_no_changes",
	"skipped_not_requested"
]);
const GitPushStepStatus = effect.Schema.Literals([
	"pushed",
	"skipped_not_requested",
	"skipped_up_to_date"
]);
const GitBranchStepStatus = effect.Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = effect.Schema.Literals([
	"created",
	"opened_existing",
	"skipped_not_requested"
]);
const GitStatusPrState = effect.Schema.Literals([
	"open",
	"closed",
	"merged"
]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = effect.Schema.Literals([
	"open",
	"closed",
	"merged"
]);
const GitPreparePullRequestThreadMode = effect.Schema.Literals(["local", "worktree"]);
const GitHostingProviderKind = effect.Schema.Literals([
	"github",
	"gitlab",
	"unknown"
]);
const GitHostingProvider = effect.Schema.Struct({
	kind: GitHostingProviderKind,
	name: TrimmedNonEmptyStringSchema,
	baseUrl: effect.Schema.String
});
const GitRunStackedActionToastRunAction = effect.Schema.Struct({ kind: GitStackedAction });
const GitRunStackedActionToastCta = effect.Schema.Union([
	effect.Schema.Struct({ kind: effect.Schema.Literal("none") }),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("open_pr"),
		label: TrimmedNonEmptyStringSchema,
		url: effect.Schema.String
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("run_action"),
		label: TrimmedNonEmptyStringSchema,
		action: GitRunStackedActionToastRunAction
	})
]);
const GitRunStackedActionToast = effect.Schema.Struct({
	title: TrimmedNonEmptyStringSchema,
	description: effect.Schema.optional(TrimmedNonEmptyStringSchema),
	cta: GitRunStackedActionToastCta
});
const GitBranch = effect.Schema.Struct({
	name: TrimmedNonEmptyStringSchema,
	isRemote: effect.Schema.optional(effect.Schema.Boolean),
	remoteName: effect.Schema.optional(TrimmedNonEmptyStringSchema),
	current: effect.Schema.Boolean,
	isDefault: effect.Schema.Boolean,
	worktreePath: TrimmedNonEmptyStringSchema.pipe(effect.Schema.NullOr)
});
const GitWorktree = effect.Schema.Struct({
	path: TrimmedNonEmptyStringSchema,
	branch: TrimmedNonEmptyStringSchema
});
const GitResolvedPullRequest = effect.Schema.Struct({
	number: PositiveInt,
	title: TrimmedNonEmptyStringSchema,
	url: effect.Schema.String,
	baseBranch: TrimmedNonEmptyStringSchema,
	headBranch: TrimmedNonEmptyStringSchema,
	state: GitPullRequestState
});
const GitStatusInput = effect.Schema.Struct({ cwd: TrimmedNonEmptyStringSchema });
const GitGetWorkingTreeDiffInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyStringSchema,
	relativePath: TrimmedNonEmptyStringSchema
});
const GitPullInput = effect.Schema.Struct({ cwd: TrimmedNonEmptyStringSchema });
const GitRunStackedActionInput = effect.Schema.Struct({
	actionId: TrimmedNonEmptyStringSchema,
	cwd: TrimmedNonEmptyStringSchema,
	action: GitStackedAction,
	commitMessage: effect.Schema.optional(TrimmedNonEmptyStringSchema.check(effect.Schema.isMaxLength(1e4))),
	featureBranch: effect.Schema.optional(effect.Schema.Boolean),
	filePaths: effect.Schema.optional(effect.Schema.Array(TrimmedNonEmptyStringSchema).check(effect.Schema.isMinLength(1)))
});
const GitListBranchesInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyStringSchema,
	query: effect.Schema.optional(TrimmedNonEmptyStringSchema.check(effect.Schema.isMaxLength(256))),
	cursor: effect.Schema.optional(NonNegativeInt),
	limit: effect.Schema.optional(PositiveInt.check(effect.Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)))
});
const GitCreateWorktreeInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyStringSchema,
	branch: TrimmedNonEmptyStringSchema,
	newBranch: effect.Schema.optional(TrimmedNonEmptyStringSchema),
	path: effect.Schema.NullOr(TrimmedNonEmptyStringSchema)
});
const GitPullRequestRefInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyStringSchema,
	reference: GitPullRequestReference
});
const GitPreparePullRequestThreadInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyStringSchema,
	reference: GitPullRequestReference,
	mode: GitPreparePullRequestThreadMode,
	threadId: effect.Schema.optional(ThreadId)
});
const GitRemoveWorktreeInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyStringSchema,
	path: TrimmedNonEmptyStringSchema,
	force: effect.Schema.optional(effect.Schema.Boolean)
});
const GitCreateBranchInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyStringSchema,
	branch: TrimmedNonEmptyStringSchema,
	checkout: effect.Schema.optional(effect.Schema.Boolean)
});
const GitCreateBranchResult = effect.Schema.Struct({ branch: TrimmedNonEmptyStringSchema });
const GitCheckoutInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyStringSchema,
	branch: TrimmedNonEmptyStringSchema
});
const GitInitInput = effect.Schema.Struct({ cwd: TrimmedNonEmptyStringSchema });
const GitMergeMode = effect.Schema.Literals(["merge", "rebase"]);
const GitMergeBranchInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyStringSchema,
	branch: TrimmedNonEmptyStringSchema,
	mode: effect.Schema.optional(GitMergeMode)
});
const GitMergeBranchResult = effect.Schema.Struct({
	status: effect.Schema.Literals([
		"completed",
		"up-to-date",
		"conflicts"
	]),
	mode: GitMergeMode,
	branch: TrimmedNonEmptyStringSchema,
	conflictPaths: effect.Schema.Array(TrimmedNonEmptyStringSchema)
});
const GitCompareBranchesInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyStringSchema,
	baseBranch: TrimmedNonEmptyStringSchema,
	headBranch: TrimmedNonEmptyStringSchema
});
const GitMergeStateInput = effect.Schema.Struct({ cwd: TrimmedNonEmptyStringSchema });
const GitMergeStateResult = effect.Schema.Struct({
	inProgress: effect.Schema.NullOr(GitMergeMode),
	conflictPaths: effect.Schema.Array(TrimmedNonEmptyStringSchema)
});
const GitAbortMergeInput = effect.Schema.Struct({ cwd: TrimmedNonEmptyStringSchema });
const GitAbortMergeResult = effect.Schema.Struct({ aborted: effect.Schema.Boolean });
const GitStatusPr = effect.Schema.Struct({
	number: PositiveInt,
	title: TrimmedNonEmptyStringSchema,
	url: effect.Schema.String,
	baseBranch: TrimmedNonEmptyStringSchema,
	headBranch: TrimmedNonEmptyStringSchema,
	state: GitStatusPrState
});
const GitWorkingTreeFileStatus = effect.Schema.Literals([
	"modified",
	"added",
	"deleted",
	"renamed",
	"untracked"
]);
const GitWorkingTreeFile = effect.Schema.Struct({
	path: TrimmedNonEmptyStringSchema,
	status: GitWorkingTreeFileStatus,
	insertions: NonNegativeInt,
	deletions: NonNegativeInt
});
const GitCompareBranchesResult = effect.Schema.Struct({
	baseBranch: TrimmedNonEmptyStringSchema,
	headBranch: TrimmedNonEmptyStringSchema,
	aheadCount: NonNegativeInt,
	behindCount: NonNegativeInt,
	files: effect.Schema.Array(GitWorkingTreeFile),
	insertions: NonNegativeInt,
	deletions: NonNegativeInt,
	overlappingPaths: effect.Schema.Array(TrimmedNonEmptyStringSchema)
});
const GitStatusLocalShape = {
	isRepo: effect.Schema.Boolean,
	hostingProvider: effect.Schema.optional(GitHostingProvider),
	hasOriginRemote: effect.Schema.Boolean,
	isDefaultBranch: effect.Schema.Boolean,
	branch: effect.Schema.NullOr(TrimmedNonEmptyStringSchema),
	hasWorkingTreeChanges: effect.Schema.Boolean,
	workingTree: effect.Schema.Struct({
		files: effect.Schema.Array(GitWorkingTreeFile),
		insertions: NonNegativeInt,
		deletions: NonNegativeInt
	})
};
const GitStatusRemoteShape = {
	hasUpstream: effect.Schema.Boolean,
	aheadCount: NonNegativeInt,
	behindCount: NonNegativeInt,
	pr: effect.Schema.NullOr(GitStatusPr)
};
const GitStatusLocalResult = effect.Schema.Struct(GitStatusLocalShape);
const GitStatusRemoteResult = effect.Schema.Struct(GitStatusRemoteShape);
const GitStatusResult = effect.Schema.Struct({
	...GitStatusLocalShape,
	...GitStatusRemoteShape
});
const GitGetWorkingTreeDiffResult = effect.Schema.Struct({ diff: effect.Schema.String });
const GitStatusStreamEvent = effect.Schema.Union([
	effect.Schema.TaggedStruct("snapshot", {
		local: GitStatusLocalResult,
		remote: effect.Schema.NullOr(GitStatusRemoteResult)
	}),
	effect.Schema.TaggedStruct("localUpdated", { local: GitStatusLocalResult }),
	effect.Schema.TaggedStruct("remoteUpdated", { remote: effect.Schema.NullOr(GitStatusRemoteResult) })
]);
const GitListBranchesResult = effect.Schema.Struct({
	branches: effect.Schema.Array(GitBranch),
	isRepo: effect.Schema.Boolean,
	hasOriginRemote: effect.Schema.Boolean,
	nextCursor: NonNegativeInt.pipe(effect.Schema.NullOr),
	totalCount: NonNegativeInt
});
const GitCreateWorktreeResult = effect.Schema.Struct({ worktree: GitWorktree });
const GitResolvePullRequestResult = effect.Schema.Struct({ pullRequest: GitResolvedPullRequest });
const GitPreparePullRequestThreadResult = effect.Schema.Struct({
	pullRequest: GitResolvedPullRequest,
	branch: TrimmedNonEmptyStringSchema,
	worktreePath: TrimmedNonEmptyStringSchema.pipe(effect.Schema.NullOr)
});
const GitCheckoutResult = effect.Schema.Struct({ branch: effect.Schema.NullOr(TrimmedNonEmptyStringSchema) });
const GitRunStackedActionResult = effect.Schema.Struct({
	action: GitStackedAction,
	branch: effect.Schema.Struct({
		status: GitBranchStepStatus,
		name: effect.Schema.optional(TrimmedNonEmptyStringSchema)
	}),
	commit: effect.Schema.Struct({
		status: GitCommitStepStatus,
		commitSha: effect.Schema.optional(TrimmedNonEmptyStringSchema),
		subject: effect.Schema.optional(TrimmedNonEmptyStringSchema)
	}),
	push: effect.Schema.Struct({
		status: GitPushStepStatus,
		branch: effect.Schema.optional(TrimmedNonEmptyStringSchema),
		upstreamBranch: effect.Schema.optional(TrimmedNonEmptyStringSchema),
		setUpstream: effect.Schema.optional(effect.Schema.Boolean)
	}),
	pr: effect.Schema.Struct({
		status: GitPrStepStatus,
		url: effect.Schema.optional(effect.Schema.String),
		number: effect.Schema.optional(PositiveInt),
		baseBranch: effect.Schema.optional(TrimmedNonEmptyStringSchema),
		headBranch: effect.Schema.optional(TrimmedNonEmptyStringSchema),
		title: effect.Schema.optional(TrimmedNonEmptyStringSchema)
	}),
	toast: GitRunStackedActionToast
});
const GitPullResult = effect.Schema.Struct({
	status: effect.Schema.Literals(["pulled", "skipped_up_to_date"]),
	branch: TrimmedNonEmptyStringSchema,
	upstreamBranch: TrimmedNonEmptyStringSchema.pipe(effect.Schema.NullOr)
});
var GitCommandError = class extends effect.Schema.TaggedErrorClass()("GitCommandError", {
	operation: effect.Schema.String,
	command: effect.Schema.String,
	cwd: effect.Schema.String,
	detail: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {
	get message() {
		return `Git command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
	}
};
var GitHubCliError = class extends effect.Schema.TaggedErrorClass()("GitHubCliError", {
	operation: effect.Schema.String,
	detail: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {
	get message() {
		return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
	}
};
var TextGenerationError = class extends effect.Schema.TaggedErrorClass()("TextGenerationError", {
	operation: effect.Schema.String,
	detail: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {
	get message() {
		return `Text generation failed in ${this.operation}: ${this.detail}`;
	}
};
var GitManagerError = class extends effect.Schema.TaggedErrorClass()("GitManagerError", {
	operation: effect.Schema.String,
	detail: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {
	get message() {
		return `Git manager failed in ${this.operation}: ${this.detail}`;
	}
};
const GitManagerServiceError = effect.Schema.Union([
	GitManagerError,
	GitCommandError,
	GitHubCliError,
	TextGenerationError
]);
const GitActionProgressBase = effect.Schema.Struct({
	actionId: TrimmedNonEmptyStringSchema,
	cwd: TrimmedNonEmptyStringSchema,
	action: GitStackedAction
});
const GitActionStartedEvent = effect.Schema.Struct({
	...GitActionProgressBase.fields,
	kind: effect.Schema.Literal("action_started"),
	phases: effect.Schema.Array(GitActionProgressPhase)
});
const GitActionPhaseStartedEvent = effect.Schema.Struct({
	...GitActionProgressBase.fields,
	kind: effect.Schema.Literal("phase_started"),
	phase: GitActionProgressPhase,
	label: TrimmedNonEmptyStringSchema
});
const GitActionHookStartedEvent = effect.Schema.Struct({
	...GitActionProgressBase.fields,
	kind: effect.Schema.Literal("hook_started"),
	hookName: TrimmedNonEmptyStringSchema
});
const GitActionHookOutputEvent = effect.Schema.Struct({
	...GitActionProgressBase.fields,
	kind: effect.Schema.Literal("hook_output"),
	hookName: effect.Schema.NullOr(TrimmedNonEmptyStringSchema),
	stream: GitActionProgressStream,
	text: TrimmedNonEmptyStringSchema
});
const GitActionHookFinishedEvent = effect.Schema.Struct({
	...GitActionProgressBase.fields,
	kind: effect.Schema.Literal("hook_finished"),
	hookName: TrimmedNonEmptyStringSchema,
	exitCode: effect.Schema.NullOr(effect.Schema.Int),
	durationMs: effect.Schema.NullOr(NonNegativeInt)
});
const GitActionFinishedEvent = effect.Schema.Struct({
	...GitActionProgressBase.fields,
	kind: effect.Schema.Literal("action_finished"),
	result: GitRunStackedActionResult
});
const GitActionFailedEvent = effect.Schema.Struct({
	...GitActionProgressBase.fields,
	kind: effect.Schema.Literal("action_failed"),
	phase: effect.Schema.NullOr(GitActionProgressPhase),
	message: TrimmedNonEmptyStringSchema
});
const GitActionProgressEvent = effect.Schema.Union([
	GitActionStartedEvent,
	GitActionPhaseStartedEvent,
	GitActionHookStartedEvent,
	GitActionHookOutputEvent,
	GitActionHookFinishedEvent,
	GitActionFinishedEvent,
	GitActionFailedEvent
]);

//#endregion
//#region ../../packages/contracts/src/productEvents.ts
const ProductEventSource = effect.Schema.Literals([
	"web",
	"server",
	"provider-runtime",
	"billing",
	"collaboration",
	"system"
]);
const ProductEventVisibility = effect.Schema.Literals([
	"internal",
	"tenant",
	"organization"
]);
const ProductEventActor = effect.Schema.Union([
	effect.Schema.Struct({
		type: effect.Schema.Literal("user"),
		userId: UserId
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("system"),
		name: TrimmedNonEmptyString
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("provider"),
		provider: ProviderKind
	})
]);
const ProductEventContext = effect.Schema.Struct({
	tenantId: TenantId,
	organizationId: effect.Schema.NullOr(OrganizationId),
	workspaceId: effect.Schema.NullOr(WorkspaceId),
	projectId: effect.Schema.NullOr(ProjectId),
	threadId: effect.Schema.NullOr(ThreadId),
	turnId: effect.Schema.NullOr(TurnId),
	messageId: effect.Schema.NullOr(MessageId),
	providerAccountId: effect.Schema.NullOr(ProviderAccountId),
	providerSessionId: effect.Schema.NullOr(ProviderSessionId)
});
const ProductEventRetention = effect.Schema.Struct({
	analyticsTtlDays: NonNegativeInt,
	auditTtlDays: NonNegativeInt,
	containsPromptText: effect.Schema.Boolean,
	containsResponseText: effect.Schema.Boolean,
	containsSecretMaterial: effect.Schema.Boolean,
	redaction: effect.Schema.Literals([
		"none",
		"hashed-content",
		"metadata-only"
	])
});
const ProductPromptEventPayload = effect.Schema.Struct({
	kind: effect.Schema.Literal("prompt.submitted"),
	provider: ProviderKind,
	model: TrimmedNonEmptyString,
	interactionMode: effect.Schema.Literals(["default", "plan"]),
	attachmentCount: NonNegativeInt,
	promptCharacters: NonNegativeInt
});
const ProductResponseEventPayload = effect.Schema.Struct({
	kind: effect.Schema.Literals([
		"response.started",
		"response.completed",
		"response.failed"
	]),
	provider: ProviderKind,
	model: TrimmedNonEmptyString,
	durationMs: NonNegativeInt,
	errorClass: effect.Schema.optional(TrimmedNonEmptyString)
});
const ProductTokenUsageEventPayload = effect.Schema.Struct({
	kind: effect.Schema.Literal("token_usage.recorded"),
	provider: ProviderKind,
	model: TrimmedNonEmptyString,
	inputTokens: NonNegativeInt,
	outputTokens: NonNegativeInt,
	reasoningTokens: NonNegativeInt,
	cachedInputTokens: NonNegativeInt,
	totalTokens: NonNegativeInt
});
const ProductCreditEventPayload = effect.Schema.Struct({
	kind: effect.Schema.Literals([
		"credits.reserved",
		"credits.consumed",
		"credits.refunded"
	]),
	creditAmount: NonNegativeInt,
	currency: TrimmedNonEmptyString,
	billingAccountId: effect.Schema.NullOr(TrimmedNonEmptyString),
	reason: TrimmedNonEmptyString
});
const ProductCollaborationEventPayload = effect.Schema.Struct({
	kind: effect.Schema.Literals([
		"collaboration.joined",
		"collaboration.left",
		"collaboration.invited",
		"collaboration.invite_accepted",
		"collaboration.message_sent"
	]),
	participantUserId: UserId,
	inviteId: effect.Schema.optional(TrimmedNonEmptyString),
	messageCharacters: effect.Schema.optional(NonNegativeInt)
});
const ProductWorkflowEventPayload = effect.Schema.Struct({
	kind: effect.Schema.Literals([
		"workflow.task_assigned",
		"workflow.delivery_created",
		"workflow.delivery_accepted",
		"workflow.delivery_rejected"
	]),
	workflowId: TrimmedNonEmptyString,
	assigneeUserId: effect.Schema.NullOr(UserId),
	status: TrimmedNonEmptyString
});
const ProductMessageEventPayload = effect.Schema.Struct({
	kind: effect.Schema.Literals([
		"message.created",
		"message.edited",
		"message.redacted"
	]),
	role: effect.Schema.Literals([
		"user",
		"assistant",
		"system"
	]),
	messageCharacters: NonNegativeInt
});
const ProductEventPayload = effect.Schema.Union([
	ProductPromptEventPayload,
	ProductResponseEventPayload,
	ProductTokenUsageEventPayload,
	ProductCreditEventPayload,
	ProductCollaborationEventPayload,
	ProductWorkflowEventPayload,
	ProductMessageEventPayload
]);
const ProductEvent = effect.Schema.Struct({
	id: ProductEventId,
	occurredAt: TrimmedNonEmptyString,
	receivedAt: TrimmedNonEmptyString,
	source: ProductEventSource,
	visibility: ProductEventVisibility,
	actor: ProductEventActor,
	context: ProductEventContext,
	retention: ProductEventRetention,
	payload: ProductEventPayload
});

//#endregion
//#region ../../packages/contracts/src/project.ts
const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const ProjectRelativePath = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(512));
const ProjectFileEncoding = effect.Schema.Literals(["utf-8", "base64"]);
const ProjectSearchEntriesInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyString,
	query: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(256)),
	limit: PositiveInt.check(effect.Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT))
});
const ProjectEntryKind = effect.Schema.Literals(["file", "directory"]);
const ProjectEntry = effect.Schema.Struct({
	path: TrimmedNonEmptyString,
	kind: ProjectEntryKind,
	parentPath: effect.Schema.optional(TrimmedNonEmptyString)
});
const ProjectSearchEntriesResult = effect.Schema.Struct({
	entries: effect.Schema.Array(ProjectEntry),
	truncated: effect.Schema.Boolean
});
var ProjectSearchEntriesError = class extends effect.Schema.TaggedErrorClass()("ProjectSearchEntriesError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
const ProjectListDirectoryInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyString,
	directoryPath: effect.Schema.optional(ProjectRelativePath)
});
const ProjectDirectoryEntry = effect.Schema.Struct({
	name: TrimmedNonEmptyString,
	path: ProjectRelativePath,
	kind: ProjectEntryKind
});
const ProjectListDirectoryResult = effect.Schema.Struct({
	directoryPath: effect.Schema.optional(ProjectRelativePath),
	entries: effect.Schema.Array(ProjectDirectoryEntry)
});
var ProjectListDirectoryError = class extends effect.Schema.TaggedErrorClass()("ProjectListDirectoryError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
const ProjectReadFileInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyString,
	relativePath: ProjectRelativePath
});
const ProjectReadFileResult = effect.Schema.Struct({
	relativePath: ProjectRelativePath,
	contents: effect.Schema.String,
	isBinary: effect.Schema.Boolean,
	tooLarge: effect.Schema.Boolean,
	sizeBytes: NonNegativeInt
});
var ProjectReadFileError = class extends effect.Schema.TaggedErrorClass()("ProjectReadFileError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
const ProjectWriteFileInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyString,
	relativePath: ProjectRelativePath,
	contents: effect.Schema.String,
	encoding: effect.Schema.optional(ProjectFileEncoding)
});
const ProjectWriteFileResult = effect.Schema.Struct({ relativePath: ProjectRelativePath });
var ProjectWriteFileError = class extends effect.Schema.TaggedErrorClass()("ProjectWriteFileError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};
const ProjectCreateEntryInput = effect.Schema.Struct({
	cwd: TrimmedNonEmptyString,
	relativePath: ProjectRelativePath,
	kind: ProjectEntryKind
});
const ProjectCreateEntryResult = effect.Schema.Struct({
	relativePath: ProjectRelativePath,
	kind: ProjectEntryKind
});
var ProjectCreateEntryError = class extends effect.Schema.TaggedErrorClass()("ProjectCreateEntryError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};

//#endregion
//#region ../../packages/contracts/src/filesystem.ts
const FILESYSTEM_PATH_MAX_LENGTH = 512;
const FilesystemBrowseInput = effect.Schema.Struct({
	partialPath: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
	cwd: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)))
});
const FilesystemBrowseEntry = effect.Schema.Struct({
	name: TrimmedNonEmptyString,
	fullPath: TrimmedNonEmptyString
});
const FilesystemBrowseResult = effect.Schema.Struct({
	parentPath: TrimmedNonEmptyString,
	entries: effect.Schema.Array(FilesystemBrowseEntry)
});
var FilesystemBrowseError = class extends effect.Schema.TaggedErrorClass()("FilesystemBrowseError", {
	message: TrimmedNonEmptyString,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};

//#endregion
//#region ../../packages/contracts/src/analytics.ts
/**
* Product analytics for what a project deploys.
*
* This is not the telemetry T3 Code emits about itself. It is the surface a
* deployed thing reports to: a web app recording page views, a PDF recording
* how far somebody read, a TUI recording which command was run. A deployment
* posts events; the workspace asks questions of them.
*
* Two ideas carry the whole contract:
*
* - An **event stream** is declared before it is used, so a chart can be drawn
*   from the declaration rather than guessed from whatever arrived first. The
*   declaration is what an agent reads to know which questions are answerable.
* - **Properties are typed and named up front.** An event whose shape drifts
*   silently is worse than no event, because every chart over it keeps drawing.
*
* @module analytics
*/
const AnalyticsStreamId = effect.Schema.String.pipe(effect.Schema.brand("AnalyticsStreamId"));
const AnalyticsEventId = effect.Schema.String.pipe(effect.Schema.brand("AnalyticsEventId"));
/**
* A slug the deployment sends and a chart refers to. Constrained because it
* ends up in URLs, in generated code and in chart titles.
*/
const AnalyticsName = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(64), effect.Schema.isPattern(/^[a-z][a-z0-9_.-]*$/));
/**
* What a property holds. Deliberately small: these are the types a chart can
* do something with, and anything richer belongs in its own event.
*/
const AnalyticsPropertyType = effect.Schema.Literals([
	"string",
	"number",
	"boolean"
]);
const AnalyticsProperty = effect.Schema.Struct({
	name: AnalyticsName,
	type: AnalyticsPropertyType,
	purpose: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(240)),
	required: effect.Schema.Boolean
});
/**
* A declared event stream. `ingestKeyName` names a secret rather than carrying
* one: the key lets a deployment write, so it must never travel in a
* projection or sit in a manifest.
*/
const AnalyticsStream = effect.Schema.Struct({
	id: AnalyticsStreamId,
	projectId: ProjectId,
	name: AnalyticsName,
	purpose: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(240)),
	properties: effect.Schema.Array(AnalyticsProperty),
	ingestKeyName: TrimmedNonEmptyString,
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime,
	archivedAt: effect.Schema.NullOr(IsoDateTime)
});
/** A property value as it arrives from a deployment. */
const AnalyticsValue = effect.Schema.Union([
	effect.Schema.String,
	effect.Schema.Number,
	effect.Schema.Boolean
]);
const AnalyticsEvent = effect.Schema.Struct({
	id: AnalyticsEventId,
	streamId: AnalyticsStreamId,
	projectId: ProjectId,
	occurredAt: IsoDateTime,
	receivedAt: IsoDateTime,
	properties: effect.Schema.Record(effect.Schema.String, AnalyticsValue)
});
const AnalyticsDeclareStreamInput = effect.Schema.Struct({
	projectId: ProjectId,
	name: AnalyticsName,
	purpose: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(240)),
	properties: effect.Schema.Array(AnalyticsProperty)
});
const AnalyticsDeclareStreamResult = effect.Schema.Struct({
	stream: AnalyticsStream,
	ingestKey: TrimmedNonEmptyString
});
const AnalyticsListStreamsInput = effect.Schema.Struct({ projectId: effect.Schema.optional(ProjectId) });
const AnalyticsListStreamsResult = effect.Schema.Struct({ streams: effect.Schema.Array(AnalyticsStream) });
/**
* What a deployment posts. The stream is named rather than referenced by id so
* the deployed code carries something a person can read, and the key proves it
* may write to that project's streams.
*/
const AnalyticsRecordInput = effect.Schema.Struct({
	stream: AnalyticsName,
	ingestKey: TrimmedNonEmptyString,
	occurredAt: effect.Schema.optional(IsoDateTime),
	properties: effect.Schema.Record(effect.Schema.String, AnalyticsValue)
});
const AnalyticsRecordResult = effect.Schema.Struct({ eventId: AnalyticsEventId });
/**
* How the numbers are rolled up. `count` needs no property; the rest are only
* meaningful over a numeric one, which the service checks against the
* declaration rather than trusting the caller.
*/
const AnalyticsAggregate = effect.Schema.Literals([
	"count",
	"sum",
	"avg",
	"min",
	"max"
]);
const AnalyticsQueryInput = effect.Schema.Struct({
	projectId: ProjectId,
	stream: AnalyticsName,
	aggregate: AnalyticsAggregate,
	valueProperty: effect.Schema.optional(AnalyticsName),
	groupBy: effect.Schema.optional(AnalyticsName),
	since: effect.Schema.optional(IsoDateTime),
	until: effect.Schema.optional(IsoDateTime),
	limit: effect.Schema.optional(NonNegativeInt)
});
const AnalyticsQueryBucket = effect.Schema.Struct({
	group: effect.Schema.NullOr(effect.Schema.String),
	value: effect.Schema.Number,
	events: NonNegativeInt
});
const AnalyticsQueryResult = effect.Schema.Struct({
	stream: AnalyticsName,
	aggregate: AnalyticsAggregate,
	buckets: effect.Schema.Array(AnalyticsQueryBucket)
});
const AnalyticsErrorCode = effect.Schema.Literals([
	"stream-not-found",
	"stream-already-declared",
	"invalid-key",
	"invalid-properties",
	"invalid-query",
	"storage-failed"
]);
var AnalyticsError = class extends effect.Schema.TaggedErrorClass()("AnalyticsError", {
	code: AnalyticsErrorCode,
	message: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};

//#endregion
//#region ../../packages/contracts/src/pack.ts
/**
* Pack format contracts.
*
* A pack is a workspace turned into something a stranger can install: the code,
* the notes the agent wrote on its way out, a declaration of everything the
* consumer has to supply before it will run — and the part that decides whether
* any of it is worth installing, which is what the thing has already been
* caught getting wrong in production.
*
* The sections that describe shape — identity, requirements, interfaces,
* runtime, permissions — are the carrier. `knowledge` and `verification` are
* the product: a manifest that declares a perfect interface with nothing
* learned behind it describes a template, and a template is something the
* consuming agent could have generated itself. So those two sections are
* required even when empty, and everything in them is shaped to be written by a
* machine watching a deployment rather than by an author volunteering notes.
*
* Every downstream surface reads this manifest: the CLI writes it, the
* marketplace indexes and ranks it, pack mode searches it, the maintenance
* agent appends to it, and the deploy dashboard charts what it declares. That
* makes the format the load-bearing contract rather than one schema among many,
* so it carries a `formatVersion` and prefers tagged unions over loose optional
* fields wherever an illegal combination would otherwise be representable.
*
* See `docs/pack-format.md` for the prose specification and a worked example.
*
* @module pack
*/
/**
* Bumped only when a reader written against the previous version could
* misinterpret a manifest. Consumers read this field before decoding anything
* else so an unsupported pack fails with "too new" rather than a field error.
*
* `2.0` exists because `verification` carries a different meaning rather than a
* different shape: in `1.0` it was a reviewer's badge, and a `1.0` reader handed
* a `2.0` manifest would read a section about production behaviour as a review
* decision. That is exactly the silent misread the bump rule is for.
*/
const PackFormatVersion = effect.Schema.Literals(["2.0"]);
const PACK_NAME_MAX_LENGTH = 64;
const PACK_SUMMARY_MAX_LENGTH = 200;
const PACK_DESCRIPTION_MAX_LENGTH = 2e4;
const PACK_PURPOSE_MAX_LENGTH = 500;
const PACK_COMMAND_MAX_LENGTH = 4e3;
const PACK_RELATIVE_PATH_MAX_LENGTH = 512;
const PACK_INTEGRATION_PROMPT_MAX_LENGTH = 8e3;
const PACK_KNOWLEDGE_TEXT_MAX_LENGTH = 4e3;
const PACK_CONDITION_VALUE_MAX_LENGTH = 64;
const PACK_MAX_PORT = 65535;
/**
* A lowercase slug, used for every name a human types or a URL carries. The
* single character case exists because short identifiers like `id` are common
* inside operation and service names.
*/
const PackSlug = TrimmedNonEmptyString.check(effect.Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/), effect.Schema.isMaxLength(PACK_NAME_MAX_LENGTH));
/** The name a person types. Unique per publisher, not globally. */
const PackName = PackSlug;
/** The publisher's public handle, the half of identity that appears in URLs. */
const PackHandle = PackSlug;
/**
* Strict semantic version. Ranges are deliberately a separate type: a release
* is always one exact point, and only dependencies get to be fuzzy.
*/
const PackVersion = TrimmedNonEmptyString.check(effect.Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/));
/** npm-style range syntax, resolved by the installer rather than the format. */
const PackVersionRange = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(64));
/**
* Paths never escape the pack directory, so a reviewer can reason about the
* file set without resolving anything and an extractor cannot be walked out of
* its own root.
*/
const PackRelativePath = TrimmedNonEmptyString.check(effect.Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@\-/]+$/), effect.Schema.isMaxLength(PACK_RELATIVE_PATH_MAX_LENGTH));
/** POSIX environment variable spelling, so shells and containers agree. */
const PackEnvVarName = TrimmedNonEmptyString.check(effect.Schema.isPattern(/^[A-Z][A-Z0-9_]*$/), effect.Schema.isMaxLength(128));
/** Dotted lowercase, matching the shape of the product event catalog. */
const PackEventName = TrimmedNonEmptyString.check(effect.Schema.isPattern(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/), effect.Schema.isMaxLength(128));
/**
* A host a pack talks to. A single leading `*.` wildcard is allowed because
* real services span subdomains; a bare `*` is not, because a permission that
* allows everything communicates nothing to a reviewer.
*/
const PackHostPattern = TrimmedNonEmptyString.check(effect.Schema.isPattern(/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/), effect.Schema.isMaxLength(253));
const PackPort = PositiveInt.check(effect.Schema.isLessThanOrEqualTo(PACK_MAX_PORT));
const PackSha256 = effect.Schema.String.check(effect.Schema.isPattern(/^[a-f0-9]{64}$/));
const PackBase64 = effect.Schema.String.check(effect.Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/), effect.Schema.isMaxLength(4096));
const PackSummaryText = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PACK_SUMMARY_MAX_LENGTH));
const PackDescriptionText = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PACK_DESCRIPTION_MAX_LENGTH));
const PackPurposeText = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PACK_PURPOSE_MAX_LENGTH));
const PackCommandText = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PACK_COMMAND_MAX_LENGTH));
/**
* Long enough for a paragraph of hard-won detail, short enough that a
* maintenance agent writing twenty of these cannot bloat a manifest a search
* index has to hold in memory.
*/
const PackKnowledgeText = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PACK_KNOWLEDGE_TEXT_MAX_LENGTH));
const PackConditionValue = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PACK_CONDITION_VALUE_MAX_LENGTH));
const PackUrl = TrimmedNonEmptyString.check(effect.Schema.isPattern(/^https:\/\/\S+$/), effect.Schema.isMaxLength(2048));
/**
* Opaque and permanent. A pack may be renamed, retitled or transferred and this
* never changes, which is what lets installs, analytics and verification
* records survive all three.
*/
const PackId = TrimmedNonEmptyString.pipe(effect.Schema.brand("PackId"));
/**
* Names the publisher's signing keypair. The private half never leaves the
* publisher; the public half is registered once with the marketplace so a
* consumer can check a release really came from that account.
*/
const PackSigningKeyId = TrimmedNonEmptyString.pipe(effect.Schema.brand("PackSigningKeyId"));
/**
* A workspace's stable, non-reversible handle. It travels instead of the
* workspace id so a public pack can prove two releases share an origin, and so
* a workspace-private pack can be pinned to its home, without leaking tenancy.
*/
const PackWorkspaceKeyId = TrimmedNonEmptyString.pipe(effect.Schema.brand("PackWorkspaceKeyId"));
/**
* A running deployment's stable, non-reversible handle. Knowledge cites it so a
* public pack can say a failure was seen in three distinct deployments — the
* claim that makes a sighting more than an anecdote — without naming any of
* the installations it was seen in.
*/
const PackDeploymentKeyId = TrimmedNonEmptyString.pipe(effect.Schema.brand("PackDeploymentKeyId"));
/**
* A closed set, because facets only work for search if everyone picks from the
* same list. Free-form discovery is what `tags` is for.
*/
const PackCategory = effect.Schema.Literals([
	"payments",
	"authentication",
	"messaging",
	"data",
	"storage",
	"analytics",
	"ai",
	"search",
	"media",
	"commerce",
	"devops",
	"integration",
	"ui",
	"workflow",
	"other"
]);
const PackTag = PackSlug;
/**
* An SPDX identifier, or one of the two escape hatches for code that is not
* open source. Both escape hatches are spelled out rather than left as an
* absent field so a consumer never has to guess what silence means.
*/
const PackLicense = TrimmedNonEmptyString.check(effect.Schema.isMaxLength(128));
/**
* Public identity. Internal ids are optional because a manifest that leaves the
* installation must still be readable by a marketplace that has never heard of
* this tenant.
*/
const PackPublisher = effect.Schema.Union([effect.Schema.Struct({
	type: effect.Schema.Literal("user"),
	handle: PackHandle,
	displayName: TrimmedNonEmptyString,
	userId: effect.Schema.optional(UserId),
	signingKeyId: effect.Schema.optional(PackSigningKeyId),
	publicKey: effect.Schema.optional(PackBase64),
	contactUrl: effect.Schema.optional(PackUrl)
}), effect.Schema.Struct({
	type: effect.Schema.Literal("organization"),
	handle: PackHandle,
	displayName: TrimmedNonEmptyString,
	organizationId: effect.Schema.optional(OrganizationId),
	signingKeyId: effect.Schema.optional(PackSigningKeyId),
	publicKey: effect.Schema.optional(PackBase64),
	contactUrl: effect.Schema.optional(PackUrl)
})]);
const PackIdentity = effect.Schema.Struct({
	id: PackId,
	name: PackName,
	version: PackVersion,
	displayName: TrimmedNonEmptyString,
	summary: PackSummaryText,
	description: effect.Schema.optional(PackDescriptionText),
	publisher: PackPublisher,
	license: PackLicense,
	categories: effect.Schema.optional(effect.Schema.Array(PackCategory)),
	tags: effect.Schema.optional(effect.Schema.Array(PackTag)),
	homepageUrl: effect.Schema.optional(PackUrl),
	repositoryUrl: effect.Schema.optional(PackUrl)
});
/**
* The workspace a pack was cut from. `workspaceId` is optional so a public
* release can drop it while the key id keeps the lineage intact.
*/
const PackOriginWorkspace = effect.Schema.Struct({
	workspaceKeyId: PackWorkspaceKeyId,
	workspaceId: effect.Schema.optional(WorkspaceId),
	tenantId: effect.Schema.optional(TenantId),
	projectId: effect.Schema.optional(ProjectId),
	title: effect.Schema.optional(TrimmedNonEmptyString)
});
/** Who cut the pack. Agents are first-class here because usually one did. */
const PackAuthor = effect.Schema.Union([effect.Schema.Struct({
	type: effect.Schema.Literal("user"),
	userId: effect.Schema.optional(UserId),
	displayName: TrimmedNonEmptyString
}), effect.Schema.Struct({
	type: effect.Schema.Literal("agent"),
	provider: TrimmedNonEmptyString,
	model: effect.Schema.optional(TrimmedNonEmptyString),
	onBehalfOfUserId: effect.Schema.optional(UserId)
})]);
/** The commit the extraction was taken from, for auditing and for re-cutting. */
const PackSourceRevision = effect.Schema.Struct({
	repositoryUrl: effect.Schema.optional(PackUrl),
	branch: effect.Schema.optional(TrimmedNonEmptyString),
	commitSha: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isPattern(/^[a-f0-9]{7,40}$/))),
	dirty: effect.Schema.optional(effect.Schema.Boolean)
});
/**
* The notes the agent writes on the way out: what it built, what it tried, what
* it left undone. Required, because a pack without a handover is a zip file.
* The prose stays in a file and only a summary travels in the manifest, so
* search and agent context stay cheap.
*/
const PackHandover = effect.Schema.Struct({
	path: PackRelativePath,
	summary: PackDescriptionText,
	generatedBy: effect.Schema.optional(PackAuthor),
	generatedAt: effect.Schema.optional(IsoDateTime)
});
const PackProvenance = effect.Schema.Struct({
	workspace: PackOriginWorkspace,
	extractedAt: IsoDateTime,
	extractedBy: PackAuthor,
	handover: PackHandover,
	source: effect.Schema.optional(PackSourceRevision),
	derivedFrom: effect.Schema.optional(effect.Schema.Struct({
		id: PackId,
		name: PackName,
		version: PackVersion,
		publisherHandle: PackHandle
	}))
});
/**
* How data crosses the pack boundary. Kept coarse on purpose: the point is to
* let an agent decide whether a pack fits before reading any code, not to
* replace the interface definitions further down.
*/
const PackPortKind = effect.Schema.Literals([
	"http-request",
	"http-response",
	"function-call",
	"function-result",
	"event",
	"webhook",
	"cli-argument",
	"file",
	"stream"
]);
const PackDataPort = effect.Schema.Struct({
	name: PackSlug,
	kind: PackPortKind,
	description: PackPurposeText,
	schemaPath: effect.Schema.optional(PackRelativePath),
	required: effect.Schema.optional(effect.Schema.Boolean)
});
const PackCapability = effect.Schema.Struct({
	does: PackSummaryText,
	useCases: effect.Schema.optional(effect.Schema.Array(PackPurposeText)),
	nonGoals: effect.Schema.optional(effect.Schema.Array(PackPurposeText)),
	inputs: effect.Schema.optional(effect.Schema.Array(PackDataPort)),
	outputs: effect.Schema.optional(effect.Schema.Array(PackDataPort))
});
/**
* Axes along which knowledge that is true here can be false there. A closed set
* because the point of naming them is that a consumer compares its own context
* field by field before trusting anything; a free-form label would only be
* legible to the agent that wrote it.
*/
const PackConditionAxis = effect.Schema.Literals([
	"account-tier",
	"region",
	"console-version",
	"api-version",
	"sdk-version",
	"runtime-version",
	"plan",
	"locale",
	"deployment-target"
]);
/**
* The kind of surface a claim describes, which is what decides how fast it goes
* out of date. A console path is redesigned without notice; a delivery
* guarantee is not. The two cannot share one staleness threshold, and the
* surface is something the observing agent already knows — unlike a half-life,
* which it would have to estimate.
*/
const PackKnowledgeSurface = effect.Schema.Literals([
	"console-navigation",
	"provider-api",
	"provider-policy",
	"sdk-surface",
	"host-codebase",
	"protocol-invariant"
]);
/**
* How fast what was true at `observedAt` stops being true.
*
* `observed` is the variant the format is betting on: a half-life fitted to
* contradictions arriving against the entry's age is something the runtime can
* compute from installs it already counts, and it needs nobody to guess. Until
* enough installs exist to fit one, `assumed` names the surface and lets the
* reader apply `PACK_SURFACE_HALF_LIFE_DAYS`. The two are separated rather than
* collapsed into one number because "measured across 200 installs" and "the
* default for console paths" support very different confidence, and a reader
* that cannot tell them apart will trust the second as hard as the first.
*/
const PackKnowledgeRot = effect.Schema.Union([effect.Schema.Struct({
	basis: effect.Schema.Literal("observed"),
	surface: PackKnowledgeSurface,
	halfLifeDays: PositiveInt,
	fromInstalls: NonNegativeInt,
	measuredAt: IsoDateTime
}), effect.Schema.Struct({
	basis: effect.Schema.Literal("assumed"),
	surface: PackKnowledgeSurface
})]);
/**
* The context one claim held under, attached per claim rather than once per
* pack. Two entries in the same manifest are routinely verified years and tiers
* apart, and a single global block would silently relabel the older one as
* having been checked under the newer one's conditions.
*
* `observedAt` is the only required field, because it is the one thing the
* observing agent always has and because undated knowledge cannot be aged out.
* Everything else narrows. An absent axis means "not recorded"; naming an axis
* in `untestedAxes` means "recorded, and we know we never varied it" — the
* difference between an agent that asserts and one that can say "verified on
* standard-tier US, yours may differ". At install volume a confident wrong
* answer travels further than a hedged right one, so the hedge is structural.
*/
const PackConditions = effect.Schema.Struct({
	observedAt: IsoDateTime,
	accountTier: effect.Schema.optional(PackConditionValue),
	regions: effect.Schema.optional(effect.Schema.Array(PackConditionValue)),
	consoleVersion: effect.Schema.optional(PackConditionValue),
	apiVersion: effect.Schema.optional(PackConditionValue),
	other: effect.Schema.optional(effect.Schema.Array(effect.Schema.Struct({
		axis: PackConditionAxis,
		value: PackConditionValue
	}))),
	observedAcrossDeployments: effect.Schema.optional(NonNegativeInt),
	untestedAxes: effect.Schema.optional(effect.Schema.Array(PackConditionAxis)),
	rot: effect.Schema.optional(PackKnowledgeRot)
});
/**
* What produced a piece of knowledge. The machine-written variants come first
* because they are the ones the format is betting on: nobody volunteers their
* edge cases, so anything that depends on an author sitting down to write is a
* source that will stay empty. `inherited` is how a failure caught once reaches
* everyone — a dependency's scar is the dependant's scar.
*/
const PackKnowledgeSource = effect.Schema.Union([
	effect.Schema.Struct({
		kind: effect.Schema.Literal("maintenance-agent"),
		provider: TrimmedNonEmptyString,
		model: effect.Schema.optional(TrimmedNonEmptyString),
		runId: effect.Schema.optional(TrimmedNonEmptyString)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("deployment-telemetry"),
		signal: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(128)))
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("install-report"),
		target: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(64)))
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("human-report"),
		reportedByUserId: effect.Schema.optional(UserId)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("inherited"),
		packId: PackId,
		packName: PackName,
		packVersion: PackVersion,
		entryId: PackSlug
	})
]);
/**
* How one entry got here and when. `introducedIn` is what makes knowledge
* propagate rather than accumulate in one place: an installer diffing the
* version it runs against the version it is offered can answer "what did the
* last four hundred deployments learn that I do not know yet" without reading
* either manifest in full.
*/
const PackKnowledgeOrigin = effect.Schema.Struct({
	introducedIn: PackVersion,
	source: PackKnowledgeSource,
	recordedAt: IsoDateTime,
	deploymentKeyIds: effect.Schema.optional(effect.Schema.Array(PackDeploymentKeyId)),
	supersedes: effect.Schema.optional(PackSlug)
});
/**
* The shape of the thing that went wrong, for search and for pattern-matching
* against a failure the consumer is currently looking at. Deliberately about
* mechanism rather than component, because "webhook retries are not idempotent"
* generalises across providers and "Stripe broke" does not.
*/
const PackFailureTrigger = effect.Schema.Literals([
	"race-condition",
	"retry",
	"idempotency",
	"rate-limit",
	"quota-exhausted",
	"clock-skew",
	"provider-quirk",
	"provider-deprecation",
	"payload-shape",
	"partial-failure",
	"cold-start",
	"concurrency",
	"misconfiguration",
	"permission-denied",
	"network-timeout",
	"version-drift"
]);
/**
* Who is actually at fault. A union rather than a free string because the four
* cases have different half-lives: a provider quirk may vanish with a console
* release, a dependency fault is fixed by a version bump, and a fault in the
* pack's own code is the only one the maintainer can close alone.
*/
const PackFailureAttribution = effect.Schema.Union([
	effect.Schema.Struct({
		kind: effect.Schema.Literal("provider"),
		service: PackSlug,
		apiVersion: effect.Schema.optional(PackConditionValue)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("dependency"),
		name: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(128)),
		versionRange: effect.Schema.optional(PackVersionRange)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("host"),
		detail: PackPurposeText
	}),
	effect.Schema.Struct({ kind: effect.Schema.Literal("pack") })
]);
/**
* How the failure announces itself. Stored so the next deployment recognises it
* instead of rediscovering it: a detector is the difference between a note
* about the past and a guard on the present, and it is the field that lets the
* maintenance agent close the loop without a human describing the symptom
* again.
*/
const PackFailureDetection = effect.Schema.Struct({
	signal: effect.Schema.Literals([
		"healthcheck",
		"error-rate",
		"log-pattern",
		"test-failure",
		"provider-error-code",
		"latency",
		"reconciliation-mismatch",
		"user-report"
	]),
	match: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(512))),
	checkId: effect.Schema.optional(PackSlug)
});
/**
* Where the failure stands. `open` still carries required advice, because an
* unresolved failure an installer is warned about is worth more than a fixed
* one nobody wrote down, and a knowledge base that only records victories is a
* marketing asset rather than a scar record.
*/
const PackFailureResolution = effect.Schema.Union([
	effect.Schema.Struct({
		kind: effect.Schema.Literal("fixed"),
		inVersion: PackVersion,
		change: PackKnowledgeText,
		checkId: effect.Schema.optional(PackSlug)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("mitigated"),
		workaround: PackKnowledgeText,
		residualRisk: effect.Schema.optional(PackPurposeText)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("upstream"),
		waitingOn: PackPurposeText,
		reportUrl: effect.Schema.optional(PackUrl),
		workaround: effect.Schema.optional(PackKnowledgeText)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("open"),
		currentAdvice: PackKnowledgeText
	})
]);
/**
* Whether a failure mode still describes the present — the same question
* `PackKnowledgeStanding` asks of an instruction, and deliberately not the same
* type.
*
* The two look alike and their arithmetic is inverted. A confirmation of an
* instruction is somebody following it and getting the screen it promised; the
* matching event here is somebody being hurt by the failure again. Sharing one
* struct would make `confirmedInInstalls` mean "it worked" on one entry and "it
* broke" on the next — a field that reads fine and silently inverts any
* threshold set on it.
*
* Counted against the deployments that took the resolution, because that is the
* population the question is about: a fix nobody has installed is not holding,
* it is untested.
*/
const PackFailureStanding = effect.Schema.Struct({
	state: effect.Schema.Literals([
		"recurring",
		"holding",
		"dormant",
		"obsolete"
	]),
	heldInDeployments: NonNegativeInt,
	recurredInDeployments: NonNegativeInt,
	lastCheckedAt: effect.Schema.optional(IsoDateTime)
});
/**
* One thing that has actually gone wrong in production — the edge cases, race
* conditions and provider quirks somebody already paid for.
*
* Every required field is something the observing agent holds at the moment it
* notices: an id it mints, a symptom it read off a signal, the deployment
* conditions it was already running under, its own clock, and its own count of
* affected deployments. Nothing here requires an author to reflect, which is
* the only way this section stays populated.
*
* `id` is stable across releases, so a repeat sighting, a fix and a regression
* check all point at the same failure rather than at three versions of a story.
*/
const PackFailureMode = effect.Schema.Struct({
	id: PackSlug,
	symptom: PackSummaryText,
	trigger: PackKnowledgeText,
	triggerKinds: effect.Schema.optional(effect.Schema.Array(PackFailureTrigger)),
	attributedTo: PackFailureAttribution,
	severity: effect.Schema.Literals([
		"critical",
		"high",
		"medium",
		"low"
	]),
	silent: effect.Schema.optional(effect.Schema.Boolean),
	detection: effect.Schema.optional(PackFailureDetection),
	resolution: PackFailureResolution,
	standing: effect.Schema.optional(PackFailureStanding),
	firstSeenAt: IsoDateTime,
	lastSeenAt: effect.Schema.optional(IsoDateTime),
	deploymentsAffected: NonNegativeInt,
	conditions: PackConditions,
	origin: PackKnowledgeOrigin
});
/**
* One move inside somebody else's console. `expect` is what makes the step
* falsifiable: an agent that knows what the screen should say can report that
* the provider redesigned it, which turns provider churn into a detected event
* rather than a user watching an agent insist on a menu that no longer exists.
*/
const PackConsoleStep = effect.Schema.Struct({
	action: PackPurposeText,
	url: effect.Schema.optional(PackUrl),
	expect: effect.Schema.optional(PackPurposeText)
});
/**
* A permission on a credential. `required` is the load-bearing half: the
* default an agent reaches for is every scope the console offers, and this is
* the field that argues it down to the two the pack actually calls.
*/
const PackCredentialScope = effect.Schema.Struct({
	name: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(128)),
	purpose: PackPurposeText,
	required: effect.Schema.Boolean
});
const PackCredentialKind = effect.Schema.Literals([
	"restricted-key",
	"secret-key",
	"publishable-key",
	"oauth-client",
	"service-account",
	"personal-access-token",
	"webhook-signing-secret"
]);
/**
* How far a consumer may move one decision. `frozen` entries carry the failure
* mode that explains them wherever one exists, because "do not touch this" is
* an assertion and "do not touch this, here is what happened the last time
* somebody did" is knowledge — and only the second one survives an agent that
* has a good reason of its own.
*/
const PackCustomisationDecision = effect.Schema.Struct({
	subject: PackSummaryText,
	latitude: effect.Schema.Literals([
		"safe-to-change",
		"change-with-care",
		"frozen"
	]),
	reason: PackPurposeText,
	failureModeId: effect.Schema.optional(PackSlug),
	path: effect.Schema.optional(PackRelativePath)
});
/**
* The four things an installing agent needs that reading the source will not
* give it: how to get the credential, how to wire the thing in, which patterns
* to hold to, and which decisions it may move.
*
* `credential-retrieval` is modelled hardest because it is the sharpest case in
* the whole format. "Go to the console, Settings → API, generate a restricted
* key with these two scopes" is in no repository, is frequently not in the
* provider's own documentation, changes without notice, and is hallucinated
* confidently by every model that is asked. It exists only in the aftermath of
* somebody doing it, which is exactly the material this section carries.
*/
const PackIntegrationKnowledgeDetail = effect.Schema.Union([
	effect.Schema.Struct({
		kind: effect.Schema.Literal("credential-retrieval"),
		environmentVariable: PackEnvVarName,
		service: PackSlug,
		credentialKind: effect.Schema.optional(PackCredentialKind),
		consoleUrl: effect.Schema.optional(PackUrl),
		navigation: effect.Schema.NonEmptyArray(PackConsoleStep),
		scopes: effect.Schema.optional(effect.Schema.Array(PackCredentialScope)),
		rotation: effect.Schema.optional(PackKnowledgeText)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("wiring"),
		prompt: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PACK_INTEGRATION_PROMPT_MAX_LENGTH)),
		interfaceId: effect.Schema.optional(PackSlug),
		touches: effect.Schema.optional(effect.Schema.Array(PackRelativePath))
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("pattern"),
		rule: PackKnowledgeText,
		rationale: PackPurposeText,
		example: effect.Schema.optional(PackKnowledgeText)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("boundary"),
		decisions: effect.Schema.NonEmptyArray(PackCustomisationDecision)
	})
]);
/**
* Whether an entry still holds. Counted from installs rather than declared,
* so a console redesign shows up as contradictions outrunning confirmations
* before anyone files a report. `superseded` entries stay in the manifest on
* purpose: knowing the path used to be this is worth more than silence when an
* agent is looking at an older console.
*/
const PackKnowledgeStanding = effect.Schema.Struct({
	state: effect.Schema.Literals([
		"holding",
		"doubtful",
		"superseded"
	]),
	confirmedInInstalls: NonNegativeInt,
	contradictedInInstalls: NonNegativeInt,
	lastConfirmedAt: effect.Schema.optional(IsoDateTime)
});
/**
* One piece of installation knowledge. The envelope carries what a search
* indexes and what a consumer thresholds on; `detail` carries what an installer
* executes. Split that way because a marketplace ranking a thousand packs must
* not have to open four different shapes to find a date and a condition.
*/
const PackIntegrationKnowledge = effect.Schema.Struct({
	id: PackSlug,
	title: PackSummaryText,
	detail: PackIntegrationKnowledgeDetail,
	conditions: PackConditions,
	origin: PackKnowledgeOrigin,
	standing: effect.Schema.optional(PackKnowledgeStanding),
	commonMistake: effect.Schema.optional(PackKnowledgeText),
	preventsFailureModeIds: effect.Schema.optional(effect.Schema.Array(PackSlug))
});
/**
* Present even when empty, like requirements and permissions. `{}` is an
* honest and useful claim — this pack has run nowhere and learned nothing yet —
* and it is a different statement from an absent section. Making it required is
* what stops the knowledge from being the part everybody skips.
*/
const PackKnowledge = effect.Schema.Struct({
	failureModes: effect.Schema.optional(effect.Schema.Array(PackFailureMode)),
	integration: effect.Schema.optional(effect.Schema.Array(PackIntegrationKnowledge))
});
/**
* A value the consumer supplies. `secret` drives storage and redaction, so it
* is separate from `required`: a public publishable key is required and not
* secret, a webhook signing secret is both.
*/
const PackEnvRequirement = effect.Schema.Struct({
	name: PackEnvVarName,
	purpose: PackPurposeText,
	secret: effect.Schema.Boolean,
	required: effect.Schema.Boolean,
	example: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(256))),
	defaultValue: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(256))),
	obtainUrl: effect.Schema.optional(PackUrl),
	pattern: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(256)))
});
/**
* How a requirement bills. Split from a boolean because "free until 5GB",
* "pennies per request" and "there is no plan under $99" rule a pack out for
* different readers, and a single `costsMoney` flag collapses all three into
* the least useful of them.
*/
const PackCostModel = effect.Schema.Literals([
	"free",
	"free-tier",
	"metered",
	"subscription",
	"paid-plan"
]);
/**
* What one requirement costs to keep running, attached wherever paying is
* actually possible rather than only to third-party accounts.
*
* Deliberately carries no price. Prices change quarterly, a manifest is frozen
* at extraction, and a stale number a consumer budgets against is worse than no
* number — so this names the shape of the bill and links to whoever is allowed
* to state its size.
*/
const PackRunningCost = effect.Schema.Struct({
	model: PackCostModel,
	billedOn: effect.Schema.optional(PackPurposeText),
	freeTierLimit: effect.Schema.optional(PackPurposeText),
	pricingUrl: effect.Schema.optional(PackUrl)
});
/** A third-party account the consumer has to hold in their own name. */
const PackExternalAccount = effect.Schema.Struct({
	service: PackSlug,
	displayName: TrimmedNonEmptyString,
	purpose: PackPurposeText,
	signupUrl: effect.Schema.optional(PackUrl),
	requiredScopes: effect.Schema.optional(effect.Schema.Array(TrimmedNonEmptyString)),
	requiredPlan: effect.Schema.optional(TrimmedNonEmptyString),
	costsMoney: effect.Schema.optional(effect.Schema.Boolean),
	cost: effect.Schema.optional(PackRunningCost),
	providesEnvironment: effect.Schema.optional(effect.Schema.Array(PackEnvVarName))
});
const PackServiceDependencyKind = effect.Schema.Literals([
	"postgres",
	"mysql",
	"sqlite",
	"redis",
	"object-storage",
	"smtp",
	"queue",
	"vector-store",
	"custom"
]);
/** Infrastructure the consumer must already be running or willing to run. */
const PackServiceDependency = effect.Schema.Struct({
	kind: PackServiceDependencyKind,
	name: PackSlug,
	purpose: PackPurposeText,
	versionRange: effect.Schema.optional(PackVersionRange),
	connectionEnvVar: effect.Schema.optional(PackEnvVarName),
	cost: effect.Schema.optional(PackRunningCost)
});
const PackToolchainRequirement = effect.Schema.Struct({
	name: PackSlug,
	versionRange: effect.Schema.optional(PackVersionRange)
});
const PackDependency = effect.Schema.Struct({
	id: PackId,
	name: PackName,
	publisherHandle: PackHandle,
	versionRange: PackVersionRange,
	optional: effect.Schema.optional(effect.Schema.Boolean)
});
/**
* An ordered step towards a runnable install. `satisfies` closes the loop
* between a declared key and the instructions for getting it, and `verify` is
* what lets a consuming agent check its own work instead of guessing.
*/
const PackSetupStep = effect.Schema.Struct({
	title: PackSummaryText,
	instructions: PackDescriptionText,
	command: effect.Schema.optional(PackCommandText),
	verifyCommand: effect.Schema.optional(PackCommandText),
	satisfies: effect.Schema.optional(effect.Schema.Array(PackEnvVarName)),
	manual: effect.Schema.optional(effect.Schema.Boolean)
});
/**
* Present even when empty: `{}` is an affirmative claim that the pack needs
* nothing supplied, which is a different statement from an absent section and
* one a reviewer can hold the publisher to.
*
* Cost sits on `accounts` and `services` and nowhere else, because those are
* the two kinds that bill. An `environment` value is free — the account behind
* it is what charges, and it is declared there. `toolchain` names interpreters
* and build tools, and a toolchain that needs paying for is a licence, which is
* an account. A dependency in `packs` states its own costs in its own manifest;
* restating them here would be a copy that goes stale the next time it reprices.
*/
const PackRequirements = effect.Schema.Struct({
	environment: effect.Schema.optional(effect.Schema.Array(PackEnvRequirement)),
	accounts: effect.Schema.optional(effect.Schema.Array(PackExternalAccount)),
	services: effect.Schema.optional(effect.Schema.Array(PackServiceDependency)),
	toolchain: effect.Schema.optional(effect.Schema.Array(PackToolchainRequirement)),
	packs: effect.Schema.optional(effect.Schema.Array(PackDependency)),
	setupSteps: effect.Schema.optional(effect.Schema.Array(PackSetupStep)),
	preflightCommand: effect.Schema.optional(PackCommandText)
});
const PackHttpMethod = effect.Schema.Literals([
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS"
]);
const PackAuthenticationKind = effect.Schema.Literals([
	"none",
	"api-key",
	"bearer",
	"session",
	"signature",
	"oauth"
]);
/**
* One callable operation. `operationId` is the join key: analytics meters
* operations by id rather than restating routes, so a path can change without
* orphaning a dashboard.
*/
const PackApiOperation = effect.Schema.Struct({
	operationId: PackSlug,
	method: PackHttpMethod,
	path: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(512)),
	summary: PackSummaryText,
	authentication: effect.Schema.optional(PackAuthenticationKind),
	requiresEnvironment: effect.Schema.optional(effect.Schema.Array(PackEnvVarName))
});
const PackLibraryExport = effect.Schema.Struct({
	name: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(128)),
	kind: effect.Schema.Literals([
		"function",
		"class",
		"component",
		"type",
		"constant",
		"hook"
	]),
	summary: PackSummaryText,
	signature: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(1024)))
});
const PackCliCommand = effect.Schema.Struct({
	name: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(128)),
	usage: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(512)),
	summary: PackSummaryText
});
/**
* How a consumer touches the pack. A union rather than a `hasWebUi` flag,
* because a headless payments API and a dashboard are not the same product and
* a marketplace that assumes a front end cannot list the first one.
*
* `serviceId` points at the runtime service that hosts the interface, so ports
* are declared exactly once.
*/
const PackInterface = effect.Schema.Union([
	effect.Schema.Struct({
		kind: effect.Schema.Literal("web"),
		id: PackSlug,
		title: TrimmedNonEmptyString,
		serviceId: effect.Schema.optional(PackSlug),
		basePath: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(512))),
		framework: effect.Schema.optional(TrimmedNonEmptyString),
		requiresAuthentication: effect.Schema.optional(effect.Schema.Boolean)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("tui"),
		id: PackSlug,
		title: TrimmedNonEmptyString,
		command: PackCommandText,
		summary: effect.Schema.optional(PackSummaryText)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("api"),
		id: PackSlug,
		title: TrimmedNonEmptyString,
		protocol: effect.Schema.Literals([
			"http",
			"websocket",
			"grpc"
		]),
		serviceId: effect.Schema.optional(PackSlug),
		basePath: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(512))),
		specPath: effect.Schema.optional(PackRelativePath),
		operations: effect.Schema.NonEmptyArray(PackApiOperation)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("library"),
		id: PackSlug,
		title: TrimmedNonEmptyString,
		language: TrimmedNonEmptyString,
		packageName: effect.Schema.optional(TrimmedNonEmptyString),
		importPath: effect.Schema.optional(PackRelativePath),
		exports: effect.Schema.NonEmptyArray(PackLibraryExport)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("cli"),
		id: PackSlug,
		title: TrimmedNonEmptyString,
		binary: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(128)),
		commands: effect.Schema.NonEmptyArray(PackCliCommand)
	}),
	effect.Schema.Struct({
		kind: effect.Schema.Literal("mcp"),
		id: PackSlug,
		title: TrimmedNonEmptyString,
		transport: effect.Schema.Literals(["stdio", "http"]),
		command: effect.Schema.optional(PackCommandText),
		serviceId: effect.Schema.optional(PackSlug),
		tools: effect.Schema.NonEmptyArray(effect.Schema.Struct({
			name: PackSlug,
			summary: PackSummaryText
		}))
	})
]);
const PackRuntimeTarget = effect.Schema.Literals([
	"node",
	"bun",
	"deno",
	"python",
	"go",
	"rust",
	"container",
	"static",
	"none"
]);
const PackRuntimeCommand = effect.Schema.Struct({
	command: PackCommandText,
	cwd: effect.Schema.optional(PackRelativePath),
	description: effect.Schema.optional(PackSummaryText)
});
/**
* A fixed lifecycle rather than a free list, because every downstream surface
* needs to answer the same handful of questions and an open-ended array would
* force each of them to guess which entry means "start".
*/
const PackRuntimeCommands = effect.Schema.Struct({
	install: effect.Schema.optional(PackRuntimeCommand),
	build: effect.Schema.optional(PackRuntimeCommand),
	start: effect.Schema.optional(PackRuntimeCommand),
	dev: effect.Schema.optional(PackRuntimeCommand),
	test: effect.Schema.optional(PackRuntimeCommand),
	migrate: effect.Schema.optional(PackRuntimeCommand),
	healthcheck: effect.Schema.optional(PackRuntimeCommand)
});
/**
* How a service picks its port. A union because "port 3000", "whatever `PORT`
* says" and "the runtime assigns one" need different handling at deploy time
* and a nullable number cannot tell them apart.
*/
const PackPortBinding = effect.Schema.Union([
	effect.Schema.Struct({
		type: effect.Schema.Literal("fixed"),
		port: PackPort
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("environment"),
		envVar: PackEnvVarName,
		defaultPort: effect.Schema.optional(PackPort)
	}),
	effect.Schema.Struct({ type: effect.Schema.Literal("dynamic") })
]);
const PackRuntimeService = effect.Schema.Struct({
	id: PackSlug,
	title: TrimmedNonEmptyString,
	protocol: effect.Schema.Literals([
		"http",
		"https",
		"ws",
		"tcp",
		"grpc"
	]),
	binding: PackPortBinding,
	exposure: effect.Schema.Literals([
		"public",
		"internal",
		"loopback"
	]),
	healthPath: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(512)))
});
const PackContainerSpec = effect.Schema.Struct({
	dockerfilePath: effect.Schema.optional(PackRelativePath),
	composePath: effect.Schema.optional(PackRelativePath),
	image: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(256)))
});
const PackRuntime = effect.Schema.Struct({
	target: PackRuntimeTarget,
	versionRange: effect.Schema.optional(PackVersionRange),
	commands: PackRuntimeCommands,
	services: effect.Schema.optional(effect.Schema.Array(PackRuntimeService)),
	container: effect.Schema.optional(PackContainerSpec)
});
/**
* What leaves the machine. Declared per destination so a reviewer reads
* "card data goes to Stripe" instead of inferring it from source.
*/
const PackDataClass = effect.Schema.Literals([
	"payment",
	"pii",
	"credentials",
	"content",
	"telemetry",
	"none"
]);
const PackNetworkEgress = effect.Schema.Struct({
	host: PackHostPattern,
	purpose: PackPurposeText,
	ports: effect.Schema.optional(effect.Schema.Array(PackPort)),
	required: effect.Schema.optional(effect.Schema.Boolean),
	dataClasses: effect.Schema.optional(effect.Schema.Array(PackDataClass))
});
/**
* Filesystem access is anchored to a named root rather than a raw path, so a
* sandbox can map the roots however it likes and `absolute` stands out as the
* one case a reviewer has to argue with.
*/
const PackFilesystemRoot = effect.Schema.Literals([
	"pack",
	"data",
	"tmp",
	"workspace",
	"home",
	"absolute"
]);
const PackFilesystemAccess = effect.Schema.Struct({
	root: PackFilesystemRoot,
	path: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PACK_RELATIVE_PATH_MAX_LENGTH)),
	access: effect.Schema.Literals([
		"read",
		"write",
		"read-write"
	]),
	purpose: PackPurposeText
});
const PackSecretAccess = effect.Schema.Struct({
	name: PackEnvVarName,
	purpose: PackPurposeText
});
const PackProcessPermission = effect.Schema.Struct({
	spawnsSubprocesses: effect.Schema.Boolean,
	commands: effect.Schema.optional(effect.Schema.Array(PackCommandText))
});
/**
* Anything the permission model above cannot express. Each entry carries a
* justification because these are exactly the requests a human should read
* before approving, and an unjustified escalation is a review failure.
*/
const PackElevatedCapability = effect.Schema.Struct({
	capability: effect.Schema.Literals([
		"raw-socket",
		"native-module",
		"privileged-port",
		"host-network",
		"docker-socket",
		"system-package-install",
		"kernel-module"
	]),
	justification: PackPurposeText
});
/**
* Like requirements, present even when empty: `{}` claims the pack needs no
* access at all, and enforcement later gets to treat anything undeclared as a
* violation rather than an omission.
*/
const PackPermissions = effect.Schema.Struct({
	network: effect.Schema.optional(effect.Schema.Array(PackNetworkEgress)),
	acceptsInboundNetwork: effect.Schema.optional(effect.Schema.Boolean),
	filesystem: effect.Schema.optional(effect.Schema.Array(PackFilesystemAccess)),
	secrets: effect.Schema.optional(effect.Schema.Array(PackSecretAccess)),
	process: effect.Schema.optional(PackProcessPermission),
	elevated: effect.Schema.optional(effect.Schema.Array(PackElevatedCapability))
});
/**
* A test that keeps running after install. `guardsFailureModeId` is what turns
* a check into evidence rather than ceremony: a check that exists because
* something broke, still passing across four hundred deployments, is a stronger
* statement about this pack than any review of its source.
*
* Counts rather than a pass/fail badge, because a check that ran four hundred
* times and failed twice, a check that has never run, and a check that passed
* once on the author's laptop are three different facts and a badge collapses
* them into one.
*/
const PackProductionCheck = effect.Schema.Struct({
	id: PackSlug,
	title: PackSummaryText,
	command: PackCommandText,
	runsOn: effect.Schema.NonEmptyArray(effect.Schema.Literals([
		"install",
		"deploy",
		"schedule",
		"upgrade"
	])),
	guardsFailureModeId: effect.Schema.optional(PackSlug),
	runs: NonNegativeInt,
	passes: NonNegativeInt,
	deploymentsCovered: effect.Schema.optional(NonNegativeInt),
	lastRunAt: effect.Schema.optional(IsoDateTime),
	lastOutcome: effect.Schema.optional(effect.Schema.Literals([
		"pass",
		"fail",
		"error",
		"skipped"
	]))
});
/**
* What the pack has survived. Raw counts, never rates: the consumer is an agent
* and can divide, and a stored ratio hides the denominator that decides whether
* the ratio means anything. Nine of ten installs succeeding is a fact; nine of
* ten with the ten unstated is a claim.
*
* Required on every manifest, filled with zeros on a pack that has never run.
* A clean record has to be visibly clean rather than absent, because "no
* breakages" and "no deployments" are the two ends of this format's central
* judgement and an omitted section reads like the good one.
*/
const PackScarRecord = effect.Schema.Struct({
	measuredAt: IsoDateTime,
	scope: effect.Schema.optional(effect.Schema.Literals(["lineage", "release"])),
	installsAttempted: NonNegativeInt,
	installsSucceeded: NonNegativeInt,
	deploymentsAttempted: NonNegativeInt,
	deploymentsSurviving: NonNegativeInt,
	survival: effect.Schema.optional(effect.Schema.Struct({
		cohortSize: NonNegativeInt,
		aliveAtDay30: NonNegativeInt,
		aliveAtDay60: effect.Schema.optional(NonNegativeInt),
		aliveAtDay90: effect.Schema.optional(NonNegativeInt)
	})),
	cumulativeServiceDays: NonNegativeInt,
	longestServiceDays: effect.Schema.optional(NonNegativeInt),
	firstDeployedAt: effect.Schema.optional(IsoDateTime),
	breakagesCaught: NonNegativeInt,
	breakagesFixed: NonNegativeInt,
	knowledgeContradictions: effect.Schema.optional(NonNegativeInt)
});
/**
* "We ran it." Kept deliberately secondary and deliberately specific: it names
* who did what, on what, and when, and it carries no ranking of its own.
* Manual review does not scale and self-attestation means nothing, so this is
* evidence a consumer may weigh rather than a badge a registry confers — and
* `conditions` is what stops "we ran it" from meaning "it runs".
*/
const PackAttestation = effect.Schema.Struct({
	attestedAt: IsoDateTime,
	attestedBy: PackAuthor,
	did: effect.Schema.NonEmptyArray(effect.Schema.Literals([
		"installed-from-clean",
		"ran-checks",
		"reviewed-source",
		"reviewed-permissions",
		"scanned-secrets",
		"deployed-to-production"
	])),
	conditions: effect.Schema.optional(PackConditions),
	note: effect.Schema.optional(PackPurposeText)
});
/**
* A stop signal, separate from the earned signals above because "nobody has run
* this yet" and "this was pulled" are opposite claims and no single scale holds
* both. This is the one part of the old reviewer-owned badge worth keeping: a
* pack found to be dangerous has to be withdrawable without waiting for
* production to notice.
*/
const PackAdvisory = effect.Schema.Struct({
	id: PackSlug,
	severity: effect.Schema.Literals([
		"revoked",
		"critical",
		"warning"
	]),
	reason: PackDescriptionText,
	issuedAt: IsoDateTime,
	issuedBy: TrimmedNonEmptyString,
	affectedVersions: effect.Schema.optional(effect.Schema.Array(PackVersionRange)),
	failureModeId: effect.Schema.optional(PackSlug)
});
/**
* What is known about whether this works, expressed as signals a consumer
* thresholds itself rather than as a tier somebody assigned. A tier is coarser
* than the decision being made — an agent wiring up a payment flow and an agent
* wiring up a changelog widget want different bars — and the consumer here is
* an agent, which can handle the nuance a badge throws away.
*
* The registry owns `advisories` and the runtime owns `record` and `checks`;
* the publisher may write `attestations` and nothing else that ranks.
*/
const PackVerification = effect.Schema.Struct({
	record: PackScarRecord,
	checks: effect.Schema.optional(effect.Schema.Array(PackProductionCheck)),
	attestations: effect.Schema.optional(effect.Schema.Array(PackAttestation)),
	advisories: effect.Schema.optional(effect.Schema.Array(PackAdvisory))
});
/**
* Who can find and install this. The scoped variants carry their own id so an
* installer can refuse a pack that wandered outside its boundary, and
* `unlisted` exists because "share a link with a client" is not the same
* request as "put this in the marketplace".
*/
/**
* The five boundaries without their ids, for the places that reason about width
* rather than about which workspace: a publication log, a search projection, a
* consent dialog.
*/
const PackVisibilityScope = effect.Schema.Literals([
	"workspace",
	"tenant",
	"organization",
	"unlisted",
	"public"
]);
const PackVisibility = effect.Schema.Union([
	effect.Schema.Struct({
		scope: effect.Schema.Literal("workspace"),
		workspaceKeyId: PackWorkspaceKeyId,
		workspaceId: effect.Schema.optional(WorkspaceId)
	}),
	effect.Schema.Struct({
		scope: effect.Schema.Literal("tenant"),
		tenantId: TenantId
	}),
	effect.Schema.Struct({
		scope: effect.Schema.Literal("organization"),
		organizationId: OrganizationId
	}),
	effect.Schema.Struct({ scope: effect.Schema.Literal("unlisted") }),
	effect.Schema.Struct({ scope: effect.Schema.Literal("public") })
]);
const PackIntegrationTarget = effect.Schema.Literals([
	"generic",
	"t3",
	"claude-code",
	"codex",
	"cursor",
	"windsurf",
	"lovable",
	"replit",
	"v0",
	"bolt"
]);
const PackIntegrationSnippet = effect.Schema.Struct({
	title: PackSummaryText,
	language: PackSlug,
	code: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(8e3)),
	description: effect.Schema.optional(PackPurposeText)
});
/**
* The paste-into-another-agent surface. The generic prompt is required and
* inline so a search result is immediately actionable without fetching files;
* variants exist because the same instructions land differently in a tool that
* owns its own hosting than in one that does not.
*
* This is the carrier, not the knowledge. It says how to invoke the pack, and
* it is authored once at extraction; `knowledge.integration` says what goes
* wrong while doing so, is written by whatever observed it, and carries the
* conditions it was true under. Keeping them apart is what stops an accumulated
* scar record from being flattened back into a prompt nobody updates.
*/
const PackIntegration = effect.Schema.Struct({
	prompt: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PACK_INTEGRATION_PROMPT_MAX_LENGTH)),
	installCommand: effect.Schema.optional(PackCommandText),
	variants: effect.Schema.optional(effect.Schema.Array(effect.Schema.Struct({
		target: PackIntegrationTarget,
		prompt: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(PACK_INTEGRATION_PROMPT_MAX_LENGTH))
	}))),
	snippets: effect.Schema.optional(effect.Schema.Array(PackIntegrationSnippet)),
	followUpQuestions: effect.Schema.optional(effect.Schema.Array(PackSummaryText))
});
const PackAnalyticsProperty = effect.Schema.Struct({
	name: TrimmedNonEmptyString.check(effect.Schema.isPattern(/^[a-z][a-z0-9_]*$/), effect.Schema.isMaxLength(64)),
	type: effect.Schema.Literals([
		"string",
		"number",
		"boolean",
		"timestamp"
	]),
	pii: effect.Schema.Boolean,
	description: effect.Schema.optional(PackPurposeText)
});
const PackAnalyticsEvent = effect.Schema.Struct({
	name: PackEventName,
	source: effect.Schema.Literals([
		"frontend",
		"backend",
		"job",
		"cli"
	]),
	description: PackPurposeText,
	properties: effect.Schema.optional(effect.Schema.Array(PackAnalyticsProperty))
});
/**
* A chart the deployment dashboard can draw without anyone configuring it.
* Sources reference declared events and operation ids rather than restating
* routes, so the manifest keeps one definition of each traffic surface.
*/
const PackAnalyticsMetric = effect.Schema.Struct({
	id: PackSlug,
	title: PackSummaryText,
	kind: effect.Schema.Literals([
		"count",
		"unique-users",
		"sum",
		"latency-p95",
		"error-rate"
	]),
	source: effect.Schema.Union([effect.Schema.Struct({
		type: effect.Schema.Literal("event"),
		event: PackEventName,
		property: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(64)))
	}), effect.Schema.Struct({
		type: effect.Schema.Literal("operation"),
		operationId: PackSlug
	})]),
	unit: effect.Schema.optional(TrimmedNonEmptyString.check(effect.Schema.isMaxLength(32)))
});
const PackAnalytics = effect.Schema.Struct({
	events: effect.Schema.optional(effect.Schema.Array(PackAnalyticsEvent)),
	meteredOperations: effect.Schema.optional(effect.Schema.Array(PackSlug)),
	metrics: effect.Schema.optional(effect.Schema.Array(PackAnalyticsMetric)),
	sink: effect.Schema.optional(effect.Schema.Struct({
		kind: effect.Schema.Literals([
			"t3",
			"none",
			"custom"
		]),
		endpointEnvVar: effect.Schema.optional(PackEnvVarName)
	}))
});
const PackFileDigest = effect.Schema.Struct({
	path: PackRelativePath,
	sha256: PackSha256,
	bytes: NonNegativeInt
});
/**
* Where the conventional files actually live. Paths are declared rather than
* assumed so a pack can be laid out to suit its language, and the digest list
* is what a signature and an archive are checked against. Authoring tools leave
* `files` empty; the publisher fills it when the bytes stop moving.
*/
const PackContents = effect.Schema.Struct({
	readmePath: effect.Schema.optional(PackRelativePath),
	licensePath: effect.Schema.optional(PackRelativePath),
	iconPath: effect.Schema.optional(PackRelativePath),
	sourceRoot: effect.Schema.optional(PackRelativePath),
	examplesRoot: effect.Schema.optional(PackRelativePath),
	files: effect.Schema.optional(effect.Schema.Array(PackFileDigest)),
	archiveSha256: effect.Schema.optional(PackSha256)
});
/**
* Covers the canonical manifest with this block removed, plus the contents
* digest, so neither the metadata nor the files can be swapped independently.
*/
const PackSignature = effect.Schema.Struct({
	keyId: PackSigningKeyId,
	algorithm: effect.Schema.Literal("ed25519"),
	publicKey: PackBase64,
	manifestSha256: PackSha256,
	contentsSha256: effect.Schema.optional(PackSha256),
	signature: PackBase64,
	signedAt: IsoDateTime
});
/**
* The whole of `pack.json`. Sections are grouped by the question they answer —
* who made it, where it came from, what it does, what it has learned, what you
* must bring, how you touch it, how it runs, what it may reach, what production
* says about it, who may see it, how to wire it up, what it reports — because
* that is the order a consumer reads them in and the order the downstream
* surfaces consume them.
*
* `knowledge` sits directly after `capability` because "what does it do" and
* "what does it know that I do not" are asked together, and because the second
* question is the one this format exists to answer.
*/
const PackManifest = effect.Schema.Struct({
	formatVersion: PackFormatVersion,
	identity: PackIdentity,
	provenance: PackProvenance,
	capability: PackCapability,
	knowledge: PackKnowledge,
	requirements: PackRequirements,
	interfaces: effect.Schema.optional(effect.Schema.NonEmptyArray(PackInterface)),
	runtime: PackRuntime,
	permissions: PackPermissions,
	verification: PackVerification,
	visibility: PackVisibility,
	integration: PackIntegration,
	analytics: effect.Schema.optional(PackAnalytics),
	contents: effect.Schema.optional(PackContents),
	signature: effect.Schema.optional(PackSignature)
});
/**
* Read first, decoded loosely, so an unsupported format version produces a
* useful message instead of a pile of missing-field errors.
*/
const PackManifestEnvelope = effect.Schema.Struct({ formatVersion: TrimmedNonEmptyString }).annotate({ parseOptions: { onExcessProperty: "ignore" } });
/**
* One move of one release across a visibility boundary.
*
* A log rather than a `publishedAt`, because visibility widens and narrows: a
* release that was public for a month and then withdrawn is not the same thing
* as one that was never published, and a single timestamp cannot tell the two
* apart — nor can it say when a pack became visible to a tenant, which is the
* moment the tenant's installers date their trust from. Narrowing is just
* another entry, so nothing has to be closed out or back-dated.
*/
const PackPublication = effect.Schema.Struct({
	scope: PackVisibilityScope,
	at: IsoDateTime,
	by: effect.Schema.optional(PackAuthor)
});
/**
* One release, as the registry knows it rather than as the manifest describes
* it. The distinction is the whole reason this lives out here: `publications`
* changes every time somebody clicks publish, and `signals` changes every time
* a deployment survives another day, while a manifest is frozen at extraction
* and covered by a signature that a later edit would invalidate. A publish time
* written inside the artifact would have to be either wrong or unsigned.
*/
const PackRelease = effect.Schema.Struct({
	version: PackVersion,
	cutAt: IsoDateTime,
	publications: effect.Schema.Array(PackPublication),
	signals: effect.Schema.optional(PackScarRecord)
});
/**
* Every release the registry holds, newest first. `latestVersion` is stated
* rather than left to be inferred from the ordering, because the reader that
* most needs it is one holding an older manifest, and a manifest cannot know
* about releases cut after it.
*/
const PackReleaseHistory = effect.Schema.Struct({
	packId: PackId,
	latestVersion: PackVersion,
	releases: effect.Schema.NonEmptyArray(PackRelease)
});
/** Enough to name one exact release. */
const PackRef = effect.Schema.Struct({
	id: PackId,
	name: PackName,
	version: PackVersion,
	publisherHandle: PackHandle
});
/**
* What a search returns. Flattened out of the manifest so a coding agent can
* scan many candidates cheaply, and carrying the required keys because "what
* would I have to set up" is the first question that rules a pack out.
*
* The production signals travel here as raw counts rather than as a badge, so
* ranking happens at the consumer: pack mode can lead with "running in 340
* deployments and it handles the webhook idempotency case that breaks most
* implementations" only if the search result carries the numbers behind both
* halves of that sentence.
*/
const PackSummary = effect.Schema.Struct({
	ref: PackRef,
	displayName: TrimmedNonEmptyString,
	summary: PackSummaryText,
	does: PackSummaryText,
	categories: effect.Schema.optional(effect.Schema.Array(PackCategory)),
	tags: effect.Schema.optional(effect.Schema.Array(PackTag)),
	interfaceKinds: effect.Schema.NonEmptyArray(effect.Schema.Literals([
		"web",
		"tui",
		"api",
		"library",
		"cli",
		"mcp"
	])),
	requiredEnvironment: effect.Schema.Array(PackEnvVarName),
	requiredAccounts: effect.Schema.Array(PackSlug),
	installsAttempted: NonNegativeInt,
	installsSucceeded: NonNegativeInt,
	deploymentsSurviving: NonNegativeInt,
	cumulativeServiceDays: NonNegativeInt,
	breakagesCaught: NonNegativeInt,
	knownFailureModes: NonNegativeInt,
	openFailureModes: NonNegativeInt,
	integrationKnowledgeEntries: NonNegativeInt,
	knowledgeOldestObservedAt: effect.Schema.optional(IsoDateTime),
	hasAdvisory: effect.Schema.Boolean,
	visibilityScope: PackVisibilityScope,
	license: PackLicense,
	updatedAt: IsoDateTime
});
/**
* Rules that a well-formed manifest can still break. They are kept out of the
* schema on purpose: a half-finished pack must stay decodable so the tooling
* can tell its author what is missing, rather than refusing to open the file.
*/
const PackReadinessCode = effect.Schema.Literals([
	"handover-empty",
	"start-command-missing",
	"service-binding-missing",
	"integration-prompt-thin",
	"license-unspecified",
	"requirements-undeclared",
	"requirement-cost-undeclared",
	"permissions-undeclared",
	"secret-value-in-manifest",
	"elevated-capability-unjustified",
	"analytics-operation-unknown",
	"interface-service-unknown",
	"contents-digest-missing",
	"signature-missing",
	"knowledge-absent",
	"verification-record-unmeasured",
	"knowledge-conditions-stale",
	"knowledge-contradicted",
	"failure-mode-open-critical",
	"knowledge-reference-unknown",
	"credential-knowledge-unlinked",
	"customisation-boundary-unexplained",
	"check-never-run",
	"advisory-open"
]);
const PackReadinessIssue = effect.Schema.Struct({
	code: PackReadinessCode,
	severity: effect.Schema.Literals(["error", "warning"]),
	path: TrimmedNonEmptyString.check(effect.Schema.isMaxLength(256)),
	message: PackPurposeText
});
const PackReadinessReport = effect.Schema.Struct({
	ref: PackRef,
	publishable: effect.Schema.Boolean,
	issues: effect.Schema.Array(PackReadinessIssue)
});
var PackError = class extends effect.Schema.TaggedErrorClass()("PackError", {
	message: TrimmedNonEmptyString,
	code: effect.Schema.Literals([
		"manifest-not-found",
		"manifest-invalid",
		"format-version-unsupported",
		"signature-invalid",
		"digest-mismatch",
		"pack-not-found",
		"version-exists",
		"visibility-forbidden",
		"requirements-unmet",
		"signals-insufficient",
		"advisory-blocked"
	]),
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};

//#endregion
//#region ../../packages/contracts/src/packEnablement.ts
/**
* Which packs a project has turned on.
*
* Enabling is deliberately not installation. Nothing is copied, nothing is run,
* and no requirement is satisfied by the act — it records that this project
* intends to use this pack at this version, and that record is what lets a
* surface show the gap between what the pack needs and what the project has.
*
* The distinction matters because the alternative is a button that appears to
* do something and does not. A pack declares environment it cannot provide and
* commands it cannot run on your behalf; pretending otherwise would produce a
* project that reads as ready and fails on first use.
*
* @module packEnablement
*/
const PackEnablementId = effect.Schema.String.pipe(effect.Schema.brand("PackEnablementId"));
/**
* A value the project supplies for something the pack asked for. Only the name
* travels: a pack's secret requirement is satisfied by the server secret store,
* and putting the value here would move every credential into a projection.
*/
const PackEnablementSetting = effect.Schema.Struct({
	name: TrimmedNonEmptyString,
	provided: effect.Schema.Boolean,
	secretName: effect.Schema.optional(TrimmedNonEmptyString)
});
const PackEnablement = effect.Schema.Struct({
	id: PackEnablementId,
	projectId: ProjectId,
	packId: PackId,
	version: PackVersion,
	packName: TrimmedNonEmptyString,
	packSummary: TrimmedNonEmptyString,
	settings: effect.Schema.Array(PackEnablementSetting),
	enabledAt: IsoDateTime,
	disabledAt: effect.Schema.NullOr(IsoDateTime)
});
/** The registry is read as somebody, so enabling carries the same scope reading does. */
const ScopeFields = {
	tenantId: TenantId,
	workspaceId: WorkspaceId
};
const PackEnableInput = effect.Schema.Struct({
	...ScopeFields,
	projectId: ProjectId,
	packId: PackId,
	version: effect.Schema.optional(PackVersion)
});
const PackEnableResult = effect.Schema.Struct({ enablement: PackEnablement });
const PackDisableInput = effect.Schema.Struct({
	...ScopeFields,
	projectId: ProjectId,
	packId: PackId
});
const PackListEnablementsInput = effect.Schema.Struct({
	...ScopeFields,
	projectId: ProjectId
});
const PackListEnablementsResult = effect.Schema.Struct({ enablements: effect.Schema.Array(PackEnablement) });
const PackEnablementErrorCode = effect.Schema.Literals([
	"pack-not-found",
	"already-enabled",
	"not-enabled",
	"storage-failed"
]);
var PackEnablementError = class extends effect.Schema.TaggedErrorClass()("PackEnablementError", {
	code: PackEnablementErrorCode,
	message: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};

//#endregion
//#region ../../packages/contracts/src/deploy.ts
/**
* Deployment contracts.
*
* A deploy target describes how a project is shipped: either a command run
* inside the workspace, or a command run on a remote host over SSH. Runs
* record the outcome so agents and humans share the same history.
*
* A **deployment** is the third idea, and the one the first two cannot express:
* the thing that is live. A target is a recipe and a run is an event, so
* between them nothing answers "what is serving right now, at what URL, and
* which numbers does it report?" That question is what a deployment is for.
*
* @module deploy
*/
const DeployTargetId = effect.Schema.String.pipe(effect.Schema.brand("DeployTargetId"));
const DeployRunId = effect.Schema.String.pipe(effect.Schema.brand("DeployRunId"));
const DeployTargetKind = effect.Schema.Literals(["command", "ssh"]);
/**
* Remote host configuration. Passwords are stored in the server secret store,
* never in the projection, so only the secret name travels over the wire.
*/
const DeploySshConfig = effect.Schema.Struct({
	host: TrimmedNonEmptyString,
	user: TrimmedNonEmptyString,
	port: effect.Schema.optional(NonNegativeInt),
	identityFile: effect.Schema.optional(TrimmedNonEmptyString),
	passwordSecretName: effect.Schema.optional(TrimmedNonEmptyString),
	remotePath: effect.Schema.optional(TrimmedNonEmptyString)
});
const DeployTarget = effect.Schema.Struct({
	id: DeployTargetId,
	projectId: ProjectId,
	tenantId: effect.Schema.NullOr(TenantId),
	name: TrimmedNonEmptyString,
	kind: DeployTargetKind,
	command: TrimmedNonEmptyString,
	ssh: effect.Schema.NullOr(DeploySshConfig),
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime,
	archivedAt: effect.Schema.NullOr(IsoDateTime)
});
const DeployRunStatus = effect.Schema.Literals([
	"running",
	"succeeded",
	"failed"
]);
const DeployRun = effect.Schema.Struct({
	id: DeployRunId,
	targetId: DeployTargetId,
	projectId: ProjectId,
	status: DeployRunStatus,
	exitCode: effect.Schema.NullOr(effect.Schema.Int),
	output: effect.Schema.String,
	triggeredBy: TrimmedNonEmptyString,
	startedAt: IsoDateTime,
	completedAt: effect.Schema.NullOr(IsoDateTime)
});
/**
* Whether the deployment is believed to be serving. `unknown` is the honest
* default: nothing here probes the URL, so a deployment registered and never
* spoken about again should not keep claiming to be live.
*/
const DeploymentStatus = effect.Schema.Literals([
	"live",
	"stopped",
	"unknown"
]);
const DeploymentId = effect.Schema.String.pipe(effect.Schema.brand("DeploymentId"));
/**
* Something a project put live.
*
* `analyticsStreamIds` holds ids rather than names so the link survives a
* rename, and it is the whole of the deploy↔analytics connection: given a
* deployment you can reach its numbers, and given a stream you can find every
* deployment writing to it.
*/
const Deployment = effect.Schema.Struct({
	id: DeploymentId,
	projectId: ProjectId,
	targetId: DeployTargetId,
	name: TrimmedNonEmptyString,
	url: effect.Schema.NullOr(TrimmedNonEmptyString),
	status: DeploymentStatus,
	lastRunId: effect.Schema.NullOr(DeployRunId),
	analyticsStreamIds: effect.Schema.Array(AnalyticsStreamId),
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime,
	archivedAt: effect.Schema.NullOr(IsoDateTime)
});
const DeployCreateTargetInput = effect.Schema.Struct({
	projectId: ProjectId,
	name: TrimmedNonEmptyString,
	kind: DeployTargetKind,
	command: TrimmedNonEmptyString,
	ssh: effect.Schema.optional(DeploySshConfig)
});
const DeployListTargetsInput = effect.Schema.Struct({ projectId: effect.Schema.optional(ProjectId) });
const DeployListTargetsResult = effect.Schema.Struct({ targets: effect.Schema.Array(DeployTarget) });
const DeployCreateTargetResult = effect.Schema.Struct({ target: DeployTarget });
const DeployDeleteTargetInput = effect.Schema.Struct({ targetId: DeployTargetId });
/**
* Ask a deploy to hand the deployment a working ingest key.
*
* The key is minted during the deploy and injected into the deploy process's
* environment, and that is the only place it ever exists outside the deployment
* itself — it is not stored, not returned over the wire, and redacted out of the
* captured output. That is the whole point: an ingest key is kept hashed so a
* leaked database cannot write to anybody's numbers, so there is no later moment
* at which a key can be handed out. Declaring and injecting have to be the same
* step or one of those two properties has to go.
*
* If the stream already exists its key is reissued, which stops the old one
* working. A stream that other live deployments report to is therefore refused
* rather than quietly cut off.
*/
const DeployAnalyticsInjection = effect.Schema.Struct({
	stream: AnalyticsName,
	keyVariable: effect.Schema.optional(TrimmedNonEmptyString),
	purpose: effect.Schema.optional(TrimmedNonEmptyString),
	properties: effect.Schema.optional(effect.Schema.Array(AnalyticsProperty)),
	deploymentName: effect.Schema.optional(TrimmedNonEmptyString),
	url: effect.Schema.optional(TrimmedNonEmptyString)
});
const DeployRunInput = effect.Schema.Struct({
	targetId: DeployTargetId,
	analytics: effect.Schema.optional(DeployAnalyticsInjection)
});
const DeployRunResult = effect.Schema.Struct({ run: DeployRun });
const DeployListRunsInput = effect.Schema.Struct({
	projectId: effect.Schema.optional(ProjectId),
	targetId: effect.Schema.optional(DeployTargetId),
	limit: effect.Schema.optional(NonNegativeInt)
});
const DeployListRunsResult = effect.Schema.Struct({ runs: effect.Schema.Array(DeployRun) });
/**
* Streams are named rather than referenced by id here: the caller is usually an
* agent that has just read a stream list, or written the declaration itself, and
* a name is what it has in hand. The service resolves them, which is also what
* proves they were declared on this project.
*/
const DeploymentRegisterInput = effect.Schema.Struct({
	projectId: ProjectId,
	targetId: DeployTargetId,
	name: TrimmedNonEmptyString,
	url: effect.Schema.optional(TrimmedNonEmptyString),
	status: effect.Schema.optional(DeploymentStatus),
	lastRunId: effect.Schema.optional(DeployRunId),
	streams: effect.Schema.optional(effect.Schema.Array(AnalyticsName))
});
const DeploymentRegisterResult = effect.Schema.Struct({ deployment: Deployment });
const DeploymentListInput = effect.Schema.Struct({
	projectId: effect.Schema.optional(ProjectId),
	targetId: effect.Schema.optional(DeployTargetId)
});
const DeploymentListResult = effect.Schema.Struct({ deployments: effect.Schema.Array(Deployment) });
/**
* Every field is optional and an omitted one is left alone. `streams`, when
* given, replaces the set rather than adding to it — "these are the streams it
* reports to" is the only statement a caller can make without first reading
* what is already there.
*/
const DeploymentUpdateInput = effect.Schema.Struct({
	deploymentId: DeploymentId,
	url: effect.Schema.optional(TrimmedNonEmptyString),
	status: effect.Schema.optional(DeploymentStatus),
	lastRunId: effect.Schema.optional(DeployRunId),
	streams: effect.Schema.optional(effect.Schema.Array(AnalyticsName))
});
const DeploymentUpdateResult = effect.Schema.Struct({ deployment: Deployment });
const DeploymentArchiveInput = effect.Schema.Struct({ deploymentId: DeploymentId });
var DeployError = class extends effect.Schema.TaggedErrorClass()("DeployError", {
	code: effect.Schema.Literals([
		"target-not-found",
		"project-not-found",
		"invalid-target",
		"forbidden",
		"execution-failed",
		"deployment-not-found",
		"invalid-deployment",
		"analytics-conflict"
	]),
	message: effect.Schema.String,
	cause: effect.Schema.optional(effect.Schema.Defect)
}) {};

//#endregion
//#region ../../packages/contracts/src/rpc.ts
const WS_METHODS = {
	projectsList: "projects.list",
	projectsAdd: "projects.add",
	projectsRemove: "projects.remove",
	projectsListDirectory: "projects.listDirectory",
	projectsReadFile: "projects.readFile",
	projectsSearchEntries: "projects.searchEntries",
	projectsWriteFile: "projects.writeFile",
	projectsCreateEntry: "projects.createEntry",
	shellOpenInEditor: "shell.openInEditor",
	filesystemBrowse: "filesystem.browse",
	gitPull: "git.pull",
	gitRefreshStatus: "git.refreshStatus",
	gitGetWorkingTreeDiff: "git.getWorkingTreeDiff",
	gitRunStackedAction: "git.runStackedAction",
	gitListBranches: "git.listBranches",
	gitCreateWorktree: "git.createWorktree",
	gitRemoveWorktree: "git.removeWorktree",
	gitCreateBranch: "git.createBranch",
	gitCheckout: "git.checkout",
	gitInit: "git.init",
	gitMergeBranch: "git.mergeBranch",
	gitCompareBranches: "git.compareBranches",
	gitGetMergeState: "git.getMergeState",
	gitAbortMerge: "git.abortMerge",
	gitResolvePullRequest: "git.resolvePullRequest",
	gitPreparePullRequestThread: "git.preparePullRequestThread",
	terminalOpen: "terminal.open",
	terminalWrite: "terminal.write",
	terminalResize: "terminal.resize",
	terminalClear: "terminal.clear",
	terminalRestart: "terminal.restart",
	terminalClose: "terminal.close",
	serverGetConfig: "server.getConfig",
	serverRefreshProviders: "server.refreshProviders",
	serverUpsertKeybinding: "server.upsertKeybinding",
	serverGetSettings: "server.getSettings",
	serverUpdateSettings: "server.updateSettings",
	providerAccountsList: "providerAccounts.list",
	providerAccountsConnect: "providerAccounts.connect",
	providerAccountsOpenAuthTerminal: "providerAccounts.openAuthTerminal",
	providerAccountsConfirm: "providerAccounts.confirm",
	providerAccountsDisconnect: "providerAccounts.disconnect",
	providerSharingOverviewGet: "providerSharing.overview.get",
	providerSharingShareUpdate: "providerSharing.share.update",
	providerSharingPolicyUpdate: "providerSharing.policy.update",
	providerSharingMemberUpdate: "providerSharing.member.update",
	providerUsageRequestCreate: "providerUsage.request.create",
	providerUsageRequestList: "providerUsage.request.list",
	providerUsageRequestRespond: "providerUsage.request.respond",
	providerUsageRequestWithdraw: "providerUsage.request.withdraw",
	shareLinksCreate: "shareLinks.create",
	shareLinksList: "shareLinks.list",
	shareLinksRevoke: "shareLinks.revoke",
	cloudSyncStatusGet: "cloudSync.status.get",
	cloudSyncStart: "cloudSync.start",
	cloudSyncPause: "cloudSync.pause",
	cloudSyncStop: "cloudSync.stop",
	cloudSyncConflictsList: "cloudSync.conflicts.list",
	cloudSyncConflictsResolve: "cloudSync.conflicts.resolve",
	subscribeGitStatus: "subscribeGitStatus",
	subscribeTerminalEvents: "subscribeTerminalEvents",
	subscribeServerConfig: "subscribeServerConfig",
	subscribeServerLifecycle: "subscribeServerLifecycle",
	subscribeAuthAccess: "subscribeAuthAccess",
	collaborationPresenceUpsert: "collaboration.presence.upsert",
	collaborationPresenceList: "collaboration.presence.list",
	collaborationInvitesCreate: "collaboration.invites.create",
	collaborationInvitesList: "collaboration.invites.list",
	collaborationInvitesAccept: "collaboration.invites.accept",
	collaborationInvitesRevoke: "collaboration.invites.revoke",
	collaborationSharedPromptRecord: "collaboration.sharedPrompt.record",
	collaborationActivityList: "collaboration.activity.list",
	collaborationActivityVisibility: "collaboration.activity.visibility",
	collaborationSettingsGet: "collaboration.settings.get",
	collaborationSettingsUpdate: "collaboration.settings.update",
	collaborationApprovalsSubmit: "collaboration.approvals.submit",
	collaborationApprovalsList: "collaboration.approvals.list",
	collaborationApprovalsDecide: "collaboration.approvals.decide",
	collaborationViewGet: "collaboration.view.get",
	collaborationViewUpdate: "collaboration.view.update",
	collaborationBranchClaim: "collaboration.branch.claim",
	collaborationBranchList: "collaboration.branch.list",
	collaborationBranchRelease: "collaboration.branch.release",
	collaborationFilesTouch: "collaboration.files.touch",
	collaborationFilesTouchList: "collaboration.files.touchList",
	collaborationMembersList: "collaboration.members.list",
	collaborationMembersUpdate: "collaboration.members.update",
	collaborationMembersRemove: "collaboration.members.remove",
	collaborationUsageRecord: "collaboration.usage.record",
	collaborationUsageQuery: "collaboration.usage.query",
	collaborationConsentGet: "collaboration.consent.get",
	collaborationConsentUpdate: "collaboration.consent.update",
	subscribeCollaboration: "collaboration.subscribe",
	packsPublish: "packs.publish",
	packsRecordVersion: "packs.recordVersion",
	packsSearch: "packs.search",
	packsGet: "packs.get",
	packsListVersions: "packs.listVersions",
	packsSetVisibility: "packs.setVisibility",
	subscribePacks: "packs.subscribe",
	deployListTargets: "deploy.targets.list",
	deployCreateTarget: "deploy.targets.create",
	deployDeleteTarget: "deploy.targets.delete",
	deployRun: "deploy.run",
	deployListRuns: "deploy.runs.list",
	deployListDeployments: "deploy.deployments.list",
	deployRegisterDeployment: "deploy.deployments.register",
	deployUpdateDeployment: "deploy.deployments.update",
	deployArchiveDeployment: "deploy.deployments.archive",
	analyticsListStreams: "analytics.streams.list",
	analyticsDeclareStream: "analytics.streams.declare",
	analyticsQuery: "analytics.query",
	packsEnable: "packs.enable",
	packsDisable: "packs.disable",
	packsListEnablements: "packs.enablements.list",
	workspacesCreate: "workspaces.create",
	organizationsCreate: "organizations.create",
	organizationsList: "organizations.list",
	organizationEmployeesInvite: "organization.employees.invite",
	organizationEmployeesAcceptInvite: "organization.employees.acceptInvite",
	organizationEmployeesList: "organization.employees.list",
	organizationEmployeesUpdate: "organization.employees.update",
	organizationEmployeesDisable: "organization.employees.disable",
	organizationTeamsCreate: "organization.teams.create",
	organizationDepartmentsCreate: "organization.departments.create",
	organizationAccessGrant: "organization.access.grant",
	organizationAccessRevoke: "organization.access.revoke",
	organizationAccessReviewCreate: "organization.accessReview.create",
	organizationAccessReviewComplete: "organization.accessReview.complete",
	organizationAuditList: "organization.audit.list"
};
const WsServerUpsertKeybindingRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.serverUpsertKeybinding, {
	payload: ServerUpsertKeybindingInput,
	success: ServerUpsertKeybindingResult,
	error: KeybindingsConfigError
});
const WsServerGetConfigRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.serverGetConfig, {
	payload: effect.Schema.Struct({}),
	success: ServerConfig,
	error: effect.Schema.Union([KeybindingsConfigError, ServerSettingsError])
});
const WsServerRefreshProvidersRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.serverRefreshProviders, {
	payload: effect.Schema.Struct({}),
	success: ServerProviderUpdatedPayload
});
const WsServerGetSettingsRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.serverGetSettings, {
	payload: effect.Schema.Struct({}),
	success: ServerSettings,
	error: ServerSettingsError
});
const WsServerUpdateSettingsRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.serverUpdateSettings, {
	payload: effect.Schema.Struct({ patch: ServerSettingsPatch }),
	success: ServerSettings,
	error: ServerSettingsError
});
const WsProviderAccountsListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerAccountsList, {
	payload: ProviderAccountListInput,
	success: ProviderAccountListResult,
	error: ProviderAccountError
});
const WsProviderAccountsConnectRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerAccountsConnect, {
	payload: ProviderAccountConnectInput,
	success: ProviderAccountConnectResult,
	error: ProviderAccountError
});
const WsProviderAccountsOpenAuthTerminalRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerAccountsOpenAuthTerminal, {
	payload: ProviderAccountOpenAuthTerminalInput,
	success: ProviderAccountOpenAuthTerminalResult,
	error: ProviderAccountError
});
const WsProviderAccountsConfirmRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerAccountsConfirm, {
	payload: ProviderAccountConfirmInput,
	success: ProviderAccountConfirmResult,
	error: ProviderAccountError
});
const WsProviderAccountsDisconnectRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerAccountsDisconnect, {
	payload: ProviderAccountDisconnectInput,
	success: ProviderAccountDisconnectResult,
	error: ProviderAccountError
});
const WsProviderSharingOverviewGetRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerSharingOverviewGet, {
	payload: ProviderSharingOverviewGetInput,
	success: ProviderSharingOverviewResult,
	error: ProviderSharingError
});
const WsProviderSharingShareUpdateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerSharingShareUpdate, {
	payload: ProviderSharingShareUpdateInput,
	success: ProviderSharingShareUpdateResult,
	error: ProviderSharingError
});
const WsProviderSharingPolicyUpdateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerSharingPolicyUpdate, {
	payload: ProviderSharingPolicyUpdateInput,
	success: ProviderSharingPolicyUpdateResult,
	error: ProviderSharingError
});
const WsProviderSharingMemberUpdateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerSharingMemberUpdate, {
	payload: ProviderSharingMemberUpdateInput,
	success: ProviderSharingMemberUpdateResult,
	error: ProviderSharingError
});
const WsProviderUsageRequestCreateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerUsageRequestCreate, {
	payload: ProviderUsageRequestCreateInput,
	success: ProviderUsageRequestCreateResult,
	error: ProviderUsageError
});
const WsProviderUsageRequestListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerUsageRequestList, {
	payload: ProviderUsageRequestListInput,
	success: ProviderUsageRequestListResult,
	error: ProviderUsageError
});
const WsProviderUsageRequestRespondRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerUsageRequestRespond, {
	payload: ProviderUsageRequestRespondInput,
	success: ProviderUsageRequestRespondResult,
	error: ProviderUsageError
});
const WsProviderUsageRequestWithdrawRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.providerUsageRequestWithdraw, {
	payload: ProviderUsageRequestWithdrawInput,
	success: ProviderUsageRequestWithdrawResult,
	error: ProviderUsageError
});
const WsShareLinksCreateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.shareLinksCreate, {
	payload: ShareLinkCreateInput,
	success: ShareLinkCreateResult,
	error: ShareLinkError
});
const WsShareLinksListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.shareLinksList, {
	payload: ShareLinkListInput,
	success: ShareLinkListResult,
	error: ShareLinkError
});
const WsShareLinksRevokeRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.shareLinksRevoke, {
	payload: ShareLinkRevokeInput,
	success: ShareLinkRevokeResult,
	error: ShareLinkError
});
const WsCloudSyncStatusGetRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.cloudSyncStatusGet, {
	payload: CloudSyncStatusGetInput,
	success: CloudSyncStatusResult,
	error: CloudSyncError
});
const WsCloudSyncStartRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.cloudSyncStart, {
	payload: CloudSyncStartInput,
	success: CloudSyncStartResult,
	error: CloudSyncError
});
const WsCloudSyncPauseRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.cloudSyncPause, {
	payload: CloudSyncPauseInput,
	success: CloudSyncPauseResult,
	error: CloudSyncError
});
const WsCloudSyncStopRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.cloudSyncStop, {
	payload: CloudSyncStopInput,
	success: CloudSyncStopResult,
	error: CloudSyncError
});
const WsCloudSyncConflictsListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.cloudSyncConflictsList, {
	payload: CloudSyncConflictListInput,
	success: CloudSyncConflictListResult,
	error: CloudSyncError
});
const WsCloudSyncConflictsResolveRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.cloudSyncConflictsResolve, {
	payload: CloudSyncConflictResolveInput,
	success: CloudSyncConflictResolveResult,
	error: CloudSyncError
});
const WsProjectsSearchEntriesRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.projectsSearchEntries, {
	payload: ProjectSearchEntriesInput,
	success: ProjectSearchEntriesResult,
	error: ProjectSearchEntriesError
});
const WsProjectsListDirectoryRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.projectsListDirectory, {
	payload: ProjectListDirectoryInput,
	success: ProjectListDirectoryResult,
	error: ProjectListDirectoryError
});
const WsProjectsReadFileRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.projectsReadFile, {
	payload: ProjectReadFileInput,
	success: ProjectReadFileResult,
	error: ProjectReadFileError
});
const WsProjectsWriteFileRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.projectsWriteFile, {
	payload: ProjectWriteFileInput,
	success: ProjectWriteFileResult,
	error: ProjectWriteFileError
});
const WsProjectsCreateEntryRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.projectsCreateEntry, {
	payload: ProjectCreateEntryInput,
	success: ProjectCreateEntryResult,
	error: ProjectCreateEntryError
});
const WsShellOpenInEditorRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.shellOpenInEditor, {
	payload: OpenInEditorInput,
	error: OpenError
});
const WsFilesystemBrowseRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.filesystemBrowse, {
	payload: FilesystemBrowseInput,
	success: FilesystemBrowseResult,
	error: FilesystemBrowseError
});
const WsSubscribeGitStatusRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.subscribeGitStatus, {
	payload: GitStatusInput,
	success: GitStatusStreamEvent,
	error: GitManagerServiceError,
	stream: true
});
const WsGitPullRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitPull, {
	payload: GitPullInput,
	success: GitPullResult,
	error: GitCommandError
});
const WsGitRefreshStatusRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitRefreshStatus, {
	payload: GitStatusInput,
	success: GitStatusResult,
	error: GitManagerServiceError
});
const WsGitGetWorkingTreeDiffRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitGetWorkingTreeDiff, {
	payload: GitGetWorkingTreeDiffInput,
	success: GitGetWorkingTreeDiffResult,
	error: GitCommandError
});
const WsGitRunStackedActionRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitRunStackedAction, {
	payload: GitRunStackedActionInput,
	success: GitActionProgressEvent,
	error: GitManagerServiceError,
	stream: true
});
const WsGitResolvePullRequestRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitResolvePullRequest, {
	payload: GitPullRequestRefInput,
	success: GitResolvePullRequestResult,
	error: GitManagerServiceError
});
const WsGitPreparePullRequestThreadRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
	payload: GitPreparePullRequestThreadInput,
	success: GitPreparePullRequestThreadResult,
	error: GitManagerServiceError
});
const WsGitListBranchesRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitListBranches, {
	payload: GitListBranchesInput,
	success: GitListBranchesResult,
	error: GitCommandError
});
const WsGitCreateWorktreeRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitCreateWorktree, {
	payload: GitCreateWorktreeInput,
	success: GitCreateWorktreeResult,
	error: GitCommandError
});
const WsGitRemoveWorktreeRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitRemoveWorktree, {
	payload: GitRemoveWorktreeInput,
	error: GitCommandError
});
const WsGitCreateBranchRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitCreateBranch, {
	payload: GitCreateBranchInput,
	success: GitCreateBranchResult,
	error: GitCommandError
});
const WsGitCheckoutRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitCheckout, {
	payload: GitCheckoutInput,
	success: GitCheckoutResult,
	error: GitCommandError
});
const WsGitInitRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitInit, {
	payload: GitInitInput,
	error: GitCommandError
});
/**
* Reading only. Declaring a stream hands back an ingest key, which is write
* access to a project's numbers — that stays on the CLI rather than becoming
* something a browser session can mint.
*/
const WsPacksEnableRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.packsEnable, {
	payload: PackEnableInput,
	success: PackEnableResult,
	error: PackEnablementError
});
const WsPacksDisableRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.packsDisable, {
	payload: PackDisableInput,
	error: PackEnablementError
});
const WsPacksListEnablementsRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.packsListEnablements, {
	payload: PackListEnablementsInput,
	success: PackListEnablementsResult,
	error: PackEnablementError
});
const WsAnalyticsListStreamsRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.analyticsListStreams, {
	payload: AnalyticsListStreamsInput,
	success: AnalyticsListStreamsResult,
	error: AnalyticsError
});
/**
* Declaring was reachable only from the CLI, so an agent inside a session could
* not open a stream for the thing it had just built without shelling out —
* and nothing told it the option existed. The ingest key comes back here for
* the same reason it does on the CLI: this is the only moment it exists.
*/
const WsAnalyticsDeclareStreamRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.analyticsDeclareStream, {
	payload: AnalyticsDeclareStreamInput,
	success: AnalyticsDeclareStreamResult,
	error: AnalyticsError
});
const WsAnalyticsQueryRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.analyticsQuery, {
	payload: AnalyticsQueryInput,
	success: AnalyticsQueryResult,
	error: AnalyticsError
});
const WsDeployListTargetsRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.deployListTargets, {
	payload: DeployListTargetsInput,
	success: DeployListTargetsResult,
	error: DeployError
});
const WsDeployCreateTargetRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.deployCreateTarget, {
	payload: DeployCreateTargetInput,
	success: DeployCreateTargetResult,
	error: DeployError
});
const WsDeployDeleteTargetRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.deployDeleteTarget, {
	payload: DeployDeleteTargetInput,
	error: DeployError
});
const WsDeployRunRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.deployRun, {
	payload: DeployRunInput,
	success: DeployRunResult,
	error: DeployError
});
const WsDeployListRunsRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.deployListRuns, {
	payload: DeployListRunsInput,
	success: DeployListRunsResult,
	error: DeployError
});
const WsDeployListDeploymentsRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.deployListDeployments, {
	payload: DeploymentListInput,
	success: DeploymentListResult,
	error: DeployError
});
const WsDeployRegisterDeploymentRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.deployRegisterDeployment, {
	payload: DeploymentRegisterInput,
	success: DeploymentRegisterResult,
	error: DeployError
});
const WsDeployUpdateDeploymentRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.deployUpdateDeployment, {
	payload: DeploymentUpdateInput,
	success: DeploymentUpdateResult,
	error: DeployError
});
const WsDeployArchiveDeploymentRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.deployArchiveDeployment, {
	payload: DeploymentArchiveInput,
	error: DeployError
});
const WsGitMergeBranchRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitMergeBranch, {
	payload: GitMergeBranchInput,
	success: GitMergeBranchResult,
	error: GitCommandError
});
const WsGitCompareBranchesRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitCompareBranches, {
	payload: GitCompareBranchesInput,
	success: GitCompareBranchesResult,
	error: GitCommandError
});
const WsGitGetMergeStateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitGetMergeState, {
	payload: GitMergeStateInput,
	success: GitMergeStateResult,
	error: GitCommandError
});
const WsGitAbortMergeRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.gitAbortMerge, {
	payload: GitAbortMergeInput,
	success: GitAbortMergeResult,
	error: GitCommandError
});
const WsTerminalOpenRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.terminalOpen, {
	payload: TerminalOpenInput,
	success: TerminalSessionSnapshot,
	error: TerminalError
});
const WsTerminalWriteRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.terminalWrite, {
	payload: TerminalWriteInput,
	error: TerminalError
});
const WsTerminalResizeRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.terminalResize, {
	payload: TerminalResizeInput,
	error: TerminalError
});
const WsTerminalClearRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.terminalClear, {
	payload: TerminalClearInput,
	error: TerminalError
});
const WsTerminalRestartRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.terminalRestart, {
	payload: TerminalRestartInput,
	success: TerminalSessionSnapshot,
	error: TerminalError
});
const WsTerminalCloseRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.terminalClose, {
	payload: TerminalCloseInput,
	error: TerminalError
});
const WsOrchestrationDispatchCommandRpc = effect_unstable_rpc_Rpc.make(ORCHESTRATION_WS_METHODS.dispatchCommand, {
	payload: ClientOrchestrationCommand,
	success: OrchestrationRpcSchemas.dispatchCommand.output,
	error: OrchestrationDispatchCommandError
});
const WsOrchestrationGetTurnDiffRpc = effect_unstable_rpc_Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
	payload: OrchestrationGetTurnDiffInput,
	success: OrchestrationRpcSchemas.getTurnDiff.output,
	error: OrchestrationGetTurnDiffError
});
const WsOrchestrationGetFullThreadDiffRpc = effect_unstable_rpc_Rpc.make(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
	payload: OrchestrationGetFullThreadDiffInput,
	success: OrchestrationRpcSchemas.getFullThreadDiff.output,
	error: OrchestrationGetFullThreadDiffError
});
const WsOrchestrationReplayEventsRpc = effect_unstable_rpc_Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
	payload: OrchestrationReplayEventsInput,
	success: OrchestrationRpcSchemas.replayEvents.output,
	error: OrchestrationReplayEventsError
});
const WsOrchestrationSubscribeShellRpc = effect_unstable_rpc_Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
	payload: OrchestrationRpcSchemas.subscribeShell.input,
	success: OrchestrationRpcSchemas.subscribeShell.output,
	error: OrchestrationGetSnapshotError,
	stream: true
});
const WsOrchestrationSubscribeThreadRpc = effect_unstable_rpc_Rpc.make(ORCHESTRATION_WS_METHODS.subscribeThread, {
	payload: OrchestrationRpcSchemas.subscribeThread.input,
	success: OrchestrationRpcSchemas.subscribeThread.output,
	error: OrchestrationGetSnapshotError,
	stream: true
});
const WsSubscribeTerminalEventsRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.subscribeTerminalEvents, {
	payload: effect.Schema.Struct({}),
	success: TerminalEvent,
	stream: true
});
const WsSubscribeServerConfigRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.subscribeServerConfig, {
	payload: effect.Schema.Struct({}),
	success: ServerConfigStreamEvent,
	error: effect.Schema.Union([KeybindingsConfigError, ServerSettingsError]),
	stream: true
});
const WsSubscribeServerLifecycleRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.subscribeServerLifecycle, {
	payload: effect.Schema.Struct({}),
	success: ServerLifecycleStreamEvent,
	stream: true
});
const WsSubscribeAuthAccessRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.subscribeAuthAccess, {
	payload: effect.Schema.Struct({}),
	success: AuthAccessStreamEvent,
	stream: true
});
const WsCollaborationPresenceUpsertRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationPresenceUpsert, {
	payload: CollaborationPresenceUpsertInput,
	success: CollaborationPresenceUpsertResult,
	error: CollaborationError
});
const WsCollaborationPresenceListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationPresenceList, {
	payload: CollaborationPresenceListInput,
	success: CollaborationPresenceListResult,
	error: CollaborationError
});
const WsCollaborationInvitesCreateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationInvitesCreate, {
	payload: CollaborationInviteCreateInput,
	success: CollaborationInviteCreateResult,
	error: CollaborationError
});
const WsCollaborationInvitesListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationInvitesList, {
	payload: CollaborationInviteListInput,
	success: CollaborationInviteListResult,
	error: CollaborationError
});
const WsCollaborationInvitesAcceptRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationInvitesAccept, {
	payload: CollaborationInviteAcceptInput,
	success: CollaborationInviteAcceptResult,
	error: CollaborationError
});
const WsCollaborationInvitesRevokeRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationInvitesRevoke, {
	payload: CollaborationInviteRevokeInput,
	success: CollaborationInviteRevokeResult,
	error: CollaborationError
});
const WsCollaborationSharedPromptRecordRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationSharedPromptRecord, {
	payload: CollaborationSharedPromptRecordInput,
	success: CollaborationSharedPromptRecordResult,
	error: CollaborationError
});
const WsCollaborationActivityListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationActivityList, {
	payload: CollaborationActivityListInput,
	success: CollaborationActivityListResult,
	error: CollaborationError
});
const WsCollaborationSettingsGetRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationSettingsGet, {
	payload: CollaborationSettingsGetInput,
	success: CollaborationSettingsResult,
	error: CollaborationError
});
const WsCollaborationSettingsUpdateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationSettingsUpdate, {
	payload: CollaborationSettingsUpdateInput,
	success: CollaborationSettingsResult,
	error: CollaborationError
});
const WsCollaborationApprovalsSubmitRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationApprovalsSubmit, {
	payload: CollaborationApprovalSubmitInput,
	success: CollaborationApprovalSubmitResult,
	error: CollaborationError
});
const WsCollaborationApprovalsListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationApprovalsList, {
	payload: CollaborationApprovalListInput,
	success: CollaborationApprovalListResult,
	error: CollaborationError
});
const WsCollaborationApprovalsDecideRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationApprovalsDecide, {
	payload: CollaborationApprovalDecideInput,
	success: CollaborationApprovalDecideResult,
	error: CollaborationError
});
const WsCollaborationViewGetRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationViewGet, {
	payload: CollaborationViewGetInput,
	success: CollaborationViewResult,
	error: CollaborationError
});
const WsCollaborationViewUpdateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationViewUpdate, {
	payload: CollaborationViewUpdateInput,
	success: CollaborationViewResult,
	error: CollaborationError
});
const WsCollaborationBranchClaimRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationBranchClaim, {
	payload: CollaborationBranchClaimInput,
	success: CollaborationBranchClaimResult,
	error: CollaborationError
});
const WsCollaborationBranchListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationBranchList, {
	payload: CollaborationBranchListInput,
	success: CollaborationBranchListResult,
	error: CollaborationError
});
const WsCollaborationBranchReleaseRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationBranchRelease, {
	payload: CollaborationBranchReleaseInput,
	success: CollaborationBranchReleaseResult,
	error: CollaborationError
});
const WsCollaborationFilesTouchRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationFilesTouch, {
	payload: CollaborationFileTouchInput,
	success: CollaborationFileTouchResult,
	error: CollaborationError
});
const WsCollaborationFilesTouchListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationFilesTouchList, {
	payload: CollaborationFileTouchListInput,
	success: CollaborationFileTouchResult,
	error: CollaborationError
});
const WsCollaborationActivityVisibilityRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationActivityVisibility, {
	payload: CollaborationActivityVisibilityInput,
	success: CollaborationActivityVisibilityResult,
	error: CollaborationError
});
const WsCollaborationMembersListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationMembersList, {
	payload: CollaborationMemberListInput,
	success: CollaborationMemberListResult,
	error: CollaborationError
});
const WsCollaborationMembersUpdateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationMembersUpdate, {
	payload: CollaborationMemberUpdateInput,
	success: CollaborationMemberResult,
	error: CollaborationError
});
const WsCollaborationMembersRemoveRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationMembersRemove, {
	payload: CollaborationMemberRemoveInput,
	success: CollaborationMemberRemoveResult,
	error: CollaborationError
});
const WsCollaborationUsageRecordRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationUsageRecord, {
	payload: CollaborationUsageRecordInput,
	success: CollaborationMemberResult,
	error: CollaborationError
});
const WsCollaborationUsageQueryRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationUsageQuery, {
	payload: CollaborationUsageQueryInput,
	success: CollaborationUsageQueryResult,
	error: CollaborationError
});
const WsCollaborationConsentGetRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationConsentGet, {
	payload: CollaborationConsentGetInput,
	success: CollaborationConsentResult,
	error: CollaborationError
});
const WsCollaborationConsentUpdateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.collaborationConsentUpdate, {
	payload: CollaborationConsentUpdateInput,
	success: CollaborationConsentResult,
	error: CollaborationError
});
const WsSubscribeCollaborationRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.subscribeCollaboration, {
	payload: CollaborationStreamInput,
	success: CollaborationStreamEvent,
	error: CollaborationError,
	stream: true
});
/**
* What one server's registry has recorded about a pack. These projections live
* beside the RPC rather than in `pack.ts` because they are not part of the pack
* format: a manifest describes a pack, and an entry describes what a particular
* registry knows about it — who published it, and who may currently see it.
*/
const PackRegistryEntry = effect.Schema.Struct({
	packId: PackId,
	tenantId: TenantId,
	workspaceId: WorkspaceId,
	name: PackName,
	publisherHandle: PackHandle,
	displayName: TrimmedNonEmptyString,
	summary: TrimmedNonEmptyString,
	capabilitySummary: TrimmedNonEmptyString,
	tags: effect.Schema.Array(PackTag),
	visibility: PackVisibility,
	latestVersion: PackVersion,
	createdAt: IsoDateTime,
	updatedAt: IsoDateTime
});
/** One immutable release. Nothing here is ever rewritten. */
const PackRegistryVersion = effect.Schema.Struct({
	packId: PackId,
	version: PackVersion,
	capabilitySummary: TrimmedNonEmptyString,
	publishedByUserId: UserId,
	publishedAt: IsoDateTime
});
/**
* The workspace a pack request is made from.
*
* The organizations a caller belongs to are deliberately absent: the server
* fills those from the session, because a viewer scope that arrives on the wire
* is a claim, and a caller that could name any organization could read every
* pack listed to it.
*/
const PackWorkspaceScopeFields = {
	tenantId: TenantId,
	workspaceId: WorkspaceId
};
const PackPublishInput = effect.Schema.Struct({
	...PackWorkspaceScopeFields,
	manifest: PackManifest
});
const PackVersionInput = effect.Schema.Struct({
	...PackWorkspaceScopeFields,
	packId: PackId,
	manifest: PackManifest
});
const PackSearchInput = effect.Schema.Struct({
	...PackWorkspaceScopeFields,
	query: effect.Schema.optional(effect.Schema.String),
	limit: effect.Schema.optional(effect.Schema.Int)
});
const PackGetInput = effect.Schema.Struct({
	...PackWorkspaceScopeFields,
	packId: PackId,
	version: effect.Schema.optional(PackVersion)
});
const PackVersionListInput = effect.Schema.Struct({
	...PackWorkspaceScopeFields,
	packId: PackId
});
const PackVisibilityInput = effect.Schema.Struct({
	...PackWorkspaceScopeFields,
	packId: PackId,
	visibility: PackVisibility
});
const PackStreamInput = effect.Schema.Struct(PackWorkspaceScopeFields);
const PackPublishResult = effect.Schema.Struct({
	pack: PackRegistryEntry,
	version: PackRegistryVersion
});
const PackSearchResult = effect.Schema.Struct({ packs: effect.Schema.Array(PackRegistryEntry) });
const PackGetResult = effect.Schema.Struct({
	pack: PackRegistryEntry,
	version: PackRegistryVersion,
	manifest: PackManifest
});
const PackVersionListResult = effect.Schema.Struct({
	pack: PackRegistryEntry,
	versions: effect.Schema.Array(PackRegistryVersion)
});
const PackVisibilityResult = effect.Schema.Struct({ pack: PackRegistryEntry });
const PackRegistryStreamEvent = effect.Schema.Union([
	effect.Schema.Struct({
		type: effect.Schema.Literal("pack-published"),
		pack: PackRegistryEntry
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("pack-version-recorded"),
		pack: PackRegistryEntry,
		version: PackRegistryVersion
	}),
	effect.Schema.Struct({
		type: effect.Schema.Literal("pack-visibility-changed"),
		pack: PackRegistryEntry
	})
]);
const WsPacksPublishRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.packsPublish, {
	payload: PackPublishInput,
	success: PackPublishResult,
	error: PackError
});
const WsPacksRecordVersionRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.packsRecordVersion, {
	payload: PackVersionInput,
	success: PackPublishResult,
	error: PackError
});
const WsPacksSearchRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.packsSearch, {
	payload: PackSearchInput,
	success: PackSearchResult,
	error: PackError
});
const WsPacksGetRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.packsGet, {
	payload: PackGetInput,
	success: PackGetResult,
	error: PackError
});
const WsPacksListVersionsRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.packsListVersions, {
	payload: PackVersionListInput,
	success: PackVersionListResult,
	error: PackError
});
const WsPacksSetVisibilityRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.packsSetVisibility, {
	payload: PackVisibilityInput,
	success: PackVisibilityResult,
	error: PackError
});
const WsSubscribePacksRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.subscribePacks, {
	payload: PackStreamInput,
	success: PackRegistryStreamEvent,
	error: PackError,
	stream: true
});
const WsWorkspacesCreateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.workspacesCreate, {
	payload: WorkspaceCreateInput,
	success: WorkspaceCreateResult,
	error: OrganizationError
});
const WsOrganizationsCreateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationsCreate, {
	payload: OrganizationCreateInput,
	success: OrganizationCreateResult,
	error: OrganizationError
});
const WsOrganizationsListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationsList, {
	payload: effect.Schema.Struct({}),
	success: OrganizationListResult,
	error: OrganizationError
});
const WsOrganizationEmployeesInviteRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationEmployeesInvite, {
	payload: OrganizationEmployeeInviteInput,
	success: OrganizationEmployeeInviteResult,
	error: OrganizationError
});
const WsOrganizationEmployeesAcceptInviteRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationEmployeesAcceptInvite, {
	payload: OrganizationEmployeeInviteAcceptInput,
	success: OrganizationEmployeeInviteAcceptResult,
	error: OrganizationError
});
const WsOrganizationEmployeesListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationEmployeesList, {
	payload: OrganizationEmployeeListInput,
	success: OrganizationEmployeeListResult,
	error: OrganizationError
});
const WsOrganizationEmployeesUpdateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationEmployeesUpdate, {
	payload: OrganizationEmployeeUpdateInput,
	success: OrganizationEmployeeUpdateResult,
	error: OrganizationError
});
const WsOrganizationEmployeesDisableRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationEmployeesDisable, {
	payload: OrganizationEmployeeDisableInput,
	success: OrganizationEmployeeUpdateResult,
	error: OrganizationError
});
const WsOrganizationTeamsCreateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationTeamsCreate, {
	payload: OrganizationTeamCreateInput,
	success: OrganizationTeamCreateResult,
	error: OrganizationError
});
const WsOrganizationDepartmentsCreateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationDepartmentsCreate, {
	payload: OrganizationDepartmentCreateInput,
	success: OrganizationDepartmentCreateResult,
	error: OrganizationError
});
const WsOrganizationAccessGrantRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationAccessGrant, {
	payload: OrganizationAccessGrantInput,
	success: OrganizationAccessGrantResult,
	error: OrganizationError
});
const WsOrganizationAccessRevokeRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationAccessRevoke, {
	payload: OrganizationAccessRevokeInput,
	success: OrganizationAccessRevokeResult,
	error: OrganizationError
});
const WsOrganizationAccessReviewCreateRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationAccessReviewCreate, {
	payload: OrganizationAccessReviewCreateInput,
	success: OrganizationAccessReviewCreateResult,
	error: OrganizationError
});
const WsOrganizationAccessReviewCompleteRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationAccessReviewComplete, {
	payload: OrganizationAccessReviewCompleteInput,
	success: OrganizationAccessReviewCompleteResult,
	error: OrganizationError
});
const WsOrganizationAuditListRpc = effect_unstable_rpc_Rpc.make(WS_METHODS.organizationAuditList, {
	payload: OrganizationAuditListInput,
	success: OrganizationAuditListResult,
	error: OrganizationError
});
const WsRpcGroup = effect_unstable_rpc_RpcGroup.make(WsServerGetConfigRpc, WsServerRefreshProvidersRpc, WsServerUpsertKeybindingRpc, WsServerGetSettingsRpc, WsServerUpdateSettingsRpc, WsProviderAccountsListRpc, WsProviderAccountsConnectRpc, WsProviderAccountsOpenAuthTerminalRpc, WsProviderAccountsConfirmRpc, WsProviderAccountsDisconnectRpc, WsProviderSharingOverviewGetRpc, WsProviderSharingShareUpdateRpc, WsProviderSharingPolicyUpdateRpc, WsProviderSharingMemberUpdateRpc, WsProviderUsageRequestCreateRpc, WsProviderUsageRequestListRpc, WsProviderUsageRequestRespondRpc, WsProviderUsageRequestWithdrawRpc, WsShareLinksCreateRpc, WsShareLinksListRpc, WsShareLinksRevokeRpc, WsCloudSyncStatusGetRpc, WsCloudSyncStartRpc, WsCloudSyncPauseRpc, WsCloudSyncStopRpc, WsCloudSyncConflictsListRpc, WsCloudSyncConflictsResolveRpc, WsProjectsSearchEntriesRpc, WsProjectsListDirectoryRpc, WsProjectsReadFileRpc, WsProjectsWriteFileRpc, WsProjectsCreateEntryRpc, WsShellOpenInEditorRpc, WsFilesystemBrowseRpc, WsSubscribeGitStatusRpc, WsGitPullRpc, WsGitRefreshStatusRpc, WsGitGetWorkingTreeDiffRpc, WsGitRunStackedActionRpc, WsGitResolvePullRequestRpc, WsGitPreparePullRequestThreadRpc, WsGitListBranchesRpc, WsGitCreateWorktreeRpc, WsGitRemoveWorktreeRpc, WsGitCreateBranchRpc, WsGitCheckoutRpc, WsGitInitRpc, WsGitMergeBranchRpc, WsGitCompareBranchesRpc, WsGitGetMergeStateRpc, WsGitAbortMergeRpc, WsDeployListTargetsRpc, WsDeployCreateTargetRpc, WsDeployDeleteTargetRpc, WsDeployRunRpc, WsDeployListRunsRpc, WsDeployListDeploymentsRpc, WsDeployRegisterDeploymentRpc, WsDeployUpdateDeploymentRpc, WsDeployArchiveDeploymentRpc, WsAnalyticsListStreamsRpc, WsAnalyticsDeclareStreamRpc, WsAnalyticsQueryRpc, WsPacksEnableRpc, WsPacksDisableRpc, WsPacksListEnablementsRpc, WsTerminalOpenRpc, WsTerminalWriteRpc, WsTerminalResizeRpc, WsTerminalClearRpc, WsTerminalRestartRpc, WsTerminalCloseRpc, WsSubscribeTerminalEventsRpc, WsSubscribeServerConfigRpc, WsSubscribeServerLifecycleRpc, WsSubscribeAuthAccessRpc, WsCollaborationPresenceUpsertRpc, WsCollaborationPresenceListRpc, WsCollaborationInvitesCreateRpc, WsCollaborationInvitesListRpc, WsCollaborationInvitesAcceptRpc, WsCollaborationInvitesRevokeRpc, WsCollaborationSharedPromptRecordRpc, WsCollaborationActivityListRpc, WsCollaborationSettingsGetRpc, WsCollaborationSettingsUpdateRpc, WsCollaborationApprovalsSubmitRpc, WsCollaborationApprovalsListRpc, WsCollaborationApprovalsDecideRpc, WsCollaborationViewGetRpc, WsCollaborationViewUpdateRpc, WsCollaborationBranchClaimRpc, WsCollaborationBranchListRpc, WsCollaborationBranchReleaseRpc, WsCollaborationFilesTouchRpc, WsCollaborationFilesTouchListRpc, WsCollaborationActivityVisibilityRpc, WsCollaborationMembersListRpc, WsCollaborationMembersUpdateRpc, WsCollaborationMembersRemoveRpc, WsCollaborationUsageRecordRpc, WsCollaborationUsageQueryRpc, WsCollaborationConsentGetRpc, WsCollaborationConsentUpdateRpc, WsSubscribeCollaborationRpc, WsPacksPublishRpc, WsPacksRecordVersionRpc, WsPacksSearchRpc, WsPacksGetRpc, WsPacksListVersionsRpc, WsPacksSetVisibilityRpc, WsSubscribePacksRpc, WsWorkspacesCreateRpc, WsOrganizationsCreateRpc, WsOrganizationsListRpc, WsOrganizationEmployeesInviteRpc, WsOrganizationEmployeesAcceptInviteRpc, WsOrganizationEmployeesListRpc, WsOrganizationEmployeesUpdateRpc, WsOrganizationEmployeesDisableRpc, WsOrganizationTeamsCreateRpc, WsOrganizationDepartmentsCreateRpc, WsOrganizationAccessGrantRpc, WsOrganizationAccessRevokeRpc, WsOrganizationAccessReviewCreateRpc, WsOrganizationAccessReviewCompleteRpc, WsOrganizationAuditListRpc, WsOrchestrationDispatchCommandRpc, WsOrchestrationGetTurnDiffRpc, WsOrchestrationGetFullThreadDiffRpc, WsOrchestrationReplayEventsRpc, WsOrchestrationSubscribeShellRpc, WsOrchestrationSubscribeThreadRpc);

//#endregion
//#region ../../packages/shared/src/schemaJson.ts
/**
* A `Getter` that parses a lenient JSON string (tolerating trailing commas
* and JS-style comments) into an unknown value.
*
* Mirrors `SchemaGetter.parseJson()` but uses `parseLenientJson` instead
* of `JSON.parse`.
*/
const parseLenientJsonGetter = effect.SchemaGetter.onSome((input) => effect.Effect.try({
	try: () => {
		let stripped = input.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (match, stringLiteral) => stringLiteral ? match : "");
		stripped = stripped.replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g, (match, stringLiteral) => stringLiteral ? match : "");
		stripped = stripped.replace(/,(\s*[}\]])/g, "$1");
		return effect.Option.some(JSON.parse(stripped));
	},
	catch: (e) => new effect.SchemaIssue.InvalidValue(effect.Option.some(input), { message: String(e) })
}));
/**
* Schema transformation: lenient JSONC string ↔ unknown.
*
* Same API as `SchemaTransformation.fromJsonString`, but the decode side
* strips trailing commas and JS-style comments before parsing.
* Encoding produces strict JSON via `JSON.stringify`.
*/
const fromLenientJsonString = new effect.SchemaTransformation.Transformation(parseLenientJsonGetter, effect.SchemaGetter.stringifyJson());
/**
* Build a schema that decodes a lenient JSON string into `A`.
*
* Drop-in replacement for `Schema.fromJsonString(schema)` that tolerates
* trailing commas and comments in the input.
*/
const fromLenientJson = (schema) => effect.Schema.String.pipe(effect.Schema.decodeTo(schema, fromLenientJsonString));

//#endregion
//#region ../../packages/shared/src/serverSettings.ts
const ServerSettingsJson = fromLenientJson(ServerSettings);
function normalizePersistedServerSettingString(value) {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : void 0;
}
function extractPersistedServerObservabilitySettings(input) {
	return {
		otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
		otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl)
	};
}
function parsePersistedServerObservabilitySettings(raw) {
	try {
		return extractPersistedServerObservabilitySettings(effect.Schema.decodeUnknownSync(ServerSettingsJson)(raw));
	} catch {
		return {
			otlpTracesUrl: void 0,
			otlpMetricsUrl: void 0
		};
	}
}

//#endregion
//#region ../../packages/shared/src/Net.ts
var NetError = class extends effect.Data.TaggedError("NetError") {};
function isErrnoExceptionWithCode(cause) {
	return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string";
}
const closeServer = (server) => {
	try {
		server.close();
	} catch {}
};
const tryReservePort = (port) => effect.Effect.callback((resume) => {
	const server = node_net.createServer();
	let settled = false;
	const settle = (effect$1) => {
		if (settled) return;
		settled = true;
		resume(effect$1);
	};
	server.unref();
	server.once("error", (cause) => {
		settle(effect.Effect.fail(new NetError({
			message: "Could not find an available port.",
			cause
		})));
	});
	server.listen(port, () => {
		const address = server.address();
		const resolved = typeof address === "object" && address !== null ? address.port : 0;
		server.close(() => {
			if (resolved > 0) {
				settle(effect.Effect.succeed(resolved));
				return;
			}
			settle(effect.Effect.fail(new NetError({ message: "Could not find an available port." })));
		});
	});
	return effect.Effect.sync(() => {
		closeServer(server);
	});
});
/**
* NetService - Service tag for startup networking helpers.
*/
var NetService = class NetService extends effect.Context.Service()("@t3tools/shared/Net/NetService") {
	static layer = effect.Layer.sync(NetService, () => {
		/**
		* Returns true when a TCP server can bind to {host, port}.
		* `EADDRNOTAVAIL` is treated as available so IPv6-absent hosts don't fail
		* loopback availability checks.
		*/
		const canListenOnHost = (port, host) => effect.Effect.callback((resume) => {
			const server = node_net.createServer();
			let settled = false;
			const settle = (value) => {
				if (settled) return;
				settled = true;
				resume(effect.Effect.succeed(value));
			};
			server.unref();
			server.once("error", (cause) => {
				if (isErrnoExceptionWithCode(cause) && cause.code === "EADDRNOTAVAIL") {
					settle(true);
					return;
				}
				settle(false);
			});
			server.once("listening", () => {
				server.close(() => {
					settle(true);
				});
			});
			server.listen({
				host,
				port
			});
			return effect.Effect.sync(() => {
				closeServer(server);
			});
		});
		/**
		* Reserve an ephemeral loopback port and release it immediately.
		* Returns the reserved port number.
		*/
		const reserveLoopbackPort = (host = "127.0.0.1") => effect.Effect.callback((resume) => {
			const probe = node_net.createServer();
			let settled = false;
			const settle = (effect$2) => {
				if (settled) return;
				settled = true;
				resume(effect$2);
			};
			probe.once("error", (cause) => {
				settle(effect.Effect.fail(new NetError({
					message: "Failed to reserve loopback port",
					cause
				})));
			});
			probe.listen(0, host, () => {
				const address = probe.address();
				const port = typeof address === "object" && address !== null ? address.port : 0;
				probe.close(() => {
					if (port > 0) {
						settle(effect.Effect.succeed(port));
						return;
					}
					settle(effect.Effect.fail(new NetError({ message: "Failed to reserve loopback port" })));
				});
			});
			return effect.Effect.sync(() => {
				closeServer(probe);
			});
		});
		return {
			canListenOnHost,
			isPortAvailableOnLoopback: (port) => effect.Effect.zipWith(canListenOnHost(port, "127.0.0.1"), canListenOnHost(port, "::1"), (ipv4, ipv6) => ipv4 && ipv6),
			reserveLoopbackPort,
			findAvailablePort: (preferred) => effect.Effect.catch(tryReservePort(preferred), () => tryReservePort(0))
		};
	});
};

//#endregion
//#region src/backendPort.ts
const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65535;
const defaultCanListenOnHost = async (port, host) => effect_Effect.service(NetService).pipe(effect_Effect.flatMap((net) => net.canListenOnHost(port, host)), effect_Effect.provide(NetService.layer), effect_Effect.runPromise);
const isValidPort = (port) => Number.isInteger(port) && port >= 1 && port <= MAX_TCP_PORT;
const normalizeHosts = (host, requiredHosts) => Array.from(new Set([host, ...requiredHosts].map((candidate) => candidate.trim()).filter((candidate) => candidate.length > 0)));
async function canListenOnAllHosts(port, hosts, canListenOnHost) {
	for (const candidateHost of hosts) if (!await canListenOnHost(port, candidateHost)) return false;
	return true;
}
async function resolveDesktopBackendPort({ host, startPort = DEFAULT_DESKTOP_BACKEND_PORT, maxPort = MAX_TCP_PORT, requiredHosts = [], canListenOnHost = defaultCanListenOnHost }) {
	if (!isValidPort(startPort)) throw new Error(`Invalid desktop backend start port: ${startPort}`);
	if (!isValidPort(maxPort)) throw new Error(`Invalid desktop backend max port: ${maxPort}`);
	if (maxPort < startPort) throw new Error(`Desktop backend max port ${maxPort} is below start port ${startPort}`);
	const hostsToCheck = normalizeHosts(host, requiredHosts);
	for (let port = startPort; port <= maxPort; port += 1) if (await canListenOnAllHosts(port, hostsToCheck, canListenOnHost)) return port;
	throw new Error(`No desktop backend port is available on hosts ${hostsToCheck.join(", ")} between ${startPort} and ${maxPort}`);
}

//#endregion
//#region src/updateChannels.ts
const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;
function isNightlyDesktopVersion(version) {
	return NIGHTLY_VERSION_PATTERN.test(version);
}
function resolveDefaultDesktopUpdateChannel(appVersion) {
	return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}
function doesVersionMatchDesktopUpdateChannel(version, channel) {
	return resolveDefaultDesktopUpdateChannel(version) === channel;
}

//#endregion
//#region src/desktopSettings.ts
const DEFAULT_DESKTOP_SETTINGS = {
	serverExposureMode: "local-only",
	updateChannel: "latest",
	updateChannelConfiguredByUser: false
};
function resolveDefaultDesktopSettings(appVersion) {
	return {
		...DEFAULT_DESKTOP_SETTINGS,
		updateChannel: resolveDefaultDesktopUpdateChannel(appVersion)
	};
}
function setDesktopServerExposurePreference(settings, requestedMode) {
	return settings.serverExposureMode === requestedMode ? settings : {
		...settings,
		serverExposureMode: requestedMode
	};
}
function setDesktopUpdateChannelPreference(settings, requestedChannel) {
	return {
		...settings,
		updateChannel: requestedChannel,
		updateChannelConfiguredByUser: true
	};
}
function readDesktopSettings(settingsPath, appVersion) {
	const defaultSettings = resolveDefaultDesktopSettings(appVersion);
	try {
		if (!node_fs.existsSync(settingsPath)) return defaultSettings;
		const raw = node_fs.readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw);
		const parsedUpdateChannel = parsed.updateChannel === "nightly" || parsed.updateChannel === "latest" ? parsed.updateChannel : null;
		const isLegacySettings = parsed.updateChannelConfiguredByUser === void 0;
		const updateChannelConfiguredByUser = parsed.updateChannelConfiguredByUser === true || isLegacySettings && parsedUpdateChannel === "nightly";
		return {
			serverExposureMode: parsed.serverExposureMode === "network-accessible" ? "network-accessible" : "local-only",
			updateChannel: updateChannelConfiguredByUser && parsedUpdateChannel !== null ? parsedUpdateChannel : defaultSettings.updateChannel,
			updateChannelConfiguredByUser
		};
	} catch {
		return defaultSettings;
	}
}
function writeDesktopSettings(settingsPath, settings) {
	const directory = node_path.dirname(settingsPath);
	const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
	node_fs.mkdirSync(directory, { recursive: true });
	node_fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	node_fs.renameSync(tempPath, settingsPath);
}

//#endregion
//#region src/clientPersistence.ts
function readJsonFile(filePath) {
	try {
		if (!node_fs.existsSync(filePath)) return null;
		return JSON.parse(node_fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}
function writeJsonFile(filePath, value) {
	const directory = node_path.dirname(filePath);
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	node_fs.mkdirSync(directory, { recursive: true });
	node_fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	node_fs.renameSync(tempPath, filePath);
}
function isPersistedSavedEnvironmentStorageRecord(value) {
	return effect.Predicate.isObject(value) && typeof value.environmentId === "string" && typeof value.label === "string" && typeof value.httpBaseUrl === "string" && typeof value.wsBaseUrl === "string" && typeof value.createdAt === "string" && (value.lastConnectedAt === null || typeof value.lastConnectedAt === "string") && (value.encryptedBearerToken === void 0 || typeof value.encryptedBearerToken === "string");
}
function readSavedEnvironmentRegistryDocument(filePath) {
	const parsed = readJsonFile(filePath);
	if (!effect.Predicate.isObject(parsed)) return { records: [] };
	return { records: Array.isArray(parsed.records) ? parsed.records.filter(isPersistedSavedEnvironmentStorageRecord) : [] };
}
function toPersistedSavedEnvironmentRecord(record) {
	return {
		environmentId: record.environmentId,
		label: record.label,
		httpBaseUrl: record.httpBaseUrl,
		wsBaseUrl: record.wsBaseUrl,
		createdAt: record.createdAt,
		lastConnectedAt: record.lastConnectedAt
	};
}
function readClientSettings(settingsPath) {
	const raw = readJsonFile(settingsPath)?.settings;
	if (!raw) return null;
	try {
		return effect_Schema.decodeUnknownSync(ClientSettingsSchema)(raw);
	} catch {
		return null;
	}
}
function writeClientSettings(settingsPath, settings) {
	writeJsonFile(settingsPath, { settings });
}
function readSavedEnvironmentRegistry(registryPath) {
	return readSavedEnvironmentRegistryDocument(registryPath).records.map((record) => toPersistedSavedEnvironmentRecord(record));
}
function writeSavedEnvironmentRegistry(registryPath, records) {
	const currentDocument = readSavedEnvironmentRegistryDocument(registryPath);
	const encryptedBearerTokenById = new Map(currentDocument.records.flatMap((record) => record.encryptedBearerToken ? [[record.environmentId, record.encryptedBearerToken]] : []));
	writeJsonFile(registryPath, { records: records.map((record) => {
		const encryptedBearerToken = encryptedBearerTokenById.get(record.environmentId);
		return encryptedBearerToken ? {
			environmentId: record.environmentId,
			label: record.label,
			httpBaseUrl: record.httpBaseUrl,
			wsBaseUrl: record.wsBaseUrl,
			createdAt: record.createdAt,
			lastConnectedAt: record.lastConnectedAt,
			encryptedBearerToken
		} : record;
	}) });
}
function readSavedEnvironmentSecret(input) {
	const encoded = readSavedEnvironmentRegistryDocument(input.registryPath).records.find((record) => record.environmentId === input.environmentId)?.encryptedBearerToken;
	if (!encoded) return null;
	if (!input.secretStorage.isEncryptionAvailable()) return null;
	try {
		return input.secretStorage.decryptString(Buffer.from(encoded, "base64"));
	} catch {
		return null;
	}
}
function writeSavedEnvironmentSecret(input) {
	const document = readSavedEnvironmentRegistryDocument(input.registryPath);
	if (!input.secretStorage.isEncryptionAvailable()) return false;
	let found = false;
	writeJsonFile(input.registryPath, { records: document.records.map((record) => {
		if (record.environmentId !== input.environmentId) return record;
		found = true;
		const encryptedBearerToken = input.secretStorage.encryptString(input.secret).toString("base64");
		return {
			environmentId: record.environmentId,
			label: record.label,
			httpBaseUrl: record.httpBaseUrl,
			wsBaseUrl: record.wsBaseUrl,
			createdAt: record.createdAt,
			lastConnectedAt: record.lastConnectedAt,
			encryptedBearerToken
		};
	}) });
	return found;
}
function removeSavedEnvironmentSecret(input) {
	const document = readSavedEnvironmentRegistryDocument(input.registryPath);
	if (!document.records.some((record) => record.environmentId === input.environmentId && record.encryptedBearerToken !== void 0)) return;
	writeJsonFile(input.registryPath, { records: document.records.map((record) => {
		if (record.environmentId !== input.environmentId) return record;
		return toPersistedSavedEnvironmentRecord(record);
	}) });
}

//#endregion
//#region src/cloudSync/liveShare.ts
/**
* Sharing a project without making anyone wait for the first pass.
*
* Sharing starts two things at once: the upload to the cloud, and a Cloudflare
* quick tunnel publishing this laptop's own copy. This coordinates the second
* one against the first, and every decision in it comes from the same sentence
* in `docs/cloud-sync-spec.md`: **the link handed out is always the cloud URL,
* never the tunnel's**. A quick tunnel's address changes on every restart and
* dies with the laptop, so a link built on it is dead tomorrow in somebody
* else's inbox — which is worse than making them wait.
*
* Nothing here can stop a sync. If `cloudflared` is missing, or the tunnel's own
* preflight refuses to publish a server that would hand a visitor an owner
* session, the sync goes ahead without a live copy and the state below says so
* in as many words. The live link is an accelerator; the upload is the feature.
*
* The tunnel is never started by this file. It asks a controller that already
* owns the single `cloudflared` child and already refuses to publish an
* auto-issuing auth policy — that gate is load-bearing here, not incidental, and
* duplicating a tunnel launcher beside it would be a second way to publish this
* machine with only one of them checked.
*/
/**
* How often the tunnel's state is re-read while it is still coming up.
*
* A quick tunnel takes a few seconds to publish its hostname, and the whole
* point of this feature is that a visitor is not left watching a bar. Polling at
* the heartbeat interval instead would leave a live tunnel unregistered — and so
* unoffered — for most of a minute after it was ready.
*/
const STARTUP_POLL_MS = 1e3;
/**
* How long the tunnel is kept alive after the first pass completes.
*
* Long enough for a visitor sitting on the live copy to make one more request
* and be redirected home; short enough that the public door into this laptop
* closes while the person who opened it is still at their desk. Nobody new is
* sent here during it: the registration is withdrawn first, so the cloud stops
* offering this address the moment it stops being the fastest answer.
*/
const HANDOFF_GRACE_MS = 3e4;
function initialState() {
	return {
		phase: "off",
		url: null,
		reason: null,
		syncProceeds: true,
		lastRegisteredAt: null,
		lastRegistrationError: null
	};
}
/** What the tunnel's own vocabulary means to somebody waiting for a link. */
function describeTunnel(state) {
	return state.failureReason ?? "A live copy could not be published, so this project is only reachable once the upload finishes.";
}
/**
* Runs the tunnel beside a sync: start it, keep its address registered while it
* lives, and hand visitors over to the cloud when the first pass completes.
*/
var LiveShareCoordinator = class {
	state = initialState();
	timer = null;
	handoffTimer = null;
	beat = 0;
	tunnel;
	registrar;
	onStateChange;
	heartbeatMs;
	startupPollMs;
	handoffGraceMs;
	now;
	constructor(options) {
		this.tunnel = options.tunnel;
		this.registrar = options.registrar;
		this.onStateChange = options.onStateChange;
		this.heartbeatMs = options.heartbeatMs ?? CLOUD_SYNC_LIVE_COPY_HEARTBEAT_MS;
		this.startupPollMs = options.startupPollMs ?? STARTUP_POLL_MS;
		this.handoffGraceMs = options.handoffGraceMs ?? HANDOFF_GRACE_MS;
		this.now = options.now ?? (() => /* @__PURE__ */ new Date());
	}
	getState() {
		return this.state;
	}
	/**
	* Called when a sync starts in the default mode. Returns as soon as the tunnel
	* has been asked for — the caller is starting an upload and must not be made
	* to wait on `cloudflared`.
	*/
	async begin(port) {
		if (this.state.phase !== "off") return this.state;
		this.setState({
			...initialState(),
			phase: "starting"
		});
		await this.heartbeat(null);
		let started;
		try {
			started = await this.tunnel.start(port);
		} catch (error) {
			this.settleWithoutLiveCopy(error instanceof Error ? error.message : String(error));
			this.schedule(this.heartbeatMs);
			return this.state;
		}
		this.applyTunnelState(started);
		if (this.state.url !== null) await this.heartbeat(this.state.url);
		this.schedule(this.state.phase === "starting" ? this.startupPollMs : this.heartbeatMs);
		return this.state;
	}
	/**
	* The first pass has completed. The cloud copy is canonical from here, so
	* anyone still on the tunnel is handed over and the tunnel is stopped.
	*
	* The handoff is registered *before* the tunnel is withdrawn and long before
	* it is stopped, because the redirect it enables is served by this laptop. If
	* the tunnel is already dead none of this matters: every link that was handed
	* out was the cloud URL, so the visitors it would have caught are the ones who
	* clicked through in this session, and they can go back to the address they
	* arrived from. The redirect is the courtesy, not the mechanism.
	*/
	async firstPassComplete() {
		if (this.state.phase === "off" || this.state.phase === "handed-off") return this.state;
		this.clearTimer();
		await this.attempt(() => this.registrar.registerHandoff());
		await this.heartbeat(null);
		this.setState({
			...this.state,
			phase: "handed-off",
			url: null,
			reason: null
		});
		this.handoffTimer = setTimeout(() => {
			this.handoffTimer = null;
			this.tunnel.stop();
		}, this.handoffGraceMs);
		this.handoffTimer.unref?.();
		return this.state;
	}
	/** Sharing stopped, or the app is going away. Idempotent, like the tunnel's own stop. */
	async stop() {
		this.clearTimer();
		if (this.handoffTimer !== null) {
			clearTimeout(this.handoffTimer);
			this.handoffTimer = null;
		}
		const wasSharing = this.state.phase !== "off";
		this.tunnel.stop();
		if (wasSharing) await this.attempt(() => this.registrar.registerLiveCopy(null));
		this.setState(initialState());
		return this.state;
	}
	async tick() {
		if (this.state.phase === "off" || this.state.phase === "handed-off") return;
		this.applyTunnelState(this.tunnel.getState());
		await this.heartbeat(this.state.url);
		this.schedule(this.state.phase === "starting" ? this.startupPollMs : this.heartbeatMs);
	}
	applyTunnelState(tunnelState) {
		switch (tunnelState.status) {
			case "live":
				if (tunnelState.url === null || !isSafeCloudSyncCopyUrl(tunnelState.url)) {
					this.settleWithoutLiveCopy("The tunnel published an address this build will not hand to a visitor.");
					return;
				}
				this.setState({
					...this.state,
					phase: "live",
					url: tunnelState.url,
					reason: null
				});
				return;
			case "starting":
				this.setState({
					...this.state,
					phase: "starting",
					url: null,
					reason: null
				});
				return;
			case "unavailable":
			case "failed":
			case "stopping":
			case "not-shared":
				this.settleWithoutLiveCopy(describeTunnel(tunnelState));
				return;
		}
	}
	settleWithoutLiveCopy(reason) {
		if (this.state.phase === "handed-off" || this.state.phase === "off") return;
		this.setState({
			...this.state,
			phase: "no-live-copy",
			url: null,
			reason
		});
	}
	async heartbeat(url) {
		if (await this.attempt(() => this.registrar.registerLiveCopy(url)) === null) this.setState({
			...this.state,
			lastRegisteredAt: this.now().toISOString()
		});
	}
	/** Returns the failure message, or null on success. Nothing here ever throws. */
	async attempt(action) {
		try {
			await action();
			if (this.state.lastRegistrationError !== null) this.setState({
				...this.state,
				lastRegistrationError: null
			});
			return null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setState({
				...this.state,
				lastRegistrationError: message
			});
			return message;
		}
	}
	schedule(delayMs) {
		this.clearTimer();
		if (this.state.phase === "off" || this.state.phase === "handed-off") return;
		const beat = ++this.beat;
		this.timer = setTimeout(() => {
			this.timer = null;
			if (beat !== this.beat) return;
			this.tick();
		}, delayMs);
		this.timer.unref?.();
	}
	clearTimer() {
		this.beat += 1;
		if (this.timer === null) return;
		clearTimeout(this.timer);
		this.timer = null;
	}
	setState(next) {
		this.state = next;
		this.onStateChange?.(next);
	}
};
/**
* The two calls this coordinator makes, over HTTP.
*
* They go to different servers on purpose, and that is the shape of the whole
* handoff: the live copy is registered *with the cloud*, so it can offer a
* faster route while it fills in; the handoff is registered *with this laptop*,
* so the machine the tunnel published is the one that can send a visitor home.
*/
function createHttpLiveShareRegistrar(options) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const headers = {
		"content-type": "application/json",
		...options.authorization === null ? {} : { authorization: options.authorization }
	};
	const post = async (baseUrl, path, body) => {
		const response = await fetchImpl(new URL(path, baseUrl), {
			method: "POST",
			headers,
			body: JSON.stringify(body)
		});
		if (!response.ok) throw new Error(`${path} was refused with ${response.status}.`);
	};
	return {
		registerLiveCopy: (url) => post(options.cloudBaseUrl, "/api/cloud-sync/live-copy", {
			...options.scope,
			url
		}),
		registerHandoff: () => post(options.localBaseUrl, "/api/cloud-sync/handoff", {
			...options.scope,
			canonicalUrl: new URL(`/projects/${encodeURIComponent(options.scope.projectId)}`, options.cloudBaseUrl).toString()
		})
	};
}
/**
* The check `main.ts` runs before it will post anything anywhere on a
* renderer's say-so. Two ordinary URLs, and the cloud one has to be an address
* a visitor could be redirected to.
*/
function isUsableLiveShareEndpoint(candidate) {
	return typeof candidate === "string" && isSafeCloudSyncCopyUrl(candidate);
}

//#endregion
//#region src/cloudSync/scan.ts
/**
* Walking a project directory, deciding what is allowed to leave the laptop, and hashing
* it. The laptop half of `docs/cloud-sync-spec.md`; the decisions live in
* `@t3tools/shared/cloudSync/reconcile` and are not repeated here.
*
* Two properties of this module are load-bearing, and both exist because of the same
* failure. The reconciler is handed a `Map` of what is on disk, and any path missing from
* that map reads as "the user deleted this" — which, for a path the remote has not
* touched, becomes a remote delete. So:
*
* 1. **A scan says whether it was complete.** A permission error, an abort, or a
*    `.gitignore` we could not read makes `complete` false. It never makes the map
*    smaller and calls that a result. A caller that reconciles an incomplete scan deletes
*    a tree; a caller that refuses one loses a pass.
* 2. **Everything excluded is named.** A path we decided not to hash is not a path we
*    know to be absent, so `skipped` carries every one of them and
*    {@link createUnknownPathPredicate} turns that list into the exclusion the reconciler
*    cannot express. Without it, adding a line to `.gitignore` deletes the matching files
*    from the cloud copy.
*
* Modification times are used here and only here: as a cheap "might have changed" filter
* that decides whether to re-read a file. The hash is what is reported and the hash is
* what decides. See {@link isUnchangedSince} for why the filter looks at more than mtime.
*/
/**
* Files bigger than this are reported as skipped rather than uploaded. The spec asks for a
* ceiling without naming one; this is generous enough that an ordinary project never meets
* it and small enough that a stray VM image does not hold a first sync hostage.
*/
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
/**
* The suffix on every half-written file this feature creates. It lives here rather than in
* `apply.ts` because the scanner is what has to not report them: a temp file that appeared
* in a scan would be uploaded, and then deleted from the cloud the moment it was renamed
* into place.
*/
const SYNC_TEMP_FILE_SUFFIX = ".t3sync-tmp";
/**
* Directory names refused wherever they appear, not just at the root. A nested
* `node_modules` is the same mistake as a top-level one, and a nested `.git` is a
* submodule — the case where half-replicating a repository hurts most.
*/
const ALWAYS_IGNORED_DIRECTORY_NAMES = new Set([
	".git",
	"node_modules",
	".Spotlight-V100",
	".Trashes",
	".fseventsd",
	".TemporaryItems",
	"$RECYCLE.BIN",
	"System Volume Information"
]);
/** Written by the OS, edited by nobody. Syncing them starts arguments between machines. */
const OS_NOISE_FILE_NAMES = new Set([
	".DS_Store",
	"Thumbs.db",
	"ehthumbs.db",
	"desktop.ini"
]);
/** True for a name this feature refuses on sight, before any `.gitignore` is consulted. */
function isAlwaysIgnoredName(name, isDirectory) {
	if (name.endsWith(SYNC_TEMP_FILE_SUFFIX)) return true;
	if (isDirectory) return ALWAYS_IGNORED_DIRECTORY_NAMES.has(name);
	return OS_NOISE_FILE_NAMES.has(name) || name.startsWith("._");
}
function escapeRegExp(value) {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
function findCharacterClassEnd(glob, openIndex) {
	let index = openIndex + 1;
	if (glob.charAt(index) === "!") index += 1;
	if (glob.charAt(index) === "]") index += 1;
	while (index < glob.length) {
		if (glob.charAt(index) === "]") return index;
		index += 1;
	}
	return -1;
}
function globToRegExpSource(glob) {
	let source = "";
	let index = 0;
	while (index < glob.length) {
		const char = glob.charAt(index);
		if (char === "\\") {
			const next = glob.charAt(index + 1);
			source += next === "" ? String.raw`\\` : escapeRegExp(next);
			index += 2;
			continue;
		}
		if (char === "*") {
			if (glob.charAt(index + 1) === "*") {
				if (glob.charAt(index + 2) === "/") {
					source += "(?:[^/]+/)*";
					index += 3;
					continue;
				}
				source += ".*";
				index += 2;
				continue;
			}
			source += "[^/]*";
			index += 1;
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			index += 1;
			continue;
		}
		if (char === "[") {
			const end = findCharacterClassEnd(glob, index);
			if (end === -1) {
				source += String.raw`\[`;
				index += 1;
				continue;
			}
			const body = glob.slice(index + 1, end);
			source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
			index = end + 1;
			continue;
		}
		source += escapeRegExp(char);
		index += 1;
	}
	return source;
}
function compileGitignore(contents) {
	const patterns = [];
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.replace(/(?<!\\)\s+$/, "");
		if (line === "" || line.startsWith("#")) continue;
		const negated = line.startsWith("!");
		let body = negated ? line.slice(1) : line;
		if (body.startsWith(String.raw`\#`) || body.startsWith(String.raw`\!`)) body = body.slice(1);
		const directoryOnly = body.endsWith("/");
		if (directoryOnly) body = body.slice(0, -1);
		if (body === "") continue;
		let anchored = body.includes("/");
		if (body.startsWith("/")) {
			anchored = true;
			body = body.slice(1);
		}
		const source = globToRegExpSource(body);
		patterns.push({
			negated,
			directoryOnly,
			matcher: new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`)
		});
	}
	return patterns;
}
function relativeToLayer(layer, relativePath) {
	if (layer.base === "") return relativePath;
	const prefix = `${layer.base}/`;
	return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : null;
}
/**
* Whether the layers ignore this path. Later layers are deeper, later patterns are newer,
* and the last match wins — git's rule, and the one people write `!keep-this` expecting.
*/
function isPathIgnored(layers, relativePath, isDirectory) {
	let ignored = false;
	for (const layer of layers) {
		const candidate = relativeToLayer(layer, relativePath);
		if (candidate === null) continue;
		for (const pattern of layer.patterns) {
			if (pattern.directoryOnly && !isDirectory) continue;
			if (pattern.matcher.test(candidate)) ignored = !pattern.negated;
		}
	}
	return ignored;
}
/**
* `O_NOFOLLOW` closes the gap between deciding a directory entry is a regular file and
* opening it. Without it, replacing that entry with a symlink in between is enough to make
* the scanner read a file outside the project — the exact thing the spec refuses. Windows
* has no such flag; there the `lstat` check above the call is the whole defence.
*/
const O_NOFOLLOW = node_fs.constants.O_NOFOLLOW ?? 0;
const HASH_ALGORITHM = "sha256";
const HASH_CHUNK_BYTES = 65536;
function createContentHasher() {
	const hash = node_crypto.createHash(HASH_ALGORITHM);
	return {
		update: (chunk) => {
			hash.update(chunk);
		},
		digest: () => `${HASH_ALGORITHM}:${hash.digest("hex")}`
	};
}
/**
* Streams the file rather than reading it whole: a scan must not need as much memory as
* the largest file in the project. Returns the byte count it actually read, which is the
* number the ceiling is enforced against — a file that grew since `lstat` is caught here.
*/
async function hashFileAt(absolutePath, maxBytes = Number.POSITIVE_INFINITY) {
	const handle = await node_fs.promises.open(absolutePath, node_fs.constants.O_RDONLY | O_NOFOLLOW);
	try {
		const hasher = createContentHasher();
		const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
		let sizeBytes = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			sizeBytes += bytesRead;
			if (sizeBytes > maxBytes) return { tooLarge: true };
			hasher.update(buffer.subarray(0, bytesRead));
		}
		return {
			hash: hasher.digest(),
			sizeBytes
		};
	} finally {
		await handle.close();
	}
}
/**
* The pre-filter. True when nothing about the inode has moved since the previous scan, so
* the previous hash still describes the bytes.
*
* Size and mtime alone are forgeable — `touch -r` after a rewrite reproduces both — so
* ctime and the inode number are in the comparison too. ctime is set by the kernel on
* every inode change and cannot be assigned by a caller, which is what makes this a filter
* rather than a guess. It is still a filter: `rehashAll` exists for the pass that trusts
* nothing, and the hash, never this, is what any decision is made against.
*/
function isUnchangedSince(previous, stats) {
	return previous !== void 0 && previous.sizeBytes === stats.size && previous.mtimeMs === stats.mtimeMs && previous.ctimeMs === stats.ctimeMs && previous.inode === stats.ino;
}
function describeError(error) {
	if (error instanceof Error) {
		const code = error.code;
		return code === void 0 ? error.message : `${code}: ${error.message}`;
	}
	return String(error);
}
function errorCode(error) {
	return error instanceof Error ? error.code : void 0;
}
function joinRelative(base, name) {
	return base === "" ? name : `${base}/${name}`;
}
/**
* Walks `root` and hashes every file that is allowed to sync.
*
* Never recurses into a symlinked directory and never opens a symlinked file, so a link
* pointing at `$HOME` cannot pull a home directory into a shared workspace. Never
* follows a link even to decide what kind of thing it points at: every stat here is an
* `lstat`.
*/
async function scanProject(options) {
	const root = node_path.resolve(options.root);
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const previous = options.rehashAll === true ? void 0 : options.previous;
	const files = /* @__PURE__ */ new Map();
	const skipped = [];
	const incompleteReasons = [];
	let filesHashed = 0;
	let bytesHashed = 0;
	let filesReused = 0;
	function markIncomplete(reason) {
		incompleteReasons.push(reason);
	}
	const stack = [{
		relative: "",
		layers: []
	}];
	while (stack.length > 0) {
		if (options.signal?.aborted === true) {
			markIncomplete("The scan was cancelled before it finished.");
			break;
		}
		const frame = stack.pop();
		if (frame === void 0) break;
		const absoluteDirectory = frame.relative === "" ? root : node_path.join(root, frame.relative);
		let entries;
		try {
			entries = await node_fs.promises.readdir(absoluteDirectory, { withFileTypes: true });
		} catch (error) {
			const vanished = errorCode(error) === "ENOENT" && frame.relative !== "";
			skipped.push({
				path: frame.relative,
				reason: vanished ? "vanished" : "unreadable",
				isDirectory: true,
				detail: describeError(error)
			});
			if (!vanished) markIncomplete(`Could not read ${frame.relative === "" ? "the project directory" : frame.relative}: ${describeError(error)}`);
			continue;
		}
		entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
		let layers = frame.layers;
		const gitignoreEntry = entries.find((entry) => entry.name === ".gitignore");
		if (gitignoreEntry !== void 0 && !gitignoreEntry.isSymbolicLink()) {
			const gitignorePath = node_path.join(absoluteDirectory, ".gitignore");
			try {
				const handle = await node_fs.promises.open(gitignorePath, node_fs.constants.O_RDONLY | O_NOFOLLOW);
				try {
					const contents = await handle.readFile("utf8");
					layers = [...layers, {
						base: frame.relative,
						patterns: compileGitignore(contents)
					}];
				} finally {
					await handle.close();
				}
			} catch (error) {
				skipped.push({
					path: joinRelative(frame.relative, ".gitignore"),
					reason: "unreadable",
					isDirectory: false,
					detail: describeError(error)
				});
				markIncomplete(`Could not read ${joinRelative(frame.relative, ".gitignore")}, so its exclusions are unknown: ${describeError(error)}`);
			}
		}
		const childDirectories = [];
		for (const entry of entries) {
			const relative = joinRelative(frame.relative, entry.name);
			if (entry.isSymbolicLink()) {
				skipped.push({
					path: relative,
					reason: "symlink",
					isDirectory: false
				});
				continue;
			}
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			let stats;
			if (!isDirectory && !isFile) {
				try {
					stats = await node_fs.promises.lstat(node_path.join(absoluteDirectory, entry.name));
				} catch (error) {
					const code = errorCode(error);
					skipped.push({
						path: relative,
						reason: code === "ENOENT" ? "vanished" : "unreadable",
						isDirectory: false,
						detail: describeError(error)
					});
					if (code !== "ENOENT") markIncomplete(`Could not inspect ${relative}: ${describeError(error)}`);
					continue;
				}
				if (stats.isSymbolicLink()) {
					skipped.push({
						path: relative,
						reason: "symlink",
						isDirectory: false
					});
					continue;
				}
				isDirectory = stats.isDirectory();
				isFile = stats.isFile();
			}
			if (!isDirectory && !isFile) {
				skipped.push({
					path: relative,
					reason: "unsupportedType",
					isDirectory: false
				});
				continue;
			}
			if (isAlwaysIgnoredName(entry.name, isDirectory) || isPathIgnored(layers, relative, isDirectory)) {
				skipped.push({
					path: relative,
					reason: "ignored",
					isDirectory
				});
				continue;
			}
			if (isDirectory) {
				childDirectories.push({
					relative,
					layers
				});
				continue;
			}
			if (stats === void 0) try {
				stats = await node_fs.promises.lstat(node_path.join(absoluteDirectory, entry.name));
			} catch (error) {
				const code = errorCode(error);
				skipped.push({
					path: relative,
					reason: code === "ENOENT" ? "vanished" : "unreadable",
					isDirectory: false,
					detail: describeError(error)
				});
				if (code !== "ENOENT") markIncomplete(`Could not inspect ${relative}: ${describeError(error)}`);
				continue;
			}
			if (stats.size > maxFileBytes) {
				skipped.push({
					path: relative,
					reason: "tooLarge",
					isDirectory: false,
					sizeBytes: stats.size
				});
				continue;
			}
			const remembered = previous?.get(relative);
			if (isUnchangedSince(remembered, stats) && remembered !== void 0) {
				files.set(relative, {
					hash: remembered.hash,
					sizeBytes: stats.size,
					mtimeMs: stats.mtimeMs,
					ctimeMs: stats.ctimeMs,
					inode: stats.ino
				});
				filesReused += 1;
				continue;
			}
			try {
				const hashed = await hashFileAt(node_path.join(absoluteDirectory, entry.name), maxFileBytes);
				if ("tooLarge" in hashed) {
					skipped.push({
						path: relative,
						reason: "tooLarge",
						isDirectory: false
					});
					continue;
				}
				files.set(relative, {
					hash: hashed.hash,
					sizeBytes: hashed.sizeBytes,
					mtimeMs: stats.mtimeMs,
					ctimeMs: stats.ctimeMs,
					inode: stats.ino
				});
				filesHashed += 1;
				bytesHashed += hashed.sizeBytes;
			} catch (error) {
				const vanished = errorCode(error) === "ENOENT";
				skipped.push({
					path: relative,
					reason: vanished ? "vanished" : "unreadable",
					isDirectory: false,
					detail: describeError(error)
				});
				if (!vanished) markIncomplete(`Could not read ${relative}: ${describeError(error)}`);
			}
		}
		for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
			const child = childDirectories[index];
			if (child !== void 0) stack.push(child);
		}
	}
	return {
		root,
		files,
		complete: incompleteReasons.length === 0,
		incompleteReasons,
		skipped,
		filesHashed,
		bytesHashed,
		filesReused
	};
}
/**
* A scan reduced to what a UI can render and an IPC boundary can carry. The skip list is
* truncated because a large ignored tree produces thousands of entries, and `skippedCount`
* is reported separately so the truncation is visible rather than reassuring.
*/
function summariseScan(result, maxSkipped = 200) {
	let totalBytes = 0;
	for (const file of result.files.values()) totalBytes += file.sizeBytes;
	return {
		root: result.root,
		fileCount: result.files.size,
		totalBytes,
		complete: result.complete,
		incompleteReasons: result.incompleteReasons,
		skippedCount: result.skipped.length,
		skipped: result.skipped.slice(0, maxSkipped),
		filesHashed: result.filesHashed,
		filesReused: result.filesReused
	};
}

//#endregion
//#region src/backendReadiness.ts
const DEFAULT_TIMEOUT_MS = 3e4;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 1e3;
var BackendReadinessAbortedError = class extends Error {
	constructor() {
		super("Backend readiness wait was aborted.");
		this.name = "BackendReadinessAbortedError";
	}
};
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(new BackendReadinessAbortedError());
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		if (signal?.aborted) {
			cleanup();
			reject(new BackendReadinessAbortedError());
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function isBackendReadinessAborted(error) {
	return error instanceof BackendReadinessAbortedError;
}
async function waitForHttpReady(baseUrl, options) {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const signal = options?.signal;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
	const requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const readinessPath = options?.path ?? "/";
	const isReady = options?.isReady ?? ((response) => response.ok);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted) throw new BackendReadinessAbortedError();
		const requestController = new AbortController();
		const requestTimeout = setTimeout(() => {
			requestController.abort();
		}, requestTimeoutMs);
		const abortRequest = () => {
			requestController.abort();
		};
		signal?.addEventListener("abort", abortRequest, { once: true });
		try {
			if (isReady(await fetchImpl(new URL(readinessPath, baseUrl).toString(), {
				redirect: "manual",
				signal: requestController.signal
			}))) return;
		} catch (error) {
			if (isBackendReadinessAborted(error)) throw error;
			if (signal?.aborted) throw new BackendReadinessAbortedError();
		} finally {
			clearTimeout(requestTimeout);
			signal?.removeEventListener("abort", abortRequest);
		}
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for backend readiness at ${baseUrl}.`);
		await delay(intervalMs, signal);
	}
}

//#endregion
//#region src/confirmDialog.ts
const CONFIRM_BUTTON_INDEX = 1;
async function showDesktopConfirmDialog(message, ownerWindow) {
	const normalizedMessage = message.trim();
	if (normalizedMessage.length === 0) return false;
	const options = {
		type: "question",
		buttons: ["No", "Yes"],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
		message: normalizedMessage
	};
	return (ownerWindow ? await electron.dialog.showMessageBox(ownerWindow, options) : await electron.dialog.showMessageBox(options)).response === CONFIRM_BUTTON_INDEX;
}

//#endregion
//#region src/serverExposure.ts
const DESKTOP_LOOPBACK_HOST$1 = "127.0.0.1";
const DESKTOP_LAN_BIND_HOST = "0.0.0.0";
const normalizeOptionalHost = (value) => {
	const normalized = value?.trim();
	return normalized && normalized.length > 0 ? normalized : void 0;
};
const isUsableLanIpv4Address = (address) => !address.startsWith("127.") && !address.startsWith("169.254.");
function resolveLanAdvertisedHost(networkInterfaces, explicitHost) {
	const normalizedExplicitHost = normalizeOptionalHost(explicitHost);
	if (normalizedExplicitHost) return normalizedExplicitHost;
	for (const interfaceAddresses of Object.values(networkInterfaces)) {
		if (!interfaceAddresses) continue;
		for (const address of interfaceAddresses) {
			if (address.internal) continue;
			if (address.family !== "IPv4") continue;
			if (!isUsableLanIpv4Address(address.address)) continue;
			return address.address;
		}
	}
	return null;
}
function resolveDesktopServerExposure(input) {
	const localHttpUrl = `http://${DESKTOP_LOOPBACK_HOST$1}:${input.port}`;
	const localWsUrl = `ws://${DESKTOP_LOOPBACK_HOST$1}:${input.port}`;
	if (input.mode === "local-only") return {
		mode: input.mode,
		bindHost: DESKTOP_LOOPBACK_HOST$1,
		localHttpUrl,
		localWsUrl,
		endpointUrl: null,
		advertisedHost: null
	};
	const advertisedHost = resolveLanAdvertisedHost(input.networkInterfaces, input.advertisedHostOverride);
	return {
		mode: input.mode,
		bindHost: DESKTOP_LAN_BIND_HOST,
		localHttpUrl,
		localWsUrl,
		endpointUrl: advertisedHost ? `http://${advertisedHost}:${input.port}` : null,
		advertisedHost
	};
}

//#endregion
//#region src/tunnel.ts
/**
* Cloudflare quick tunnel that publishes the desktop app's local server.
*
* SECURITY: the tunnel terminates at Cloudflare and forwards to 127.0.0.1, so the
* server sees every stranger as a loopback peer. Any "it came from localhost, so it
* must be this user" assumption therefore applies to the whole internet while a
* tunnel is live. Peer addresses are logged as 127.0.0.1 through the tunnel too, so
* a tunnelled session shows up in the Connections list looking like a local device.
*
* Two server auth policies carry exactly that assumption: `loopback-browser` (a CLI
* `t3 serve`) and `unsafe-no-auth` (`--unsafe-no-auth` or basic-auth env vars).
* Under either of them `GET /api/auth/session` hands a full owner session — shell,
* PTYs, filesystem, git, provider credentials — to whoever opens the URL. So this
* controller asks the server which policy it is running before it spawns anything,
* and refuses to publish an auto-issuing one. Refusing is the right trade: a
* running cloudflared is much harder to take back than an error message.
*
* The server has its own defence (it will not auto-issue when it knows it is
* published, or when a request arrives carrying proxy headers), but that one is
* a backstop. This refusal is the guard rail, because it is the only layer that
* knows a tunnel is about to exist.
*
* Deliberately left open: `/.well-known/t3/environment` stays unauthenticated
* while a tunnel is live, so anyone holding the URL can read the workspace folder
* name, the OS, the CPU architecture, and the server version. That endpoint has to
* answer before a client can know how to authenticate, so it cannot be gated
* without breaking pairing. It is an information leak to a URL-holder, not a way in.
*/
const CLOUDFLARED_BINARY = "cloudflared";
/**
* cloudflared only announces the public hostname once, in its startup banner, and
* different builds put that banner on stdout or stderr. Both streams are merged
* before matching so a version change cannot silently break URL discovery.
*/
const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi;
/**
* `api.trycloudflare.com` is the control-plane endpoint cloudflared talks to while
* requesting a tunnel; it shows up in ordinary and failed-request logs and is never
* the user's public URL.
*/
const QUICK_TUNNEL_RESERVED_SUBDOMAINS = new Set(["api", "www"]);
const DEFAULT_URL_TIMEOUT_MS = 25e3;
const MAX_DIAGNOSTIC_CHARS = 8192;
const AVAILABILITY_PROBE_TIMEOUT_MS = 5e3;
const STOP_FORCE_KILL_DELAY_MS = 2e3;
const AUTH_POLICY_PROBE_TIMEOUT_MS = 5e3;
/** Guards the untyped probe response; an unrecognised policy is treated as unknown. */
const KNOWN_AUTH_POLICIES = new Set([
	"desktop-managed-local",
	"loopback-browser",
	"remote-reachable",
	"unsafe-no-auth"
]);
/**
* Decides whether a server running this auth policy may be published at all.
*
* An unknown policy is refused rather than allowed. The cost of being wrong in
* one direction is a share that does not start; in the other it is a stranger
* with a shell on this laptop.
*/
function evaluateWorkspaceSharePreflight(policy) {
	if (policy === null) return {
		allowed: false,
		reason: "Could not read this server's authentication policy, so sharing stopped rather than risk publishing a server that hands full access to anyone with the link. Make sure the server is running, then try again."
	};
	if (policy === "loopback-browser") return {
		allowed: false,
		reason: "This server gives full owner access to anything that reaches it from this machine, and a tunnel makes every visitor look like this machine. Turn on network access in Settings so the server asks visitors to pair first, then share again."
	};
	if (policy === "unsafe-no-auth") return {
		allowed: false,
		reason: "This server was started with authentication turned off (--unsafe-no-auth, or the basic-auth environment variables), so anyone with the link would get full access to this computer. Restart it without those options, turn on network access in Settings, then share again."
	};
	return { allowed: true };
}
/**
* Asks the local server which auth policy it is running.
*
* The `x-t3-auth-entry-path` header makes the session route report its state
* without minting a session, so checking whether the server auto-issues owner
* sessions cannot itself cause one to be issued.
*/
async function probeServerAuthPolicy(port, fetchImpl = globalThis.fetch) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AUTH_POLICY_PROBE_TIMEOUT_MS);
	timer.unref?.();
	try {
		const response = await fetchImpl(`http://127.0.0.1:${port}/api/auth/session`, {
			headers: { "x-t3-auth-entry-path": "/pair" },
			signal: controller.signal
		});
		if (!response.ok) return null;
		const policy = (await response.json())?.auth?.policy;
		return typeof policy === "string" && KNOWN_AUTH_POLICIES.has(policy) ? policy : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
function createWorkspaceShareState() {
	return {
		status: "not-shared",
		url: null,
		failureReason: null,
		diagnostics: null
	};
}
function canStartWorkspaceShare(status) {
	return status === "not-shared" || status === "failed" || status === "unavailable";
}
function canStopWorkspaceShare(status) {
	return status === "starting" || status === "live";
}
function reduceWorkspaceShareOnStartRequested(state) {
	if (!canStartWorkspaceShare(state.status)) return state;
	return {
		status: "starting",
		url: null,
		failureReason: null,
		diagnostics: null
	};
}
function reduceWorkspaceShareOnUrlDetected(state, url) {
	if (state.status !== "starting") return state;
	return {
		status: "live",
		url,
		failureReason: null,
		diagnostics: null
	};
}
function reduceWorkspaceShareOnFailure(state, reason, diagnostics = null) {
	if (state.status === "stopping" || state.status === "not-shared") return createWorkspaceShareState();
	return {
		status: "failed",
		url: null,
		failureReason: reason,
		diagnostics
	};
}
function reduceWorkspaceShareOnUnavailable(_state, reason) {
	return {
		status: "unavailable",
		url: null,
		failureReason: reason,
		diagnostics: null
	};
}
function reduceWorkspaceShareOnStopRequested(state) {
	if (!canStopWorkspaceShare(state.status)) return createWorkspaceShareState();
	return {
		status: "stopping",
		url: null,
		failureReason: null,
		diagnostics: null
	};
}
function reduceWorkspaceShareOnStopped(_state) {
	return createWorkspaceShareState();
}
function parseQuickTunnelUrl(output) {
	QUICK_TUNNEL_URL_PATTERN.lastIndex = 0;
	for (const match of output.matchAll(QUICK_TUNNEL_URL_PATTERN)) {
		const url = match[0].toLowerCase();
		const subdomain = url.slice(8, url.indexOf(".trycloudflare.com"));
		if (QUICK_TUNNEL_RESERVED_SUBDOMAINS.has(subdomain)) continue;
		return url;
	}
	return null;
}
function buildQuickTunnelArgs(port) {
	return [
		"--config",
		"/dev/null",
		"--no-autoupdate",
		"tunnel",
		"--url",
		`http://127.0.0.1:${port}`
	];
}
function interpretCloudflaredVersionProbe(probe) {
	if (probe.spawnError) return {
		available: false,
		version: null,
		reason: probe.spawnError.code === "ENOENT" ? "cloudflared was not found on this computer. Install it, then try sharing again." : `cloudflared could not be started: ${probe.spawnError.message}`
	};
	if (probe.exitCode !== 0) return {
		available: false,
		version: null,
		reason: `cloudflared exited with code ${probe.exitCode ?? "null"} when asked for its version.`
	};
	return {
		available: true,
		version: parseCloudflaredVersion(probe.stdout ?? ""),
		reason: null
	};
}
function parseCloudflaredVersion(stdout) {
	return /cloudflared version (\S+)/i.exec(stdout)?.[1] ?? null;
}
/**
* Accumulates cloudflared's merged output, yielding the public URL as soon as it
* appears and retaining a bounded tail so a timeout can report what was actually
* printed instead of an opaque "it did not work".
*/
var QuickTunnelOutputCollector = class {
	buffer = "";
	url = null;
	push(chunk) {
		const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		this.buffer = `${this.buffer}${text}`;
		if (this.url === null) this.url = parseQuickTunnelUrl(this.buffer);
		if (this.buffer.length > MAX_DIAGNOSTIC_CHARS) this.buffer = this.buffer.slice(-MAX_DIAGNOSTIC_CHARS);
		return this.url;
	}
	getUrl() {
		return this.url;
	}
	getDiagnostics() {
		return this.buffer.trim();
	}
};
function formatQuickTunnelTimeoutReason(timeoutMs) {
	return `cloudflared did not publish a public URL within ${Math.round(timeoutMs / 1e3)}s.`;
}
async function probeCloudflaredAvailability(spawn = node_child_process.spawn) {
	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		const settle = (probe) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(interpretCloudflaredVersionProbe(probe));
		};
		const timer = setTimeout(() => {
			child?.kill("SIGKILL");
			settle({ spawnError: { message: "cloudflared did not respond to --version." } });
		}, AVAILABILITY_PROBE_TIMEOUT_MS);
		timer.unref?.();
		let child = null;
		try {
			child = spawn(CLOUDFLARED_BINARY, ["--version"], { stdio: [
				"ignore",
				"pipe",
				"pipe"
			] });
		} catch (error) {
			settle({ spawnError: toSpawnError(error) });
			return;
		}
		child.stdout?.on("data", (chunk) => {
			stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		});
		child.on("error", (error) => {
			settle({ spawnError: toSpawnError(error) });
		});
		child.on("exit", (code) => {
			settle({
				exitCode: code,
				stdout
			});
		});
	});
}
function toSpawnError(error) {
	if (!(error instanceof Error)) return { message: String(error) };
	const code = error.code;
	return code === void 0 ? { message: error.message } : {
		code,
		message: error.message
	};
}
/**
* Owns the single cloudflared child process backing "share this workspace".
*
* The controller is deliberately the only holder of the child handle: a leaked
* cloudflared keeps a public URL pointed at the user's laptop long after they
* believe sharing stopped, so every exit path funnels through `stop()`.
*/
var QuickTunnelController = class {
	state = createWorkspaceShareState();
	child = null;
	urlTimer = null;
	spawn;
	urlTimeoutMs;
	onStateChange;
	probeAvailability;
	resolveServerAuthPolicy;
	constructor(options = {}) {
		this.spawn = options.spawn ?? node_child_process.spawn;
		this.urlTimeoutMs = options.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS;
		this.onStateChange = options.onStateChange;
		this.probeAvailability = options.probeAvailability ?? (() => probeCloudflaredAvailability());
		this.resolveServerAuthPolicy = options.resolveServerAuthPolicy ?? ((port) => probeServerAuthPolicy(port));
	}
	getState() {
		return this.state;
	}
	async start(port) {
		if (!canStartWorkspaceShare(this.state.status)) return this.state;
		const preflight = evaluateWorkspaceSharePreflight(await this.resolveServerAuthPolicy(port).catch(() => null));
		if (!preflight.allowed) return this.setState(reduceWorkspaceShareOnUnavailable(this.state, preflight.reason));
		const availability = await this.probeAvailability();
		if (!availability.available) return this.setState(reduceWorkspaceShareOnUnavailable(this.state, availability.reason ?? "cloudflared is unavailable."));
		this.setState(reduceWorkspaceShareOnStartRequested(this.state));
		const collector = new QuickTunnelOutputCollector();
		let child;
		try {
			child = this.spawn(CLOUDFLARED_BINARY, [...buildQuickTunnelArgs(port)], { stdio: [
				"ignore",
				"pipe",
				"pipe"
			] });
		} catch (error) {
			return this.setState(reduceWorkspaceShareOnFailure(this.state, toSpawnError(error).message));
		}
		this.child = child;
		const onOutput = (chunk) => {
			const url = collector.push(chunk);
			if (url && this.child === child && this.state.status === "starting") {
				this.clearUrlTimer();
				this.setState(reduceWorkspaceShareOnUrlDetected(this.state, url));
			}
		};
		child.stdout?.on("data", onOutput);
		child.stderr?.on("data", onOutput);
		child.on("error", (error) => {
			if (this.child !== child) return;
			this.child = null;
			this.clearUrlTimer();
			this.setState(reduceWorkspaceShareOnFailure(this.state, error.message, collector.getDiagnostics()));
		});
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = null;
			this.clearUrlTimer();
			if (this.state.status === "stopping") {
				this.setState(reduceWorkspaceShareOnStopped(this.state));
				return;
			}
			this.setState(reduceWorkspaceShareOnFailure(this.state, `cloudflared exited (code=${code ?? "null"} signal=${signal ?? "null"}).`, collector.getDiagnostics()));
		});
		this.urlTimer = setTimeout(() => {
			this.urlTimer = null;
			if (this.child !== child || this.state.status !== "starting") return;
			const diagnostics = collector.getDiagnostics();
			this.killChild(child);
			this.child = null;
			this.setState(reduceWorkspaceShareOnFailure(this.state, formatQuickTunnelTimeoutReason(this.urlTimeoutMs), diagnostics));
		}, this.urlTimeoutMs);
		this.urlTimer.unref?.();
		return this.state;
	}
	stop() {
		this.clearUrlTimer();
		const child = this.child;
		this.child = null;
		if (!child) return this.setState(reduceWorkspaceShareOnStopped(this.state));
		this.setState(reduceWorkspaceShareOnStopRequested(this.state));
		this.killChild(child);
		return this.setState(reduceWorkspaceShareOnStopped(this.state));
	}
	/**
	* Synchronous, allocation-free teardown for `process.on("exit")`, where async work
	* and even the event loop are already gone.
	*/
	disposeSync() {
		this.clearUrlTimer();
		const child = this.child;
		this.child = null;
		if (child) this.killChild(child);
		this.state = createWorkspaceShareState();
	}
	killChild(child) {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, STOP_FORCE_KILL_DELAY_MS).unref?.();
	}
	clearUrlTimer() {
		if (!this.urlTimer) return;
		clearTimeout(this.urlTimer);
		this.urlTimer = null;
	}
	setState(next) {
		if (next === this.state) return this.state;
		this.state = next;
		this.onStateChange?.(next);
		return next;
	}
};

//#endregion
//#region ../../packages/shared/src/shell.ts
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;
const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"];
function trimNonEmpty(value) {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : void 0;
}
function readUserLoginShell() {
	try {
		return trimNonEmpty(node_os.userInfo().shell);
	} catch {
		return;
	}
}
function listLoginShellCandidates(platform, shell, userShell = readUserLoginShell()) {
	const fallbackShell = platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : void 0;
	const seen = /* @__PURE__ */ new Set();
	const candidates = [];
	for (const candidate of [
		trimNonEmpty(shell),
		trimNonEmpty(userShell),
		fallbackShell
	]) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		candidates.push(candidate);
	}
	return candidates;
}
function readPathFromLaunchctl(execFile = node_child_process.execFileSync) {
	try {
		return trimNonEmpty(execFile("/bin/launchctl", ["getenv", "PATH"], {
			encoding: "utf8",
			timeout: 2e3
		}));
	} catch {
		return;
	}
}
function mergePathEntries(preferredPath, inheritedPath, platform) {
	const delimiter = platform === "win32" ? ";" : ":";
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	for (const pathValue of [preferredPath, inheritedPath]) {
		if (!pathValue) continue;
		for (const entry of pathValue.split(delimiter)) {
			const trimmedEntry = entry.trim();
			if (!trimmedEntry || seen.has(trimmedEntry)) continue;
			seen.add(trimmedEntry);
			merged.push(trimmedEntry);
		}
	}
	return merged.length > 0 ? merged.join(delimiter) : void 0;
}
function envCaptureStart(name) {
	return `__T3CODE_ENV_${name}_START__`;
}
function envCaptureEnd(name) {
	return `__T3CODE_ENV_${name}_END__`;
}
function buildEnvironmentCaptureCommand(names) {
	return names.map((name) => {
		if (!SHELL_ENV_NAME_PATTERN.test(name)) throw new Error(`Unsupported environment variable name: ${name}`);
		return [
			`printf '%s\\n' '${envCaptureStart(name)}'`,
			`printenv ${name} || true`,
			`printf '%s\\n' '${envCaptureEnd(name)}'`
		].join("; ");
	}).join("; ");
}
function buildWindowsEnvironmentCaptureCommand(names) {
	return ["$ErrorActionPreference = 'Stop'", ...names.flatMap((name) => {
		if (!SHELL_ENV_NAME_PATTERN.test(name)) throw new Error(`Unsupported environment variable name: ${name}`);
		return [
			`Write-Output '${envCaptureStart(name)}'`,
			`$value = [Environment]::GetEnvironmentVariable('${name}')`,
			"if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
			`Write-Output '${envCaptureEnd(name)}'`
		];
	})].join("; ");
}
function extractEnvironmentValue(output, name) {
	const startMarker = envCaptureStart(name);
	const endMarker = envCaptureEnd(name);
	const startIndex = output.indexOf(startMarker);
	if (startIndex === -1) return void 0;
	const valueStartIndex = startIndex + startMarker.length;
	const endIndex = output.indexOf(endMarker, valueStartIndex);
	if (endIndex === -1) return void 0;
	const value = output.slice(valueStartIndex, endIndex).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
	return value.length > 0 ? value : void 0;
}
const readEnvironmentFromLoginShell = (shell, names, execFile = node_child_process.execFileSync) => {
	if (names.length === 0) return {};
	const output = execFile(shell, ["-ilc", buildEnvironmentCaptureCommand(names)], {
		encoding: "utf8",
		timeout: 5e3
	});
	const environment = {};
	for (const name of names) {
		const value = extractEnvironmentValue(output, name);
		if (value !== void 0) environment[name] = value;
	}
	return environment;
};
function readEnvironmentFromWindowsShell(names, optionsOrExecFile, maybeExecFile) {
	if (names.length === 0) return {};
	const options = typeof optionsOrExecFile === "function" ? {} : optionsOrExecFile ?? {};
	const execFile = typeof optionsOrExecFile === "function" ? optionsOrExecFile : maybeExecFile ?? node_child_process.execFileSync;
	const command = buildWindowsEnvironmentCaptureCommand(names);
	const args = [
		"-NoLogo",
		...options.loadProfile ? [] : ["-NoProfile"],
		"-NonInteractive",
		"-Command",
		command
	];
	for (const shell of WINDOWS_SHELL_CANDIDATES) try {
		const output = execFile(shell, args, {
			encoding: "utf8",
			timeout: 5e3
		});
		const environment = {};
		for (const name of names) {
			const value = extractEnvironmentValue(output, name);
			if (value !== void 0) environment[name] = value;
		}
		return environment;
	} catch {
		continue;
	}
	return {};
}
function stripWrappingQuotes(value) {
	return value.replace(/^"+|"+$/g, "");
}
function pathDelimiterForPlatform(platform) {
	return platform === "win32" ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER;
}
function normalizePathEntryForComparison(entry, platform) {
	const normalized = stripWrappingQuotes(entry.trim());
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}
function mergePathValues(preferredPath, inheritedPath, platform) {
	const delimiter = pathDelimiterForPlatform(platform);
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	for (const rawValue of [preferredPath, inheritedPath]) {
		if (!rawValue) continue;
		for (const entry of rawValue.split(delimiter)) {
			const trimmed = entry.trim();
			if (trimmed.length === 0) continue;
			const normalized = normalizePathEntryForComparison(trimmed, platform);
			if (normalized.length === 0 || seen.has(normalized)) continue;
			seen.add(normalized);
			merged.push(trimmed);
		}
	}
	return merged.length > 0 ? merged.join(delimiter) : void 0;
}
function readEnvPath(env) {
	return env.PATH ?? env.Path ?? env.path;
}
function resolvePathEnvironmentVariable(env) {
	return readEnvPath(env) ?? "";
}
function resolveWindowsPathExtensions(env) {
	const rawValue = env.PATHEXT;
	const fallback = [
		".COM",
		".EXE",
		".BAT",
		".CMD"
	];
	if (!rawValue) return fallback;
	const parsed = rawValue.split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0).map((entry) => entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`);
	return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}
function resolveCommandCandidates(command, platform, windowsPathExtensions) {
	if (platform !== "win32") return [command];
	const extension = (0, node_path.extname)(command);
	const normalizedExtension = extension.toUpperCase();
	if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
		const commandWithoutExtension = command.slice(0, -extension.length);
		return Array.from(new Set([
			command,
			`${commandWithoutExtension}${normalizedExtension}`,
			`${commandWithoutExtension}${normalizedExtension.toLowerCase()}`
		]));
	}
	const candidates = [];
	for (const candidateExtension of windowsPathExtensions) {
		candidates.push(`${command}${candidateExtension}`);
		candidates.push(`${command}${candidateExtension.toLowerCase()}`);
	}
	return Array.from(new Set(candidates));
}
function isExecutableFile(filePath, platform, windowsPathExtensions) {
	try {
		if (!(0, node_fs.statSync)(filePath).isFile()) return false;
		if (platform === "win32") {
			const extension = (0, node_path.extname)(filePath);
			if (extension.length === 0) return false;
			return windowsPathExtensions.includes(extension.toUpperCase());
		}
		(0, node_fs.accessSync)(filePath, node_fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function isCommandAvailable(command, options = {}) {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
	const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);
	if (command.includes("/") || command.includes("\\")) return commandCandidates.some((candidate) => isExecutableFile(candidate, platform, windowsPathExtensions));
	const pathValue = resolvePathEnvironmentVariable(env);
	if (pathValue.length === 0) return false;
	const pathEntries = pathValue.split(pathDelimiterForPlatform(platform)).map((entry) => stripWrappingQuotes(entry.trim())).filter((entry) => entry.length > 0);
	for (const pathEntry of pathEntries) for (const candidate of commandCandidates) if (isExecutableFile((0, node_path.join)(pathEntry, candidate), platform, windowsPathExtensions)) return true;
	return false;
}
function resolveKnownWindowsCliDirs(env) {
	const appData = env.APPDATA?.trim();
	const localAppData = env.LOCALAPPDATA?.trim();
	const userProfile = env.USERPROFILE?.trim();
	return [
		...appData ? [`${appData}\\npm`] : [],
		...localAppData ? [`${localAppData}\\Programs\\nodejs`, `${localAppData}\\Volta\\bin`] : [],
		...localAppData ? [`${localAppData}\\pnpm`] : [],
		...userProfile ? [`${userProfile}\\.bun\\bin`, `${userProfile}\\scoop\\shims`] : []
	];
}
function readWindowsEnvironmentSafely(readEnvironment, names, options) {
	try {
		return readEnvironment(names, options);
	} catch {
		return {};
	}
}
function mergeWindowsEnv(currentEnv, patch) {
	const nextEnv = { ...currentEnv };
	for (const [key, value] of Object.entries(patch)) if (value !== void 0) nextEnv[key] = value;
	return nextEnv;
}
function resolveWindowsEnvironment(env, options = {}) {
	const readEnvironment = options.readEnvironment ?? readEnvironmentFromWindowsShell;
	const commandAvailable = options.commandAvailable ?? isCommandAvailable;
	const inheritedPath = readEnvPath(env);
	const shellPath = readWindowsEnvironmentSafely(readEnvironment, ["PATH"], { loadProfile: false }).PATH;
	const mergedPath = mergePathValues(shellPath, inheritedPath, "win32");
	const baselinePath = mergePathValues(resolveKnownWindowsCliDirs(env).join(WINDOWS_PATH_DELIMITER), mergedPath, "win32");
	const baselinePatch = baselinePath ? { PATH: baselinePath } : {};
	if (commandAvailable("node", {
		platform: "win32",
		env: mergeWindowsEnv(env, baselinePatch)
	})) return baselinePatch;
	const profiledEnvironment = readWindowsEnvironmentSafely(readEnvironment, [
		"PATH",
		"FNM_DIR",
		"FNM_MULTISHELL_PATH"
	], { loadProfile: true });
	const profiledPath = mergePathValues(profiledEnvironment.PATH, baselinePath, "win32");
	const profiledPatch = {
		...profiledPath ? { PATH: profiledPath } : {},
		...profiledEnvironment.FNM_DIR ? { FNM_DIR: profiledEnvironment.FNM_DIR } : {},
		...profiledEnvironment.FNM_MULTISHELL_PATH ? { FNM_MULTISHELL_PATH: profiledEnvironment.FNM_MULTISHELL_PATH } : {}
	};
	return Object.keys(profiledPatch).length > 0 ? {
		...baselinePatch,
		...profiledPatch
	} : baselinePatch;
}

//#endregion
//#region src/syncShellEnvironment.ts
const LOGIN_SHELL_ENV_NAMES = [
	"PATH",
	"SSH_AUTH_SOCK",
	"HOMEBREW_PREFIX",
	"HOMEBREW_CELLAR",
	"HOMEBREW_REPOSITORY",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME"
];
function logShellEnvironmentWarning(message, error) {
	console.warn(`[desktop] ${message}`, error instanceof Error ? error.message : error ?? "");
}
function syncShellEnvironment(env = process.env, options = {}) {
	const platform = options.platform ?? process.platform;
	const logWarning = options.logWarning ?? logShellEnvironmentWarning;
	const readEnvironment = options.readEnvironment ?? readEnvironmentFromLoginShell;
	const shellEnvironment = {};
	try {
		if (platform === "win32") {
			const repairedEnvironment = resolveWindowsEnvironment(env, {
				...options.readWindowsEnvironment ? { readEnvironment: options.readWindowsEnvironment } : {},
				...options.isWindowsCommandAvailable ? { commandAvailable: options.isWindowsCommandAvailable } : {}
			});
			for (const [key, value] of Object.entries(repairedEnvironment)) if (value !== void 0) env[key] = value;
			return;
		}
		if (platform !== "darwin" && platform !== "linux") return;
		for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) try {
			Object.assign(shellEnvironment, readEnvironment(shell, LOGIN_SHELL_ENV_NAMES));
			if (shellEnvironment.PATH) break;
		} catch (error) {
			logWarning(`Failed to read login shell environment from ${shell}.`, error);
		}
		const launchctlPath = platform === "darwin" && !shellEnvironment.PATH ? (options.readLaunchctlPath ?? readPathFromLaunchctl)() : void 0;
		const mergedPath = mergePathEntries(shellEnvironment.PATH ?? launchctlPath, env.PATH, platform);
		if (mergedPath) env.PATH = mergedPath;
		if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
		for (const name of [
			"HOMEBREW_PREFIX",
			"HOMEBREW_CELLAR",
			"HOMEBREW_REPOSITORY",
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME"
		]) if (!env[name] && shellEnvironment[name]) env[name] = shellEnvironment[name];
	} catch (error) {
		logWarning("Failed to synchronize the desktop shell environment.", error);
	}
}

//#endregion
//#region src/updateState.ts
function shouldBroadcastDownloadProgress(currentState, nextPercent) {
	if (currentState.status !== "downloading") return true;
	const currentPercent = currentState.downloadPercent;
	if (currentPercent === null) return true;
	const previousStep = Math.floor(currentPercent / 10);
	return Math.floor(nextPercent / 10) !== previousStep || nextPercent === 100;
}
function nextStatusAfterDownloadFailure(currentState) {
	return currentState.availableVersion ? "available" : "error";
}
function getCanRetryAfterDownloadFailure(currentState) {
	return currentState.availableVersion !== null;
}
function getAutoUpdateDisabledReason(args) {
	if (!args.hasUpdateFeedConfig) return "Automatic updates are not available because no update feed is configured.";
	if (args.isDevelopment || !args.isPackaged) return "Automatic updates are only available in packaged production builds.";
	if (args.disabledByEnv) return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
	if (args.platform === "linux" && !args.appImage) return "Automatic updates on Linux require running the AppImage build.";
	return null;
}

//#endregion
//#region src/serverListeningDetector.ts
const LISTENING_LOG_FRAGMENT = "Listening on http://";
const MAX_BUFFER_CHARS = 8192;
var ServerListeningDetector = class {
	buffer = "";
	settled = false;
	resolvePromise;
	rejectPromise;
	promise;
	constructor() {
		let resolvePromise = null;
		let rejectPromise = null;
		this.promise = new Promise((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		this.resolvePromise = () => {
			if (this.settled) return;
			this.settled = true;
			resolvePromise?.();
		};
		this.rejectPromise = (error) => {
			if (this.settled) return;
			this.settled = true;
			rejectPromise?.(error);
		};
	}
	push(chunk) {
		if (this.settled) return;
		const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		this.buffer = `${this.buffer}${text.replace(/\r/g, "")}`;
		if (this.buffer.includes(LISTENING_LOG_FRAGMENT)) {
			this.resolvePromise();
			return;
		}
		if (this.buffer.length > MAX_BUFFER_CHARS) this.buffer = this.buffer.slice(-MAX_BUFFER_CHARS);
	}
	fail(error) {
		this.rejectPromise(error);
	}
};

//#endregion
//#region src/updateMachine.ts
function createInitialDesktopUpdateState(currentVersion, runtimeInfo, channel) {
	return {
		enabled: false,
		status: "disabled",
		channel,
		currentVersion,
		hostArch: runtimeInfo.hostArch,
		appArch: runtimeInfo.appArch,
		runningUnderArm64Translation: runtimeInfo.runningUnderArm64Translation,
		availableVersion: null,
		downloadedVersion: null,
		downloadPercent: null,
		checkedAt: null,
		message: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnCheckStart(state, checkedAt) {
	return {
		...state,
		status: "checking",
		checkedAt,
		message: null,
		downloadPercent: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnCheckFailure(state, message, checkedAt) {
	return {
		...state,
		status: "error",
		message,
		checkedAt,
		downloadPercent: null,
		errorContext: "check",
		canRetry: true
	};
}
function reduceDesktopUpdateStateOnUpdateAvailable(state, version, checkedAt) {
	return {
		...state,
		status: "available",
		availableVersion: version,
		downloadedVersion: null,
		downloadPercent: null,
		checkedAt,
		message: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnNoUpdate(state, checkedAt) {
	return {
		...state,
		status: "up-to-date",
		availableVersion: null,
		downloadedVersion: null,
		downloadPercent: null,
		checkedAt,
		message: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnDownloadStart(state) {
	return {
		...state,
		status: "downloading",
		downloadPercent: 0,
		message: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnDownloadFailure(state, message) {
	return {
		...state,
		status: nextStatusAfterDownloadFailure(state),
		message,
		downloadPercent: null,
		errorContext: "download",
		canRetry: getCanRetryAfterDownloadFailure(state)
	};
}
function reduceDesktopUpdateStateOnDownloadProgress(state, percent) {
	return {
		...state,
		status: "downloading",
		downloadPercent: percent,
		message: null,
		errorContext: null,
		canRetry: false
	};
}
function reduceDesktopUpdateStateOnDownloadComplete(state, version) {
	return {
		...state,
		status: "downloaded",
		availableVersion: version,
		downloadedVersion: version,
		downloadPercent: 100,
		message: null,
		errorContext: null,
		canRetry: true
	};
}
function reduceDesktopUpdateStateOnInstallFailure(state, message) {
	return {
		...state,
		status: "downloaded",
		message,
		errorContext: "install",
		canRetry: true
	};
}

//#endregion
//#region src/runtimeArch.ts
function normalizeDesktopArch(arch) {
	if (arch === "arm64") return "arm64";
	if (arch === "x64") return "x64";
	return "other";
}
function resolveDesktopRuntimeInfo(input) {
	const appArch = normalizeDesktopArch(input.processArch);
	if (input.platform !== "darwin") return {
		hostArch: appArch,
		appArch,
		runningUnderArm64Translation: false
	};
	return {
		hostArch: appArch === "arm64" || input.runningUnderArm64Translation ? "arm64" : appArch,
		appArch,
		runningUnderArm64Translation: input.runningUnderArm64Translation
	};
}
function isArm64HostRunningIntelBuild(runtimeInfo) {
	return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

//#endregion
//#region src/appBranding.ts
const APP_BASE_NAME = "LogicPacks";
function resolveDesktopAppStageLabel(input) {
	if (input.isDevelopment) return "Dev";
	return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}
function resolveDesktopAppBranding(input) {
	const stageLabel = resolveDesktopAppStageLabel(input);
	return {
		baseName: APP_BASE_NAME,
		stageLabel,
		displayName: `${APP_BASE_NAME} (${stageLabel})`
	};
}

//#endregion
//#region src/notchContext.ts
/**
* What the notch panel is *about*, derived from the route the app window is on.
*
* The panel has one surface and a few hundred milliseconds of attention, so the
* figures worth putting in it depend entirely on what the person is looking at:
* deployment numbers are noise on the analytics page and the reverse is just as
* true. This module is the whole of that decision, kept pure so the mapping can
* be exercised against every route the app has without an Electron window.
*
* The context is read from the URL rather than reported by the renderer. The web
* app runs on hash history under Electron (`apps/web/src/main.tsx`), so
* `webContents.getURL()` already carries the active route in its fragment, and
* the main process can see it without a `DesktopBridge` method — which would
* mean a new channel, a new preload surface, and a stub in every test that
* constructs a bridge. Nothing here imports Electron; the caller hands in a
* string.
*
* Two properties this file has to keep:
*
* 1. **Every context defines exactly `NOTCH_SLOT_COUNT` slots.** The panel's
*    geometry is fixed by `notchGeometry.ts` and the window never resizes, so a
*    context with four rows would overflow the surface and one with two would
*    leave a hole. A panel that changes shape as you navigate is worse than one
*    that never changes at all, so the count is a constant and a test.
* 2. **A context names a project only when the route did.** `deployment` and
*    `analytics` are read for one project; inventing an id for them would make
*    the panel confidently report somebody else's deployments.
*/
/**
* Rows the expanded panel draws. Three fits `NOTCH_PANEL_HEIGHT` with the title
* above it; see `notchPanelDocument.ts` for the box this has to live inside.
*/
const NOTCH_SLOT_COUNT = 3;
/**
* What each context shows.
*
* `prompting` is deliberately thin. The main process knows which route the app
* is on, not what the thread is doing — there is no turn state on this side of
* the process boundary — so it reports the one thing it can stand behind (a
* thread is open, and what the account has spent) and says outright that the
* turn itself is not visible. A spinner here would be a drawing of something
* nobody looked at.
*/
const NOTCH_CONTEXT_PANELS = {
	default: {
		title: "Live activity",
		slots: [
			{
				figure: "shareClicks",
				label: "Share clicks"
			},
			{
				figure: "tokenSpend",
				label: "Token spend"
			},
			{
				figure: "activeSyncs",
				label: "Active syncs"
			}
		]
	},
	deployment: {
		title: "Deployment",
		slots: [
			{
				figure: "liveDeployments",
				label: "Live"
			},
			{
				figure: "deploymentTraffic",
				label: "Traffic"
			},
			{
				figure: "lastDeploy",
				label: "Last deploy"
			}
		]
	},
	analytics: {
		title: "Analytics",
		slots: [
			{
				figure: "analyticsStreams",
				label: "Streams"
			},
			{
				figure: "analyticsEvents",
				label: "Events"
			},
			{
				figure: "analyticsReporters",
				label: "Reporting"
			}
		]
	},
	prompting: {
		title: "Current thread",
		slots: [
			{
				figure: "threadRoute",
				label: "Thread"
			},
			{
				figure: "tokenSpend",
				label: "Token spend"
			},
			{
				figure: "turnState",
				label: "Turn"
			}
		]
	}
};
const defaultNotchContext = {
	kind: "default",
	projectId: null,
	thread: null
};
/**
* First path segments the router resolves statically, from
* `apps/web/src/routeTree.gen.ts`.
*
* This list is what makes `/$environmentId/$threadId` decidable: a thread route
* is two segments, and so is `/settings/general`, so the only way to tell them
* apart is to know which first segments are spoken for. TanStack Router picks
* the static branch over the dynamic one for exactly the same reason, so this
* mirrors its resolution rather than guessing at it. A route added to the web
* app without being added here would be read as a thread; the test file lists
* every current route so that drift shows up as a failure.
*/
const STATIC_FIRST_SEGMENTS = new Set([
	"settings",
	"pair",
	"invite",
	"pack",
	"infra",
	"draft",
	"analytics",
	"project"
]);
/**
* The route the app window is on, as path segments.
*
* Returns `null` when there is no route to read — no window yet, `about:blank`,
* or a URL with no fragment because the router has not written one. That is a
* different answer from "the root route", though both end up on the default
* context: the account-wide figures are true wherever the app happens to be.
*/
function readRouteSegments(url) {
	if (typeof url !== "string" || url.length === 0) return null;
	const hash = url.indexOf("#");
	if (hash === -1) return null;
	return (url.slice(hash + 1).split("?")[0] ?? "").split("/").filter((segment) => segment.length > 0).map((segment) => {
		try {
			return decodeURIComponent(segment);
		} catch {
			return segment;
		}
	});
}
function projectContext(kind, projectId) {
	return projectId === void 0 || projectId.length === 0 ? defaultNotchContext : {
		kind,
		projectId,
		thread: null
	};
}
/**
* Maps a window URL onto the context the panel should draw.
*
* Anything unrecognised is the default context on purpose: the account-wide
* figures are the ones that are true everywhere, so an unmapped route degrades
* to today's panel rather than to an empty one.
*/
function resolveNotchContext(url) {
	const segments = readRouteSegments(url);
	if (segments === null || segments.length === 0) return defaultNotchContext;
	const [first, second] = segments;
	switch (first) {
		case "infra": return projectContext("deployment", second);
		case "analytics": return projectContext("analytics", second);
		case "draft": return second === void 0 || second.length === 0 ? defaultNotchContext : {
			kind: "prompting",
			projectId: null,
			thread: "draft"
		};
		default: break;
	}
	if (segments.length === 2 && first !== void 0 && !STATIC_FIRST_SEGMENTS.has(first) && second !== void 0) return {
		kind: "prompting",
		projectId: null,
		thread: "started"
	};
	return defaultNotchContext;
}
function areNotchContextsEqual(left, right) {
	return left.kind === right.kind && left.projectId === right.projectId && left.thread === right.thread;
}
function resolveNotchFeed(context) {
	return context.projectId === null ? { kind: "account" } : {
		kind: "project",
		projectId: context.projectId
	};
}

//#endregion
//#region src/notchGeometry.ts
const NOTCH_COLLAPSED_WIDTH = 190;
/**
* How far the collapsed pill drops below the menu bar. On a notched Mac the
* rest of the pill is hidden behind the notch itself, so this sliver is the
* only part anyone ever sees.
*/
const NOTCH_COLLAPSED_CHIN_HEIGHT = 10;
/**
* On a Mac without a notch there is nothing to hide behind, so the collapsed
* pill sits entirely below the menu bar and needs enough height to read as a
* deliberate shape rather than a rendering glitch.
*/
const NOTCH_COLLAPSED_STANDALONE_HEIGHT = 14;
const NOTCH_PANEL_WIDTH = 380;
const NOTCH_PANEL_HEIGHT = 160;
/**
* Slack around the panel inside the host window. The panel's drop shadow is
* drawn by CSS, so it needs transparent window to bleed into or macOS clips it.
*/
const NOTCH_PANEL_GUTTER = 16;
/**
* A notched display reserves a taller menu bar so the menus clear the camera
* housing: roughly 37-38pt against 24-25pt on every other Mac. macOS exposes
* no notch API, so that gap is the only signal available, and any threshold
* between the two clusters separates them.
*/
const NOTCH_MENU_BAR_INSET_THRESHOLD = 32;
function centerWithin(outer, width) {
	return Math.round(outer.x + (outer.width - width) / 2);
}
/** Rects are clamped rather than allowed to go non-positive on odd displays. */
function atLeastOne(value) {
	return Math.max(1, Math.round(value));
}
function resolveNotchLayout(display) {
	const { bounds, workArea } = display;
	const menuBarInset = Math.max(0, Math.round(workArea.y - bounds.y));
	const hasNotch = menuBarInset >= NOTCH_MENU_BAR_INSET_THRESHOLD;
	const panelWidth = atLeastOne(Math.min(NOTCH_PANEL_WIDTH, bounds.width));
	const panelHeight = atLeastOne(Math.min(NOTCH_PANEL_HEIGHT, bounds.height - menuBarInset));
	const windowWidth = atLeastOne(Math.min(panelWidth + NOTCH_PANEL_GUTTER * 2, bounds.width));
	const windowHeight = atLeastOne(Math.min(menuBarInset + panelHeight + NOTCH_PANEL_GUTTER, bounds.height));
	const window = {
		x: centerWithin(bounds, windowWidth),
		y: Math.round(bounds.y),
		width: windowWidth,
		height: windowHeight
	};
	const chinHeight = hasNotch ? NOTCH_COLLAPSED_CHIN_HEIGHT : NOTCH_COLLAPSED_STANDALONE_HEIGHT;
	const collapsedWidth = atLeastOne(Math.min(NOTCH_COLLAPSED_WIDTH, windowWidth));
	return {
		window,
		collapsed: {
			x: centerWithin(bounds, collapsedWidth),
			y: hasNotch ? window.y : window.y + menuBarInset,
			width: collapsedWidth,
			height: atLeastOne(Math.min(hasNotch ? menuBarInset + chinHeight : chinHeight, windowHeight))
		},
		expanded: {
			x: centerWithin(bounds, panelWidth),
			y: window.y + menuBarInset,
			width: panelWidth,
			height: panelHeight
		},
		menuBarInset,
		chinHeight,
		hasNotch
	};
}
/** Left/top edges are inside the rect, right/bottom edges are not. */
function containsPoint(rect, point) {
	return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}
function unionRect(a, b) {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y
	};
}
/**
* The region that counts as "still hovering". Expanding uses the pill alone so
* the panel does not fire from anywhere along the menu bar; staying expanded
* uses the pill *and* the panel, so travelling down into the panel — across the
* gap the pill leaves behind — never reads as a mouse-out.
*/
function resolveNotchHoverTarget(layout, expanded) {
	return expanded ? unionRect(layout.collapsed, layout.expanded) : layout.collapsed;
}
/**
* The region the panel is allowed to take clicks in, or `null` when it must
* stay click-through.
*
* The host window is one rectangle that starts at the top of the display, so
* turning mouse events on for it turns them on over the menu bar too. This is
* what keeps that from happening: the answer is only ever `expanded`, and
* `expanded.y` is the top of the work area by construction — the strip the menu
* bar owns, and the part of the collapsed pill that overlaps it, are outside
* every rect this can return. `actionable` is the second half of the rule:
* a panel showing figures has nothing to press, so it goes on costing nothing.
*/
function resolveNotchClickTarget(layout, expanded, actionable) {
	return expanded && actionable ? layout.expanded : null;
}
/** Screen-space rect rebased onto the host window's coordinate system. */
function toWindowLocalRect(rect, window) {
	return {
		x: rect.x - window.x,
		y: rect.y - window.y,
		width: rect.width,
		height: rect.height
	};
}
function areRectsEqual(a, b) {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

//#endregion
//#region src/notchPanelDocument.ts
/**
* The notch panel's document, generated in-process.
*
* It is built as a string and handed to the renderer as a `data:` URL instead
* of shipping an HTML file, because the desktop bundler only emits
* `main.cjs`/`preload.cjs` — a loose asset under `src/` would exist in the repo
* and be missing from every packaged build. Keeping it here also guarantees the
* "no external assets, no network" property by construction: there is nothing
* for the page to reference.
*
* Collapsed/expanded state is driven from the main process by assigning a data
* attribute on `<html>`; everything else is CSS. That keeps the page free of
* script and means the morph runs on the compositor rather than over IPC. The
* numbers arrive the same way: `buildNotchDataScript` writes text into slots
* the document already laid out, so the page never has to know where a figure
* came from or how to ask for it.
*
* The rows are numbered rather than named, because what they hold depends on
* what the person is looking at (`notchContext.ts`). The document lays out
* exactly `NOTCH_SLOT_COUNT` rows once and the update script rewrites their
* labels along with their values, so navigating swaps the *content* of a box
* whose size was fixed at load. Nothing a context can do reflows the panel.
*/
const NOTCH_STATE_ATTRIBUTE = "notchState";
const NOTCH_ACTION_ATTRIBUTE = "notchAction";
/** Written when no state offers an action, so the switch is a plain assignment. */
const NOTCH_ACTION_NONE = "none";
/**
* The one hook a click has to find, named here because this module writes it.
*
* The page carries no script of its own, so the click is recognised in
* `notchPreload.ts` by this attribute. Sharing the constant is what stops the
* button and the code listening for it from drifting apart silently.
*/
const NOTCH_ACTION_BUTTON_ATTRIBUTE = "data-notch-action-button";
/**
* The page -> main direction of the same contract the rest of this module
* defines going the other way. Main drives the panel by evaluating the scripts
* below; this is the single message that travels back, and it carries nothing —
* the channel *is* the message.
*/
const NOTCH_SIGN_IN_CHANNEL = "desktop:notch-sign-in";
const EM_DASH = "—";
/** What the page shows between being loaded and the first read landing. */
const initialNotchPanelView = {
	title: NOTCH_CONTEXT_PANELS.default.title,
	slots: NOTCH_CONTEXT_PANELS.default.slots.map(({ label }) => ({
		label,
		value: EM_DASH,
		note: "",
		detail: "Not read yet."
	})),
	action: null
};
/**
* The signed-out panel's words.
*
* Two lines and no more: this is a hover panel at the top of the screen, and
* the reader has already been told the app is not signed in by the fact that
* they are looking at this rather than at their figures. The tooltip says what
* the button actually does, because pressing it lands on the app window rather
* than on a form the panel could ever host itself.
*/
const SIGN_IN_LINE = "Not signed in, so there is nothing to report yet.";
const SIGN_IN_BUTTON_LABEL = "Sign in";
const SIGN_IN_BUTTON_DETAIL = "Brings the T3 Code window forward, where you can sign in.";
/** Corner radius of the expanded panel, in CSS pixels. */
const PANEL_RADIUS = 22;
/** Radius on the two corners of the collapsed pill that are actually visible. */
const PILL_RADIUS = 12;
const MORPH_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const MORPH_DURATION_MS = 260;
/** Width of the small handle drawn on the collapsed pill. */
const GRIP_WIDTH = 26;
const GRIP_HEIGHT = 3;
function buildNotchCssVariables(layout) {
	const collapsed = toWindowLocalRect(layout.collapsed, layout.window);
	const expanded = toWindowLocalRect(layout.expanded, layout.window);
	return {
		"--notch-pill-top": `${collapsed.y}px`,
		"--notch-pill-width": `${collapsed.width}px`,
		"--notch-pill-height": `${collapsed.height}px`,
		"--notch-pill-radius": layout.hasNotch ? `0 0 ${PILL_RADIUS}px ${PILL_RADIUS}px` : `${Math.round(collapsed.height / 2)}px`,
		"--notch-grip-bottom": `${Math.max(2, Math.round((layout.chinHeight - GRIP_HEIGHT) / 2))}px`,
		"--notch-panel-top": `${expanded.y}px`,
		"--notch-panel-width": `${expanded.width}px`,
		"--notch-panel-height": `${expanded.height}px`
	};
}
function renderCssVariableBlock(layout) {
	return Object.entries(buildNotchCssVariables(layout)).map(([name, value]) => `      ${name}: ${value};`).join("\n");
}
/**
* Values and details are generated here, but they still pass through this on
* the way into a template string — the day one of them starts carrying a
* server-supplied name, the escaping has to already be in place.
*/
function escapeHtml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}
function renderSlots() {
	return initialNotchPanelView.slots.map((slot, index) => {
		const detail = escapeHtml(slot.detail);
		const value = slot.value === EM_DASH ? "&mdash;" : escapeHtml(slot.value);
		return `        <div class="slot" data-slot="${index}"><dt>${escapeHtml(slot.label)}</dt><dd title="${detail}" aria-label="${detail}"><span class="value">${value}</span><span class="note">${escapeHtml(slot.note)}</span></dd></div>`;
	}).join("\n");
}
function buildNotchPanelHtml(layout) {
	return `<!doctype html>
<html lang="en" data-notch-state="collapsed" data-notch-action="${NOTCH_ACTION_NONE}">
  <head>
    <meta charset="utf-8" />
    <title>Live activity</title>
    <style>
      :root {
${renderCssVariableBlock(layout)}
      }

      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }

      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
        color: rgba(255, 255, 255, 0.92);
        cursor: default;
        user-select: none;
      }

      /*
       * One element morphs between the two shapes. Animating the box rather
       * than swapping two elements is what keeps the expansion continuous:
       * the pill visibly grows into the panel instead of being replaced by it.
       */
      .surface {
        position: absolute;
        left: 50%;
        top: var(--notch-pill-top);
        width: var(--notch-pill-width);
        height: var(--notch-pill-height);
        transform: translateX(-50%);
        border-radius: var(--notch-pill-radius);
        background-color: rgba(12, 12, 14, 0.94);
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.32);
        overflow: hidden;
        transition:
          top ${MORPH_DURATION_MS}ms ${MORPH_EASING},
          width ${MORPH_DURATION_MS}ms ${MORPH_EASING},
          height ${MORPH_DURATION_MS}ms ${MORPH_EASING},
          border-radius ${MORPH_DURATION_MS}ms ${MORPH_EASING},
          background-color ${MORPH_DURATION_MS}ms ease,
          box-shadow ${MORPH_DURATION_MS}ms ease;
      }

      html[data-notch-state="expanded"] .surface {
        top: var(--notch-panel-top);
        width: var(--notch-panel-width);
        height: var(--notch-panel-height);
        border-radius: ${PANEL_RADIUS}px;
        /*
         * Real macOS vibrancy is a window-level effect and would tint the whole
         * host window, including the transparent gutter, so the panel settles
         * for straight alpha over the desktop instead.
         */
        background-color: rgba(20, 20, 23, 0.86);
        box-shadow:
          0 18px 44px rgba(0, 0, 0, 0.45),
          inset 0 1px 0 rgba(255, 255, 255, 0.09);
      }

      .grip {
        position: absolute;
        left: 50%;
        bottom: var(--notch-grip-bottom);
        width: ${GRIP_WIDTH}px;
        height: ${GRIP_HEIGHT}px;
        transform: translateX(-50%);
        border-radius: 999px;
        background-color: rgba(255, 255, 255, 0.28);
        transition: opacity 140ms ease;
      }

      html[data-notch-state="expanded"] .grip {
        opacity: 0;
      }

      /*
       * Pinned to the panel's final size so the text does not reflow while the
       * surface is still growing; the surface clips it until there is room.
       */
      .panel {
        position: absolute;
        left: 0;
        top: 0;
        width: var(--notch-panel-width);
        height: var(--notch-panel-height);
        padding: 20px 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        opacity: 0;
        transform: translateY(-6px);
        transition:
          opacity 140ms ease,
          transform 200ms ${MORPH_EASING};
      }

      html[data-notch-state="expanded"] .panel {
        opacity: 1;
        transform: none;
        /* Let the box finish most of its travel before the content arrives. */
        transition-delay: 90ms;
      }

      /*
       * Single-line, clipped rather than wrapped: the heading changes with the
       * context, and a two-line heading would push the rows below it down.
       */
      .panel-title {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.42);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .slots {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .slot {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
      }

      /*
       * Labels are rewritten as the context changes, so they are pinned to one
       * line. A label allowed to wrap would make the panel taller on some pages
       * than on others, inside a window whose height was fixed at load.
       */
      .slot dt {
        font-size: 13px;
        color: rgba(255, 255, 255, 0.55);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .slot dd {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
      }

      .slot dd .value {
        font-size: 15px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: rgba(255, 255, 255, 0.9);
      }

      /*
       * Deliberately quiet. It qualifies the number beside it — or explains a
       * dash — and must never compete with the figure for the half-second of
       * attention a hover panel gets.
       */
      .slot dd .note {
        font-size: 11px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.38);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .slot dd .note:empty {
        display: none;
      }

      /*
       * The one state the panel can do something about takes the rows' place
       * rather than joining them: the rows are laid out to fill the panel, and
       * a fourth thing below them would not fit a box whose height was fixed at
       * load. The rows stay in the document and keep being rewritten, so
       * signing in brings the figures back without rebuilding the page.
       */
      .action {
        display: none;
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
      }

      html[data-notch-action="sign-in"] .slots {
        display: none;
      }

      html[data-notch-action="sign-in"] .action {
        display: flex;
      }

      .action-line {
        font-size: 13px;
        line-height: 1.35;
        color: rgba(255, 255, 255, 0.55);
      }

      /*
       * Quiet on purpose. It is the only thing on this surface anyone can press,
       * so it has to read as pressable — but a hover panel over the menu bar is
       * not a login form, and a filled accent button here would be shouting.
       */
      .action-button {
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.92);
        background-color: rgba(255, 255, 255, 0.12);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 8px;
        padding: 6px 14px;
        cursor: pointer;
        transition: background-color 120ms ease;
      }

      .action-button:hover {
        background-color: rgba(255, 255, 255, 0.2);
      }

      .action-button:active {
        background-color: rgba(255, 255, 255, 0.26);
      }

      @media (prefers-reduced-motion: reduce) {
        .surface,
        .grip,
        .panel {
          transition-duration: 1ms;
        }
      }
    </style>
  </head>
  <body>
    <div class="surface">
      <div class="grip"></div>
      <div class="panel">
        <div class="panel-title" data-panel-title>${escapeHtml(initialNotchPanelView.title)}</div>
        <dl class="slots">
${renderSlots()}
        </dl>
        <div class="action">
          <p class="action-line">${escapeHtml(SIGN_IN_LINE)}</p>
          <button type="button" class="action-button" ${NOTCH_ACTION_BUTTON_ATTRIBUTE} title="${escapeHtml(SIGN_IN_BUTTON_DETAIL)}" aria-label="${escapeHtml(SIGN_IN_BUTTON_DETAIL)}">${escapeHtml(SIGN_IN_BUTTON_LABEL)}</button>
        </div>
      </div>
    </div>
  </body>
</html>
`;
}
function buildNotchPanelDataUrl(layout) {
	return `data:text/html;charset=utf-8,${encodeURIComponent(buildNotchPanelHtml(layout))}`;
}
/**
* Re-points the page at a new display without reloading it, so a monitor being
* plugged in does not flash the panel.
*/
function buildNotchLayoutScript(layout) {
	return `(()=>{const s=document.documentElement.style;${Object.entries(buildNotchCssVariables(layout)).map(([name, value]) => `s.setProperty(${JSON.stringify(name)},${JSON.stringify(value)});`).join("")}})();`;
}
function buildNotchStateScript(expanded) {
	return `document.documentElement.dataset.${NOTCH_STATE_ATTRIBUTE}=${JSON.stringify(expanded ? "expanded" : "collapsed")};`;
}
/**
* Writes a whole reading into the page in one evaluation.
*
* Every row is rewritten, even the ones that did not move, and the label is
* rewritten with the value: the alternative is tracking what the page currently
* shows in a second place, and a panel that disagrees with itself about which
* figure is stale — or worse, draws a deployment count under a label saying
* "Share clicks" — is far worse than one that repaints a handful of short
* strings. Rows the view does not fill are blanked for the same reason.
*
* The action travels with the figures rather than in a script of its own, so
* the page can never be showing a sign-in button beside a reading that came
* back signed in — the two are decided by one outcome and applied in one go.
*/
function buildNotchDataScript(view) {
	const action = JSON.stringify(view.action ?? NOTCH_ACTION_NONE);
	const calls = Array.from({ length: NOTCH_SLOT_COUNT }, (_unused, index) => {
		const slot = view.slots[index] ?? {
			label: "",
			value: EM_DASH,
			note: "",
			detail: ""
		};
		return `w(${index},${JSON.stringify(slot.label)},${JSON.stringify(slot.value)},${JSON.stringify(slot.note)},${JSON.stringify(slot.detail)});`;
	}).join("");
	return `(()=>{document.documentElement.dataset.${NOTCH_ACTION_ATTRIBUTE}=${action};const t=document.querySelector("[data-panel-title]");if(t)t.textContent=${JSON.stringify(view.title)};const w=(k,l,v,n,d)=>{const e=document.querySelector('[data-slot="'+k+'"]');if(!e)return;const c=e.children[1];e.children[0].textContent=l;c.children[0].textContent=v;c.children[1].textContent=n;c.title=d;c.setAttribute("aria-label",d);};${calls}})();`;
}

//#endregion
//#region src/notchData.ts
/**
* Where the notch panel's figures come from, and what it draws when it has none.
*
* The three reads it needs already exist, but only as Effect RPC over the
* server's `/ws` socket, and each demands a `tenantId`/`workspaceId` pair that
* lives in renderer state. The Electron main process has neither an RPC client
* nor those ids, so the panel reads `GET /api/desktop/activity` instead: one
* authenticated HTTP read that resolves its own scope from the session. See
* `apps/server/src/desktop/http.ts` for why that route exists rather than a
* second unauthenticated endpoint.
*
* The credential is the account's Supabase access token, which is what the app
* already presents on `/api/auth/ws-token` and `/api/auth/profile`. Main reads
* it out of the window it owns rather than minting anything of its own: the
* desktop bootstrap token is single-use and the renderer needs it, and a
* session issued from it authenticates a *machine*, not a person — it would
* resolve to an account with no memberships and report a confident zero.
*
* Everything here is written so that the ways a figure can be absent stay
* different answers. A dash carries the reason with it; nothing in this file can
* turn "we could not find out" into `0`.
*
* Which figures are read at all is decided by `notchContext.ts`: the account
* sums when the panel is showing them, one project's deployments and streams
* when the app is on a page about that project, and never both. The route takes
* an optional `?projectId=` for exactly that reason.
*/
/** Mirrors the key `apps/web/src/environments/primary/auth.ts` writes under. */
const SUPABASE_ACCESS_TOKEN_STORAGE_KEY = "t3code.supabase.accessToken";
const NOTCH_ACTIVITY_PATH = "/api/desktop/activity";
/**
* Short on purpose. This runs behind a hover, and a panel that waits on a wedged
* socket for ten seconds has already failed at being glanceable.
*/
const REQUEST_TIMEOUT_MS = 4e3;
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function readFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function readIsoOrNull(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}
function parseShareViews(value) {
	if (!isRecord(value)) return null;
	const total = readFiniteNumber(value.total);
	const linkCount = readFiniteNumber(value.linkCount);
	if (total === null || linkCount === null) return null;
	return {
		total,
		linkCount,
		lastViewedAt: readIsoOrNull(value.lastViewedAt)
	};
}
function parseTokenSpend(value) {
	if (!isRecord(value)) return null;
	const estimatedUsd = readFiniteNumber(value.estimatedUsd);
	const totalTokens = readFiniteNumber(value.totalTokens);
	if (estimatedUsd === null || totalTokens === null) return null;
	return {
		estimatedUsd,
		totalTokens,
		unpricedTokens: readFiniteNumber(value.unpricedTokens) ?? 0,
		since: readIsoOrNull(value.since),
		until: readIsoOrNull(value.until)
	};
}
function parseProjectActivity(value) {
	if (!isRecord(value)) return null;
	const deploymentCount = readFiniteNumber(value.deploymentCount);
	const streamCount = readFiniteNumber(value.streamCount);
	if (deploymentCount === null || streamCount === null) return null;
	return {
		deploymentCount,
		liveCount: readFiniteNumber(value.liveCount) ?? 0,
		reportingCount: readFiniteNumber(value.reportingCount) ?? 0,
		streamCount,
		events: readFiniteNumber(value.events),
		reportedEvents: readFiniteNumber(value.reportedEvents),
		lastDeployAt: readIsoOrNull(value.lastDeployAt),
		lastDeployStatus: readIsoOrNull(value.lastDeployStatus),
		partial: value.partial === true
	};
}
/**
* A body that does not parse is `failed`, never an empty reading — a server
* that answers with something unrecognisable has told us nothing about how many
* times anything was clicked.
*/
function parseNotchActivityBody(body) {
	if (!isRecord(body)) return { kind: "failed" };
	if (body.signedIn !== true) return { kind: "signed-out" };
	const workspaceCount = readFiniteNumber(body.workspaceCount);
	if (workspaceCount === null) return { kind: "failed" };
	return {
		kind: "ok",
		activity: {
			workspaceCount,
			partial: body.partial === true,
			shareViews: parseShareViews(body.shareViews),
			tokenSpend: parseTokenSpend(body.tokenSpend),
			project: parseProjectActivity(body.project)
		}
	};
}
/** Kept here so the desktop and the route cannot disagree about the spelling. */
function buildNotchActivityUrl(baseUrl, projectId) {
	return `${baseUrl}${NOTCH_ACTIVITY_PATH}${projectId === void 0 || projectId === null || projectId.length === 0 ? "" : `?projectId=${encodeURIComponent(projectId)}`}`;
}
async function readNotchActivity(input) {
	if (!input.baseUrl) return { kind: "offline" };
	if (!input.accessToken) return { kind: "signed-out" };
	const fetchImpl = input.fetchImpl ?? globalThis.fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, input.timeoutMs ?? REQUEST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(buildNotchActivityUrl(input.baseUrl, input.projectId), {
			headers: { authorization: `Bearer ${input.accessToken}` },
			signal: controller.signal
		});
		if (response.status === 401 || response.status === 403) return { kind: "signed-out" };
		if (response.status === 404) return { kind: "unknown-project" };
		if (!response.ok) return { kind: "failed" };
		return parseNotchActivityBody(await response.json());
	} catch {
		return { kind: "offline" };
	} finally {
		clearTimeout(timer);
	}
}
/**
* Reads the signed-in account's access token out of the app window.
*
* Main owns this `WebContents` already, and the token is deliberately not
* copied anywhere: it is read at the moment of use, so a refresh in the app is
* picked up on the next sample and a sign-out stops the panel immediately. If
* the storage key ever moves, this returns `null` and the panel says "sign in"
* — the failure mode is a dash, never a wrong number.
*/
async function readSignedInAccessToken(host) {
	if (!host || host.isDestroyed()) return null;
	try {
		const value = await host.executeJavaScript(`(()=>{try{return localStorage.getItem(${JSON.stringify(SUPABASE_ACCESS_TOKEN_STORAGE_KEY)});}catch{return null;}})()`);
		if (typeof value !== "string") return null;
		const token = value.trim();
		return token.length > 0 ? token : null;
	} catch {
		return null;
	}
}
function trimZero(value) {
	const fixed = value.toFixed(1);
	return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
function formatCompactCount(value) {
	if (!Number.isFinite(value) || value <= 0) return "0";
	const rounded = Math.round(value);
	if (rounded < 1e4) return rounded.toLocaleString();
	if (rounded < 1e6) return `${trimZero(rounded / 1e3)}K`;
	if (rounded < 1e9) return `${trimZero(rounded / 1e6)}M`;
	return `${trimZero(rounded / 1e9)}B`;
}
function formatEstimatedCost(amount) {
	if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
	if (amount < .01) return "<$0.01";
	return `$${amount.toLocaleString(void 0, {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	})}`;
}
const MILLISECONDS_PER_DAY = 864e5;
function describeWindow(since, until) {
	if (since === null || until === null) return "";
	const span = Date.parse(until) - Date.parse(since);
	if (!Number.isFinite(span) || span <= 0) return "";
	const days = Math.max(1, Math.round(span / MILLISECONDS_PER_DAY));
	return ` over the last ${days} day${days === 1 ? "" : "s"}`;
}
/**
* How long ago, short enough to sit in the value column.
*
* A timestamp is the wrong shape for a glance — "last deploy: 2h ago" answers
* the question, "2026-08-19 14:03" makes the reader do arithmetic. The exact
* moment is still in the tooltip. An unparseable date is a dash, not an epoch.
*/
function formatElapsed(iso, now = Date.now()) {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return EM_DASH;
	const minutes = Math.round((now - then) / 6e4);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(then).toLocaleDateString();
}
/** A slot with no figure, carrying the reason there is none. */
function absentSlot(note, detail) {
	return {
		value: EM_DASH,
		note,
		detail
	};
}
function presentSlot(value, note, detail) {
	return {
		value,
		note,
		detail
	};
}
/**
* Turns the number-less outcomes into wording. Written once so that "not signed
* in" and "the read failed" cannot drift into sounding alike in one slot and
* different in the next.
*/
function withActivity(outcome, subject, fromActivity) {
	switch (outcome.kind) {
		case "offline": return absentSlot("server off", `The local server is not answering, so ${subject} is unknown.`);
		case "signed-out": return absentSlot("sign in", `Sign in to T3 Code to see ${subject}.`);
		case "unknown-project": return absentSlot("unknown project", `The server does not have this project, or it belongs to another account, so ${subject} cannot be read.`);
		case "failed": return absentSlot("unavailable", `The server could not be asked about ${subject}.`);
		case "ok": return fromActivity(outcome.activity);
	}
}
/**
* An account-wide figure. Only hands a slot its figures once there is genuinely
* something to count: a tenant with no workspace has no share links to have been
* clicked, and that is not the same statement as "nobody clicked".
*/
function buildAccountSlot(outcome, subject, fromActivity) {
	return withActivity(outcome, subject, (activity) => activity.workspaceCount === 0 ? absentSlot("no workspace", `This account has no workspace yet, so there is no ${subject}.`) : fromActivity(activity));
}
/**
* A figure about the one project the route named. A missing section here means
* the server was asked and could not answer, which is why it does not fall
* through to a zero.
*/
function buildProjectSlot(outcome, subject, fromProject) {
	return withActivity(outcome, subject, (activity) => activity.project === null ? absentSlot("unavailable", `The server could not read this project's ${subject}.`) : fromProject(activity.project));
}
function partialSuffix(activity) {
	return activity.partial ? " Some workspaces could not be read, so this is a floor." : "";
}
function buildShareClicks(outcome) {
	return buildAccountSlot(outcome, "share activity", (activity) => {
		const views = activity.shareViews;
		if (views === null) return absentSlot("unavailable", "The server could not read this account's share links.");
		const links = `${views.linkCount} share link${views.linkCount === 1 ? "" : "s"}`;
		const lastViewed = views.lastViewedAt === null ? "" : ` Last opened ${new Date(views.lastViewedAt).toLocaleString()}.`;
		return presentSlot(formatCompactCount(views.total), "", `${views.total.toLocaleString()} opens across ${links}.${lastViewed}${partialSuffix(activity)}`);
	});
}
function buildTokenSpend(outcome) {
	return buildAccountSlot(outcome, "token spend", (activity) => {
		const spend = activity.tokenSpend;
		if (spend === null) return absentSlot("unavailable", "The server could not read this account's token usage.");
		const unpriced = spend.unpricedTokens > 0 ? ` ${formatCompactCount(spend.unpricedTokens)} tokens came from models with no published rate and are not in it.` : "";
		return presentSlot(formatEstimatedCost(spend.estimatedUsd), "est.", `Estimated from the server's own rate table${describeWindow(spend.since, spend.until)}, not a bill — plan pricing, discounts and rate changes are invisible to it. ${formatCompactCount(spend.totalTokens)} tokens.${unpriced}${partialSuffix(activity)}`);
	});
}
/**
* Nothing in T3 Code reports sync activity — no table, no counter, no RPC — so
* this stays a dash whatever the server says. A zero here would be a claim that
* nothing is syncing, which is a different and unsupported statement.
*/
function buildActiveSyncs() {
	return absentSlot("not wired", "Nothing in T3 Code reports sync activity yet, so this is blank rather than zero.");
}
function ofDeployments(count) {
	return `of ${count} deployment${count === 1 ? "" : "s"}`;
}
function eventFloorSuffix(project) {
	return project.partial ? " Some streams could not be counted, so this is a floor." : "";
}
/**
* How much of the project is live. `status` is what the registry was told by
* whatever registered the deployment — the panel is not probing anything, and
* the tooltip says so rather than letting a green-looking number imply a health
* check nobody ran.
*/
function buildLiveDeployments(outcome) {
	return buildProjectSlot(outcome, "deployments", (project) => {
		if (project.deploymentCount === 0) return presentSlot("0", "none registered", "This project has no registered deployments.");
		return presentSlot(project.liveCount.toLocaleString(), ofDeployments(project.deploymentCount), `${project.liveCount} of ${project.deploymentCount} registered deployments are recorded as live. That status is what the deployment reported when it was registered, not a probe run just now.`);
	});
}
/**
* Whether anything is reaching what is deployed.
*
* The two ways of having no number are kept apart exactly as
* `describeLoad` keeps them apart on the infrastructure page: a deployment wired
* to no stream *cannot* report load, and printing `0` against it would be a
* measurement nobody took.
*/
function buildDeploymentTraffic(outcome) {
	return buildProjectSlot(outcome, "traffic", (project) => {
		if (project.deploymentCount === 0) return absentSlot("nothing deployed", "This project has no registered deployments, so nothing can be reporting traffic.");
		if (project.reportingCount === 0) return absentSlot("not wired", "No registered deployment reports to an analytics stream, so none of them can report load. This is blank rather than zero because nobody measured it.");
		if (project.reportedEvents === null) return absentSlot("unavailable", "The server could not count the streams this project's deployments report to.");
		return presentSlot(formatCompactCount(project.reportedEvents), project.partial ? "floor" : "", `${project.reportedEvents.toLocaleString()} events across the streams ${project.reportingCount} ${ofDeployments(project.deploymentCount)} report to.${eventFloorSuffix(project)}`);
	});
}
function buildLastDeploy(outcome) {
	return buildProjectSlot(outcome, "deploy history", (project) => {
		if (project.lastDeployAt === null) return absentSlot("never", "No deploy run has been recorded for this project. A deployment registered by other means still shows above.");
		return presentSlot(formatElapsed(project.lastDeployAt), project.lastDeployStatus ?? "", `The most recent deploy run started ${new Date(project.lastDeployAt).toLocaleString()}${project.lastDeployStatus === null ? "" : ` and ${project.lastDeployStatus}`}.`);
	});
}
function buildAnalyticsStreams(outcome) {
	return buildProjectSlot(outcome, "streams", (project) => presentSlot(project.streamCount.toLocaleString(), project.streamCount === 0 ? "none declared" : "", project.streamCount === 0 ? "No analytics stream is declared for this project, so there is nothing for a deployment to report to." : `${project.streamCount} analytics stream${project.streamCount === 1 ? " is" : "s are"} declared for this project.`));
}
/**
* Events across every declared stream, summed the way the analytics page sums
* them: a grouped query answers with one bucket per group, so a stream's total
* is the sum of its buckets rather than its first row — see `totalEvents` in
* `apps/web/src/components/infra/deploymentLoad.logic.ts`. The addition happens
* on the server so the panel is handed a figure, not a table.
*/
function buildAnalyticsEvents(outcome) {
	return buildProjectSlot(outcome, "events", (project) => {
		if (project.streamCount === 0) return absentSlot("no streams", "Nothing is declared for this project to report to, so there is nothing to count.");
		if (project.events === null) return absentSlot("unavailable", "The server could not count this project's streams.");
		return presentSlot(formatCompactCount(project.events), project.partial ? "floor" : "", `${project.events.toLocaleString()} events across ${project.streamCount} declared stream${project.streamCount === 1 ? "" : "s"}.${eventFloorSuffix(project)}`);
	});
}
/** How much of what is deployed is visible to analytics at all. */
function buildAnalyticsReporters(outcome) {
	return buildProjectSlot(outcome, "reporting deployments", (project) => {
		if (project.deploymentCount === 0) return presentSlot("0", "none registered", "This project has no registered deployments, so nothing is reporting to its streams.");
		const blind = project.deploymentCount - project.reportingCount;
		return presentSlot(project.reportingCount.toLocaleString(), ofDeployments(project.deploymentCount), `${project.reportingCount} of ${project.deploymentCount} registered deployments name at least one stream.` + (blind > 0 ? ` The other ${blind} cannot report anything.` : ""));
	});
}
/**
* The one thing about an open thread the desktop shell can stand behind.
*
* Main knows which route the app window is on and nothing else about it: thread
* state lives in the renderer and there is no channel to it here. So this says
* what the route says and no more.
*/
function buildThreadRoute(context) {
	if (context.thread === "draft") return presentSlot("draft", "", "A draft is open in the composer. Nothing has been sent in it yet.");
	return presentSlot("open", "", "A thread is open in the app window.");
}
/**
* Deliberately, permanently blank.
*
* Whether a turn is running is renderer state, and the panel is drawn by the
* main process from the window's URL alone. Animating a spinner here would be
* drawing something nobody looked at, so it stays a dash with the reason
* attached — the same rule `buildActiveSyncs` follows.
*/
function buildTurnState() {
	return absentSlot("not visible", "The desktop shell can see which page the app is on, not what a turn is doing, so this stays blank rather than guessing.");
}
function buildFigure(figure, context, outcome) {
	switch (figure) {
		case "shareClicks": return buildShareClicks(outcome);
		case "tokenSpend": return buildTokenSpend(outcome);
		case "activeSyncs": return buildActiveSyncs();
		case "liveDeployments": return buildLiveDeployments(outcome);
		case "deploymentTraffic": return buildDeploymentTraffic(outcome);
		case "lastDeploy": return buildLastDeploy(outcome);
		case "analyticsStreams": return buildAnalyticsStreams(outcome);
		case "analyticsEvents": return buildAnalyticsEvents(outcome);
		case "analyticsReporters": return buildAnalyticsReporters(outcome);
		case "threadRoute": return buildThreadRoute(context);
		case "turnState": return buildTurnState();
	}
}
/**
* The one outcome whose remedy is known exactly.
*
* Every other absence sends the reader nowhere useful: a server that is not
* answering, a read that failed, a project this account cannot see and an
* account with no workspace are all things a click cannot mend, so they keep
* the dash and the sentence explaining it. Being signed out is different — the
* next step is a screen the app already has.
*/
function resolveNotchAction(outcome) {
	return outcome.kind === "signed-out" ? "sign-in" : null;
}
/**
* The context picks the rows and their labels; the outcome fills them in. The
* label always comes from the context rather than the builder, so a figure can
* never end up drawn under another figure's name.
*
* The rows are built even when the outcome carries an action and the page will
* draw the button instead of them: the reasons stay attached to the reading, so
* nothing here has to know which of the two the document chose to show.
*/
function toNotchPanelView(context, outcome) {
	const panel = NOTCH_CONTEXT_PANELS[context.kind];
	return {
		title: panel.title,
		slots: panel.slots.map(({ figure, label }) => {
			const view = buildFigure(figure, context, outcome);
			return {
				label,
				value: view.value,
				note: view.note,
				detail: view.detail
			};
		}),
		action: resolveNotchAction(outcome)
	};
}
/**
* The context's rows with nothing in them yet.
*
* Painted the moment the app navigates, so the panel never shows one page's
* numbers under another page's labels while the new read is in the air.
*
* No action either: an unfinished read is not evidence of being signed out, and
* offering a sign-in button to someone who is signed in would be a guess.
*/
function pendingNotchPanelView(context) {
	const panel = NOTCH_CONTEXT_PANELS[context.kind];
	return {
		title: panel.title,
		slots: panel.slots.map(({ label }) => ({
			label,
			value: EM_DASH,
			note: "",
			detail: "Not read yet."
		})),
		action: null
	};
}
/**
* When the panel is allowed to ask the server.
*
* The rule is that a collapsed panel costs nothing: no timer exists while it is
* shut, so a machine left running all day makes no requests beyond the one at
* startup. Expanding reads immediately and then keeps a cadence only for as
* long as the cursor stays. Lives here rather than in `notchWindow.ts` so it can
* be tested without an Electron window.
*
* Navigating is the one thing that can invalidate a reading rather than merely
* age it, so a refresh asked for while one is in flight is remembered and run
* once that one settles. Dropping it would leave the panel showing the page you
* just left until the next tick.
*/
function createNotchRefreshScheduler(options) {
	const schedule = options.schedule ?? ((handler, ms) => {
		const timer = setInterval(handler, ms);
		timer.unref();
		return timer;
	});
	const cancel = options.cancel ?? ((handle) => clearInterval(handle));
	let handle = null;
	let stopped = false;
	let inFlight = false;
	let queued = false;
	const refresh = () => {
		if (stopped) return;
		if (inFlight) {
			queued = true;
			return;
		}
		inFlight = true;
		options.readView().then(options.apply).catch(() => {}).finally(() => {
			inFlight = false;
			if (queued) {
				queued = false;
				refresh();
			}
		});
	};
	const stopTimer = () => {
		if (handle !== null) {
			cancel(handle);
			handle = null;
		}
	};
	return {
		readOnce: refresh,
		setExpanded: (expanded) => {
			if (stopped) return;
			if (!expanded) {
				stopTimer();
				return;
			}
			refresh();
			if (handle === null) handle = schedule(refresh, options.intervalMs);
		},
		stop: () => {
			stopped = true;
			stopTimer();
		}
	};
}
/**
* The single function the panel calls; everything above it is pure or mockable.
*
* The context decides both what is asked for and what is drawn: a project-scoped
* page asks about that project and nothing else, so the panel never pays for
* figures it is not showing.
*/
function createNotchViewReader(source) {
	return async (context) => {
		const accessToken = await readSignedInAccessToken(source.host());
		const feed = resolveNotchFeed(context);
		return toNotchPanelView(context, await readNotchActivity({
			baseUrl: source.baseUrl(),
			accessToken,
			...feed.kind === "project" ? { projectId: feed.projectId } : {},
			...source.fetchImpl ? { fetchImpl: source.fetchImpl } : {}
		}));
	};
}

//#endregion
//#region src/notchHover.ts
/** ~180ms at the sampling interval: long enough to reject a passing cursor. */
const NOTCH_HOVER_ENTER_SAMPLES = 2;
/** Matched to entry so the panel does not feel stickier than it was eager. */
const NOTCH_HOVER_EXIT_SAMPLES = 2;
const initialNotchHoverState = {
	expanded: false,
	dwellSamples: 0
};
function reduceNotchHoverState(state, cursorInside) {
	if (cursorInside === state.expanded) return state.dwellSamples === 0 ? state : {
		expanded: state.expanded,
		dwellSamples: 0
	};
	const dwellSamples = state.dwellSamples + 1;
	if (dwellSamples < (cursorInside ? NOTCH_HOVER_ENTER_SAMPLES : NOTCH_HOVER_EXIT_SAMPLES)) return {
		expanded: state.expanded,
		dwellSamples
	};
	return {
		expanded: cursorInside,
		dwellSamples: 0
	};
}

//#endregion
//#region src/notchWindow.ts
/**
* The macOS notch panel: a slim always-on-top surface hugging the top-centre of
* the primary display that expands into a small activity panel on hover.
*
* Three decisions here are non-obvious.
*
* 1. It is a `BaseWindow` + `WebContentsView`, not a `BrowserWindow`. `main.ts`
*    treats `BrowserWindow.getAllWindows()` as "the app's real windows" — it
*    decides whether to open the initial window from it, routes menu actions
*    through it, and repaints every entry with an opaque theme background when
*    the system theme changes. A `BrowserWindow` here would suppress the main
*    window on a packaged launch and have its transparency painted over.
*    `BrowserWindow.getAllWindows()` filters to `BrowserWindow` instances, so a
*    `BaseWindow` stays invisible to all of that.
*
* 2. The window is always sized for the *expanded* panel; hover only changes
*    what the page draws inside it. Growing the window itself would mean
*    tweening native bounds against a transparent, shadowless surface — which
*    on macOS leaves shadow artifacts and reflows the page on every frame.
*    A CSS morph inside a fixed window is both smoother and simpler, and the
*    extra area is transparent and click-through, so it costs nothing.
*
* 3. Hover is sampled in this process rather than reported by the page. The
*    window is click-through for all but one of its states, which makes DOM
*    hover dependent on forwarded mouse messages; polling the cursor is
*    deterministic instead, and it is the same sample that decides whether the
*    panel may take a click at all. The panel does now have a preload
*    (`notchPreload.ts`), but it carries one button press and nothing else —
*    hover has no reason to become the page's business.
*
* 4. The figures are fetched here and written into the page. Giving the page a
*    channel to ask over would mean handing a sandboxed surface a credential.
*    Main already holds the server's address, so the read stays on this side and
*    the page only ever receives a few short strings. What it reads and how it
*    authenticates is `notchData.ts`.
*
* 5. What it shows follows the app window's route, and that route is *sampled*
*    from `webContents.getURL()` in the same loop as the cursor rather than
*    subscribed to with `did-navigate`. The app window is not this module's to
*    own: it does not exist when the panel is created, it is closed and rebuilt
*    on `activate`, and attaching listeners to it would put panel lifecycle
*    code inside the main window's constructor. A synchronous string read ten
*    times a second costs nothing, survives the window being replaced, and
*    needs no renderer channel — the same argument that made hover a poll.
*
* 6. Mouse events are refused except over the expanded panel in the one state
*    that offers something to press. The window is a single rectangle reaching
*    up to the top of the display, so "clickable" is all-or-nothing for the
*    whole frame — including the strip the menu bar owns. Scoping it by cursor
*    position, against a rect that starts at the top of the *work* area, is what
*    lets the panel hold a button without the collapsed pill ever being in a
*    position to swallow a click meant for the menu bar. See
*    `resolveNotchClickTarget`.
*/
/**
* Fast enough that expansion reads as a response to the hover rather than a
* delayed reaction, and slow enough that a synchronous cursor read eight to ten
* times a second is not worth measuring.
*/
const HOVER_SAMPLE_INTERVAL_MS = 90;
/**
* How often the figures are re-read *while the panel is open*.
*
* The panel is collapsed for almost all of the day it is running, and nobody is
* reading a number they cannot see, so there is no background poll at all: one
* read when the panel first appears, one the moment it expands, and this
* cadence only for as long as it stays expanded. A hover lasts seconds, so in
* practice most expansions cost exactly one request.
*/
const DATA_REFRESH_INTERVAL_MS = 15e3;
function toLayoutInput(display) {
	return resolveNotchLayout({
		bounds: display.bounds,
		workArea: display.workArea
	});
}
/**
* Creates the notch panel and wires it to the app's lifetime.
*
* Returns `null` off macOS: the panel is defined by the notch and by the macOS
* menu bar it floats over, and neither Windows nor Linux has a surface it could
* mean anything on — so this is a deliberate absence, not an unimplemented
* branch.
*/
function createNotchPanel(options) {
	if (process.platform !== "darwin") return null;
	let layout = toLayoutInput(electron.screen.getPrimaryDisplay());
	const window = new electron.BaseWindow({
		...layout.window,
		show: false,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: false,
		type: "panel",
		focusable: false,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		closable: false,
		fullscreenable: false,
		skipTaskbar: true,
		roundedCorners: false,
		title: "Live activity"
	});
	window.setAlwaysOnTop(true, "screen-saver");
	window.setVisibleOnAllWorkspaces(true, {
		visibleOnFullScreen: true,
		skipTransformProcessType: true
	});
	window.setHiddenInMissionControl(true);
	window.setContentProtection(true);
	/**
	* Click-through is the resting state and the only state the pill is ever in:
	* it overlaps the menu bar and must never swallow a click meant for it.
	* `forward` keeps mouse moves flowing to the page while it holds, so the
	* button's hover styling works even before the panel accepts a press.
	*/
	const setClickThrough = (clickThrough) => {
		if (window.isDestroyed()) return;
		if (clickThrough) {
			window.setIgnoreMouseEvents(true, { forward: true });
			return;
		}
		window.setIgnoreMouseEvents(false);
	};
	setClickThrough(true);
	const view = new electron.WebContentsView({ webPreferences: {
		preload: node_path.join(__dirname, "notchPreload.cjs"),
		contextIsolation: true,
		nodeIntegration: false,
		sandbox: true,
		transparent: true,
		backgroundThrottling: false
	} });
	view.setBackgroundColor("#00000000");
	window.contentView.addChildView(view);
	const syncViewBounds = () => {
		const { width, height } = window.getContentBounds();
		view.setBounds({
			x: 0,
			y: 0,
			width,
			height
		});
	};
	syncViewBounds();
	window.on("resize", syncViewBounds);
	let destroyed = false;
	const evaluateInPanel = (script) => {
		if (destroyed || view.webContents.isDestroyed()) return;
		view.webContents.executeJavaScript(script, true).catch(() => {});
	};
	let hover = initialNotchHoverState;
	let action = null;
	let clickThrough = true;
	/**
	* The page and this process learn a reading in the same moment. Drawing the
	* button without recording that there is one — or the reverse — is a button
	* nobody can press, so the two are never written apart.
	*/
	const applyView = (next) => {
		action = next.action;
		evaluateInPanel(buildNotchDataScript(next));
	};
	const applyLayout = () => {
		if (destroyed || window.isDestroyed()) return;
		const next = toLayoutInput(electron.screen.getPrimaryDisplay());
		if (areRectsEqual(next.window, layout.window) && next.hasNotch === layout.hasNotch) {
			layout = next;
			return;
		}
		layout = next;
		window.setBounds(layout.window);
		syncViewBounds();
		evaluateInPanel(buildNotchLayoutScript(layout));
		window.invalidateShadow();
	};
	electron.screen.on("display-metrics-changed", applyLayout);
	electron.screen.on("display-added", applyLayout);
	electron.screen.on("display-removed", applyLayout);
	let context = defaultNotchContext;
	const readView = options.readView;
	const refresher = readView === void 0 ? null : createNotchRefreshScheduler({
		readView: async () => {
			const asked = context;
			const view = await readView(asked);
			return areNotchContextsEqual(asked, context) ? view : null;
		},
		apply: (view) => {
			if (view !== null) applyView(view);
		},
		intervalMs: options.refreshIntervalMs ?? DATA_REFRESH_INTERVAL_MS
	});
	const readUrl = options.readUrl;
	const sampleContext = () => {
		if (readUrl === void 0) return;
		let url = null;
		try {
			url = readUrl();
		} catch {
			url = null;
		}
		const next = resolveNotchContext(url);
		if (areNotchContextsEqual(next, context)) return;
		context = next;
		applyView(pendingNotchPanelView(next));
		if (hover.expanded) refresher?.readOnce();
	};
	const sampleHover = (cursor) => {
		const target = resolveNotchHoverTarget(layout, hover.expanded);
		const next = reduceNotchHoverState(hover, containsPoint(target, cursor));
		if (next.expanded !== hover.expanded) {
			evaluateInPanel(buildNotchStateScript(next.expanded));
			refresher?.setExpanded(next.expanded);
		}
		hover = next;
	};
	/**
	* The window stops being click-through only while the cursor is inside a rect
	* the panel can act on, and `resolveNotchClickTarget` never returns one that
	* reaches the menu bar. Collapsing puts it back by the same rule, without
	* needing a separate path: no expansion, no target.
	*
	* It follows the cursor rather than the hover state alone because the hover
	* region deliberately spans the pill, the gap and the panel — and the pill is
	* over the menu bar. A press is only ever possible where a press makes sense.
	*/
	const sampleClickThrough = (cursor) => {
		const target = resolveNotchClickTarget(layout, hover.expanded, action !== null);
		const next = target === null || !containsPoint(target, cursor);
		if (next === clickThrough) return;
		clickThrough = next;
		setClickThrough(next);
	};
	const sample = () => {
		if (destroyed || window.isDestroyed()) return;
		sampleContext();
		const cursor = electron.screen.getCursorScreenPoint();
		sampleHover(cursor);
		sampleClickThrough(cursor);
	};
	const handleSignIn = (event) => {
		if (destroyed || view.webContents.isDestroyed() || event.sender !== view.webContents) return;
		options.onSignIn();
	};
	electron.ipcMain.on(NOTCH_SIGN_IN_CHANNEL, handleSignIn);
	const hoverTimer = setInterval(sample, HOVER_SAMPLE_INTERVAL_MS);
	hoverTimer.unref();
	view.webContents.once("did-finish-load", () => {
		if (destroyed || window.isDestroyed()) return;
		window.showInactive();
		sampleContext();
		refresher?.readOnce();
	});
	view.webContents.loadURL(buildNotchPanelDataUrl(layout));
	const destroy = () => {
		if (destroyed) return;
		destroyed = true;
		clearInterval(hoverTimer);
		refresher?.stop();
		electron.ipcMain.removeListener(NOTCH_SIGN_IN_CHANNEL, handleSignIn);
		electron.screen.removeListener("display-metrics-changed", applyLayout);
		electron.screen.removeListener("display-added", applyLayout);
		electron.screen.removeListener("display-removed", applyLayout);
		if (!window.isDestroyed()) window.destroy();
	};
	electron.app.once("before-quit", destroy);
	return { destroy };
}

//#endregion
//#region src/main.ts
syncShellEnvironment();
const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const WRITE_CLIPBOARD_TEXT_CHANNEL = "desktop:write-clipboard-text";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_SET_CHANNEL_CHANNEL = "desktop:update-set-channel";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const GET_APP_BRANDING_CHANNEL = "desktop:get-app-branding";
const GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL = "desktop:get-local-environment-bootstrap";
const GET_CLIENT_SETTINGS_CHANNEL = "desktop:get-client-settings";
const SET_CLIENT_SETTINGS_CHANNEL = "desktop:set-client-settings";
const GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL = "desktop:get-saved-environment-registry";
const SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL = "desktop:set-saved-environment-registry";
const GET_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:get-saved-environment-secret";
const SET_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:set-saved-environment-secret";
const REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL = "desktop:remove-saved-environment-secret";
const GET_SERVER_EXPOSURE_STATE_CHANNEL = "desktop:get-server-exposure-state";
const SET_SERVER_EXPOSURE_MODE_CHANNEL = "desktop:set-server-exposure-mode";
const WORKSPACE_SHARE_STATE_CHANNEL = "desktop:workspace-share-state";
const WORKSPACE_SHARE_GET_STATE_CHANNEL = "desktop:workspace-share-get-state";
const WORKSPACE_SHARE_START_CHANNEL = "desktop:workspace-share-start";
const WORKSPACE_SHARE_STOP_CHANNEL = "desktop:workspace-share-stop";
const BASE_DIR = process.env.T3CODE_HOME?.trim() || node_path.join(node_os.homedir(), ".t3");
const STATE_DIR = node_path.join(BASE_DIR, "userdata");
const DESKTOP_SETTINGS_PATH = node_path.join(STATE_DIR, "desktop-settings.json");
const CLIENT_SETTINGS_PATH = node_path.join(STATE_DIR, "client-settings.json");
const SAVED_ENVIRONMENT_REGISTRY_PATH = node_path.join(STATE_DIR, "saved-environments.json");
const DESKTOP_SCHEME = "t3";
const ROOT_DIR = node_path.resolve(__dirname, "../../..");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const desktopAppBranding = resolveDesktopAppBranding({
	isDevelopment,
	appVersion: electron.app.getVersion()
});
const APP_DISPLAY_NAME = desktopAppBranding.displayName;
const APP_USER_MODEL_ID = isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code";
const LINUX_DESKTOP_ENTRY_NAME = isDevelopment ? "t3code-dev.desktop" : "t3code.desktop";
const LINUX_WM_CLASS = isDevelopment ? "t3code-dev" : "t3code";
const USER_DATA_DIR_NAME = isDevelopment ? "t3code-dev" : "t3code";
const LEGACY_USER_DATA_DIR_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = node_path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = node_crypto.randomBytes(6).toString("hex");
const SERVER_SETTINGS_PATH = node_path.join(STATE_DIR, "settings.json");
const AUTO_UPDATE_STARTUP_DELAY_MS = 15e3;
const AUTO_UPDATE_POLL_INTERVAL_MS = 14400 * 1e3;
function resolvePickFolderDefaultPath(rawOptions) {
	if (typeof rawOptions !== "object" || rawOptions === null) return;
	const { initialPath } = rawOptions;
	if (typeof initialPath !== "string") return;
	const trimmedPath = initialPath.trim();
	if (trimmedPath.length === 0) return;
	if (trimmedPath === "~") return node_os.homedir();
	if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) return node_path.join(node_os.homedir(), trimmedPath.slice(2));
	return node_path.resolve(trimmedPath);
}
const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_REQUIRED_PORT_PROBE_HOSTS = ["0.0.0.0", "::"];
const TITLEBAR_HEIGHT = 40;
const TITLEBAR_COLOR = "#01000000";
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
function normalizeContextMenuItems(source) {
	const normalizedItems = [];
	for (const sourceItem of source) {
		if (typeof sourceItem.id !== "string" || typeof sourceItem.label !== "string") continue;
		const normalizedItem = {
			id: sourceItem.id,
			label: sourceItem.label,
			destructive: sourceItem.destructive === true,
			disabled: sourceItem.disabled === true
		};
		if (sourceItem.children) {
			const normalizedChildren = normalizeContextMenuItems(sourceItem.children);
			if (normalizedChildren.length === 0) continue;
			normalizedItem.children = normalizedChildren;
		}
		normalizedItems.push(normalizedItem);
	}
	return normalizedItems;
}
let mainWindow = null;
let backendProcess = null;
let backendPort = 0;
let backendBindHost = DESKTOP_LOOPBACK_HOST;
let backendBootstrapToken = "";
let backendHttpUrl = "";
let backendWsUrl = "";
let backendEndpointUrl = null;
let backendAdvertisedHost = null;
let backendReadinessAbortController = null;
let backendInitialWindowOpenInFlight = null;
let backendListeningDetector = null;
let restartAttempt = 0;
let restartTimer = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache;
let desktopLogSink = null;
let backendLogSink = null;
let restoreStdIoCapture = null;
let backendObservabilitySettings = readPersistedBackendObservabilitySettings();
let desktopSettings = readDesktopSettings(DESKTOP_SETTINGS_PATH, electron.app.getVersion());
let desktopServerExposureMode = desktopSettings.serverExposureMode;
/**
* SECURITY: a quick tunnel forwards the public internet straight at the loopback
* port, so anything the server grants because "the request came from 127.0.0.1"
* is granted to every stranger holding the URL. The renderer must warn before
* starting, and the process must never outlive the app — see the quit hooks below.
*/
const workspaceShareController = new QuickTunnelController({ onStateChange: (state) => {
	for (const window of electron.BrowserWindow.getAllWindows()) {
		if (window.isDestroyed()) continue;
		window.webContents.send(WORKSPACE_SHARE_STATE_CHANNEL, state);
	}
} });
electron.app.on("before-quit", () => {
	workspaceShareController.stop();
});
electron.app.on("window-all-closed", () => {
	workspaceShareController.stop();
});
process.on("exit", () => {
	workspaceShareController.disposeSync();
});
let destructiveMenuIconCache;
const expectedBackendExitChildren = /* @__PURE__ */ new WeakSet();
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
	platform: process.platform,
	processArch: process.arch,
	runningUnderArm64Translation: electron.app.runningUnderARM64Translation === true
});
const initialUpdateState = () => createInitialDesktopUpdateState(electron.app.getVersion(), desktopRuntimeInfo, desktopSettings.updateChannel);
function logTimestamp() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function logScope(scope) {
	return `${scope} run=${APP_RUN_ID}`;
}
function sanitizeLogValue(value) {
	return value.replace(/\s+/g, " ").trim();
}
function readPersistedBackendObservabilitySettings() {
	try {
		if (!node_fs.existsSync(SERVER_SETTINGS_PATH)) return {
			otlpTracesUrl: void 0,
			otlpMetricsUrl: void 0
		};
		return parsePersistedServerObservabilitySettings(node_fs.readFileSync(SERVER_SETTINGS_PATH, "utf8"));
	} catch (error) {
		console.warn("[desktop] failed to read persisted backend observability settings", error);
		return {
			otlpTracesUrl: void 0,
			otlpMetricsUrl: void 0
		};
	}
}
function resolveConfiguredDesktopBackendPort(rawPort) {
	if (!rawPort) return;
	const parsedPort = Number.parseInt(rawPort, 10);
	if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return;
	return parsedPort;
}
function resolveDesktopDevServerUrl() {
	const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
	if (!devServerUrl) throw new Error("VITE_DEV_SERVER_URL is required in desktop development.");
	return devServerUrl;
}
function backendChildEnv() {
	const env = { ...process.env };
	delete env.T3CODE_PORT;
	delete env.T3CODE_MODE;
	delete env.T3CODE_NO_BROWSER;
	delete env.T3CODE_HOST;
	delete env.T3CODE_DESKTOP_WS_URL;
	delete env.T3CODE_DESKTOP_LAN_ACCESS;
	delete env.T3CODE_DESKTOP_LAN_HOST;
	return env;
}
function getDesktopServerExposureState() {
	return {
		mode: desktopServerExposureMode,
		endpointUrl: backendEndpointUrl,
		advertisedHost: backendAdvertisedHost
	};
}
function getDesktopSecretStorage() {
	return {
		isEncryptionAvailable: () => electron.safeStorage.isEncryptionAvailable(),
		encryptString: (value) => electron.safeStorage.encryptString(value),
		decryptString: (value) => electron.safeStorage.decryptString(value)
	};
}
function resolveAdvertisedHostOverride() {
	const override = process.env.T3CODE_DESKTOP_LAN_HOST?.trim();
	return override && override.length > 0 ? override : void 0;
}
async function applyDesktopServerExposureMode(mode, options) {
	const advertisedHostOverride = resolveAdvertisedHostOverride();
	const requestedMode = mode;
	let exposure = resolveDesktopServerExposure({
		mode,
		port: backendPort,
		networkInterfaces: node_os.networkInterfaces(),
		...advertisedHostOverride ? { advertisedHostOverride } : {}
	});
	if (requestedMode === "network-accessible" && exposure.endpointUrl === null) {
		if (options?.rejectIfUnavailable) throw new Error("No reachable network address is available for this desktop right now.");
		exposure = resolveDesktopServerExposure({
			mode: "local-only",
			port: backendPort,
			networkInterfaces: node_os.networkInterfaces(),
			...advertisedHostOverride ? { advertisedHostOverride } : {}
		});
	}
	desktopServerExposureMode = exposure.mode;
	desktopSettings = setDesktopServerExposurePreference(desktopSettings, requestedMode);
	backendBindHost = exposure.bindHost;
	backendHttpUrl = exposure.localHttpUrl;
	backendWsUrl = exposure.localWsUrl;
	backendEndpointUrl = exposure.endpointUrl;
	backendAdvertisedHost = exposure.advertisedHost;
	if (options?.persist) writeDesktopSettings(DESKTOP_SETTINGS_PATH, desktopSettings);
	return getDesktopServerExposureState();
}
function relaunchDesktopApp(reason) {
	writeDesktopLogHeader(`desktop relaunch requested reason=${reason}`);
	setImmediate(() => {
		isQuitting = true;
		clearUpdatePollTimer();
		cancelBackendReadinessWait();
		stopBackendAndWaitForExit().catch((error) => {
			writeDesktopLogHeader(`desktop relaunch backend shutdown warning message=${formatErrorMessage(error)}`);
		}).finally(() => {
			restoreStdIoCapture?.();
			if (isDevelopment) {
				electron.app.exit(75);
				return;
			}
			electron.app.relaunch({
				execPath: process.execPath,
				args: process.argv.slice(1)
			});
			electron.app.exit(0);
		});
	});
}
function writeDesktopLogHeader(message) {
	if (!desktopLogSink) return;
	desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}
function writeBackendSessionBoundary(phase, details) {
	if (!backendLogSink) return;
	const normalizedDetails = sanitizeLogValue(details);
	backendLogSink.write(`[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`);
}
function formatErrorMessage(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
function getSafeExternalUrl(rawUrl) {
	if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
	let parsedUrl;
	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		return null;
	}
	if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return null;
	return parsedUrl.toString();
}
function getSafeTheme(rawTheme) {
	if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") return rawTheme;
	return null;
}
async function waitForBackendHttpReady(baseUrl, options) {
	cancelBackendReadinessWait();
	const controller = new AbortController();
	backendReadinessAbortController = controller;
	try {
		await waitForHttpReady(baseUrl, {
			...options,
			signal: controller.signal
		});
	} finally {
		if (backendReadinessAbortController === controller) backendReadinessAbortController = null;
	}
}
function cancelBackendReadinessWait() {
	backendReadinessAbortController?.abort();
	backendReadinessAbortController = null;
}
async function waitForBackendWindowReady(baseUrl) {
	const httpReadyPromise = waitForBackendHttpReady(baseUrl, { timeoutMs: 6e4 });
	const listeningPromise = backendListeningDetector?.promise;
	if (!listeningPromise) {
		await httpReadyPromise;
		return "http";
	}
	return await new Promise((resolve, reject) => {
		let settled = false;
		const settleResolve = (source) => {
			if (settled) return;
			settled = true;
			if (source === "listening") cancelBackendReadinessWait();
			resolve(source);
		};
		const settleReject = (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		listeningPromise.then(() => settleResolve("listening"), (error) => settleReject(error));
		httpReadyPromise.then(() => settleResolve("http"), (error) => {
			if (settled && isBackendReadinessAborted(error)) return;
			settleReject(error);
		});
	});
}
function ensureInitialBackendWindowOpen() {
	const existingWindow = mainWindow ?? electron.BrowserWindow.getAllWindows()[0] ?? null;
	if (isDevelopment || existingWindow !== null || backendInitialWindowOpenInFlight !== null) return;
	const nextOpen = waitForBackendWindowReady(backendHttpUrl).then((source) => {
		writeDesktopLogHeader(`bootstrap backend ready source=${source}`);
		if (mainWindow ?? electron.BrowserWindow.getAllWindows()[0]) return;
		mainWindow = createWindow();
		writeDesktopLogHeader("bootstrap main window created");
	}).catch((error) => {
		if (isBackendReadinessAborted(error)) return;
		writeDesktopLogHeader(`bootstrap backend readiness warning message=${formatErrorMessage(error)}`);
		console.warn("[desktop] backend readiness check timed out during packaged bootstrap", error);
	}).finally(() => {
		if (backendInitialWindowOpenInFlight === nextOpen) backendInitialWindowOpenInFlight = null;
	});
	backendInitialWindowOpenInFlight = nextOpen;
}
function writeDesktopStreamChunk(streamName, chunk, encoding) {
	if (!desktopLogSink) return;
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : void 0);
	desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
	desktopLogSink.write(buffer);
	if (buffer.length === 0 || buffer[buffer.length - 1] !== 10) desktopLogSink.write("\n");
}
function installStdIoCapture() {
	if (!electron.app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) return;
	const originalStdoutWrite = process.stdout.write.bind(process.stdout);
	const originalStderrWrite = process.stderr.write.bind(process.stderr);
	const patchWrite = (streamName, originalWrite) => (chunk, encodingOrCallback, callback) => {
		const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : void 0;
		writeDesktopStreamChunk(streamName, chunk, encoding);
		if (typeof encodingOrCallback === "function") return originalWrite(chunk, encodingOrCallback);
		if (callback !== void 0) return originalWrite(chunk, encoding, callback);
		if (encoding !== void 0) return originalWrite(chunk, encoding);
		return originalWrite(chunk);
	};
	process.stdout.write = patchWrite("stdout", originalStdoutWrite);
	process.stderr.write = patchWrite("stderr", originalStderrWrite);
	restoreStdIoCapture = () => {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
		restoreStdIoCapture = null;
	};
}
function initializePackagedLogging() {
	if (!electron.app.isPackaged) return;
	try {
		desktopLogSink = new RotatingFileSink({
			filePath: node_path.join(LOG_DIR, "desktop-main.log"),
			maxBytes: LOG_FILE_MAX_BYTES,
			maxFiles: LOG_FILE_MAX_FILES
		});
		backendLogSink = new RotatingFileSink({
			filePath: node_path.join(LOG_DIR, "server-child.log"),
			maxBytes: LOG_FILE_MAX_BYTES,
			maxFiles: LOG_FILE_MAX_FILES
		});
		installStdIoCapture();
		writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
	} catch (error) {
		console.error("[desktop] failed to initialize packaged logging", error);
	}
}
function captureBackendOutput(child) {
	const attachStream = (stream) => {
		stream?.on("data", (chunk) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
			backendLogSink?.write(buffer);
			backendListeningDetector?.push(buffer);
		});
	};
	attachStream(child.stdout);
	attachStream(child.stderr);
}
initializePackagedLogging();
if (process.platform === "linux") electron.app.commandLine.appendSwitch("class", LINUX_WM_CLASS);
function getDestructiveMenuIcon() {
	if (process.platform !== "darwin") return void 0;
	if (destructiveMenuIconCache !== void 0) return destructiveMenuIconCache ?? void 0;
	try {
		const icon = electron.nativeImage.createFromNamedImage("trash").resize({
			width: 14,
			height: 14
		});
		if (icon.isEmpty()) {
			destructiveMenuIconCache = null;
			return;
		}
		icon.setTemplateImage(true);
		destructiveMenuIconCache = icon;
		return icon;
	} catch {
		destructiveMenuIconCache = null;
		return;
	}
}
let updatePollTimer = null;
let updateStartupTimer = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let updateInstallInFlight = false;
let updaterConfigured = false;
let updateState = initialUpdateState();
function resolveUpdaterErrorContext() {
	if (updateInstallInFlight) return "install";
	if (updateDownloadInFlight) return "download";
	if (updateCheckInFlight) return "check";
	return updateState.errorContext;
}
electron.protocol.registerSchemesAsPrivileged([{
	scheme: DESKTOP_SCHEME,
	privileges: {
		standard: true,
		secure: true,
		supportFetchAPI: true,
		corsEnabled: true
	}
}]);
function resolveAppRoot() {
	if (!electron.app.isPackaged) return ROOT_DIR;
	return electron.app.getAppPath();
}
/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYml() {
	try {
		const ymlPath = electron.app.isPackaged ? node_path.join(process.resourcesPath, "app-update.yml") : node_path.join(electron.app.getAppPath(), "dev-app-update.yml");
		const raw = node_fs.readFileSync(ymlPath, "utf-8");
		const entries = {};
		for (const line of raw.split("\n")) {
			const match = line.match(/^(\w+):\s*(.+)$/);
			if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
		}
		return entries.provider ? entries : null;
	} catch {
		return null;
	}
}
function normalizeCommitHash(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!COMMIT_HASH_PATTERN.test(trimmed)) return null;
	return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}
function resolveEmbeddedCommitHash() {
	const packageJsonPath = node_path.join(resolveAppRoot(), "package.json");
	if (!node_fs.existsSync(packageJsonPath)) return null;
	try {
		const raw = node_fs.readFileSync(packageJsonPath, "utf8");
		return normalizeCommitHash(JSON.parse(raw).t3codeCommitHash);
	} catch {
		return null;
	}
}
function resolveAboutCommitHash() {
	if (aboutCommitHashCache !== void 0) return aboutCommitHashCache;
	const envCommitHash = normalizeCommitHash(process.env.T3CODE_COMMIT_HASH);
	if (envCommitHash) {
		aboutCommitHashCache = envCommitHash;
		return aboutCommitHashCache;
	}
	if (!electron.app.isPackaged) {
		aboutCommitHashCache = null;
		return aboutCommitHashCache;
	}
	aboutCommitHashCache = resolveEmbeddedCommitHash();
	return aboutCommitHashCache;
}
function resolveBackendEntry() {
	return node_path.join(resolveAppRoot(), "apps/server/dist/bin.mjs");
}
function resolveBackendCwd() {
	if (!electron.app.isPackaged) return resolveAppRoot();
	return node_os.homedir();
}
function resolveDesktopStaticDir() {
	const appRoot = resolveAppRoot();
	const candidates = [node_path.join(appRoot, "apps/server/dist/client"), node_path.join(appRoot, "apps/web/dist")];
	for (const candidate of candidates) if (node_fs.existsSync(node_path.join(candidate, "index.html"))) return candidate;
	return null;
}
function resolveDesktopStaticPath(staticRoot, requestUrl) {
	const url = new URL(requestUrl);
	const rawPath = decodeURIComponent(url.pathname);
	const normalizedPath = node_path.posix.normalize(rawPath).replace(/^\/+/, "");
	if (normalizedPath.includes("..")) return node_path.join(staticRoot, "index.html");
	const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
	const resolvedPath = node_path.join(staticRoot, requestedPath);
	if (node_path.extname(resolvedPath)) return resolvedPath;
	const nestedIndex = node_path.join(resolvedPath, "index.html");
	if (node_fs.existsSync(nestedIndex)) return nestedIndex;
	return node_path.join(staticRoot, "index.html");
}
function isStaticAssetRequest(requestUrl) {
	try {
		const url = new URL(requestUrl);
		return node_path.extname(url.pathname).length > 0;
	} catch {
		return false;
	}
}
function handleFatalStartupError(stage, error) {
	const message = formatErrorMessage(error);
	const detail = error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
	writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
	console.error(`[desktop] fatal startup error (${stage})`, error);
	if (!isQuitting) {
		isQuitting = true;
		electron.dialog.showErrorBox("LogicPacks failed to start", `Stage: ${stage}\n${message}${detail}`);
	}
	stopBackend();
	restoreStdIoCapture?.();
	electron.app.quit();
}
function registerDesktopProtocol() {
	if (isDevelopment || desktopProtocolRegistered) return;
	const staticRoot = resolveDesktopStaticDir();
	if (!staticRoot) throw new Error("Desktop static bundle missing. Build apps/server (with bundled client) first.");
	const staticRootResolved = node_path.resolve(staticRoot);
	const staticRootPrefix = `${staticRootResolved}${node_path.sep}`;
	const fallbackIndex = node_path.join(staticRootResolved, "index.html");
	electron.protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
		try {
			const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
			const resolvedCandidate = node_path.resolve(candidate);
			const isInRoot = resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
			const isAssetRequest = isStaticAssetRequest(request.url);
			if (!isInRoot || !node_fs.existsSync(resolvedCandidate)) {
				if (isAssetRequest) {
					callback({ error: -6 });
					return;
				}
				callback({ path: fallbackIndex });
				return;
			}
			callback({ path: resolvedCandidate });
		} catch {
			callback({ path: fallbackIndex });
		}
	});
	desktopProtocolRegistered = true;
}
function dispatchMenuAction(action) {
	const existingWindow = electron.BrowserWindow.getFocusedWindow() ?? mainWindow ?? electron.BrowserWindow.getAllWindows()[0];
	const targetWindow = existingWindow ?? createWindow();
	if (!existingWindow) mainWindow = targetWindow;
	const send = () => {
		if (targetWindow.isDestroyed()) return;
		targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
		revealWindow(targetWindow);
	};
	if (targetWindow.webContents.isLoadingMainFrame()) {
		targetWindow.webContents.once("did-finish-load", send);
		return;
	}
	send();
}
function handleCheckForUpdatesMenuClick() {
	const hasUpdateFeedConfig = readAppUpdateYml() !== null || Boolean(process.env.T3CODE_DESKTOP_MOCK_UPDATES);
	const disabledReason = getAutoUpdateDisabledReason({
		isDevelopment,
		isPackaged: electron.app.isPackaged,
		platform: process.platform,
		appImage: process.env.APPIMAGE,
		disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
		hasUpdateFeedConfig
	});
	if (disabledReason) {
		console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
		electron.dialog.showMessageBox({
			type: "info",
			title: "Updates unavailable",
			message: "Automatic updates are not available right now.",
			detail: disabledReason,
			buttons: ["OK"]
		});
		return;
	}
	if (!electron.BrowserWindow.getAllWindows().length) mainWindow = createWindow();
	checkForUpdatesFromMenu();
}
async function checkForUpdatesFromMenu() {
	await checkForUpdates("menu");
	if (updateState.status === "up-to-date") electron.dialog.showMessageBox({
		type: "info",
		title: "You're up to date!",
		message: `LogicPacks ${updateState.currentVersion} is currently the newest version available.`,
		buttons: ["OK"]
	});
	else if (updateState.status === "error") electron.dialog.showMessageBox({
		type: "warning",
		title: "Update check failed",
		message: "Could not check for updates.",
		detail: updateState.message ?? "An unknown error occurred. Please try again later.",
		buttons: ["OK"]
	});
}
function configureApplicationMenu() {
	const template = [];
	if (process.platform === "darwin") template.push({
		label: electron.app.name,
		submenu: [
			{ role: "about" },
			{
				label: "Check for Updates...",
				click: () => handleCheckForUpdatesMenuClick()
			},
			{ type: "separator" },
			{
				label: "Settings...",
				accelerator: "CmdOrCtrl+,",
				click: () => dispatchMenuAction("open-settings")
			},
			{ type: "separator" },
			{ role: "services" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "unhide" },
			{ type: "separator" },
			{ role: "quit" }
		]
	});
	template.push({
		label: "File",
		submenu: [...process.platform === "darwin" ? [] : [{
			label: "Settings...",
			accelerator: "CmdOrCtrl+,",
			click: () => dispatchMenuAction("open-settings")
		}, { type: "separator" }], { role: process.platform === "darwin" ? "close" : "quit" }]
	}, { role: "editMenu" }, {
		label: "View",
		submenu: [
			{ role: "reload" },
			{ role: "forceReload" },
			{ role: "toggleDevTools" },
			{ type: "separator" },
			{ role: "resetZoom" },
			{
				role: "zoomIn",
				accelerator: "CmdOrCtrl+="
			},
			{
				role: "zoomIn",
				accelerator: "CmdOrCtrl+Plus",
				visible: false
			},
			{ role: "zoomOut" },
			{ type: "separator" },
			{ role: "togglefullscreen" }
		]
	}, { role: "windowMenu" }, {
		role: "help",
		submenu: [{
			label: "Check for Updates...",
			click: () => handleCheckForUpdatesMenuClick()
		}]
	});
	electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
function resolveResourcePath(fileName) {
	const candidates = [
		node_path.join(__dirname, "../resources", fileName),
		node_path.join(__dirname, "../prod-resources", fileName),
		node_path.join(process.resourcesPath, "resources", fileName),
		node_path.join(process.resourcesPath, fileName)
	];
	for (const candidate of candidates) if (node_fs.existsSync(candidate)) return candidate;
	return null;
}
function resolveIconPath(ext) {
	if (isDevelopment && process.platform === "darwin" && ext === "png") {
		const developmentDockIconPath = node_path.join(ROOT_DIR, "assets", "dev", "blueprint-macos-1024.png");
		if (node_fs.existsSync(developmentDockIconPath)) return developmentDockIconPath;
	}
	return resolveResourcePath(`icon.${ext}`);
}
/**
* Resolve the Electron userData directory path.
*
* Electron derives the default userData path from `productName` in
* package.json, which currently produces directories with spaces and
* parentheses (e.g. `~/.config/T3 Code (Alpha)` on Linux). This is
* unfriendly for shell usage and violates Linux naming conventions.
*
* We override it to a clean lowercase name (`t3code`). If the legacy
* directory already exists we keep using it so existing users don't
* lose their Chromium profile data (localStorage, cookies, sessions).
*/
function resolveUserDataPath() {
	const appDataBase = process.platform === "win32" ? process.env.APPDATA || node_path.join(node_os.homedir(), "AppData", "Roaming") : process.platform === "darwin" ? node_path.join(node_os.homedir(), "Library", "Application Support") : process.env.XDG_CONFIG_HOME || node_path.join(node_os.homedir(), ".config");
	const legacyPath = node_path.join(appDataBase, LEGACY_USER_DATA_DIR_NAME);
	if (node_fs.existsSync(legacyPath)) return legacyPath;
	return node_path.join(appDataBase, USER_DATA_DIR_NAME);
}
function configureAppIdentity() {
	electron.app.setName(APP_DISPLAY_NAME);
	const commitHash = resolveAboutCommitHash();
	electron.app.setAboutPanelOptions({
		applicationName: APP_DISPLAY_NAME,
		applicationVersion: electron.app.getVersion(),
		version: commitHash ?? "unknown"
	});
	if (process.platform === "win32") electron.app.setAppUserModelId(APP_USER_MODEL_ID);
	if (process.platform === "linux") electron.app.setDesktopName?.(LINUX_DESKTOP_ENTRY_NAME);
	if (process.platform === "darwin" && electron.app.dock) {
		const iconPath = resolveIconPath("png");
		if (iconPath) electron.app.dock.setIcon(iconPath);
	}
}
function clearUpdatePollTimer() {
	if (updateStartupTimer) {
		clearTimeout(updateStartupTimer);
		updateStartupTimer = null;
	}
	if (updatePollTimer) {
		clearInterval(updatePollTimer);
		updatePollTimer = null;
	}
}
function revealWindow(window) {
	if (window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	if (!window.isVisible()) window.show();
	if (process.platform === "darwin") electron.app.focus({ steal: true });
	window.focus();
}
function emitUpdateState() {
	for (const window of electron.BrowserWindow.getAllWindows()) {
		if (window.isDestroyed()) continue;
		window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
	}
}
function setUpdateState(patch) {
	updateState = {
		...updateState,
		...patch
	};
	emitUpdateState();
}
function createBaseUpdateState(channel, enabled) {
	return {
		...createInitialDesktopUpdateState(electron.app.getVersion(), desktopRuntimeInfo, channel),
		enabled,
		status: enabled ? "idle" : "disabled"
	};
}
function applyAutoUpdaterChannel(channel) {
	electron_updater.autoUpdater.channel = channel;
	electron_updater.autoUpdater.allowPrerelease = channel === "nightly";
	electron_updater.autoUpdater.allowDowngrade = channel === "nightly";
	console.info(`[desktop-updater] Using update channel '${channel}' (allowPrerelease=${channel === "nightly"}, allowDowngrade=${channel === "nightly"}).`);
}
function shouldEnableAutoUpdates() {
	const hasUpdateFeedConfig = readAppUpdateYml() !== null || Boolean(process.env.T3CODE_DESKTOP_MOCK_UPDATES);
	return getAutoUpdateDisabledReason({
		isDevelopment,
		isPackaged: electron.app.isPackaged,
		platform: process.platform,
		appImage: process.env.APPIMAGE,
		disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
		hasUpdateFeedConfig
	}) === null;
}
async function checkForUpdates(reason) {
	if (isQuitting || !updaterConfigured || updateCheckInFlight) return false;
	if (updateState.status === "downloading" || updateState.status === "downloaded") {
		console.info(`[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`);
		return false;
	}
	updateCheckInFlight = true;
	setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, (/* @__PURE__ */ new Date()).toISOString()));
	console.info(`[desktop-updater] Checking for updates (${reason})...`);
	try {
		await electron_updater.autoUpdater.checkForUpdates();
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		setUpdateState(reduceDesktopUpdateStateOnCheckFailure(updateState, message, (/* @__PURE__ */ new Date()).toISOString()));
		console.error(`[desktop-updater] Failed to check for updates: ${message}`);
		return true;
	} finally {
		updateCheckInFlight = false;
	}
}
async function downloadAvailableUpdate() {
	if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") return {
		accepted: false,
		completed: false
	};
	updateDownloadInFlight = true;
	setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
	electron_updater.autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
	console.info("[desktop-updater] Downloading update...");
	try {
		await electron_updater.autoUpdater.downloadUpdate();
		return {
			accepted: true,
			completed: true
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
		console.error(`[desktop-updater] Failed to download update: ${message}`);
		return {
			accepted: true,
			completed: false
		};
	} finally {
		updateDownloadInFlight = false;
	}
}
async function installDownloadedUpdate() {
	if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") return {
		accepted: false,
		completed: false
	};
	isQuitting = true;
	updateInstallInFlight = true;
	clearUpdatePollTimer();
	try {
		await stopBackendAndWaitForExit();
		for (const win of electron.BrowserWindow.getAllWindows()) win.destroy();
		electron_updater.autoUpdater.quitAndInstall(true, true);
		return {
			accepted: true,
			completed: false
		};
	} catch (error) {
		const message = formatErrorMessage(error);
		updateInstallInFlight = false;
		isQuitting = false;
		setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
		console.error(`[desktop-updater] Failed to install update: ${message}`);
		return {
			accepted: true,
			completed: false
		};
	}
}
function configureAutoUpdater() {
	const githubToken = process.env.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
	if (githubToken) {
		const appUpdateYml = readAppUpdateYml();
		if (appUpdateYml?.provider === "github") electron_updater.autoUpdater.setFeedURL({
			...appUpdateYml,
			provider: "github",
			private: true,
			token: githubToken
		});
	}
	if (process.env.T3CODE_DESKTOP_MOCK_UPDATES) electron_updater.autoUpdater.setFeedURL({
		provider: "generic",
		url: `http://localhost:${process.env.T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT ?? 3e3}`
	});
	const enabled = shouldEnableAutoUpdates();
	setUpdateState(createBaseUpdateState(desktopSettings.updateChannel, enabled));
	if (!enabled) return;
	updaterConfigured = true;
	electron_updater.autoUpdater.autoDownload = false;
	electron_updater.autoUpdater.autoInstallOnAppQuit = false;
	applyAutoUpdaterChannel(desktopSettings.updateChannel);
	electron_updater.autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
	let lastLoggedDownloadMilestone = -1;
	if (isArm64HostRunningIntelBuild(desktopRuntimeInfo)) console.info("[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.");
	electron_updater.autoUpdater.on("checking-for-update", () => {
		console.info("[desktop-updater] Looking for updates...");
	});
	electron_updater.autoUpdater.on("update-available", (info) => {
		if (!doesVersionMatchDesktopUpdateChannel(info.version, updateState.channel)) {
			console.info(`[desktop-updater] Ignoring ${info.version} because it does not match the selected '${updateState.channel}' channel.`);
			setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, (/* @__PURE__ */ new Date()).toISOString()));
			lastLoggedDownloadMilestone = -1;
			return;
		}
		setUpdateState(reduceDesktopUpdateStateOnUpdateAvailable(updateState, info.version, (/* @__PURE__ */ new Date()).toISOString()));
		lastLoggedDownloadMilestone = -1;
		console.info(`[desktop-updater] Update available: ${info.version}`);
	});
	electron_updater.autoUpdater.on("update-not-available", () => {
		setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, (/* @__PURE__ */ new Date()).toISOString()));
		lastLoggedDownloadMilestone = -1;
		console.info("[desktop-updater] No updates available.");
	});
	electron_updater.autoUpdater.on("error", (error) => {
		const message = formatErrorMessage(error);
		if (updateInstallInFlight) {
			updateInstallInFlight = false;
			isQuitting = false;
			setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
			console.error(`[desktop-updater] Updater error: ${message}`);
			return;
		}
		if (!updateCheckInFlight && !updateDownloadInFlight) setUpdateState({
			status: "error",
			message,
			checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
			downloadPercent: null,
			errorContext: resolveUpdaterErrorContext(),
			canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null
		});
		console.error(`[desktop-updater] Updater error: ${message}`);
	});
	electron_updater.autoUpdater.on("download-progress", (progress) => {
		const percent = Math.floor(progress.percent);
		if (shouldBroadcastDownloadProgress(updateState, progress.percent) || updateState.message !== null) setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
		const milestone = percent - percent % 10;
		if (milestone > lastLoggedDownloadMilestone) {
			lastLoggedDownloadMilestone = milestone;
			console.info(`[desktop-updater] Download progress: ${percent}%`);
		}
	});
	electron_updater.autoUpdater.on("update-downloaded", (info) => {
		setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
		console.info(`[desktop-updater] Update downloaded: ${info.version}`);
	});
	clearUpdatePollTimer();
	updateStartupTimer = setTimeout(() => {
		updateStartupTimer = null;
		checkForUpdates("startup");
	}, AUTO_UPDATE_STARTUP_DELAY_MS);
	updateStartupTimer.unref();
	updatePollTimer = setInterval(() => {
		checkForUpdates("poll");
	}, AUTO_UPDATE_POLL_INTERVAL_MS);
	updatePollTimer.unref();
}
function scheduleBackendRestart(reason) {
	if (isQuitting || restartTimer) return;
	const delayMs = Math.min(500 * 2 ** restartAttempt, 1e4);
	restartAttempt += 1;
	console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);
	restartTimer = setTimeout(() => {
		restartTimer = null;
		startBackend();
	}, delayMs);
}
function startBackend() {
	if (isQuitting || backendProcess) return;
	backendObservabilitySettings = readPersistedBackendObservabilitySettings();
	const backendEntry = resolveBackendEntry();
	if (!node_fs.existsSync(backendEntry)) {
		scheduleBackendRestart(`missing server entry at ${backendEntry}`);
		return;
	}
	const captureBackendLogs = !isDevelopment;
	const child = node_child_process.spawn(process.execPath, [
		backendEntry,
		"--bootstrap-fd",
		"3"
	], {
		cwd: resolveBackendCwd(),
		env: {
			...backendChildEnv(),
			ELECTRON_RUN_AS_NODE: "1"
		},
		stdio: captureBackendLogs ? [
			"ignore",
			"pipe",
			"pipe",
			"pipe"
		] : [
			"ignore",
			"inherit",
			"inherit",
			"pipe"
		]
	});
	const bootstrapStream = child.stdio[3];
	if (bootstrapStream && "write" in bootstrapStream) {
		bootstrapStream.write(`${JSON.stringify({
			mode: "desktop",
			noBrowser: true,
			port: backendPort,
			t3Home: BASE_DIR,
			host: backendBindHost,
			desktopBootstrapToken: backendBootstrapToken,
			...backendObservabilitySettings.otlpTracesUrl ? { otlpTracesUrl: backendObservabilitySettings.otlpTracesUrl } : {},
			...backendObservabilitySettings.otlpMetricsUrl ? { otlpMetricsUrl: backendObservabilitySettings.otlpMetricsUrl } : {}
		})}\n`);
		bootstrapStream.end();
	} else {
		child.kill("SIGTERM");
		scheduleBackendRestart("missing desktop bootstrap pipe");
		return;
	}
	const listeningDetector = new ServerListeningDetector();
	backendListeningDetector = listeningDetector;
	backendProcess = child;
	let backendSessionClosed = false;
	const closeBackendSession = (details) => {
		if (backendSessionClosed) return;
		backendSessionClosed = true;
		writeBackendSessionBoundary("END", details);
	};
	writeBackendSessionBoundary("START", `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`);
	captureBackendOutput(child);
	child.once("spawn", () => {
		restartAttempt = 0;
	});
	child.on("error", (error) => {
		if (backendListeningDetector === listeningDetector) {
			listeningDetector.fail(error);
			backendListeningDetector = null;
		}
		const wasExpected = expectedBackendExitChildren.has(child);
		if (backendProcess === child) backendProcess = null;
		closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
		if (wasExpected) return;
		scheduleBackendRestart(error.message);
	});
	child.on("exit", (code, signal) => {
		if (backendListeningDetector === listeningDetector) {
			listeningDetector.fail(/* @__PURE__ */ new Error(`backend exited before logging readiness (code=${code ?? "null"} signal=${signal ?? "null"})`));
			backendListeningDetector = null;
		}
		const wasExpected = expectedBackendExitChildren.has(child);
		if (backendProcess === child) backendProcess = null;
		closeBackendSession(`pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`);
		if (isQuitting || wasExpected) return;
		scheduleBackendRestart(`code=${code ?? "null"} signal=${signal ?? "null"}`);
	});
	ensureInitialBackendWindowOpen();
}
function stopBackend() {
	cancelBackendReadinessWait();
	backendListeningDetector = null;
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	const child = backendProcess;
	backendProcess = null;
	if (!child) return;
	if (child.exitCode === null && child.signalCode === null) {
		expectedBackendExitChildren.add(child);
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, 2e3).unref();
	}
}
async function stopBackendAndWaitForExit(timeoutMs = 5e3) {
	cancelBackendReadinessWait();
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	const child = backendProcess;
	backendProcess = null;
	if (!child) return;
	const backendChild = child;
	if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;
	expectedBackendExitChildren.add(backendChild);
	await new Promise((resolve) => {
		let settled = false;
		let forceKillTimer = null;
		let exitTimeoutTimer = null;
		function settle() {
			if (settled) return;
			settled = true;
			backendChild.off("exit", onExit);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (exitTimeoutTimer) clearTimeout(exitTimeoutTimer);
			resolve();
		}
		function onExit() {
			settle();
		}
		backendChild.once("exit", onExit);
		backendChild.kill("SIGTERM");
		forceKillTimer = setTimeout(() => {
			if (backendChild.exitCode === null && backendChild.signalCode === null) backendChild.kill("SIGKILL");
		}, 2e3);
		forceKillTimer.unref();
		exitTimeoutTimer = setTimeout(() => {
			settle();
		}, timeoutMs);
		exitTimeoutTimer.unref();
	});
}
function registerIpcHandlers() {
	electron.ipcMain.removeAllListeners(GET_APP_BRANDING_CHANNEL);
	electron.ipcMain.on(GET_APP_BRANDING_CHANNEL, (event) => {
		event.returnValue = desktopAppBranding;
	});
	electron.ipcMain.removeAllListeners(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL);
	electron.ipcMain.on(GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL, (event) => {
		event.returnValue = {
			label: "Local environment",
			httpBaseUrl: backendHttpUrl || null,
			wsBaseUrl: backendWsUrl || null,
			bootstrapToken: backendBootstrapToken || void 0
		};
	});
	electron.ipcMain.removeHandler(GET_CLIENT_SETTINGS_CHANNEL);
	electron.ipcMain.handle(GET_CLIENT_SETTINGS_CHANNEL, async () => readClientSettings(CLIENT_SETTINGS_PATH));
	electron.ipcMain.removeHandler(SET_CLIENT_SETTINGS_CHANNEL);
	electron.ipcMain.handle(SET_CLIENT_SETTINGS_CHANNEL, async (_event, rawSettings) => {
		if (typeof rawSettings !== "object" || rawSettings === null) throw new Error("Invalid client settings payload.");
		writeClientSettings(CLIENT_SETTINGS_PATH, rawSettings);
	});
	electron.ipcMain.removeHandler(GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL);
	electron.ipcMain.handle(GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL, async () => readSavedEnvironmentRegistry(SAVED_ENVIRONMENT_REGISTRY_PATH));
	electron.ipcMain.removeHandler(SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL);
	electron.ipcMain.handle(SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL, async (_event, rawRecords) => {
		if (!Array.isArray(rawRecords)) throw new Error("Invalid saved environment registry payload.");
		writeSavedEnvironmentRegistry(SAVED_ENVIRONMENT_REGISTRY_PATH, rawRecords);
	});
	electron.ipcMain.removeHandler(GET_SAVED_ENVIRONMENT_SECRET_CHANNEL);
	electron.ipcMain.handle(GET_SAVED_ENVIRONMENT_SECRET_CHANNEL, async (_event, rawEnvironmentId) => {
		if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) return null;
		return readSavedEnvironmentSecret({
			registryPath: SAVED_ENVIRONMENT_REGISTRY_PATH,
			environmentId: rawEnvironmentId,
			secretStorage: getDesktopSecretStorage()
		});
	});
	electron.ipcMain.removeHandler(SET_SAVED_ENVIRONMENT_SECRET_CHANNEL);
	electron.ipcMain.handle(SET_SAVED_ENVIRONMENT_SECRET_CHANNEL, async (_event, rawEnvironmentId, rawSecret) => {
		if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) throw new Error("Invalid saved environment id.");
		if (typeof rawSecret !== "string" || rawSecret.trim().length === 0) throw new Error("Invalid saved environment secret.");
		return writeSavedEnvironmentSecret({
			registryPath: SAVED_ENVIRONMENT_REGISTRY_PATH,
			environmentId: rawEnvironmentId,
			secret: rawSecret,
			secretStorage: getDesktopSecretStorage()
		});
	});
	electron.ipcMain.removeHandler(REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL);
	electron.ipcMain.handle(REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL, async (_event, rawEnvironmentId) => {
		if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) return;
		removeSavedEnvironmentSecret({
			registryPath: SAVED_ENVIRONMENT_REGISTRY_PATH,
			environmentId: rawEnvironmentId
		});
	});
	electron.ipcMain.removeHandler(GET_SERVER_EXPOSURE_STATE_CHANNEL);
	electron.ipcMain.handle(GET_SERVER_EXPOSURE_STATE_CHANNEL, async () => getDesktopServerExposureState());
	electron.ipcMain.removeHandler(SET_SERVER_EXPOSURE_MODE_CHANNEL);
	electron.ipcMain.handle(SET_SERVER_EXPOSURE_MODE_CHANNEL, async (_event, rawMode) => {
		if (rawMode !== "local-only" && rawMode !== "network-accessible") throw new Error("Invalid desktop server exposure input.");
		const nextMode = rawMode;
		if (nextMode === desktopServerExposureMode) return getDesktopServerExposureState();
		const nextState = await applyDesktopServerExposureMode(nextMode, {
			persist: true,
			rejectIfUnavailable: true
		});
		relaunchDesktopApp(`serverExposureMode=${nextMode}`);
		return nextState;
	});
	electron.ipcMain.removeHandler(WORKSPACE_SHARE_GET_STATE_CHANNEL);
	electron.ipcMain.handle(WORKSPACE_SHARE_GET_STATE_CHANNEL, async () => workspaceShareController.getState());
	electron.ipcMain.removeHandler(WORKSPACE_SHARE_START_CHANNEL);
	electron.ipcMain.handle(WORKSPACE_SHARE_START_CHANNEL, async () => workspaceShareController.start(backendPort));
	electron.ipcMain.removeHandler(WORKSPACE_SHARE_STOP_CHANNEL);
	electron.ipcMain.handle(WORKSPACE_SHARE_STOP_CHANNEL, async () => workspaceShareController.stop());
	const CLOUD_SYNC_SCAN_CHANNEL = "desktop:cloud-sync-scan";
	electron.ipcMain.removeHandler(CLOUD_SYNC_SCAN_CHANNEL);
	electron.ipcMain.handle(CLOUD_SYNC_SCAN_CHANNEL, async (_event, rawRoot) => {
		if (typeof rawRoot !== "string" || rawRoot.trim() === "") throw new Error("Invalid cloud sync scan payload.");
		return summariseScan(await scanProject({ root: rawRoot }));
	});
	const CLOUD_SYNC_LIVE_SHARE_BEGIN_CHANNEL = "desktop:cloud-sync-live-share-begin";
	const CLOUD_SYNC_LIVE_SHARE_SYNCED_CHANNEL = "desktop:cloud-sync-live-share-synced";
	const CLOUD_SYNC_LIVE_SHARE_STOP_CHANNEL = "desktop:cloud-sync-live-share-stop";
	let liveShareCoordinator = null;
	electron.ipcMain.removeHandler(CLOUD_SYNC_LIVE_SHARE_BEGIN_CHANNEL);
	electron.ipcMain.handle(CLOUD_SYNC_LIVE_SHARE_BEGIN_CHANNEL, async (_event, rawInput) => {
		const input = rawInput;
		const tenantId = input?.scope?.tenantId;
		const workspaceId = input?.scope?.workspaceId;
		const projectId = input?.scope?.projectId;
		if (!isUsableLiveShareEndpoint(input?.cloudBaseUrl) || typeof tenantId !== "string" || typeof workspaceId !== "string" || typeof projectId !== "string") throw new Error("Invalid cloud sync live share payload.");
		await liveShareCoordinator?.stop();
		liveShareCoordinator = new LiveShareCoordinator({
			tunnel: workspaceShareController,
			registrar: createHttpLiveShareRegistrar({
				cloudBaseUrl: input.cloudBaseUrl,
				localBaseUrl: `http://127.0.0.1:${backendPort}`,
				scope: {
					tenantId,
					workspaceId,
					projectId
				},
				authorization: typeof input.authorization === "string" ? input.authorization : null
			})
		});
		return liveShareCoordinator.begin(backendPort);
	});
	electron.ipcMain.removeHandler(CLOUD_SYNC_LIVE_SHARE_SYNCED_CHANNEL);
	electron.ipcMain.handle(CLOUD_SYNC_LIVE_SHARE_SYNCED_CHANNEL, async () => liveShareCoordinator === null ? null : liveShareCoordinator.firstPassComplete());
	electron.ipcMain.removeHandler(CLOUD_SYNC_LIVE_SHARE_STOP_CHANNEL);
	electron.ipcMain.handle(CLOUD_SYNC_LIVE_SHARE_STOP_CHANNEL, async () => {
		const stopped = await liveShareCoordinator?.stop() ?? null;
		liveShareCoordinator = null;
		return stopped;
	});
	electron.ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
	electron.ipcMain.handle(PICK_FOLDER_CHANNEL, async (_event, rawOptions) => {
		const owner = electron.BrowserWindow.getFocusedWindow() ?? mainWindow;
		const defaultPath = resolvePickFolderDefaultPath(rawOptions);
		const openDialogOptions = {
			properties: ["openDirectory", "createDirectory"],
			...defaultPath ? { defaultPath } : {}
		};
		const result = owner ? await electron.dialog.showOpenDialog(owner, openDialogOptions) : await electron.dialog.showOpenDialog(openDialogOptions);
		if (result.canceled) return null;
		return result.filePaths[0] ?? null;
	});
	electron.ipcMain.removeHandler(CONFIRM_CHANNEL);
	electron.ipcMain.handle(CONFIRM_CHANNEL, async (_event, message) => {
		if (typeof message !== "string") return false;
		return showDesktopConfirmDialog(message, electron.BrowserWindow.getFocusedWindow() ?? mainWindow);
	});
	electron.ipcMain.removeHandler(SET_THEME_CHANNEL);
	electron.ipcMain.handle(SET_THEME_CHANNEL, async (_event, rawTheme) => {
		const theme = getSafeTheme(rawTheme);
		if (!theme) return;
		electron.nativeTheme.themeSource = theme;
	});
	electron.ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
	electron.ipcMain.handle(CONTEXT_MENU_CHANNEL, async (_event, items, position) => {
		const normalizedItems = normalizeContextMenuItems(items);
		if (normalizedItems.length === 0) return null;
		const popupPosition = position && Number.isFinite(position.x) && Number.isFinite(position.y) && position.x >= 0 && position.y >= 0 ? {
			x: Math.floor(position.x),
			y: Math.floor(position.y)
		} : null;
		const window = electron.BrowserWindow.getFocusedWindow() ?? mainWindow;
		if (!window) return null;
		return new Promise((resolve) => {
			const buildTemplate = (entries) => {
				const template = [];
				let hasInsertedDestructiveSeparator = false;
				for (const item of entries) {
					if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
						template.push({ type: "separator" });
						hasInsertedDestructiveSeparator = true;
					}
					const itemOption = {
						label: item.label,
						enabled: !item.disabled
					};
					if (item.children && item.children.length > 0) itemOption.submenu = buildTemplate(item.children);
					else itemOption.click = () => resolve(item.id);
					if (item.destructive && (!item.children || item.children.length === 0)) {
						const destructiveIcon = getDestructiveMenuIcon();
						if (destructiveIcon) itemOption.icon = destructiveIcon;
					}
					template.push(itemOption);
				}
				return template;
			};
			electron.Menu.buildFromTemplate(buildTemplate(normalizedItems)).popup({
				window,
				...popupPosition,
				callback: () => resolve(null)
			});
		});
	});
	electron.ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
	electron.ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl) => {
		const externalUrl = getSafeExternalUrl(rawUrl);
		if (!externalUrl) return false;
		try {
			await electron.shell.openExternal(externalUrl);
			return true;
		} catch {
			return false;
		}
	});
	electron.ipcMain.removeHandler(WRITE_CLIPBOARD_TEXT_CHANNEL);
	electron.ipcMain.handle(WRITE_CLIPBOARD_TEXT_CHANNEL, async (_event, rawText) => {
		if (typeof rawText !== "string" || rawText.length === 0) return false;
		electron.clipboard.writeText(rawText);
		return true;
	});
	electron.ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
	electron.ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);
	electron.ipcMain.removeHandler(UPDATE_SET_CHANNEL_CHANNEL);
	electron.ipcMain.handle(UPDATE_SET_CHANNEL_CHANNEL, async (_event, rawChannel) => {
		if (rawChannel !== "latest" && rawChannel !== "nightly") throw new Error("Invalid desktop update channel input.");
		if (updateCheckInFlight || updateDownloadInFlight || updateInstallInFlight) throw new Error("Cannot change update tracks while an update action is in progress.");
		const nextChannel = rawChannel;
		desktopSettings = setDesktopUpdateChannelPreference(desktopSettings, nextChannel);
		writeDesktopSettings(DESKTOP_SETTINGS_PATH, desktopSettings);
		if (nextChannel === updateState.channel) return updateState;
		const enabled = shouldEnableAutoUpdates();
		setUpdateState(createBaseUpdateState(nextChannel, enabled));
		if (!enabled || !updaterConfigured) return updateState;
		applyAutoUpdaterChannel(nextChannel);
		const allowDowngrade = electron_updater.autoUpdater.allowDowngrade;
		electron_updater.autoUpdater.allowDowngrade = true;
		try {
			await checkForUpdates("channel-change");
		} finally {
			electron_updater.autoUpdater.allowDowngrade = allowDowngrade;
		}
		return updateState;
	});
	electron.ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
	electron.ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
		const result = await downloadAvailableUpdate();
		return {
			accepted: result.accepted,
			completed: result.completed,
			state: updateState
		};
	});
	electron.ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
	electron.ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
		if (isQuitting) return {
			accepted: false,
			completed: false,
			state: updateState
		};
		const result = await installDownloadedUpdate();
		return {
			accepted: result.accepted,
			completed: result.completed,
			state: updateState
		};
	});
	electron.ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
	electron.ipcMain.handle(UPDATE_CHECK_CHANNEL, async () => {
		if (!updaterConfigured) return {
			checked: false,
			state: updateState
		};
		return {
			checked: await checkForUpdates("web-ui"),
			state: updateState
		};
	});
}
function getIconOption() {
	if (process.platform === "darwin") return {};
	const iconPath = resolveIconPath(process.platform === "win32" ? "ico" : "png");
	return iconPath ? { icon: iconPath } : {};
}
function getInitialWindowBackgroundColor() {
	return electron.nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}
function getWindowTitleBarOptions() {
	if (process.platform === "darwin") return {
		titleBarStyle: "hiddenInset",
		trafficLightPosition: {
			x: 16,
			y: 18
		}
	};
	return {
		titleBarStyle: "hidden",
		titleBarOverlay: {
			color: TITLEBAR_COLOR,
			height: TITLEBAR_HEIGHT,
			symbolColor: electron.nativeTheme.shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR
		}
	};
}
function syncWindowAppearance(window) {
	if (window.isDestroyed()) return;
	window.setBackgroundColor(getInitialWindowBackgroundColor());
	const { titleBarOverlay } = getWindowTitleBarOptions();
	if (typeof titleBarOverlay === "object") window.setTitleBarOverlay(titleBarOverlay);
}
function syncAllWindowAppearance() {
	for (const window of electron.BrowserWindow.getAllWindows()) syncWindowAppearance(window);
}
electron.nativeTheme.on("updated", syncAllWindowAppearance);
function createWindow() {
	const window = new electron.BrowserWindow({
		width: 1100,
		height: 780,
		minWidth: 840,
		minHeight: 620,
		show: false,
		autoHideMenuBar: true,
		backgroundColor: getInitialWindowBackgroundColor(),
		...getIconOption(),
		title: APP_DISPLAY_NAME,
		...getWindowTitleBarOptions(),
		webPreferences: {
			preload: node_path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	window.webContents.on("context-menu", (event, params) => {
		event.preventDefault();
		const menuTemplate = [];
		if (params.misspelledWord) {
			for (const suggestion of params.dictionarySuggestions.slice(0, 5)) menuTemplate.push({
				label: suggestion,
				click: () => window.webContents.replaceMisspelling(suggestion)
			});
			if (params.dictionarySuggestions.length === 0) menuTemplate.push({
				label: "No suggestions",
				enabled: false
			});
			menuTemplate.push({ type: "separator" });
		}
		if (getSafeExternalUrl(params.linkURL)) menuTemplate.push({
			label: "Copy Link",
			click: () => electron.clipboard.writeText(params.linkURL)
		}, { type: "separator" });
		if (params.mediaType === "image") {
			menuTemplate.push({
				label: "Copy Image",
				click: () => window.webContents.copyImageAt(params.x, params.y)
			});
			menuTemplate.push({ type: "separator" });
		}
		menuTemplate.push({
			role: "cut",
			enabled: params.editFlags.canCut
		}, {
			role: "copy",
			enabled: params.editFlags.canCopy
		}, {
			role: "paste",
			enabled: params.editFlags.canPaste
		}, {
			role: "selectAll",
			enabled: params.editFlags.canSelectAll
		});
		electron.Menu.buildFromTemplate(menuTemplate).popup({ window });
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		const externalUrl = getSafeExternalUrl(url);
		if (externalUrl) electron.shell.openExternal(externalUrl);
		return { action: "deny" };
	});
	window.on("page-title-updated", (event) => {
		event.preventDefault();
		window.setTitle(APP_DISPLAY_NAME);
	});
	window.webContents.on("did-finish-load", () => {
		window.setTitle(APP_DISPLAY_NAME);
		emitUpdateState();
	});
	let initialRevealScheduled = false;
	const revealInitialWindow = () => {
		if (initialRevealScheduled) return;
		initialRevealScheduled = true;
		revealWindow(window);
	};
	window.once("ready-to-show", revealInitialWindow);
	if (isDevelopment) {
		window.loadURL(resolveDesktopDevServerUrl());
		window.webContents.openDevTools({ mode: "detach" });
	} else window.loadURL(backendHttpUrl);
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});
	return window;
}
electron.app.setPath("userData", resolveUserDataPath());
configureAppIdentity();
async function bootstrap() {
	writeDesktopLogHeader("bootstrap start");
	const configuredBackendPort = resolveConfiguredDesktopBackendPort(process.env.T3CODE_PORT);
	if (isDevelopment && configuredBackendPort === void 0) throw new Error("T3CODE_PORT is required in desktop development.");
	backendPort = configuredBackendPort ?? await resolveDesktopBackendPort({
		host: DESKTOP_LOOPBACK_HOST,
		startPort: DEFAULT_DESKTOP_BACKEND_PORT,
		requiredHosts: DESKTOP_REQUIRED_PORT_PROBE_HOSTS
	});
	writeDesktopLogHeader(configuredBackendPort === void 0 ? `selected backend port via sequential scan startPort=${DEFAULT_DESKTOP_BACKEND_PORT} port=${backendPort}` : `using configured backend port port=${backendPort}`);
	backendBootstrapToken = node_crypto.randomBytes(24).toString("hex");
	if (desktopSettings.serverExposureMode !== DEFAULT_DESKTOP_SETTINGS.serverExposureMode) writeDesktopLogHeader(`bootstrap restoring persisted server exposure mode mode=${desktopSettings.serverExposureMode}`);
	const serverExposureState = await applyDesktopServerExposureMode(desktopSettings.serverExposureMode, { persist: desktopSettings.serverExposureMode !== DEFAULT_DESKTOP_SETTINGS.serverExposureMode });
	writeDesktopLogHeader(`bootstrap resolved backend endpoint baseUrl=${backendHttpUrl}`);
	if (serverExposureState.endpointUrl) writeDesktopLogHeader(`bootstrap enabled network access endpointUrl=${serverExposureState.endpointUrl}`);
	else if (desktopSettings.serverExposureMode === "network-accessible") writeDesktopLogHeader("bootstrap fell back to local-only because no advertised network host was available");
	registerIpcHandlers();
	writeDesktopLogHeader("bootstrap ipc handlers registered");
	startBackend();
	writeDesktopLogHeader("bootstrap backend start requested");
	if (isDevelopment) {
		mainWindow = createWindow();
		writeDesktopLogHeader("bootstrap main window created");
		waitForBackendHttpReady(backendHttpUrl).then(() => {
			writeDesktopLogHeader("bootstrap backend ready");
		}).catch((error) => {
			if (isBackendReadinessAborted(error)) return;
			writeDesktopLogHeader(`bootstrap backend readiness warning message=${formatErrorMessage(error)}`);
			console.warn("[desktop] backend readiness check timed out during dev bootstrap", error);
		});
		return;
	}
	ensureInitialBackendWindowOpen();
}
electron.app.on("before-quit", () => {
	isQuitting = true;
	updateInstallInFlight = false;
	writeDesktopLogHeader("before-quit received");
	clearUpdatePollTimer();
	cancelBackendReadinessWait();
	stopBackend();
	restoreStdIoCapture?.();
});
electron.app.whenReady().then(() => {
	writeDesktopLogHeader("app ready");
	configureAppIdentity();
	configureApplicationMenu();
	registerDesktopProtocol();
	configureAutoUpdater();
	const revealOrOpenAppWindow = () => {
		const existingWindow = mainWindow ?? electron.BrowserWindow.getAllWindows()[0];
		if (existingWindow) {
			revealWindow(existingWindow);
			return;
		}
		if (isDevelopment) {
			mainWindow = createWindow();
			return;
		}
		ensureInitialBackendWindowOpen();
	};
	createNotchPanel({
		readView: createNotchViewReader({
			baseUrl: () => backendHttpUrl || null,
			host: () => mainWindow?.webContents ?? null
		}),
		readUrl: () => {
			const contents = mainWindow?.webContents;
			return contents && !contents.isDestroyed() ? contents.getURL() : null;
		},
		onSignIn: revealOrOpenAppWindow
	});
	bootstrap().catch((error) => {
		if (isBackendReadinessAborted(error) && isQuitting) return;
		handleFatalStartupError("bootstrap", error);
	});
	electron.app.on("activate", revealOrOpenAppWindow);
}).catch((error) => {
	handleFatalStartupError("whenReady", error);
});
electron.app.on("window-all-closed", () => {
	if (process.platform !== "darwin" && !isQuitting) electron.app.quit();
});
if (process.platform !== "win32") {
	process.on("SIGINT", () => {
		if (isQuitting) return;
		isQuitting = true;
		writeDesktopLogHeader("SIGINT received");
		clearUpdatePollTimer();
		cancelBackendReadinessWait();
		stopBackend();
		restoreStdIoCapture?.();
		electron.app.quit();
	});
	process.on("SIGTERM", () => {
		if (isQuitting) return;
		isQuitting = true;
		writeDesktopLogHeader("SIGTERM received");
		clearUpdatePollTimer();
		stopBackend();
		restoreStdIoCapture?.();
		electron.app.quit();
	});
}

//#endregion
//# sourceMappingURL=main.cjs.map