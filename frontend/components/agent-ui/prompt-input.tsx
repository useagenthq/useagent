// Ported from beui.dev registry "prompt-input" (components/agents/prompt-input.tsx +
// the inlined Button, morph popover and select motion primitives). Re-expressed with our
// AlignUI tokens + Remixicon. A chat prompt composer: auto-growing textarea, an action
// popover, a model picker, and a send / stop button that morphs on submit.
"use client";

import {
  RiAddLine,
  RiArrowUpLine,
  RiAttachmentLine,
  RiCheckLine,
  RiCodeSSlashLine,
  RiImageAddLine,
  RiSparkling2Line,
  RiStopFill,
} from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  createContext,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;

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

function useDismiss(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, ref]);
}

// -- Button (focused to used variants/sizes) -------------------------------
type ButtonVariant = "primary" | "ghost";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-button-primary text-text-white",
  ghost: "text-text-secondary hover:text-text-primary hover:bg-background-primary-hover",
};

function Button({
  variant = "primary",
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: "icon";
  className?: string;
  children?: ReactNode;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  "aria-label"?: string;
}) {
  const reduce = useReducedMotion();
  const canHover = useHoverCapable();
  return (
    <motion.button
      whileTap={reduce ? undefined : { scale: 0.93 }}
      whileHover={reduce || !canHover ? undefined : { scale: 1.02 }}
      transition={SPRING_PRESS}
      className={cx(
        "inline-flex select-none items-center justify-center rounded-lg font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:pointer-events-none disabled:opacity-50",
        BUTTON_VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

// -- morph popover ---------------------------------------------------------
type MorphCtx = { open: boolean; setOpen: (open: boolean) => void };
const MorphContext = createContext<MorphCtx | null>(null);

function MorphPopover({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setOpen = useCallback((next: boolean) => onOpenChange(next), [onOpenChange]);
  useDismiss(open, () => setOpen(false), containerRef);
  const ctx = useMemo(() => ({ open, setOpen }), [open, setOpen]);
  return (
    <MorphContext.Provider value={ctx}>
      <div ref={containerRef} className="relative inline-flex">
        {children}
      </div>
    </MorphContext.Provider>
  );
}

function useMorph() {
  const ctx = useContext(MorphContext);
  if (!ctx) throw new Error("MorphPopover parts must be used inside <MorphPopover>");
  return ctx;
}

function MorphPopoverTrigger({ children }: { children: ReactNode }) {
  const { open, setOpen } = useMorph();
  return (
    <span onClick={() => setOpen(!open)} className="inline-flex">
      {children}
    </span>
  );
}

function MorphPopoverContent({
  sideOffset = 8,
  radius = 12,
  className,
  children,
}: {
  sideOffset?: number;
  radius?: number;
  className?: string;
  children: ReactNode;
}) {
  const { open } = useMorph();
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="menu"
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 4 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          style={{ bottom: "100%", left: 0, marginBottom: sideOffset, borderRadius: radius, transformOrigin: "bottom left" }}
          className={cx("absolute z-20 border border-border-button-default bg-background-primary-default shadow-md", className)}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// -- select ----------------------------------------------------------------
type SelectCtx = {
  value: string;
  onValueChange: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled?: boolean;
};
const SelectContext = createContext<SelectCtx | null>(null);

function Select({
  value,
  onValueChange,
  disabled,
  className,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), containerRef);
  const ctx = useMemo(
    () => ({ value, onValueChange, open, setOpen, disabled }),
    [value, onValueChange, open, disabled],
  );
  return (
    <SelectContext.Provider value={ctx}>
      <div ref={containerRef} className={cx("relative", className)}>
        {children}
      </div>
    </SelectContext.Provider>
  );
}

function useSelectCtx() {
  const ctx = useContext(SelectContext);
  if (!ctx) throw new Error("Select parts must be used inside <Select>");
  return ctx;
}

function SelectTrigger({ className, children }: { className?: string; children: ReactNode }) {
  const { open, setOpen, disabled } = useSelectCtx();
  const reduce = useReducedMotion();
  return (
    <button
      type="button"
      disabled={disabled}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => !disabled && setOpen(!open)}
      className={cx(
        "inline-flex items-center gap-1 outline-none transition-colors disabled:opacity-50 focus-visible:ring-border-focus-ring",
        className,
      )}
    >
      {children}
      <motion.span
        aria-hidden="true"
        animate={{ rotate: open ? 180 : 0 }}
        transition={reduce ? { duration: 0 } : SPRING_SWAP}
        className="grid shrink-0 place-items-center text-text-tertiary"
      >
        <ChevronGlyph />
      </motion.span>
    </button>
  );
}

// small inline chevron so the trigger stays icon-free of a heavy import in two states.
function ChevronGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SelectContent({ className, children }: { className?: string; children: ReactNode }) {
  const { open } = useSelectCtx();
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="listbox"
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 4 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          style={{ bottom: "100%", left: 0, marginBottom: 6, transformOrigin: "bottom left" }}
          className={cx(
            "absolute z-20 rounded-xl border border-border-button-default bg-background-primary-default p-1 shadow-md",
            className,
          )}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function SelectItem({
  value,
  disabled,
  className,
  children,
}: {
  value: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { value: current, onValueChange, setOpen } = useSelectCtx();
  const selected = current === value;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={() => {
        onValueChange(value);
        setOpen(false);
      }}
      className={cx(
        "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left outline-none transition-colors hover:bg-background-primary-hover focus-visible:bg-background-primary-hover disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {selected ? <RiCheckLine className="size-3.5 shrink-0 text-text-secondary" /> : null}
    </button>
  );
}

// -- PromptInput primitive -------------------------------------------------
export interface PromptModel {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptAction {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptInputProps
  extends Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "defaultValue" | "onChange" | "onSubmit" | "children"
  > {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  models?: PromptModel[];
  model?: string;
  defaultModel?: string;
  onModelChange?: (model: string) => void;
  actions?: PromptAction[];
  onAction?: (action: string) => void;
  onSubmit?: (value: string, model?: string) => void | Promise<void>;
  loading?: boolean;
  onStop?: () => void;
  minRows?: number;
  maxRows?: number;
  leadingAction?: ReactNode;
  className?: string;
}

/** Chat prompt composer: auto-growing textarea with an action popover, a model picker,
 * and a send button that morphs into a stop control while generating. */
export function PromptInputPanel({
  value,
  defaultValue = "",
  onValueChange,
  models = [],
  model,
  defaultModel,
  onModelChange,
  actions = [],
  onAction,
  onSubmit,
  loading = false,
  onStop,
  minRows = 2,
  maxRows = 8,
  leadingAction,
  className,
  disabled,
  placeholder = "Ask the agent to do something...",
  "aria-label": ariaLabel = "Prompt",
  onKeyDown,
  ...textareaProps
}: PromptInputProps) {
  const reduce = useReducedMotion() ?? false;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [internalModel, setInternalModel] = useState(defaultModel ?? models[0]?.value);
  const [actionsOpen, setActionsOpen] = useState(false);
  const currentValue = value ?? internalValue;
  const currentModelValue = model ?? internalModel ?? "";
  const currentModel = models.find((option) => option.value === currentModelValue);
  const canSubmit = Boolean(currentValue.trim()) && !disabled && !loading;

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    const measurement = measurementRef.current;
    if (!textarea || !measurement || textarea.value !== currentValue) return;
    const lineHeight = 24;
    const nextHeight = Math.min(Math.max(measurement.scrollHeight, minRows * lineHeight), maxRows * lineHeight);
    const height = `${nextHeight}px`;
    if (textarea.style.height !== height) textarea.style.height = height;
  }, [currentValue, maxRows, minRows]);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeTextarea);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  const setValue = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  };

  const setModel = (next: string) => {
    if (model === undefined) setInternalModel(next);
    onModelChange?.(next);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = currentValue.trim();
    if (!prompt || disabled || loading) return;
    onSubmit?.(prompt, currentModelValue);
    if (value === undefined) setInternalValue("");
    textareaRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      onSubmit={submit}
      className={cx(
        "relative w-full rounded-2xl border border-border-button-default bg-background-primary-default p-2 transition-colors focus-within:border-text-tertiary",
        disabled && "opacity-60",
        className,
      )}
    >
      <div
        ref={measurementRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-2 top-0 whitespace-pre-wrap px-2 text-body-2-regular leading-6 [overflow-wrap:break-word]"
      >
        {`${currentValue}​`}
      </div>
      <textarea
        ref={textareaRef}
        value={currentValue}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        rows={minRows}
        {...textareaProps}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        className="block w-full resize-none overflow-y-auto bg-transparent px-2 pt-1.5 text-body-2-regular leading-6 text-text-primary outline-none [scrollbar-width:none] placeholder:text-text-placeholder"
      />

      <div className="mt-1 flex min-h-8 items-center gap-1">
        {actions.length ? (
          <MorphPopover open={actionsOpen} onOpenChange={setActionsOpen}>
            <MorphPopoverTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || loading}
                aria-label="Add to prompt"
                className="size-8 rounded-full"
              >
                <motion.span
                  aria-hidden="true"
                  animate={{ rotate: actionsOpen ? 45 : 0 }}
                  transition={reduce ? { duration: 0 } : SPRING_SWAP}
                >
                  <RiAddLine className="size-4" />
                </motion.span>
              </Button>
            </MorphPopoverTrigger>

            <MorphPopoverContent sideOffset={8} radius={12} className="w-56 p-1.5">
              {actions.map((action) => (
                <button
                  key={action.value}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => {
                    onAction?.(action.value);
                    setActionsOpen(false);
                  }}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-background-primary-hover focus-visible:bg-background-primary-hover disabled:pointer-events-none disabled:opacity-50"
                >
                  {action.icon ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-text-tertiary [&_svg]:size-4">
                      {action.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0">
                    <span className="block text-body-2-regular text-text-primary">{action.label}</span>
                    {action.description ? (
                      <span className="mt-0.5 block text-caption-1-regular leading-4 text-text-secondary">
                        {action.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </MorphPopoverContent>
          </MorphPopover>
        ) : null}
        {leadingAction}
        {models.length ? (
          <Select value={currentModelValue} onValueChange={setModel} disabled={disabled || loading} className="min-w-0">
            <SelectTrigger className="h-8 w-auto max-w-52 rounded-xl px-2 py-0 text-caption-1-regular hover:bg-background-primary-hover focus-visible:ring-2">
              <span className="flex min-w-0 items-center gap-1.5">
                {currentModel?.icon ? (
                  <span className="grid size-4 shrink-0 place-items-center text-text-tertiary [&_svg]:size-3.5">
                    {currentModel.icon}
                  </span>
                ) : null}
                <span className="truncate text-text-secondary">{currentModel?.label ?? "Choose model"}</span>
              </span>
            </SelectTrigger>
            <SelectContent className="w-52">
              {models.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled} className="py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    {option.icon ? (
                      <span className="grid size-5 shrink-0 place-items-center text-text-tertiary [&_svg]:size-4">
                        {option.icon}
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate text-body-2-regular text-text-primary">{option.label}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Button
          type={loading ? "button" : "submit"}
          size="icon"
          disabled={loading ? !onStop : !canSubmit}
          aria-label={loading ? "Stop generating" : "Send prompt"}
          onClick={loading ? onStop : undefined}
          className="ml-auto size-8 rounded-full"
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={loading ? "stop" : "send"}
              initial={reduce ? { opacity: 1 } : { opacity: 0, y: 3, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.8 }}
              transition={reduce ? { duration: 0 } : SPRING_SWAP}
              className="grid place-items-center"
            >
              {loading ? <RiStopFill className="size-3.5" /> : <RiArrowUpLine className="size-4" />}
            </motion.span>
          </AnimatePresence>
        </Button>
      </div>
    </form>
  );
}

// -- self-driving demo -----------------------------------------------------
const MODELS: PromptModel[] = [
  { value: "sonnet", label: "Claude Sonnet", icon: <RiSparkling2Line /> },
  { value: "opus", label: "Claude Opus", icon: <RiSparkling2Line /> },
  { value: "haiku", label: "Claude Haiku", icon: <RiSparkling2Line /> },
];

const ACTIONS: PromptAction[] = [
  { value: "attach", label: "Attach files", description: "Add images or documents", icon: <RiAttachmentLine /> },
  { value: "image", label: "Add screenshot", description: "Paste from the clipboard", icon: <RiImageAddLine /> },
  { value: "code", label: "Insert code", description: "Reference a file or snippet", icon: <RiCodeSSlashLine /> },
];

const SCRIPT = "Refactor the parser and open a pull request";
const TYPE_MS = 55;
const HOLD_MS = 900;
const LOAD_MS = 1800;
const RESET_MS = 1100;

/** Self-driving demo: types a prompt, submits it, shows the stop state, then loops. */
export function PromptInputDemo() {
  const reactId = useId();
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let index = 0;

    const type = () => {
      if (index <= SCRIPT.length) {
        setValue(SCRIPT.slice(0, index));
        index += 1;
        timer = setTimeout(type, TYPE_MS);
        return;
      }
      timer = setTimeout(() => {
        setValue("");
        setLoading(true);
        timer = setTimeout(() => {
          setLoading(false);
          index = 0;
          timer = setTimeout(type, RESET_MS);
        }, LOAD_MS);
      }, HOLD_MS);
    };

    timer = setTimeout(type, RESET_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <PromptInputPanel
          key={reactId}
          value={value}
          onValueChange={setValue}
          models={MODELS}
          actions={ACTIONS}
          loading={loading}
          onStop={() => setLoading(false)}
          onSubmit={() => {
            setValue("");
            setLoading(true);
          }}
        />
      </div>
    </div>
  );
}

export default PromptInputDemo;
