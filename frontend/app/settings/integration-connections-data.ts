// The integration summary WIRE CONTRACT - the row shape, the backend set, and the
// browser-safe decoders - is the shared agent-client contract (the backend
// integration service builds exactly this shape). Re-exported here so the settings
// surfaces and their tests keep one local import path instead of a hand-copied
// mirror that could drift from the server.
export {
  INTEGRATION_BACKENDS,
  decodeIntegrationSummary,
  decodeIntegrationSummaries,
  integrationAccountLabel,
} from "@useagent/agent-client/integrations";
export type {
  IntegrationBackend,
  IntegrationSummary,
} from "@useagent/agent-client/integrations";
