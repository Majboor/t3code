import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      organization_id TEXT,
      runtime_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS organizations (
      organization_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tenant_memberships (
      membership_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      organization_id TEXT,
      roles_json TEXT NOT NULL,
      organization_roles_json TEXT,
      team_ids_json TEXT,
      department_id TEXT,
      created_at TEXT NOT NULL,
      disabled_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS organization_employees (
      membership_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS organization_teams (
      team_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE (organization_id, slug)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS organization_departments (
      department_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE (organization_id, slug)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tenant_invites (
      invite_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT,
      invited_by_user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      scope TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      revoked_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS organization_access_grants (
      grant_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      membership_id TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      granted_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS organization_access_reviews (
      review_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      membership_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS organization_audit_events (
      event_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_presence (
      presence_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      thread_id TEXT,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS collaboration_activities (
      activity_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT,
      thread_id TEXT,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_accounts (
      provider_account_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_json TEXT NOT NULL,
      sharing TEXT NOT NULL,
      auth_home_dir TEXT NOT NULL,
      config_dir TEXT NOT NULL,
      secrets_dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      disabled_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_session_isolation (
      provider_session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_home_dir TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ended_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tenant_runtime_systemd_units (
      runtime_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      unit_name TEXT NOT NULL,
      unit_file TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      last_written_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tenant_runtime_descriptors (
      runtime_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      linux_user TEXT NOT NULL,
      base_dir TEXT NOT NULL,
      data_dir TEXT NOT NULL,
      secrets_dir TEXT NOT NULL,
      attachments_dir TEXT NOT NULL,
      worktrees_dir TEXT NOT NULL,
      runs_dir TEXT NOT NULL,
      provider_homes_dir TEXT NOT NULL,
      internal_host TEXT NOT NULL,
      internal_port INTEGER NOT NULL,
      status TEXT NOT NULL,
      idle_shutdown_after_ms INTEGER NOT NULL,
      last_started_at TEXT,
      last_stopped_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tenant_runtime_lifecycle_steps (
      idempotency_key TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      source_action TEXT NOT NULL,
      target_status TEXT NOT NULL,
      process_action INTEGER NOT NULL,
      reason TEXT NOT NULL,
      completed_at TEXT NOT NULL
    )
  `;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_tenant_memberships_org ON tenant_memberships(organization_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_org_employees_org ON organization_employees(organization_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant_workspace ON tenant_invites(tenant_id, workspace_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_org_audit_events_org_created ON organization_audit_events(organization_id, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_collaboration_presence_scope ON collaboration_presence(tenant_id, workspace_id, thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_collaboration_activities_scope ON collaboration_activities(tenant_id, workspace_id, thread_id, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_provider_accounts_tenant_provider ON provider_accounts(tenant_id, provider)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_provider_session_isolation_tenant_user ON provider_session_isolation(tenant_id, user_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_tenant_runtime_systemd_units_tenant ON tenant_runtime_systemd_units(tenant_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_tenant_runtime_descriptors_tenant_status ON tenant_runtime_descriptors(tenant_id, status)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_tenant_runtime_lifecycle_steps_runtime ON tenant_runtime_lifecycle_steps(tenant_id, runtime_id, completed_at)`;
});
