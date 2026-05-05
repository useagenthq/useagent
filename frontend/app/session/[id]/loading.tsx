import { LoadingState } from "@/components/chat/loading-state";

// Route-level fallback shown while the session's run is fetched on the server
// (state-family #5: the pixel-matrix `.ai-loading-pixel` LoadingState).
export default function SessionLoading() {
  return (
    <div className="bg-bg-weak-50 flex h-dvh items-center justify-center">
      <LoadingState label="Loading session" />
    </div>
  );
}
