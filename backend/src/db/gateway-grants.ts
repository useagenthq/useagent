import type { Sql } from "postgres";

/**
 * Declarative grants for the RESTRICTED sandbox-gateway role, applied
 * idempotently at every backend boot (right after migrations).
 *
 * ROOT CAUSE this exists to kill: grants used to live only in
 * deploy/hetzner/configure-host.sh, which runs once at host provisioning -
 * while tables arrive via migrations on every deploy. Twice a migration
 * shipped a gateway-written table whose INSERTs then died in production with
 * 42501 (knowledge_*, artifact_workpiece_proposals). With the manifest in
 * code, the grant lands in the same commit as the feature and every deploy
 * reconciles it. configure-host.sh keeps the role/REVOKE baseline and the
 * credentials view; its grant list mirrors this manifest and a test keeps the
 * two in sync.
 *
 * Rules: least privilege, no DELETE anywhere, column-scoped where the lane
 * only touches specific columns. When a migration adds a table the GATEWAY
 * process writes, add it HERE in the same change.
 */
export const GATEWAY_GRANTS: readonly string[] = [
  "GRANT SELECT ON runs, skills, skill_revisions, secrets, artifacts, provider_gateway_audit, slack_threads TO skynet_gateway",
  "GRANT UPDATE (skill_id, skill_version, skill_content_hash, updated_at) ON runs TO skynet_gateway",
  "GRANT UPDATE (usage_count, last_run_at, updated_at) ON skills TO skynet_gateway",
  "GRANT SELECT (id, run_id, seq, event_type, payload) ON provider_events TO skynet_gateway",
  "GRANT INSERT (id, run_id, thread_id, seq, provider, event_type, native_session_id, native_parent_session_id, native_message_id, native_part_id, native_call_id, payload, created_at) ON provider_events TO skynet_gateway",
  "GRANT UPDATE (seq, event_type, payload, created_at) ON provider_events TO skynet_gateway",
  "GRANT SELECT, INSERT ON artifacts TO skynet_gateway",
  // Republish-as-revision (and companion seeding) update an existing artifact row
  // in place under the restricted role; column-scoped so it can never touch org
  // scope or identity columns.
  "GRANT UPDATE (name, content_type, size_bytes, sha256, storage_key, workpiece_kind, workpiece_state, workpiece_revision, preview_storage_key) ON artifacts TO skynet_gateway",
  "GRANT SELECT, INSERT, UPDATE ON provider_gateway_audit TO skynet_gateway",
  "GRANT INSERT ON slack_outbox TO skynet_gateway",
  "GRANT SELECT, INSERT, UPDATE ON knowledge_records, knowledge_documents, knowledge_revisions TO skynet_gateway",
  "GRANT SELECT, INSERT ON artifact_workpiece_proposals TO skynet_gateway",
  "GRANT UPDATE (status, resolved_at, resolved_by, resolved_revision) ON artifact_workpiece_proposals TO skynet_gateway",
  // Unified context index (Phase 1): the gateway context_search/context_read
  // tools READ the projection; the privileged BACKEND writes it (projector on
  // skill/knowledge/automation writes). SELECT only - no gateway write path.
  "GRANT SELECT ON context_index TO skynet_gateway",
];

/** The BYOK credentials view is created by provisioning; grant only if present. */
const VIEW_GRANT =
  "GRANT SELECT ON gateway_provider_api_key_credentials TO skynet_gateway";

/**
 * Apply the manifest with the privileged boot connection. A database without
 * the restricted role (local dev, throwaway test DBs) skips silently - that is
 * the normal non-hosted state, not an error. A present role with a failing
 * grant is LOUD: that is exactly the production incident class this prevents.
 */
export async function applyGatewayGrants(sql: Sql): Promise<void> {
  const [role] = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'skynet_gateway'`;
  if (!role) return;
  for (const grant of GATEWAY_GRANTS) {
    try {
      await sql.unsafe(grant);
    } catch (error) {
      console.error(`[gateway-grants] failed: ${grant}:`, error);
    }
  }
  const [view] = await sql`SELECT 1 FROM pg_views WHERE viewname = 'gateway_provider_api_key_credentials'`;
  if (view) {
    await sql.unsafe(VIEW_GRANT).catch((error) => {
      console.error(`[gateway-grants] failed: ${VIEW_GRANT}:`, error);
    });
  }
  console.log(`[gateway-grants] reconciled ${GATEWAY_GRANTS.length} grants for skynet_gateway`);
}
