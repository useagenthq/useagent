export function FailedNote() {
  return (
    <p className="text-body-2-regular text-text-error-primary">
      This run failed before producing a summary.
    </p>
  );
}

export function CaptureDegradedNote() {
  return (
    <p className="text-text-tertiary text-caption-1-regular" data-capture-degraded="">
      Part of this run's activity was not recorded. What is shown is complete as saved.
    </p>
  );
}
