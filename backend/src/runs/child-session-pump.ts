let pump: ((threadId: string) => Promise<string | null>) | null = null;

export function configureProductChildPump(value: (threadId: string) => Promise<string | null>): () => void {
  const previous = pump;
  pump = value;
  return () => { pump = previous; };
}

export async function pumpProductChildThread(threadId: string): Promise<void> {
  if (!pump) throw new Error("product child pump is not configured in this process");
  await pump(threadId);
}
