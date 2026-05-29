"use client";

import { useEffect, useId, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { cx } from "@/utils/cx";

export const DEFAULT_AGENT_PROGRESS_STEPS = [
  "Read project files",
  "Update and install light mode tokens",
  "Implement dark mode tokens",
  "Add reusable registered theme toggle",
  "Run registry, lint and production build",
] as const;

const STEP_REVEAL_STAGGER_SECONDS = 0.16;
const STEP_REVEAL_DURATION_SECONDS = 0.45;
const MODULE_EXPAND_SECONDS = 0.65;
const MODULE_REOPEN_SECONDS = 0.24;
const STEP_REOPEN_STAGGER_SECONDS = 0.035;
const DEFAULT_STEP_DURATION_MS = 3000;
const DEFAULT_COMPLETION_DELAY_MS = 1000;
const PROCESS_START_DELAY_MS =
  (MODULE_EXPAND_SECONDS + STEP_REVEAL_DURATION_SECONDS) * 1000;

const ACTIVE_BORDER_TRANSITION = {
  type: "spring" as const,
  stiffness: 260,
  damping: 30,
  mass: 0.8,
};

function ProgressLoadingText({ children, className }: { children: string; className?: string }) {
  return (
    <span
      aria-label={children}
      className={cx("agent-progress-loading-text inline-block", className)}
    >
      {children}
    </span>
  );
}

function ProgressRing({
  running,
  duration,
  size = 16,
}: {
  running: boolean;
  duration: number;
  size?: number;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className="shrink-0 -rotate-90"
    >
      <circle
        cx="8"
        cy="8"
        r="6.75"
        fill="none"
        stroke="var(--color-border-button-default)"
        strokeWidth="2.5"
      />
      <motion.circle
        data-progress-ring
        cx="8"
        cy="8"
        r="6.75"
        fill="none"
        stroke="var(--color-agent-progress-ring)"
        strokeWidth="2.5"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: running ? 1 : 0 }}
        transition={{
          duration: running ? duration : 0,
          ease: "linear",
        }}
      />
    </svg>
  );
}

function ActiveStepLoader({ running, duration }: { running: boolean; duration: number }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      className="size-3.5 shrink-0 -rotate-90"
    >
      <circle
        cx="7"
        cy="7"
        r="5.75"
        fill="none"
        stroke="var(--color-border-button-default)"
        strokeWidth="1.5"
      />
      <motion.circle
        data-step-progress
        cx="7"
        cy="7"
        r="5.75"
        fill="none"
        stroke="var(--color-agent-progress-ring)"
        strokeWidth="1.5"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: running ? 1 : 0 }}
        transition={{
          duration: running ? duration : 0,
          ease: "linear",
        }}
      />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <span aria-hidden className="relative block size-5 shrink-0">
      <span className="absolute top-px left-px size-[18px] rounded-sm bg-background-quaternary-default" />
      <span className="absolute top-[13px] left-1 h-0.5 w-3 rounded-[3px] bg-foreground-icon-secondary" />
    </span>
  );
}

function CompletedStepIcon() {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-[15px]">
      <circle cx="7" cy="7" r="7" fill="var(--color-background-quaternary-default)" />
      <path
        d="M4 7.5 5.646 9.146a.5.5 0 0 0 .708 0L10 5.5"
        fill="none"
        stroke="var(--color-foreground-icon-secondary)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PendingStepIcon() {
  return (
    <svg aria-hidden viewBox="0 0 15 15" className="size-[15px]">
      <circle
        cx="7.5"
        cy="7.5"
        r="7"
        fill="none"
        stroke="var(--color-background-quaternary-default)"
        strokeDasharray="2 2"
      />
    </svg>
  );
}

function CurrentStepIcon() {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-3.5 shrink-0">
      <path
        d="M7.47 2.47a.75.75 0 0 1 1.06 0l4.177 4.176a.5.5 0 0 1 0 .708L8.53 11.53a.75.75 0 0 1-1.06-1.06l2.72-2.72H2a.75.75 0 0 1 0-1.5h8.19L7.47 3.53a.75.75 0 0 1 0-1.06Z"
        fill="var(--color-foreground-icon-secondary)"
      />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="size-5">
      <rect
        x="1"
        y="1"
        width="18"
        height="18"
        rx="4"
        fill="var(--color-background-quaternary-default)"
      />
      <path
        d="M7.553 6.109a.75.75 0 0 1 .75-.75h5.907a.5.5 0 0 1 .5.5v5.906a.75.75 0 0 1-1.5 0V7.919l-5.79 5.791a.75.75 0 1 1-1.061-1.06l5.79-5.791H8.303a.75.75 0 0 1-.75-.75Z"
        fill="var(--color-foreground-icon-secondary)"
      />
    </svg>
  );
}

function AnimatedStatusLabel({ label, className }: { label: string; className?: string }) {
  return (
    <motion.span
      layout="position"
      transition={ACTIVE_BORDER_TRANSITION}
      className={cx("relative inline-flex min-w-0 overflow-hidden", className)}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={label}
          initial={{ opacity: 0, y: 4, filter: "blur(3px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -4, filter: "blur(3px)" }}
          transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          className="block whitespace-nowrap"
        >
          {label}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

function AnimatedStepLabel({
  label,
  complete,
  active,
}: {
  label: string;
  complete: boolean;
  active: boolean;
}) {
  return (
    <span
      className={cx(
        "relative block min-w-0 max-w-full truncate text-body-medium leading-5 transition-colors duration-300",
        complete || !active ? "text-text-secondary" : "text-text-primary",
      )}
    >
      {active ? <ProgressLoadingText>{label}</ProgressLoadingText> : label}
      <AnimatePresence>
        {complete && (
          <motion.span
            aria-hidden
            className="absolute top-1/2 right-0 left-0 h-px origin-left bg-current"
            initial={{ scaleX: 0, opacity: 0 }}
            animate={{ scaleX: 1, opacity: 0.8 }}
            exit={{ scaleX: 0, opacity: 0 }}
            transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
      </AnimatePresence>
    </span>
  );
}

function StepRow({
  label,
  index,
  completedCount,
  processingStarted,
  reopening,
  stepCount,
  stepDuration,
}: {
  label: string;
  index: number;
  completedCount: number;
  processingStarted: boolean;
  reopening: boolean;
  stepCount: number;
  stepDuration: number;
}) {
  const complete = index < completedCount;
  const active = index === completedCount && completedCount < stepCount;

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -4, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{
        delay: reopening
          ? STEP_REOPEN_STAGGER_SECONDS * index
          : MODULE_EXPAND_SECONDS + STEP_REVEAL_STAGGER_SECONDS * index,
        duration: reopening ? MODULE_REOPEN_SECONDS : STEP_REVEAL_DURATION_SECONDS,
        ease: [0.22, 1, 0.36, 1],
        layout: ACTIVE_BORDER_TRANSITION,
      }}
      className="h-8 w-full"
    >
      <motion.div
        animate={{
          paddingLeft: active ? 9 : 4,
          paddingRight: active ? 13 : 4,
        }}
        transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
        className="relative flex h-full w-full items-center gap-2 rounded-full"
      >
        {active && (
          <motion.span
            layoutId="active-step-border"
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full border border-border-button-default"
            transition={ACTIVE_BORDER_TRANSITION}
          />
        )}

        <span className="relative z-10 flex size-3.5 shrink-0 items-center justify-center">
          <AnimatePresence initial={false} mode="popLayout">
            {complete ? (
              <motion.span
                key="complete"
                initial={{ opacity: 0, scale: 0.72, rotate: -18 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
                className="absolute inset-[-0.5px]"
              >
                <CompletedStepIcon />
              </motion.span>
            ) : active ? (
              <motion.span
                key={`active-${index}`}
                initial={{ opacity: 0, scale: 0.82 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.82 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                className="absolute inset-0"
              >
                <ActiveStepLoader running={processingStarted} duration={stepDuration} />
              </motion.span>
            ) : (
              <motion.span
                key="pending"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-[-0.5px]"
              >
                <PendingStepIcon />
              </motion.span>
            )}
          </AnimatePresence>
        </span>

        <span className="relative z-10 flex min-w-0 flex-1 items-center truncate leading-5">
          <AnimatedStepLabel label={label} complete={complete} active={active} />
        </span>
      </motion.div>
    </motion.div>
  );
}

export interface AgentProgressProps {
  /** Ordered task labels. The built-in coding workflow is used by default. */
  steps?: readonly string[];
  /** Time spent on each step, in milliseconds. */
  stepDuration?: number;
  /** Time to keep the completed state visible before calling `onFinished`. */
  completionDelay?: number;
  onFinished?: () => void;
  className?: string;
}

export function AgentProgress({
  steps = DEFAULT_AGENT_PROGRESS_STEPS,
  stepDuration = DEFAULT_STEP_DURATION_MS,
  completionDelay = DEFAULT_COMPLETION_DELAY_MS,
  onFinished,
  className,
}: AgentProgressProps = {}) {
  const layoutGroupId = useId();
  const progressSteps = steps.length > 0 ? steps : DEFAULT_AGENT_PROGRESS_STEPS;
  const safeStepDuration = Math.max(0, stepDuration);
  const stepDurationSeconds = safeStepDuration / 1000;
  const totalDurationSeconds = progressSteps.length * stepDurationSeconds;
  const expandedHeight = Math.max(44, 45 + progressSteps.length * 38);
  const [completedCount, setCompletedCount] = useState(0);
  const [minimized, setMinimized] = useState(false);
  const [fastReopen, setFastReopen] = useState(false);
  const [processingStarted, setProcessingStarted] = useState(false);
  const remainingCount = progressSteps.length - completedCount;
  const currentStep = progressSteps[Math.min(completedCount, progressSteps.length - 1)];
  const complete = completedCount >= progressSteps.length;

  useEffect(() => {
    const startTimer = window.setTimeout(() => {
      setProcessingStarted(true);
    }, PROCESS_START_DELAY_MS);

    return () => window.clearTimeout(startTimer);
  }, []);

  useEffect(() => {
    if (!processingStarted || complete) return;

    const completionTimer = window.setTimeout(() => {
      setCompletedCount((count) => Math.min(count + 1, progressSteps.length));
    }, safeStepDuration);

    return () => window.clearTimeout(completionTimer);
  }, [complete, completedCount, processingStarted, progressSteps.length, safeStepDuration]);

  useEffect(() => {
    if (!complete || !onFinished) return;

    const finishedTimer = window.setTimeout(onFinished, Math.max(0, completionDelay));
    return () => window.clearTimeout(finishedTimer);
  }, [complete, completionDelay, onFinished]);

  const statusLabel = complete
    ? "All steps completed"
    : `${remainingCount} ${remainingCount === 1 ? "step" : "steps"} left`;

  return (
    <motion.div
      initial={{ opacity: 0, y: -12, height: 0, filter: "blur(8px)" }}
      animate={{
        opacity: 1,
        y: 0,
        height: minimized ? 44 : expandedHeight,
        filter: "blur(0px)",
      }}
      transition={{
        opacity: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
        y: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
        filter: { duration: 0.4, ease: [0.22, 1, 0.36, 1] },
        height: {
          duration: minimized
            ? 0.42
            : fastReopen
              ? MODULE_REOPEN_SECONDS
              : MODULE_EXPAND_SECONDS,
          ease: [0.22, 1, 0.36, 1],
        },
      }}
      onAnimationComplete={() => {
        if (!minimized) setFastReopen(false);
      }}
      className={cx(
        "relative w-[341px] max-w-full overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-xs",
        className,
      )}
      aria-live="polite"
      data-testid="agent-progress"
    >
      <AnimatePresence initial={false}>
        {!complete && (
          <motion.span
            key="persistent-progress-ring"
            className="pointer-events-none absolute top-[14px] left-[14px] z-20 flex size-4 items-center justify-center"
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.82 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <ProgressRing running={processingStarted} duration={totalDurationSeconds} />
          </motion.span>
        )}
      </AnimatePresence>

      <AnimatePresence mode="sync">
        {minimized ? (
          <motion.button
            key="minimized"
            type="button"
            data-testid="agent-progress-minimized"
            aria-label="Expand steps"
            onClick={() => {
              setFastReopen(true);
              setMinimized(false);
            }}
            initial={{ opacity: 0, filter: "blur(3px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, filter: "blur(3px)" }}
            transition={{ duration: 0.2, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
            className="group absolute inset-0 flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left"
          >
            <span className="flex min-w-0 shrink-0 items-center pl-1">
              <AnimatePresence initial={false}>
                {!complete && (
                  <motion.span
                    key="progress-ring"
                    className="flex h-4 w-6 shrink-0 items-center overflow-hidden"
                    initial={{ width: 24, opacity: 1 }}
                    animate={{ width: 24, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  />
                )}
              </AnimatePresence>
              <AnimatedStatusLabel
                label={statusLabel}
                className="text-body-medium text-text-secondary"
              />
            </span>

            {!complete && (
              <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden py-1.5 pr-6 [mask-image:linear-gradient(to_right,#000_0%,#000_100%)] transition-[mask-image] duration-300 group-hover:[mask-image:linear-gradient(to_right,#000_0%,#000_68%,transparent_94%)]">
                <CurrentStepIcon />
                <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-body-medium">
                  <ProgressLoadingText className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                    {currentStep}
                  </ProgressLoadingText>
                </span>
              </span>
            )}

            <span className="absolute top-1/2 right-2.5 size-5 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
              <ExpandIcon />
            </span>
          </motion.button>
        ) : (
          <motion.div
            key="expanded"
            data-testid="agent-progress-expanded"
            initial={{ opacity: 0, filter: "blur(3px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -4, filter: "blur(3px)" }}
            transition={{
              duration: fastReopen ? 0.16 : 0.22,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="absolute inset-x-0 top-0 px-2.5 pt-2 pb-2.5"
            style={{ height: expandedHeight }}
          >
            <div className="pt-1">
              <div className="flex h-5 w-full items-center pl-1">
                <AnimatePresence initial={false}>
                  {!complete && (
                    <motion.span
                      key="progress-ring"
                      className="flex h-4 w-6 shrink-0 items-center overflow-hidden"
                      initial={{ width: 24, opacity: 1 }}
                      animate={{ width: 24, opacity: 1 }}
                      exit={{ width: 0, opacity: 0 }}
                      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                    />
                  )}
                </AnimatePresence>
                <AnimatedStatusLabel
                  label={statusLabel}
                  className="flex-1 text-body-medium text-text-secondary"
                />
                <button
                  type="button"
                  aria-label="Minimize steps"
                  onClick={() => setMinimized(true)}
                  className="size-5 cursor-pointer rounded-sm transition-opacity duration-200 hover:opacity-80"
                >
                  <MinimizeIcon />
                </button>
              </div>

              <LayoutGroup id={layoutGroupId}>
                <div className="mt-[9px] flex flex-col gap-1.5">
                  {progressSteps.map((step, index) => (
                    <StepRow
                      key={step}
                      label={step}
                      index={index}
                      completedCount={completedCount}
                      processingStarted={processingStarted}
                      reopening={fastReopen}
                      stepCount={progressSteps.length}
                      stepDuration={stepDurationSeconds}
                    />
                  ))}
                </div>
              </LayoutGroup>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
