import { backendFetch } from "./backend-fetch";

const TRANSIENT_RUN_CREATE_STATUSES = new Set([502, 503, 504]);

export interface RunCreateAttempt {
  serializedBody: string | undefined;
  idempotencyKey: string;
}

export function selectRunCreateAttempt(
  body: unknown,
  previous: RunCreateAttempt | null,
  generateKey: () => string = () => crypto.randomUUID(),
): RunCreateAttempt {
  const serializedBody = JSON.stringify(body);
  if (previous?.serializedBody === serializedBody) return previous;
  return { serializedBody, idempotencyKey: generateKey() };
}

export async function createRun(body: unknown, idempotencyKey = crypto.randomUUID()) {
  const serializedBody = JSON.stringify(body);
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: serializedBody,
  };

  const response = await backendFetch("/api/runs", init);
  if (!TRANSIENT_RUN_CREATE_STATUSES.has(response.status)) return response;

  await response.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 100));
  return backendFetch("/api/runs", init);
}
