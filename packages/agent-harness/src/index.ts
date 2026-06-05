/**
 * @useagent/agent-harness - server-side agent harness contracts.
 *
 * Translates native harnesses (OpenCode, Claude ACP, Codex ACP, future) into ONE
 * provider-neutral canonical event vocabulary and exposes a typed control seam.
 * It knows provider protocols but nothing about the useAgent backend, database,
 * Daytona, or the React UI. The browser-facing `@useagent/agent-client` may import
 * only the zero-dependency `./canonical` subpath from here, never a translator.
 *
 * Subpath entry points (see package.json exports):
 *   - `@useagent/agent-harness/canonical` - the pure canonical event vocabulary
 *   - `@useagent/agent-harness/control`   - the pure HarnessAdapter control types
 *   - `@useagent/agent-harness/opencode`  - the OpenCode -> canonical translator
 */
export * from "./canonical";
export * from "./control";
export * from "./opencode-canonical";
export * from "./t3-tool";
