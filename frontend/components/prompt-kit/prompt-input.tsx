"use client";

// Vendored from prompt-kit (prompt-kit.com/c/prompt-input.json), adapted to the
// BoardUI foundation (semantic tokens from styles/theme.css). Two adaptations
// from the shadcn original:
//   - the shadcn textarea dep is replaced with a plain autosizing
//     <textarea> (a design-system Textarea ships its own bordered container we
//     don't want inside the composer card);
//   - the shadcn tooltip dep is dropped - `PromptInputAction` renders
//     its child directly (the composer's controls are self-describing). The
//     `tooltip` prop is kept optional so the call-shape stays source-compatible.

import { cx as cn } from "@/utils/cx";
import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type PromptInputContextType = {
  isLoading: boolean;
  value: string;
  setValue: (value: string) => void;
  maxHeight: number | string;
  onSubmit?: () => void;
  disabled?: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
};

const PromptInputContext = createContext<PromptInputContextType>({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
  textareaRef: React.createRef<HTMLTextAreaElement>(),
});

function usePromptInput() {
  return useContext(PromptInputContext);
}

export type PromptInputProps = {
  isLoading?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  maxHeight?: number | string;
  onSubmit?: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
} & Omit<React.ComponentProps<"fieldset">, "disabled">;

function PromptInput({
  className,
  isLoading = false,
  maxHeight = 240,
  value,
  onValueChange,
  onSubmit,
  children,
  disabled = false,
  onPointerDown,
  ...props
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleChange = (newValue: string) => {
    setInternalValue(newValue);
    onValueChange?.(newValue);
  };

  const handlePointerDown: React.PointerEventHandler<HTMLFieldSetElement> = (event) => {
    const target = event.target;
    const interactive = target instanceof Element
      ? target.closest("button, input, select, textarea, a, [role='button'], [role='menuitem']")
      : null;
    if (!disabled && !interactive) textareaRef.current?.focus();
    onPointerDown?.(event);
  };

  return (
    <PromptInputContext.Provider
      value={{
        isLoading,
        value: value ?? internalValue,
        setValue: onValueChange ?? handleChange,
        maxHeight,
        onSubmit,
        disabled,
        textareaRef,
      }}
    >
      <fieldset
        disabled={disabled}
        onPointerDown={handlePointerDown}
        className={cn(
          "border-border-button-default bg-background-primary-default min-w-0 cursor-text rounded-2xl border p-2 shadow-card",
          disabled && "cursor-not-allowed opacity-60",
          className,
        )}
        {...props}
      >
        {children}
      </fieldset>
    </PromptInputContext.Provider>
  );
}

export type PromptInputTextareaProps = {
  disableAutosize?: boolean;
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>;

function PromptInputTextarea({
  className,
  onKeyDown,
  disableAutosize = false,
  ...props
}: PromptInputTextareaProps) {
  const { value, setValue, maxHeight, onSubmit, disabled, textareaRef } =
    usePromptInput();

  const adjustHeight = (el: HTMLTextAreaElement | null) => {
    if (!el || disableAutosize) return;
    // Collapse before measuring. `height: auto` can inherit a transiently
    // stretched grid/flex track while the session rail is booting, turning the
    // textarea's used height into its next scrollHeight and freezing a tall
    // empty composer until another state change remeasures it.
    el.style.height = "0px";
    if (typeof maxHeight === "number") {
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    } else {
      el.style.height = `min(${el.scrollHeight}px, ${maxHeight})`;
    }
  };

  const handleRef = (el: HTMLTextAreaElement | null) => {
    textareaRef.current = el;
    adjustHeight(el);
  };

  useLayoutEffect(() => {
    if (!textareaRef.current || disableAutosize) return;
    adjustHeight(textareaRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, maxHeight, disableAutosize]);

  // The measured height goes stale whenever the textarea's width changes
  // under it (a rail drag, the sidebar folding, a window resize, a pane that
  // was display:none at first measure): the wrapped line count changes but
  // nothing above re-runs the value effect, so an empty composer can sit at
  // a tall frozen height until the next keystroke. Re-measure on every size
  // change of the element itself.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || disableAutosize || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.contentRect.width ?? lastWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      adjustHeight(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disableAutosize, maxHeight]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    adjustHeight(e.target);
    setValue(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Caller first: an autocomplete popover (slash commands) must be able to
    // claim Enter/arrows via preventDefault before Enter submits the prompt.
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    // IME composition guard: while composing (e.g. selecting a CJK candidate),
    // Enter confirms the candidate — it must not submit the prompt.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit?.();
    }
  };

  return (
    <textarea
      ref={handleRef}
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      className={cn(
        "text-text-primary placeholder:text-text-tertiary min-h-[44px] w-full resize-none border-none bg-transparent shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
        className,
      )}
      rows={1}
      disabled={disabled}
      {...props}
    />
  );
}

export type PromptInputActionsProps = React.HTMLAttributes<HTMLDivElement>;

function PromptInputActions({
  children,
  className,
  ...props
}: PromptInputActionsProps) {
  return (
    <div className={cn("flex items-center gap-2", className)} {...props}>
      {children}
    </div>
  );
}

export type PromptInputActionProps = {
  className?: string;
  tooltip?: React.ReactNode;
  children: React.ReactNode;
};

// Tooltip-free adaptation: renders the child directly. `tooltip` is accepted
// (and applied as a native title when it's a string) to stay source-compatible
// with prompt-kit call sites.
function PromptInputAction({ tooltip, children }: PromptInputActionProps) {
  if (typeof tooltip === "string") {
    return <span title={tooltip}>{children}</span>;
  }
  return <>{children}</>;
}

export {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputAction,
};
