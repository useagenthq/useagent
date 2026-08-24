/** Shared Hono environment: org-scoping middleware populates these per request. */
export type AppEnv = {
  Variables: {
    orgId: string;
    userId: string | null;
    // Set only by the API-key bearer lane (src/middleware/bearer.ts). Session
    // requests leave it undefined. Management routes assert it is NOT set so a
    // bearer key can never mint or revoke keys.
    bearerAuthenticated?: boolean;
  };
};
