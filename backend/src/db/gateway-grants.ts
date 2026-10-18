import type { Sql } from "postgres";

export const GATEWAY_DATABASE_ROLE = "useagent_gateway";
/** The role databases created before the rename still carry. */
export const LEGACY_GATEWAY_DATABASE_ROLE = "skynet_gateway";

/**
 * Declarative grants for the RESTRICTED sandbox-gateway role, applied
 * idempotently at every backend boot (right after migrations).
 *
 * ROOT CAUSE this exists to kill: grants used to live only in
 * the host provisioning script, which runs once at setup -
 * while tables arrive via migrations on every deploy. Twice a migration
 * shipped a gateway-written table whose INSERTs then died in production with
 * 42501 (knowledge_*, artifact_workpiece_proposals). With the manifest in
 * code, the grant lands in the same commit as the feature and every deploy
 * reconciles it. configure-host.sh owns only the empty-database-safe role and
 * REVOKE/default-privilege baseline. Migration 0039 owns the credentials view;
 * release migration and production boot apply this manifest after schema setup.
 *
 * Rules: least privilege, no DELETE anywhere, column-scoped where the lane
 * only touches specific columns. When a migration adds a table the GATEWAY
 * process writes, add it HERE in the same change.
 */
export const GATEWAY_GRANTS: readonly string[] = [
  "GRANT SELECT ON runs, skills, skill_revisions, secrets, artifacts, provider_gateway_audit, slack_threads, thread_relationships TO useagent_gateway",
  "GRANT UPDATE (skill_id, skill_version, skill_content_hash, updated_at) ON runs TO useagent_gateway",
  // Every UPDATE on runs fires trg_validate_batched_child_run_update (migration
  // 0077), whose function runs as the invoking role and reads
  // child_thread_batch_items (org_id, child_run_id) to refuse a thread change on
  // a batched child. The executor checks that read on the range-table entry that
  // survives in the generic plan, before the AND short-circuits, so without this
  // grant the gateway's skill activation (the runs UPDATE above) fails with 42501
  // and the tool returns HTTP 500. Exactly the two columns the EXISTS reads; the
  // gateway never writes batches.
  "GRANT SELECT (org_id, child_run_id) ON child_thread_batch_items TO useagent_gateway",
  // A developer's machine as a sandbox: the gateway resolves a run's local sandbox to its
  // machine (id, owner, enrolment, the token hash behind the binding fingerprint) and the
  // organisation's local-execution policy; it never holds a link or a token.
  "GRANT SELECT (id, org_id, user_id, name, platform, status, logins, enrolled_at, token_hash) ON runners TO useagent_gateway",
  "GRANT SELECT ON runner_policies TO useagent_gateway",
  // Spend allowance: the admission check reads the member's account. Today a
  // restricted gateway bridges every acceptance to the backend (child sessions
  // and run-now fail closed without a primary origin), so this is defence in
  // depth for any future in-process acceptance; the ledger is only ever
  // written by the backend's finalization.
  "GRANT SELECT ON spend_accounts TO useagent_gateway",
  "GRANT UPDATE (usage_count, last_run_at, updated_at) ON skills TO useagent_gateway",
  "GRANT SELECT (id, run_id, thread_id, seq, provider, event_type, payload) ON provider_events TO useagent_gateway",
  "GRANT INSERT (id, run_id, thread_id, seq, provider, event_type, native_session_id, native_parent_session_id, native_message_id, native_part_id, native_call_id, payload, created_at) ON provider_events TO useagent_gateway",
  "GRANT UPDATE (seq, event_type, payload, created_at) ON provider_events TO useagent_gateway",
  "GRANT SELECT, INSERT ON artifacts TO useagent_gateway",
  // Republish-as-revision (and companion seeding) update an existing artifact row
  // in place under the restricted role; column-scoped so it can never touch org
  // scope or identity columns.
  "GRANT UPDATE (name, content_type, size_bytes, sha256, storage_key, workpiece_kind, workpiece_state, workpiece_revision, preview_storage_key) ON artifacts TO useagent_gateway",
  "GRANT SELECT, INSERT, UPDATE ON provider_gateway_audit TO useagent_gateway",
  "GRANT INSERT ON slack_outbox TO useagent_gateway",
  "GRANT SELECT, INSERT, UPDATE ON knowledge_records, knowledge_documents, knowledge_revisions TO useagent_gateway",
  "GRANT SELECT, INSERT ON artifact_workpiece_proposals TO useagent_gateway",
  "GRANT UPDATE (status, resolved_at, resolved_by, resolved_revision) ON artifact_workpiece_proposals TO useagent_gateway",
  // Completion-producing gateway tools open/waive obligations and record the
  // artifact-store receipt that atomically satisfies them. Database constraints
  // keep semantic fields immutable and prohibit untrusted receipt authorities.
  "GRANT SELECT, INSERT ON finished_work_obligations, finished_work_receipts TO useagent_gateway",
  "GRANT UPDATE (state, materialized_artifact_id, materialized_artifact_revision, failure_code, resolved_at, updated_at) ON finished_work_obligations TO useagent_gateway",
  // Durable task tools resolve or create a project, then create/list/update
  // org-scoped tasks. Keep updates column-scoped to the exact gateway patches.
  "GRANT SELECT, INSERT ON projects TO useagent_gateway",
  "GRANT UPDATE (repo_full_name, updated_at) ON projects TO useagent_gateway",
  "GRANT SELECT, INSERT ON tasks TO useagent_gateway",
  "GRANT UPDATE (title, body, status, priority, order_key, updated_at) ON tasks TO useagent_gateway",
  // Integration action discovery/execution reads tenant-safe connection metadata
  // and the encrypted server-side credential. OAuth lifecycle writes stay in
  // the privileged control plane.
  "GRANT SELECT ON integration_connections, integration_connection_credentials TO useagent_gateway",
  // Personal computer bindings resolve through the filtered API-key view; the
  // provider's control-plane labels are the sandbox ownership trust anchor.
  // Never grant the gateway the underlying provider_connections table.
  "GRANT SELECT ON sandbox_labels TO useagent_gateway",
  // Unified context index (Phase 1): the gateway context_search/context_read
  // tools READ the projection; the privileged BACKEND writes it (projector on
  // skill/knowledge/automation writes). SELECT only - no gateway write path.
  "GRANT SELECT ON context_index TO useagent_gateway",
  // The gateway accepts new work through the single door (child sessions, child
  // batches, run-automation-now, approval-minted follow-ups), and the door reads
  // the member's sandbox minutes ledger to refuse a capped member. The ledger is
  // written only by the privileged backend at settlement.
  "GRANT SELECT ON sandbox_minutes_entries TO useagent_gateway",
];

/** Migration 0039 creates the BYOK credentials view; later migrations extend
 * it with non-secret computer metadata. Grant only if present. The UPDATE lets
 * the gateway mark a member's key the provider rejected as reauth_required;
 * the view holds only connected keys, so it can never reconnect one. */
const VIEW_GRANTS = [
  "GRANT SELECT ON gateway_provider_api_key_credentials TO useagent_gateway",
  "GRANT UPDATE (status, status_reason, updated_at) ON gateway_provider_api_key_credentials TO useagent_gateway",
];

function grantsForRole(role: string): readonly string[] {
  if (role === GATEWAY_DATABASE_ROLE) return GATEWAY_GRANTS;
  return GATEWAY_GRANTS.map((grant) => grant.replaceAll(GATEWAY_DATABASE_ROLE, role));
}

/**
 * Apply the manifest with the privileged boot connection. A database without
 * the restricted role (local dev, throwaway test DBs) skips silently - that is
 * the normal non-hosted state, not an error. A present role with a failing
 * grant is LOUD: that is exactly the production incident class this prevents.
 */
export async function applyGatewayGrants(
  sql: Sql,
  options: { strict?: boolean } = {},
): Promise<void> {
  const [currentRole] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${GATEWAY_DATABASE_ROLE}`;
  const [legacyRole] = currentRole
    ? []
    : await sql`SELECT 1 FROM pg_roles WHERE rolname = ${LEGACY_GATEWAY_DATABASE_ROLE}`;
  const role = currentRole
    ? GATEWAY_DATABASE_ROLE
    : legacyRole
      ? LEGACY_GATEWAY_DATABASE_ROLE
      : null;
  if (!role) {
    if (options.strict) throw new Error(`required hosted role ${GATEWAY_DATABASE_ROLE} is missing`);
    return;
  }
  const grants = grantsForRole(role);
  for (const grant of grants) {
    try {
      await sql.unsafe(grant);
    } catch (error) {
      console.error(`[gateway-grants] failed: ${grant}:`, error);
      throw error;
    }
  }
  const [view] = await sql`SELECT 1 FROM pg_views WHERE viewname = 'gateway_provider_api_key_credentials'`;
  if (view) {
    for (const viewGrant of VIEW_GRANTS.map((grant) => grant.replaceAll(GATEWAY_DATABASE_ROLE, role))) {
      await sql.unsafe(viewGrant).catch((error) => {
        console.error(`[gateway-grants] failed: ${viewGrant}:`, error);
        throw error;
      });
    }
  } else if (options.strict) {
    throw new Error("required hosted credentials view gateway_provider_api_key_credentials is missing");
  }
  console.log(`[gateway-grants] reconciled ${grants.length} grants for ${role}`);
}
