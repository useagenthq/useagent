import { backendFetch } from "./backend-fetch";
import { taskSounds } from "./task-sounds-player";

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

async function postAcceptedCommand(path: string, body: unknown, idempotencyKey: string) {
  const serializedBody = JSON.stringify(body);
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: serializedBody,
  };

  const response = await backendFetch(path, init);
  if (!TRANSIENT_RUN_CREATE_STATUSES.has(response.status)) return response;

  await response.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 100));
  return backendFetch(path, init);
}

/** Work the person just started rings "sent" once the backend has accepted it. */
async function sounded(request: Promise<Response>): Promise<Response> {
  const response = await request;
  if (response.ok) taskSounds.moment("sent");
  return response;
}

export async function createRun(body: unknown, idempotencyKey = crypto.randomUUID()) {
  return sounded(postAcceptedCommand("/api/runs", body, idempotencyKey));
}

export async function createThreadMessage(
  threadId: string,
  body: { readonly text: string; readonly attachments?: readonly string[] },
  idempotencyKey = crypto.randomUUID(),
) {
  return sounded(
    postAcceptedCommand(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      body,
      idempotencyKey,
    ),
  );
}

export async function continueNativeChildAsSession(
  parentThreadId: string,
  executionId: string,
  title: string,
  idempotencyKey = crypto.randomUUID(),
) {
  return postAcceptedCommand(
    `/api/threads/${encodeURIComponent(parentThreadId)}/continue-native-child`,
    { executionId, title, idempotencyKey },
    idempotencyKey,
  );
}

export async function runCreateFailureMessage(
  response: Response,
  fallback = "Couldn't start the thread. Check Settings and try again.",
): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof payload?.message === "string" && payload.message.trim()
    ? payload.message.trim()
    : fallback;
}
