// Ported from beui.dev registry "approval-card" (components/agents/approval-card.tsx +
// agent-disclosure, roll text-swap, and the focused Button / Checkbox / Radio / Input
// motion primitives inlined). Re-expressed with our AlignUI tokens + Remixicon. A detailed,
// multi-step approval card: a stepped question flow (single-select, multi-select, custom
// input) with a rolling title swap, progress dots, and auto-advance, plus a simple
// approve / request-changes / reject mode.
"use client";
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiChat3Line,
  RiCheckLine,
  RiCloseLine,
  RiLoader4Line,
  RiQuestionLine,
} from "@remixicon/react";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "motion/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@/utils/cn";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const EASE_OUT_CSS = "cubic-bezier(0.16, 1, 0.3, 1)";
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;
const SPRING_LAYOUT = { type: "spring", stiffness: 360, damping: 32, mass: 0.6 } as const;

function useHoverCapable() {
  const [canHover, setCanHover] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setCanHover(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return canHover;
}

// -- collapsible disclosure ------------------------------------------------
function AgentDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      aria-hidden={!open}
      inert={!open}
      initial={false}
      animate={
        reduce
          ? { opacity: open ? 1 : 0 }
          : {
              opacity: open ? 1 : 0,
              clipPath: open ? "inset(0 0 0% 0)" : "inset(0 0 100% 0)",
              y: open ? 0 : -4,
            }
      }
      transition={{ duration: reduce ? 0 : open ? 0.22 : 0.14, ease: EASE_OUT }}
      className="overflow-hidden"
      style={{ height: open ? "auto" : 0, pointerEvents: open ? undefined : "none", transformOrigin: "top" }}
    >
      {children}
    </motion.div>
  );
}

// -- rolling title swap ----------------------------------------------------
const ROLL_BLUR = "blur(3px)";
const ROLL_VARIANTS = {
  initial: { opacity: 0, y: "90%", filter: ROLL_BLUR },
  animate: { opacity: 1, y: "0%", filter: "blur(0px)", transition: SPRING_SWAP },
  exit: { opacity: 0, y: "-90%", filter: ROLL_BLUR, transition: { duration: 0.14, ease: EASE_OUT } },
} as const;

function SwapRollText({ value, children }: { value: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const measureRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    const nextWidth = measureRef.current?.offsetWidth;
    if (nextWidth) setWidth((current) => (current === nextWidth ? current : nextWidth));
  });
  return (
    <span
      className="relative inline-block overflow-hidden whitespace-normal align-bottom"
      style={{ width, transition: reduce ? undefined : `width 220ms ${EASE_OUT_CSS}` }}
    >
      <span ref={measureRef} aria-hidden className="invisible inline-block">
        {children}
      </span>
      <AnimatePresence initial={false}>
        <motion.span
          key={value}
          variants={ROLL_VARIANTS}
          initial={reduce ? false : "initial"}
          animate={reduce ? { opacity: 1, filter: "blur(0px)", y: 0 } : "animate"}
          exit={reduce ? undefined : "exit"}
          className="absolute left-0 top-0 inline-block will-change-[opacity,filter,transform]"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

// -- Button (focused to used variants / sizes) -----------------------------
type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "sm" | "icon";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary-base text-static-white hover:bg-primary-base/90",
  secondary: "border border-stroke-soft-200 bg-bg-white-0 text-text-strong-950 hover:bg-bg-weak-50",
  ghost: "text-text-sub-600 hover:text-text-strong-950 hover:bg-bg-weak-50",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-paragraph-xs gap-1.5 rounded-full",
  icon: "h-8 w-8 rounded-lg",
};

function Button({
  variant = "primary",
  size = "sm",
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  "aria-label"?: string;
}) {
  const reduce = useReducedMotion();
  const canHover = useHoverCapable();
  return (
    <motion.button
      type="button"
      whileTap={reduce ? undefined : { scale: 0.93 }}
      whileHover={reduce || !canHover ? undefined : { scale: 1.02 }}
      transition={SPRING_PRESS}
      className={cn(
        "inline-flex select-none items-center justify-center font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-stroke-strong-950 disabled:pointer-events-none disabled:opacity-50",
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

// -- Checkbox (animated draw) ----------------------------------------------
const CHECK_PATH = "M5 13l4 4L19 7";

function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  label,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const id = useId();
  const reduce = useReducedMotion();
  return (
    <label
      htmlFor={id}
      className={cn("inline-flex items-center gap-3", disabled ? "cursor-not-allowed" : "cursor-pointer", className)}
    >
      <motion.button
        id={id}
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onCheckedChange(!checked)}
        whileTap={reduce || disabled ? undefined : { scale: 0.92 }}
        transition={SPRING_PRESS}
        data-state={checked ? "checked" : "unchecked"}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-md border-2 outline-none transition-colors duration-200",
          "focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-white-0",
          "disabled:cursor-not-allowed disabled:opacity-60",
          checked
            ? "border-primary-base bg-primary-base text-static-white"
            : "border-stroke-soft-200 bg-bg-white-0 hover:border-text-soft-400",
        )}
      >
        <AnimatePresence initial={false}>
          {checked ? (
            <motion.svg
              key="checked"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.5 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5, filter: "blur(4px)" }}
              transition={reduce ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }}
              aria-hidden
            >
              <motion.path
                d={CHECK_PATH}
                initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={reduce ? { duration: 0 } : { duration: 0.3, ease: EASE_OUT, delay: 0.04 }}
              />
            </motion.svg>
          ) : null}
        </AnimatePresence>
      </motion.button>
      {label ? (
        <span className={cn("select-none text-paragraph-sm text-text-strong-950", disabled && "opacity-60")}>
          {label}
        </span>
      ) : null}
    </label>
  );
}

// -- Radio (shared-layout fill) --------------------------------------------
type RadioCtx = { value: string; setValue: (value: string) => void; layoutId: string };
const RadioContext = createContext<RadioCtx | null>(null);

function RadioGroup({
  value,
  onValueChange,
  children,
  className,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const [internal, setInternal] = useState("");
  const layoutId = useId();
  const reduce = useReducedMotion();
  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const setValue = useCallback(
    (next: string) => {
      if (!controlled) setInternal(next);
      onValueChange?.(next);
    },
    [controlled, onValueChange],
  );
  const contextValue = useMemo(() => ({ value: current, setValue, layoutId }), [current, layoutId, setValue]);
  return (
    <MotionConfig transition={reduce ? { duration: 0 } : SPRING_LAYOUT}>
      <RadioContext.Provider value={contextValue}>
        <div role="radiogroup" className={cn("flex flex-col gap-3", className)}>
          {children}
        </div>
      </RadioContext.Provider>
    </MotionConfig>
  );
}

function RadioGroupItem({
  value,
  label,
  disabled,
  className,
}: {
  value: string;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const ctx = useContext(RadioContext);
  if (!ctx) throw new Error("RadioGroupItem must be used inside <RadioGroup>");
  const { value: groupValue, setValue, layoutId } = ctx;
  const id = useId();
  const reduce = useReducedMotion();
  const selected = groupValue === value;
  return (
    <label
      htmlFor={id}
      className={cn("inline-flex items-center gap-3", disabled ? "cursor-not-allowed" : "cursor-pointer", className)}
    >
      <motion.button
        id={id}
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={() => !disabled && setValue(value)}
        whileTap={reduce || disabled ? undefined : { scale: 0.92 }}
        transition={SPRING_PRESS}
        data-state={selected ? "checked" : "unchecked"}
        className={cn(
          "relative inline-flex size-5 shrink-0 items-center justify-center rounded-full border-2 outline-none transition-colors duration-200",
          "focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-white-0",
          "disabled:cursor-not-allowed disabled:opacity-60",
          selected ? "border-primary-base" : "border-stroke-soft-200 hover:border-text-soft-400",
        )}
      >
        {selected ? (
          <motion.span
            layoutId={layoutId}
            className="absolute inset-1 rounded-full bg-primary-base"
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
          />
        ) : null}
      </motion.button>
      {label ? (
        <span className={cn("select-none text-paragraph-sm text-text-strong-950", disabled && "opacity-60")}>
          {label}
        </span>
      ) : null}
    </label>
  );
}

// -- Input (focused: focus ring, value/onChange) ---------------------------
function Input({
  value,
  onChange,
  disabled,
  placeholder,
  className,
  fieldClassName,
  inputClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  fieldClassName?: string;
  inputClassName?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div
        data-state={focused ? "focused" : "idle"}
        className={cn(
          "relative h-11 overflow-hidden rounded-full border border-stroke-soft-200 transition-colors duration-200",
          focused && "border-text-soft-400 ring-2 ring-stroke-strong-950/20",
          disabled && "opacity-60",
          fieldClassName,
        )}
      >
        <input
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={cn(
            "peer h-full w-full bg-transparent px-3.5 text-paragraph-sm leading-6 text-text-strong-950 caret-text-strong-950 outline-none placeholder:text-text-soft-400",
            disabled && "cursor-not-allowed",
            inputClassName,
          )}
        />
      </div>
    </div>
  );
}

// -- ApprovalCard primitive ------------------------------------------------
export type RichApprovalStatus =
  | "pending"
  | "submitting"
  | "approved"
  | "rejected"
  | "changes-requested"
  | "answered";

export interface RichApprovalOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface RichApprovalQuestion {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  options?: RichApprovalOption[];
  multiple?: boolean;
  autoAdvance?: boolean;
  allowCustom?: boolean;
  customPlaceholder?: string;
}

export interface RichApprovalAnswer {
  selected: string[];
  custom?: string;
}

export type RichApprovalAnswers = Record<string, RichApprovalAnswer>;

interface RichApprovalCardProps {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  questions?: RichApprovalQuestion[];
  status?: RichApprovalStatus;
  answers?: RichApprovalAnswers;
  defaultAnswers?: RichApprovalAnswers;
  onAnswersChange?: (answers: RichApprovalAnswers) => void;
  step?: number;
  defaultStep?: number;
  onStepChange?: (step: number) => void;
  onSubmit?: (answers: RichApprovalAnswers) => void;
  onApprove?: () => void;
  onReject?: () => void;
  onRequestChanges?: () => void;
  onDismiss?: () => void;
  approveLabel?: ReactNode;
  submitLabel?: ReactNode;
  result?: ReactNode;
  className?: string;
}

const EMPTY_ANSWER: RichApprovalAnswer = { selected: [], custom: "" };

function getStatusLabel(status: RichApprovalStatus) {
  if (status === "submitting") return "Submitting";
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "changes-requested") return "Changes requested";
  if (status === "answered") return "Response submitted";
  return "Input required";
}

function getStatusClass(status: RichApprovalStatus) {
  if (status === "approved" || status === "answered") return "text-success-base";
  if (status === "rejected") return "text-error-base";
  if (status === "changes-requested") return "text-warning-base";
  return "text-text-sub-600";
}

// pending/changes-requested=warning, submitting=information, approved/answered=success, rejected=error.
function getStatusBadgeClass(status: RichApprovalStatus) {
  if (status === "pending" || status === "changes-requested") {
    return "border-warning-base/30 bg-warning-base/10 text-warning-base";
  }
  if (status === "submitting") return "border-information-base/30 bg-information-base/10 text-information-base";
  if (status === "approved" || status === "answered") {
    return "border-success-base/30 bg-success-base/10 text-success-base";
  }
  return "border-error-base/30 bg-error-base/10 text-error-base";
}

function isAnswered(answer: RichApprovalAnswer) {
  return answer.selected.length > 0 || Boolean(answer.custom?.trim());
}

function QuestionOptions({
  question,
  answer,
  disabled,
  onChange,
  onSingleSelect,
}: {
  question: RichApprovalQuestion;
  answer: RichApprovalAnswer;
  disabled: boolean;
  onChange: (answer: RichApprovalAnswer) => void;
  onSingleSelect?: () => void;
}) {
  const custom = answer.custom ?? "";
  return (
    <div className="mt-3">
      {question.options?.length ? (
        question.multiple ? (
          <div className="grid gap-0.5">
            {question.options.map((option) => (
              <Checkbox
                key={option.value}
                checked={answer.selected.includes(option.value)}
                disabled={disabled || option.disabled}
                label={option.label}
                onCheckedChange={(checked) =>
                  onChange({
                    ...answer,
                    selected: checked
                      ? [...answer.selected, option.value]
                      : answer.selected.filter((value) => value !== option.value),
                  })
                }
                className="min-h-9 rounded-lg px-1.5 py-1"
              />
            ))}
          </div>
        ) : (
          <RadioGroup
            value={answer.selected[0] ?? ""}
            onValueChange={(value) => {
              onChange({ selected: [value], custom: "" });
              onSingleSelect?.();
            }}
            className="gap-0.5"
          >
            {question.options.map((option) => (
              <RadioGroupItem
                key={option.value}
                value={option.value}
                label={option.label}
                disabled={disabled || option.disabled}
                className="min-h-9 rounded-lg px-1.5 py-1"
              />
            ))}
          </RadioGroup>
        )
      ) : null}

      {question.allowCustom ? (
        <Input
          value={custom}
          disabled={disabled}
          placeholder={question.customPlaceholder ?? "Add another response..."}
          onChange={(next) => onChange({ selected: question.multiple ? answer.selected : [], custom: next })}
          className={cn("p-0.5", question.options?.length && "mt-1.5")}
          fieldClassName="h-10 rounded-xl border-0 bg-bg-weak-50 focus-within:bg-bg-white-0"
          inputClassName="px-3 text-paragraph-sm"
        />
      ) : null}
    </div>
  );
}

function ProgressDots({ current, ids }: { current: number; ids: string[] }) {
  return (
    <span className="flex gap-1.5">
      <span className="sr-only">
        Question {current + 1} of {ids.length}
      </span>
      {ids.map((id, index) => (
        <motion.span
          key={id}
          aria-hidden="true"
          initial={{ scale: index === current ? 1 : 0.75, opacity: index <= current ? 1 : 0.35 }}
          animate={{ scale: index === current ? 1 : 0.75, opacity: index <= current ? 1 : 0.35 }}
          transition={SPRING_SWAP}
          className="size-1.5 rounded-full bg-text-strong-950"
        />
      ))}
    </span>
  );
}

/** Detailed, multi-step approval card: a stepped question flow (single-select, multi-select,
 * custom input) with a rolling title swap, progress dots and auto-advance, or a simple
 * approve / request-changes / reject mode when no questions are supplied. */
export function RichApprovalCard({
  title = "Approval required",
  description,
  children,
  questions = [],
  status = "pending",
  answers,
  defaultAnswers = {},
  onAnswersChange,
  step,
  defaultStep = 0,
  onStepChange,
  onSubmit,
  onApprove,
  onReject,
  onRequestChanges,
  onDismiss,
  approveLabel = "Approve",
  submitLabel = "Submit response",
  result,
  className,
}: RichApprovalCardProps) {
  const reduce = useReducedMotion() ?? false;
  const [internalAnswers, setInternalAnswers] = useState<RichApprovalAnswers>(defaultAnswers);
  const [internalStep, setInternalStep] = useState(defaultStep);
  const autoAdvanceTimer = useRef<number | undefined>(undefined);
  const currentAnswers = answers ?? internalAnswers;
  const currentStep = Math.min(Math.max(0, step ?? internalStep), Math.max(0, questions.length - 1));
  const question = questions[currentStep];
  const questionMode = questions.length > 0;
  const pending = status === "pending";
  const busy = status === "submitting";
  const interactive = pending || busy;
  const currentAnswer = question ? (currentAnswers[question.id] ?? EMPTY_ANSWER) : EMPTY_ANSWER;
  const displayTitle = question?.title ?? title;
  const titleKey = question?.id ?? String(status);
  const statusLabel = getStatusLabel(status);

  const clearAutoAdvance = useCallback(() => {
    if (autoAdvanceTimer.current === undefined) return;
    window.clearTimeout(autoAdvanceTimer.current);
    autoAdvanceTimer.current = undefined;
  }, []);

  useEffect(() => clearAutoAdvance, [clearAutoAdvance]);

  const setAnswers = useCallback(
    (next: RichApprovalAnswers) => {
      if (answers === undefined) setInternalAnswers(next);
      onAnswersChange?.(next);
    },
    [answers, onAnswersChange],
  );

  const setStep = (next: number) => {
    clearAutoAdvance();
    if (step === undefined) setInternalStep(next);
    onStepChange?.(next);
  };

  const updateCurrentAnswer = (next: RichApprovalAnswer) => {
    if (!question) return;
    setAnswers({ ...currentAnswers, [question.id]: next });
  };

  const continueQuestion = () => {
    if (currentStep < questions.length - 1) {
      setStep(currentStep + 1);
      return;
    }
    onSubmit?.(currentAnswers);
  };

  const queueAutoAdvance = () => {
    if (!question || question.multiple || question.autoAdvance === false || currentStep >= questions.length - 1 || busy)
      return;
    clearAutoAdvance();
    autoAdvanceTimer.current = window.setTimeout(() => setStep(currentStep + 1), 240);
  };

  return (
    <div
      data-state={status}
      aria-busy={busy}
      className={cn(
        "w-full overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-4 text-paragraph-sm shadow-regular-sm",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={cn("grid size-5 shrink-0 place-items-center", getStatusClass(status))}>
          {busy ? (
            <RiLoader4Line className={cn("size-4", !reduce && "animate-spin")} />
          ) : interactive ? (
            questionMode ? (
              <RiQuestionLine className="size-4" />
            ) : (
              <RiChat3Line className="size-4" />
            )
          ) : status === "rejected" ? (
            <RiCloseLine className="size-4" />
          ) : (
            <RiCheckLine className="size-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-3">
            <h3 className="min-w-0 flex-1 text-label-sm leading-5 text-text-strong-950">
              <SwapRollText value={titleKey}>{displayTitle}</SwapRollText>
            </h3>
            {questionMode && interactive ? (
              <span className="shrink-0 text-paragraph-xs tabular-nums text-text-soft-400">
                {currentStep + 1}/{questions.length}
              </span>
            ) : (
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                  getStatusBadgeClass(status),
                )}
              >
                {statusLabel}
              </span>
            )}
            {onDismiss ? (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={onDismiss}
                className="grid size-5 shrink-0 place-items-center rounded-full text-text-sub-600 outline-none transition-colors hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
              >
                <RiCloseLine className="size-4" />
              </button>
            ) : null}
          </div>

          <AgentDisclosure open={interactive}>
            {questionMode && question ? (
              <AnimatePresence initial={false} mode="wait">
                <motion.div
                  key={question.id}
                  initial={reduce ? { opacity: 1 } : { opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, x: -6 }}
                  transition={{ duration: reduce ? 0 : 0.2, ease: EASE_OUT }}
                >
                  {question.description ? (
                    <p className="mt-1 leading-5 text-text-sub-600">{question.description}</p>
                  ) : null}
                  <QuestionOptions
                    question={question}
                    answer={currentAnswer}
                    disabled={busy}
                    onChange={updateCurrentAnswer}
                    onSingleSelect={queueAutoAdvance}
                  />
                </motion.div>
              </AnimatePresence>
            ) : (
              <div>
                {description ? <p className="mt-1 leading-5 text-text-sub-600">{description}</p> : null}
                {children ? <div className="mt-3">{children}</div> : null}
              </div>
            )}

            {questionMode ? (
              <div className="mt-4 flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous question"
                  disabled={busy || currentStep === 0}
                  onClick={() => setStep(currentStep - 1)}
                  className="rounded-full"
                >
                  <RiArrowLeftLine className="size-4" />
                </Button>
                <ProgressDots current={currentStep} ids={questions.map((item) => item.id)} />
                <Button
                  size={currentStep === questions.length - 1 ? "sm" : "icon"}
                  aria-label={currentStep === questions.length - 1 ? "Submit response" : "Next question"}
                  disabled={busy || !isAnswered(currentAnswer)}
                  onClick={continueQuestion}
                  className="ml-auto rounded-full"
                >
                  {busy ? (
                    <RiLoader4Line className={cn("size-4", !reduce && "animate-spin")} />
                  ) : currentStep === questions.length - 1 ? (
                    <>
                      {submitLabel}
                      <RiArrowRightLine className="size-3.5" />
                    </>
                  ) : (
                    <RiArrowRightLine className="size-4" />
                  )}
                </Button>
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={busy} onClick={onApprove} className="rounded-full">
                  {approveLabel}
                </Button>
                {onRequestChanges ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={onRequestChanges}
                    className="rounded-full"
                  >
                    Request changes
                  </Button>
                ) : null}
                {onReject ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={onReject}
                    className="rounded-full text-text-sub-600 hover:text-error-base"
                  >
                    Reject
                  </Button>
                ) : null}
              </div>
            )}
          </AgentDisclosure>

          {!interactive ? <p className="mt-1 text-paragraph-sm text-text-sub-600">{result ?? statusLabel}</p> : null}
        </div>
      </div>
    </div>
  );
}

// -- self-contained demo ---------------------------------------------------
const DEMO_QUESTIONS: RichApprovalQuestion[] = [
  {
    id: "rollout",
    title: "Approve deploy to production?",
    description: "The agent finished 3 tasks and is ready to ship.",
    options: [
      { value: "ship", label: "Ship it now" },
      { value: "canary", label: "Roll out to 10% first" },
      { value: "hold", label: "Hold for review" },
    ],
    autoAdvance: true,
  },
  {
    id: "checks",
    title: "Which checks must pass first?",
    multiple: true,
    options: [
      { value: "tests", label: "Unit tests" },
      { value: "e2e", label: "End-to-end suite" },
      { value: "types", label: "Type + lint" },
    ],
  },
  {
    id: "note",
    title: "Add a release note?",
    allowCustom: true,
    customPlaceholder: "Optional release note...",
    options: [{ value: "auto", label: "Generate one automatically" }],
  },
];

/** Self-driving demo: walks the stepped question flow, submits, shows the result, then loops. */
export function RichApprovalCardDemo() {
  const [status, setStatus] = useState<RichApprovalStatus>("pending");
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    if (status === "submitting") {
      const t = setTimeout(() => setStatus("answered"), 900);
      return () => clearTimeout(t);
    }
    if (status === "answered") {
      const t = setTimeout(() => {
        setStatus("pending");
        setRunId((r) => r + 1);
      }, 3200);
      return () => clearTimeout(t);
    }
  }, [status]);

  return (
    <div className="flex items-center justify-center rounded-xl bg-bg-weak-50 p-3">
      <div className="w-full max-w-md">
        <RichApprovalCard
          key={runId}
          questions={DEMO_QUESTIONS}
          status={status}
          submitLabel="Approve & deploy"
          result="Response submitted - deploying now."
          onSubmit={() => setStatus("submitting")}
        />
      </div>
    </div>
  );
}

export default RichApprovalCardDemo;
