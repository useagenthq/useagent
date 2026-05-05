/** Shared Hono environment: org-scoping middleware populates these per request. */
export type AppEnv = {
  Variables: {
    orgId: string;
    userId: string | null;
  };
};
