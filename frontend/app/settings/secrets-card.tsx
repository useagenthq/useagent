import { SecretsManager } from "@/app/secrets/secrets-manager";

/**
 * Settings > Secrets section. Renders the real, backend-wired secrets manager
 * (the same component the /secrets page uses) so there is ONE implementation and
 * no mock persistence. With no SSR seed it self-fetches on mount.
 */
export function SecretsCard() {
  return <SecretsManager />;
}
