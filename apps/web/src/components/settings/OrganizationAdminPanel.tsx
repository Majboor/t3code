import {
  Building2Icon,
  ClipboardCheckIcon,
  CopyIcon,
  HistoryIcon,
  PlusIcon,
  SendIcon,
  ShieldCheckIcon,
  UsersIcon,
  XCircleIcon,
} from "lucide-react";
import type {
  MembershipId,
  Organization,
  OrganizationAccessGrant,
  OrganizationAccessScope,
  OrganizationAccessReview,
  OrganizationAuditEvent,
  OrganizationDepartment,
  OrganizationEmployee,
  OrganizationId,
  OrganizationListResult,
  OrganizationRole,
  OrganizationTeam,
  Tenant,
  TenantInvite,
  TenantRole,
  WorkspaceId,
  ProjectId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const TENANT_ROLES: readonly TenantRole[] = ["admin", "developer", "pm", "support", "viewer"];
const ORGANIZATION_ROLES: readonly OrganizationRole[] = [
  "admin",
  "manager",
  "developer",
  "pm",
  "support",
  "auditor",
  "viewer",
];
const INVITE_STATUS_FILTERS = ["all", "pending", "accepted", "revoked"] as const;
type InviteStatusFilter = (typeof INVITE_STATUS_FILTERS)[number];

type OrgSnapshot = OrganizationListResult & {
  readonly auditEvents: readonly OrganizationAuditEvent[];
  readonly collaborationInvites: readonly TenantInvite[];
};

interface CreatedEmployeeInviteLink {
  readonly email: string;
  readonly inviteUrl: string;
  readonly setupUrl: string;
}

const EMPTY_SNAPSHOT: OrgSnapshot = {
  organizations: [],
  tenants: [],
  employees: [],
  invites: [],
  memberships: [],
  teams: [],
  departments: [],
  grants: [],
  reviews: [],
  auditEvents: [],
  collaborationInvites: [],
};

function slugFromName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "")
      .slice(0, 48) || "organization"
  );
}

function expiresIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function roleLabel(roles: readonly string[] | undefined): string {
  return roles && roles.length > 0 ? roles.join(", ") : "None";
}

function getInviteStatus(invite: TenantInvite): Exclude<InviteStatusFilter, "all"> {
  return invite.revokedAt ? "revoked" : invite.acceptedAt ? "accepted" : "pending";
}

function inviteUrlPath(invite: TenantInvite): string {
  return `/invite?inviteId=${encodeURIComponent(invite.id)}`;
}

function inviteShareUrl(invite: TenantInvite): string {
  const path = inviteUrlPath(invite);
  return typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
}

function absoluteAppUrl(path: string): string {
  return typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

function isForbiddenError(error: unknown): boolean {
  return error instanceof Error && /\bforbidden\b/i.test(error.message);
}

function NativeSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-foreground">
      {label}
      <select
        value={value}
        className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/20"
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

function FieldLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-foreground">
      {label}
      {children}
    </label>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function findTenantForOrg(snapshot: OrgSnapshot, organization: Organization | null): Tenant | null {
  if (!organization) return null;
  return snapshot.tenants.find((tenant) => tenant.organizationId === organization.id) ?? null;
}

export function OrganizationAdminPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const [snapshot, setSnapshot] = useState<OrgSnapshot>(EMPTY_SNAPSHOT);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<OrganizationId | null>(null);
  const selectedOrganizationIdRef = useRef<OrganizationId | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [createdEmployeeInvite, setCreatedEmployeeInvite] =
    useState<CreatedEmployeeInviteLink | null>(null);
  const [tenantRole, setTenantRole] = useState<TenantRole>("developer");
  const [organizationRole, setOrganizationRole] = useState<OrganizationRole>("developer");
  const [teamName, setTeamName] = useState("");
  const [departmentName, setDepartmentName] = useState("");
  const [grantMembershipId, setGrantMembershipId] = useState("");
  const [grantRole, setGrantRole] = useState<TenantRole>("developer");
  const [grantScopeType, setGrantScopeType] =
    useState<OrganizationAccessScope["type"]>("organization");
  const [grantScopeId, setGrantScopeId] = useState("");
  const [reviewMembershipIds, setReviewMembershipIds] = useState<ReadonlySet<string>>(new Set());

  const selectedOrganization =
    snapshot.organizations.find((organization) => organization.id === selectedOrganizationId) ??
    snapshot.organizations[0] ??
    null;
  const selectedTenant = findTenantForOrg(snapshot, selectedOrganization);
  const employees = useMemo(
    () =>
      selectedOrganization
        ? snapshot.employees.filter(
            (employee) => employee.membership.organizationId === selectedOrganization.id,
          )
        : [],
    [selectedOrganization, snapshot.employees],
  );
  const teams = useMemo(
    () =>
      selectedOrganization
        ? snapshot.teams.filter((team) => team.organizationId === selectedOrganization.id)
        : [],
    [selectedOrganization, snapshot.teams],
  );
  const departments = useMemo(
    () =>
      selectedOrganization
        ? snapshot.departments.filter(
            (department) => department.organizationId === selectedOrganization.id,
          )
        : [],
    [selectedOrganization, snapshot.departments],
  );
  const invites = useMemo(
    () =>
      selectedTenant
        ? [
            ...snapshot.invites.filter((invite) => invite.tenantId === selectedTenant.id),
            ...snapshot.collaborationInvites.filter(
              (invite) => invite.tenantId === selectedTenant.id,
            ),
          ]
        : [],
    [selectedTenant, snapshot.collaborationInvites, snapshot.invites],
  );
  const grants = useMemo(
    () =>
      selectedOrganization
        ? snapshot.grants.filter((grant) => grant.organizationId === selectedOrganization.id)
        : [],
    [selectedOrganization, snapshot.grants],
  );
  const grantScope = useMemo<OrganizationAccessScope | null>(() => {
    if (!selectedOrganization || !selectedTenant) return null;
    if (grantScopeType === "global") return { type: "global" };
    if (grantScopeType === "organization") {
      return { type: "organization", organizationId: selectedOrganization.id };
    }
    if (grantScopeType === "tenant") return { type: "tenant", tenantId: selectedTenant.id };
    if (grantScopeType === "workspace") {
      const workspaceId = grantScopeId.trim();
      return workspaceId ? { type: "workspace", workspaceId: workspaceId as WorkspaceId } : null;
    }
    if (grantScopeType === "project") {
      const projectId = grantScopeId.trim();
      return projectId ? { type: "project", projectId: projectId as ProjectId } : null;
    }
    return null;
  }, [grantScopeId, grantScopeType, selectedOrganization, selectedTenant]);
  const reviews = useMemo(
    () =>
      selectedOrganization
        ? snapshot.reviews.filter((review) => review.organizationId === selectedOrganization.id)
        : [],
    [selectedOrganization, snapshot.reviews],
  );

  const selectOrganizationId = useCallback((organizationId: OrganizationId | null) => {
    selectedOrganizationIdRef.current = organizationId;
    setSelectedOrganizationId(organizationId);
  }, []);

  const load = useCallback(async () => {
    if (!environmentId) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    setLoading(true);
    try {
      const result = await api.organizations.list();
      const currentOrganizationId = selectedOrganizationIdRef.current;
      const nextOrganizationId =
        currentOrganizationId &&
        result.organizations.some((org) => org.id === currentOrganizationId)
          ? currentOrganizationId
          : (result.organizations[0]?.id ?? null);
      const events =
        nextOrganizationId !== null
          ? await api.organizations
              .listAuditEvents({ organizationId: nextOrganizationId })
              .then((result) => result.events)
              .catch((error: unknown) => {
                if (isForbiddenError(error)) return [];
                throw error;
              })
          : [];
      const nextOrganization =
        nextOrganizationId !== null
          ? (result.organizations.find((organization) => organization.id === nextOrganizationId) ??
            null)
          : null;
      const nextTenant = nextOrganization
        ? (result.tenants.find((tenant) => tenant.organizationId === nextOrganization.id) ?? null)
        : null;
      const collaborationInvites = nextTenant
        ? (await api.collaboration.listInvites({ tenantId: nextTenant.id })).invites
        : [];
      setSnapshot({ ...result, auditEvents: events, collaborationInvites });
      selectOrganizationId(nextOrganizationId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not load organization admin",
        description: getErrorMessage(error),
      });
    } finally {
      setLoading(false);
    }
  }, [environmentId, selectOrganizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshAudit = useCallback(
    async (organizationId: Organization["id"]) => {
      if (!environmentId) return;
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      const events = await api.organizations
        .listAuditEvents({ organizationId })
        .catch((error: unknown) => {
          if (isForbiddenError(error)) return { events: [] };
          throw error;
        });
      setSnapshot((current) => ({ ...current, auditEvents: events.events }));
    },
    [environmentId],
  );

  const runMutation = useCallback(
    async (label: string, task: () => Promise<void>) => {
      setBusy(label);
      try {
        await task();
        await load();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Organization request failed",
          description: getErrorMessage(error),
        });
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const api = environmentId ? readEnvironmentApi(environmentId) : undefined;
  const canSubmit = Boolean(api) && busy === null;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Organization"
        icon={<Building2Icon className="size-3.5" />}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={loading || busy !== null}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        }
      >
        <SettingsRow
          title="Admin workspace"
          description="Create and select the organization scope used by employee, team, invite, and audit controls."
        >
          <div className="grid gap-3 pt-4 md:grid-cols-[1fr_12rem_auto]">
            <FieldLabel label="Organization name">
              <Input
                value={createName}
                placeholder="Acme Engineering"
                onChange={(event) => setCreateName(event.currentTarget.value)}
              />
            </FieldLabel>
            <FieldLabel label="Slug">
              <Input value={slugFromName(createName)} readOnly />
            </FieldLabel>
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={!canSubmit || createName.trim().length === 0}
                onClick={() =>
                  void runMutation("create-org", async () => {
                    if (!api) return;
                    const result = await api.organizations.create({
                      displayName: createName.trim(),
                      slug: slugFromName(createName),
                    });
                    selectOrganizationId(result.organization.id);
                    setCreateName("");
                  })
                }
              >
                <PlusIcon className="size-4" />
                Create
              </Button>
            </div>
          </div>
          {snapshot.organizations.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {snapshot.organizations.map((organization) => (
                <Button
                  key={organization.id}
                  size="xs"
                  variant={organization.id === selectedOrganization?.id ? "default" : "outline"}
                  onClick={() => {
                    selectOrganizationId(organization.id);
                    void refreshAudit(organization.id);
                  }}
                >
                  {organization.displayName}
                </Button>
              ))}
            </div>
          ) : (
            <div className="mt-4">
              <EmptyLine>No organization has been created yet.</EmptyLine>
            </div>
          )}
        </SettingsRow>
      </SettingsSection>

      {selectedOrganization && selectedTenant ? (
        <>
          <SettingsSection title="Employees" icon={<UsersIcon className="size-3.5" />}>
            <SettingsRow
              title="Invite employee"
              description="Send a tenant-scoped invite and create the employee membership record."
            >
              <div className="grid gap-3 pt-4 md:grid-cols-2">
                <FieldLabel label="Email">
                  <Input
                    type="email"
                    value={inviteEmail}
                    placeholder="teammate@example.com"
                    onChange={(event) => setInviteEmail(event.currentTarget.value)}
                  />
                </FieldLabel>
                <FieldLabel label="Display name">
                  <Input
                    value={inviteName}
                    placeholder="Teammate"
                    onChange={(event) => setInviteName(event.currentTarget.value)}
                  />
                </FieldLabel>
                <NativeSelect
                  label="Tenant role"
                  value={tenantRole}
                  onChange={(value) => setTenantRole(value as TenantRole)}
                >
                  {TENANT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  label="Organization role"
                  value={organizationRole}
                  onChange={(value) => setOrganizationRole(value as OrganizationRole)}
                >
                  {ORGANIZATION_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="mt-3">
                <Button
                  size="sm"
                  disabled={!canSubmit || inviteEmail.trim().length === 0}
                  onClick={() =>
                    void runMutation("invite-employee", async () => {
                      if (!api) return;
                      const result = await api.organizations.inviteEmployee({
                        organizationId: selectedOrganization.id,
                        tenantId: selectedTenant.id,
                        email: inviteEmail.trim(),
                        displayName: inviteName.trim() || inviteEmail.trim(),
                        roles: [tenantRole],
                        organizationRoles: [organizationRole],
                        teamIds: [],
                        departmentId: null,
                        expiresAt: expiresIn(14),
                      });
                      const inviteLink = inviteShareUrl(result.invite);
                      const setupLink = absoluteAppUrl(
                        result.accountSetupUrlPath ?? inviteUrlPath(result.invite),
                      );
                      setCreatedEmployeeInvite({
                        email: result.invite.email,
                        inviteUrl: inviteLink,
                        setupUrl: setupLink,
                      });
                      toastManager.add({
                        type: "success",
                        title: "Employee invite created",
                        description: setupLink,
                        actionProps: {
                          children: "Copy",
                          onClick: () => {
                            void navigator.clipboard?.writeText(setupLink);
                          },
                        },
                      });
                      setInviteEmail("");
                      setInviteName("");
                    })
                  }
                >
                  <SendIcon className="size-4" />
                  Invite employee
                </Button>
              </div>
              {createdEmployeeInvite ? (
                <div className="mt-4 rounded-lg border border-border bg-background p-3">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        Invite link for {createdEmployeeInvite.email}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Send the setup link to a new employee. Existing signed-in users can use the
                        invite-only link.
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setCreatedEmployeeInvite(null);
                      }}
                    >
                      Close
                    </Button>
                  </div>
                  <div className="mt-3 grid gap-2">
                    <InviteLinkRow label="Setup link" value={createdEmployeeInvite.setupUrl} />
                    {createdEmployeeInvite.inviteUrl !== createdEmployeeInvite.setupUrl ? (
                      <InviteLinkRow
                        label="Existing account link"
                        value={createdEmployeeInvite.inviteUrl}
                      />
                    ) : null}
                  </div>
                </div>
              ) : null}
            </SettingsRow>
            <SettingsRow
              title="Employee lifecycle"
              description="Review active and invited employees, update roles, or disable access."
            >
              <EmployeeTable
                employees={employees}
                teams={teams}
                departments={departments}
                canSubmit={canSubmit}
                onUpdate={(employee, role) =>
                  runMutation("update-employee", async () => {
                    if (!api) return;
                    await api.organizations.updateEmployee({
                      organizationId: selectedOrganization.id,
                      membershipId: employee.membership.id,
                      organizationRoles: [role],
                    });
                  })
                }
                onDisable={(employee) =>
                  runMutation("disable-employee", async () => {
                    if (!api) return;
                    await api.organizations.disableEmployee({
                      organizationId: selectedOrganization.id,
                      membershipId: employee.membership.id,
                    });
                  })
                }
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Teams" icon={<Building2Icon className="size-3.5" />}>
            <SettingsRow
              title="Teams and departments"
              description="Create org units used by employee assignment and scoped access grants."
            >
              <div className="grid gap-3 pt-4 md:grid-cols-[1fr_auto_1fr_auto]">
                <FieldLabel label="Team">
                  <Input
                    value={teamName}
                    placeholder="Platform"
                    onChange={(event) => setTeamName(event.currentTarget.value)}
                  />
                </FieldLabel>
                <div className="flex items-end">
                  <Button
                    size="sm"
                    disabled={!canSubmit || teamName.trim().length === 0}
                    onClick={() =>
                      void runMutation("create-team", async () => {
                        if (!api) return;
                        await api.organizations.createTeam({
                          organizationId: selectedOrganization.id,
                          displayName: teamName.trim(),
                          slug: slugFromName(teamName),
                        });
                        setTeamName("");
                      })
                    }
                  >
                    Add team
                  </Button>
                </div>
                <FieldLabel label="Department">
                  <Input
                    value={departmentName}
                    placeholder="Engineering"
                    onChange={(event) => setDepartmentName(event.currentTarget.value)}
                  />
                </FieldLabel>
                <div className="flex items-end">
                  <Button
                    size="sm"
                    disabled={!canSubmit || departmentName.trim().length === 0}
                    onClick={() =>
                      void runMutation("create-department", async () => {
                        if (!api) return;
                        await api.organizations.createDepartment({
                          organizationId: selectedOrganization.id,
                          displayName: departmentName.trim(),
                          slug: slugFromName(departmentName),
                        });
                        setDepartmentName("");
                      })
                    }
                  >
                    Add department
                  </Button>
                </div>
              </div>
              <UnitList teams={teams} departments={departments} />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Access" icon={<ShieldCheckIcon className="size-3.5" />}>
            <SettingsRow
              title="Access grants"
              description="Grant tenant roles scoped to this organization for selected memberships."
            >
              <div className="grid gap-3 pt-4 md:grid-cols-[1fr_10rem_11rem_1fr_auto]">
                <NativeSelect
                  label="Employee"
                  value={grantMembershipId}
                  onChange={setGrantMembershipId}
                >
                  <option value="">Select employee</option>
                  {employees.map((employee) => (
                    <option key={employee.membership.id} value={employee.membership.id}>
                      {employee.displayName}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  label="Scope"
                  value={grantScopeType}
                  onChange={(value) => {
                    setGrantScopeType(value as OrganizationAccessScope["type"]);
                    setGrantScopeId("");
                  }}
                >
                  <option value="organization">Organization</option>
                  <option value="tenant">Workspace group</option>
                  <option value="workspace">Workspace</option>
                  <option value="project">Project</option>
                  <option value="global">Global</option>
                </NativeSelect>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  <span>{grantScopeType === "workspace" ? "Workspace ID" : "Project ID"}</span>
                  <Input
                    value={grantScopeId}
                    disabled={grantScopeType !== "workspace" && grantScopeType !== "project"}
                    placeholder={
                      grantScopeType === "workspace"
                        ? "workspace:..."
                        : grantScopeType === "project"
                          ? "project:..."
                          : "Automatic"
                    }
                    onChange={(event) => setGrantScopeId(event.currentTarget.value)}
                  />
                </label>
                <NativeSelect
                  label="Role"
                  value={grantRole}
                  onChange={(value) => setGrantRole(value as TenantRole)}
                >
                  {TENANT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </NativeSelect>
                <div className="flex items-end">
                  <Button
                    className="w-full"
                    size="sm"
                    disabled={!canSubmit || grantMembershipId.length === 0 || grantScope === null}
                    onClick={() =>
                      void runMutation("grant-access", async () => {
                        if (!api || !grantScope) return;
                        await api.organizations.grantAccess({
                          organizationId: selectedOrganization.id,
                          membershipId: grantMembershipId as MembershipId,
                          scope: grantScope,
                          roles: [grantRole],
                        });
                        setGrantMembershipId("");
                        setGrantScopeId("");
                      })
                    }
                  >
                    Grant
                  </Button>
                </div>
              </div>
              <GrantList grants={grants} employees={employees} />
            </SettingsRow>
            <SettingsRow
              title="Access reviews"
              description="Open a review against selected employee memberships and keep the audit trail visible."
            >
              <div className="mt-4 grid gap-2">
                {employees.length === 0 ? (
                  <EmptyLine>No employees available for review.</EmptyLine>
                ) : (
                  employees.map((employee) => (
                    <label
                      key={employee.membership.id}
                      className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={reviewMembershipIds.has(employee.membership.id)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setReviewMembershipIds((current) => {
                            const next = new Set(current);
                            if (checked) {
                              next.add(employee.membership.id);
                            } else {
                              next.delete(employee.membership.id);
                            }
                            return next;
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">{employee.displayName}</span>
                      <span className="text-xs text-muted-foreground">{employee.status}</span>
                    </label>
                  ))
                )}
              </div>
              <div className="mt-3">
                <Button
                  size="sm"
                  disabled={!canSubmit || reviewMembershipIds.size === 0}
                  onClick={() =>
                    void runMutation("create-review", async () => {
                      if (!api) return;
                      await api.organizations.createAccessReview({
                        organizationId: selectedOrganization.id,
                        membershipIds: Array.from(reviewMembershipIds) as MembershipId[],
                      });
                      setReviewMembershipIds(new Set());
                    })
                  }
                >
                  <ClipboardCheckIcon className="size-4" />
                  Create review
                </Button>
              </div>
              <ReviewList
                canSubmit={canSubmit}
                reviews={reviews}
                employees={employees}
                onComplete={(review) =>
                  runMutation("complete-review", async () => {
                    if (!api) return;
                    await api.organizations.completeAccessReview({
                      organizationId: selectedOrganization.id,
                      reviewId: review.id,
                    });
                  })
                }
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Invites and audit" icon={<HistoryIcon className="size-3.5" />}>
            <SettingsRow
              title="Pending invites"
              description="Inspect invite records created from employee and collaboration workflows."
            >
              <InviteList
                canSubmit={canSubmit}
                invites={invites}
                onRevoke={(invite) =>
                  runMutation("revoke-invite", async () => {
                    if (!api) return;
                    await api.collaboration.revokeInvite({
                      tenantId: invite.tenantId,
                      inviteId: invite.id,
                    });
                  })
                }
              />
            </SettingsRow>
            <SettingsRow title="Audit log" description="Review recent organization admin events.">
              <AuditList events={snapshot.auditEvents} />
            </SettingsRow>
          </SettingsSection>
        </>
      ) : null}
    </SettingsPageContainer>
  );
}

function InviteLinkRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
          {value}
        </code>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            toastManager.add({ type: "success", title: "Invite link copied" });
          }}
        >
          <CopyIcon className="size-3.5" />
          Copy
        </Button>
      </div>
    </div>
  );
}

function EmployeeTable({
  canSubmit,
  departments,
  employees,
  onDisable,
  onUpdate,
  teams,
}: {
  canSubmit: boolean;
  departments: readonly OrganizationDepartment[];
  employees: readonly OrganizationEmployee[];
  teams: readonly OrganizationTeam[];
  onDisable: (employee: OrganizationEmployee) => Promise<void>;
  onUpdate: (employee: OrganizationEmployee, role: OrganizationRole) => Promise<void>;
}) {
  if (employees.length === 0) {
    return (
      <div className="mt-4">
        <EmptyLine>No employees yet.</EmptyLine>
      </div>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[46rem] text-left text-sm">
        <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Employee</th>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 font-medium">Unit</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((employee) => {
            const teamNames = (employee.membership.teamIds ?? [])
              .map((teamId) => teams.find((team) => team.id === teamId)?.displayName)
              .filter(Boolean);
            const departmentName = departments.find(
              (department) => department.id === employee.membership.departmentId,
            )?.displayName;
            return (
              <tr
                key={employee.membership.id}
                className="border-b border-border/70 last:border-b-0"
              >
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{employee.displayName}</div>
                  <div className="text-xs text-muted-foreground">{employee.email}</div>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {roleLabel(employee.membership.organizationRoles)}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {[departmentName, ...teamNames].filter(Boolean).join(" / ") || "Unassigned"}
                </td>
                <td className="px-3 py-2">
                  <StatusText disabled={employee.status === "disabled"}>
                    {employee.status}
                  </StatusText>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-2">
                    <select
                      disabled={!canSubmit || employee.status === "disabled"}
                      className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                      value={employee.membership.organizationRoles?.[0] ?? "viewer"}
                      onChange={(event) =>
                        void onUpdate(employee, event.currentTarget.value as OrganizationRole)
                      }
                    >
                      {ORGANIZATION_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canSubmit || employee.status === "disabled"}
                      onClick={() => void onDisable(employee)}
                    >
                      Disable
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UnitList({
  departments,
  teams,
}: {
  departments: readonly OrganizationDepartment[];
  teams: readonly OrganizationTeam[];
}) {
  const items = [
    ...teams.map((team) => ({
      id: team.id,
      label: team.displayName,
      type: "Team",
      slug: team.slug,
    })),
    ...departments.map((department) => ({
      id: department.id,
      label: department.displayName,
      type: "Department",
      slug: department.slug,
    })),
  ];
  if (items.length === 0) {
    return (
      <div className="mt-4">
        <EmptyLine>No teams or departments yet.</EmptyLine>
      </div>
    );
  }
  return (
    <div className="mt-4 grid gap-2 md:grid-cols-2">
      {items.map((item) => (
        <div key={item.id} className="rounded-lg border border-border px-3 py-2">
          <div className="text-sm font-medium text-foreground">{item.label}</div>
          <div className="text-xs text-muted-foreground">
            {item.type} · {item.slug}
          </div>
        </div>
      ))}
    </div>
  );
}

function GrantList({
  employees,
  grants,
}: {
  employees: readonly OrganizationEmployee[];
  grants: readonly OrganizationAccessGrant[];
}) {
  if (grants.length === 0) {
    return (
      <div className="mt-4">
        <EmptyLine>No access grants yet.</EmptyLine>
      </div>
    );
  }
  return (
    <div className="mt-4 grid gap-2">
      {grants.map((grant) => {
        const employee = employees.find((entry) => entry.membership.id === grant.membershipId);
        return (
          <div key={grant.id} className="rounded-lg border border-border px-3 py-2 text-sm">
            <div className="font-medium text-foreground">
              {employee?.displayName ?? grant.membershipId}
            </div>
            <div className="text-xs text-muted-foreground">
              {roleLabel(grant.roles)} on {grant.scope.type} · {formatDate(grant.createdAt)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReviewList({
  canSubmit,
  employees,
  onComplete,
  reviews,
}: {
  canSubmit: boolean;
  employees: readonly OrganizationEmployee[];
  onComplete: (review: OrganizationAccessReview) => void;
  reviews: readonly OrganizationAccessReview[];
}) {
  if (reviews.length === 0) {
    return null;
  }
  return (
    <div className="mt-4 grid gap-2">
      {reviews.map((review) => {
        const names = review.membershipIds
          .map(
            (id) => employees.find((employee) => employee.membership.id === id)?.displayName ?? id,
          )
          .join(", ");
        return (
          <div
            key={review.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground">
                {names || "No memberships"}
              </div>
              <div className="text-xs text-muted-foreground">
                {review.status} · {formatDate(review.createdAt)}
              </div>
            </div>
            {review.status === "open" ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!canSubmit}
                onClick={() => onComplete(review)}
              >
                Complete
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function InviteList({
  canSubmit,
  invites,
  onRevoke,
}: {
  canSubmit: boolean;
  invites: readonly TenantInvite[];
  onRevoke: (invite: TenantInvite) => Promise<void>;
}) {
  const [filter, setFilter] = useState<InviteStatusFilter>("all");
  const { copyToClipboard } = useCopyToClipboard<TenantInvite>({
    onCopy: (invite) => {
      toastManager.add({
        type: "success",
        title: "Invite link copied",
        description: `${invite.email} can use this link until it expires or is revoked.`,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy invite link",
        description: error.message,
      });
    },
  });
  const filteredInvites =
    filter === "all" ? invites : invites.filter((invite) => getInviteStatus(invite) === filter);

  if (invites.length === 0) {
    return (
      <div className="mt-4">
        <EmptyLine>No invites yet.</EmptyLine>
      </div>
    );
  }
  return (
    <div className="mt-4 grid gap-3">
      <div className="flex flex-wrap gap-2">
        {INVITE_STATUS_FILTERS.map((item) => (
          <Button
            key={item}
            size="xs"
            variant={filter === item ? "default" : "outline"}
            aria-label={`Show ${item} invites`}
            aria-pressed={filter === item}
            onClick={() => setFilter(item)}
          >
            {item}
          </Button>
        ))}
      </div>
      {filteredInvites.length === 0 ? <EmptyLine>No {filter} invites.</EmptyLine> : null}
      {filteredInvites.map((invite) => {
        const status = getInviteStatus(invite);
        const canRevoke = status === "pending" && invite.scope !== "tenant";
        const path = inviteUrlPath(invite);
        return (
          <div key={invite.id} className="rounded-lg border border-border px-3 py-2 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1 truncate font-medium text-foreground">
                {invite.email}
              </div>
              <StatusText disabled={status !== "pending"}>{status}</StatusText>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {invite.scope} · expires {formatDate(invite.expiresAt)}
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                {path}
              </code>
              <Button
                size="xs"
                variant="outline"
                aria-label={`Copy invite link for ${invite.email}`}
                onClick={() => copyToClipboard(inviteShareUrl(invite), invite)}
              >
                <CopyIcon className="size-3.5" />
                Copy
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!canSubmit || !canRevoke}
                aria-label={`Revoke invite for ${invite.email}`}
                onClick={() => void onRevoke(invite)}
              >
                <XCircleIcon className="size-3.5" />
                Revoke
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AuditList({ events }: { events: readonly OrganizationAuditEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="mt-4">
        <EmptyLine>No audit events yet.</EmptyLine>
      </div>
    );
  }
  return (
    <div className="mt-4 grid gap-2">
      {events.map((event) => (
        <div key={event.id} className="rounded-lg border border-border px-3 py-2 text-sm">
          <div className="font-medium text-foreground">{event.summary}</div>
          <div className="text-xs text-muted-foreground">
            {event.kind} · {formatDate(event.createdAt)}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusText({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return (
    <span
      className={cn("text-xs font-medium", disabled ? "text-muted-foreground" : "text-foreground")}
    >
      {children}
    </span>
  );
}
