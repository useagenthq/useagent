// Pure SSE connection controller for the thread stream — the reconnect / health /
// fallback-poll state machine, extracted from the React hook so it is deterministic
// and unit-testable with a fake EventSource + fake timers (Codex review finding 3;
// there is no React hook renderer in this repo).
//
// Guarantees:
//  - at most ONE EventSource, ONE reconnect timer, ONE health timer, ONE poll timer
//    at any moment;
//  - the failure counter resets ONLY after a real health condition (a snapshot frame
//    arrives, OR the socket stays open for `healthyMs`) — NOT merely on `onopen`, so
//    an open-then-immediately-die loop still reaches the fallback poll;
//  - a constructor throw still schedules an SSE retry (not just polling);
//  - a healthy recovery stops the poll immediately (SSE and poll never both run);
//  - `stop()` cancels the source and every timer.

export interface EventSourceLike {
  addEventListener(type: string, listener: (e: { data: string }) => void): void;
  close(): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
}

export interface TimerHost {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (t: unknown) => void;
}

export interface ThreadConnectionOptions {
  url: string;
  /** Frame `event:` names to subscribe to. */
  frameTypes: readonly string[];
  /** The frame whose arrival proves the connection is healthy (resets failures). */
  healthFrame: string;
  /** Construct an EventSource (may throw — the controller recovers). */
  createEventSource: (url: string) => EventSourceLike;
  /** Deliver a raw frame (event name + data string) to the consumer. */
  onFrame: (event: string, data: string) => void;
  /** One fallback-poll tick (fetch the thread + merge). Errors must be swallowed. */
  poll: () => void;
  timers: TimerHost;
  maxAttempts?: number;
  healthyMs?: number;
  pollMs?: number;
  /** Backoff for the Nth consecutive failure (ms). */
  backoff?: (attempts: number) => number;
}

export interface ThreadConnection {
  start(): void;
  stop(): void;
  /** Test/introspection: whether the fallback poll is currently active. */
  isPolling(): boolean;
}

export function createThreadConnection(opts: ThreadConnectionOptions): ThreadConnection {
  const maxAttempts = opts.maxAttempts ?? 5;
  const healthyMs = opts.healthyMs ?? 3000;
  const pollMs = opts.pollMs ?? 5000;
  const backoff = opts.backoff ?? ((n: number) => Math.min(1000 * n, 5000));
  const { timers } = opts;

  let source: EventSourceLike | null = null;
  let reconnectTimer: unknown = null;
  let healthTimer: unknown = null;
  let pollTimer: unknown = null;
  let attempts = 0;
  let stopped = false;
  // Bumped on every (re)connect and on stop(). Each EventSource's callbacks capture their
  // generation and no-op if it is stale, so a REPLACED source that fires late (a buffered
  // frame, or an onopen/onerror after close()) can never mutate the current connection's
  // state. addEventListener listeners cannot be detached via EventSourceLike, so this guard
  // is the only thing protecting the current connection from a stale source's frames.
  let generation = 0;

  const clearReconnect = (): void => {
    if (reconnectTimer !== null) { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  const clearHealth = (): void => {
    if (healthTimer !== null) { timers.clearTimeout(healthTimer); healthTimer = null; }
  };
  const stopPolling = (): void => {
    if (pollTimer !== null) { timers.clearInterval(pollTimer); pollTimer = null; }
  };
  const startPolling = (): void => {
    if (pollTimer !== null || stopped) return;
    pollTimer = timers.setInterval(() => opts.poll(), pollMs);
  };
  const closeSource = (): void => {
    if (source) {
      // Detach onopen/onerror before close() so a synchronous close-driven callback on the
      // old source cannot run (the addEventListener frames are covered by the generation
      // guard, which cannot be detached).
      source.onopen = null;
      source.onerror = null;
      try { source.close(); } catch { /* ignore */ }
      source = null;
    }
  };

  // A real health condition: reset the failure counter and stop any fallback poll,
  // so SSE and polling never both run.
  const markHealthy = (): void => {
    attempts = 0;
    clearHealth();
    stopPolling();
  };

  const scheduleReconnect = (): void => {
    clearReconnect();
    if (stopped) return;
    reconnectTimer = timers.setTimeout(connect, backoff(attempts));
  };

  const onFailure = (): void => {
    if (stopped) return;
    clearHealth();
    closeSource();
    attempts += 1;
    if (attempts >= maxAttempts) startPolling(); // fallback engaged after bounded failures
    scheduleReconnect(); // keep probing SSE regardless, so a recovery stops the poll
  };

  function connect(): void {
    if (stopped) return;
    clearReconnect();
    closeSource();
    const gen = ++generation; // this connection's generation; captured by its callbacks
    // A callback is stale if the controller stopped OR a newer connection replaced this
    // source. A stale source's frames/onopen/onerror must NOT touch current state.
    const isStale = (): boolean => stopped || gen !== generation;
    let es: EventSourceLike;
    try {
      es = opts.createEventSource(opts.url);
    } catch {
      onFailure(); // constructor threw — still schedule an SSE retry (not just polling)
      return;
    }
    source = es;
    for (const type of opts.frameTypes) {
      es.addEventListener(type, (e) => {
        if (isStale()) return;
        if (type === opts.healthFrame) markHealthy();
        opts.onFrame(type, e.data);
      });
    }
    es.onopen = () => {
      // Do NOT reset failures here: an accepted-then-dropped socket must still count
      // toward the fallback. Health is only reached if it STAYS open for healthyMs
      // (or a snapshot frame arrives first, which calls markHealthy above).
      if (isStale()) return;
      clearHealth();
      healthTimer = timers.setTimeout(markHealthy, healthyMs);
    };
    es.onerror = () => {
      if (isStale()) return;
      onFailure();
    };
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      clearReconnect();
      clearHealth();
      stopPolling();
      closeSource();
    },
    isPolling() {
      return pollTimer !== null;
    },
  };
}
