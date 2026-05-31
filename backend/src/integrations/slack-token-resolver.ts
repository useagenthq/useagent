import type { SlackConfig } from "../env";
import { findConnectedOrgIntegrationRecord } from "./connection-repo";
import { readSlackCredential, SLACK_NATIVE_RUNTIME_BINDING_ID } from "./slack-native-backend";

interface SlackTokenResolverDependencies {
  readonly findConnection?: typeof findConnectedOrgIntegrationRecord;
  readonly readCredential?: typeof readSlackCredential;
}

export async function resolveSlackBotTokenForWorkspace(
  input: {
    readonly orgId: string;
    readonly teamId: string;
    readonly config: SlackConfig;
  },
  dependencies: SlackTokenResolverDependencies = {},
): Promise<string | null> {
  const findConnection = dependencies.findConnection ?? findConnectedOrgIntegrationRecord;
  const readCredential = dependencies.readCredential ?? readSlackCredential;
  const connection = await findConnection({
    orgId: input.orgId,
    provider: "slack",
    runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
    externalConnectionId: input.teamId,
  });
  if (connection) {
    const credential = await readCredential(connection);
    if (!credential) return null;
    return credential.bot.accessToken;
  }
  return input.config.legacyTeamId === input.teamId
    ? input.config.legacyBotToken
    : null;
}
