export function awaitRuntimeOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  cleanup: () => Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    void cleanup().catch(() => {});
    void operation.then(
      () => cleanup().catch(() => {}),
      () => cleanup().catch(() => {}),
    );
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void cleanup().catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) {
          void cleanup().catch(() => {});
          return;
        }
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) {
          void cleanup().catch(() => {});
          return;
        }
        reject(error);
      },
    );
  });
}
