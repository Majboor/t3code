import { Schema } from "effect";

export const TrimmedString = Schema.Trim;
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings
 */
const makeEntityId = <Brand extends string>(brand: Brand) => {
  return TrimmedNonEmptyString.pipe(Schema.brand(brand));
};

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const ProductEventId = makeEntityId("ProductEventId");
export type ProductEventId = typeof ProductEventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;
export const AuthSessionId = makeEntityId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;
export const UserId = makeEntityId("UserId");
export type UserId = typeof UserId.Type;
export const OrganizationId = makeEntityId("OrganizationId");
export type OrganizationId = typeof OrganizationId.Type;
export const OrganizationTeamId = makeEntityId("OrganizationTeamId");
export type OrganizationTeamId = typeof OrganizationTeamId.Type;
export const OrganizationDepartmentId = makeEntityId("OrganizationDepartmentId");
export type OrganizationDepartmentId = typeof OrganizationDepartmentId.Type;
export const OrganizationAccessGrantId = makeEntityId("OrganizationAccessGrantId");
export type OrganizationAccessGrantId = typeof OrganizationAccessGrantId.Type;
export const OrganizationAccessReviewId = makeEntityId("OrganizationAccessReviewId");
export type OrganizationAccessReviewId = typeof OrganizationAccessReviewId.Type;
export const OrganizationAuditEventId = makeEntityId("OrganizationAuditEventId");
export type OrganizationAuditEventId = typeof OrganizationAuditEventId.Type;
export const TenantId = makeEntityId("TenantId");
export type TenantId = typeof TenantId.Type;
export const MembershipId = makeEntityId("MembershipId");
export type MembershipId = typeof MembershipId.Type;
export const WorkspaceId = makeEntityId("WorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;
export const TenantRuntimeId = makeEntityId("TenantRuntimeId");
export type TenantRuntimeId = typeof TenantRuntimeId.Type;
export const ProviderAccountId = makeEntityId("ProviderAccountId");
export type ProviderAccountId = typeof ProviderAccountId.Type;
export const ProviderSessionId = makeEntityId("ProviderSessionId");
export type ProviderSessionId = typeof ProviderSessionId.Type;
export const InviteId = makeEntityId("InviteId");
export type InviteId = typeof InviteId.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;
