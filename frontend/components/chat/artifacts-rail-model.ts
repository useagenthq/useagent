export function artifactQueryForThread(threadId: string): string {
  return `/api/artifacts?thread_id=${encodeURIComponent(threadId)}`;
}
