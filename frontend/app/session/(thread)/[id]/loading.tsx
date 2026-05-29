/**
 * Content-area skeleton while the next session's thread is fetched. Renders
 * INSIDE the persistent (thread) shell, so switching sessions keeps the
 * sidebar and chrome mounted and only this pane shimmers - a quiet
 * conversation-shaped placeholder, never a full-viewport takeover.
 */
export default function SessionLoading() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-6 p-6 motion-safe:animate-pulse" aria-label="Loading session">
      <div className="ml-auto h-9 w-2/5 rounded-2xl bg-background-secondary-default" />
      <div className="flex flex-col gap-3">
        <div className="h-4 w-40 rounded-lg bg-background-secondary-default" />
        <div className="h-4 w-3/5 rounded-lg bg-background-secondary-default" />
        <div className="h-4 w-1/2 rounded-lg bg-background-secondary-default" />
        <div className="h-24 w-4/5 rounded-xl bg-background-secondary-default" />
      </div>
      <div className="ml-auto h-9 w-1/3 rounded-2xl bg-background-secondary-default" />
      <div className="flex flex-col gap-3">
        <div className="h-4 w-48 rounded-lg bg-background-secondary-default" />
        <div className="h-4 w-2/3 rounded-lg bg-background-secondary-default" />
      </div>
      <div className="mt-auto h-24 w-full rounded-2xl border border-border-button-default bg-background-primary-default" />
    </div>
  );
}
