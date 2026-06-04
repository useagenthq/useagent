// Aggregated schema barrel. The event-sourced tables are split per domain under
// ./schema/*; this file re-exports EVERYTHING so `../db/schema` stays the single
// import path for every consumer and drizzle-kit sees the whole schema.
export * from "./schema/runs";
export * from "./schema/commands";
export * from "./schema/provider-events";
export * from "./schema/approvals";
export * from "./schema/canonical";
export * from "./schema/skills";
export * from "./schema/learning";
export * from "./schema/secrets";
export * from "./schema/api-keys";
export * from "./schema/integrations";
export * from "./schema/provider-connections";
export * from "./schema/slack";
export * from "./schema/artifacts";
export * from "./schema/uploads";
export * from "./schema/memory";
export * from "./schema/reconcile";
export * from "./schema/schedules";
export * from "./schema/commands-catalog";
export * from "./schema/fleet";
export * from "./schema/projects";
export * from "./schema/tasks";
export * from "./schema/github-publication";

// Re-export the better-auth tables so drizzle-kit sees the whole schema and
// the drizzle adapter can resolve every model.
export * from "./auth-schema";
