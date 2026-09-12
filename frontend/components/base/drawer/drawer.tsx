"use client";

/**
 * Right-side drawer / sheet primitive.
 *
 * Compound API (Root/Trigger/Close/Content/Header/Title/Body/Footer) built on
 * @radix-ui/react-dialog for focus-trap, Esc-to-close, scroll-lock and backdrop
 * dismiss. Slides in from the right; callers own the open state (Root
 * open/onOpenChange) and focus returns to whatever opened the drawer on
 * close. BoardUI tokens; callers restyle via className.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cx } from "@/utils/cx";
import { CloseButton } from "@/components/base/buttons/close-button";
import { OverlayPortalContainerContext, escapeBelongsToNestedOverlay } from "@/components/base/overlay-portal-container";
import { useFocusReturn } from "@/components/base/modal/focus-return";

const DrawerRoot = DialogPrimitive.Root;
const DrawerTrigger = DialogPrimitive.Trigger;
const DrawerClose = DialogPrimitive.Close;
const DrawerPortal = DialogPrimitive.Portal;

const DrawerOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...rest }, forwardedRef) => {
  return (
    <DialogPrimitive.Overlay
      ref={forwardedRef}
      className={cx(
        // base
        "fixed inset-0 z-50 grid grid-cols-1 place-items-end overflow-hidden bg-black/50 backdrop-blur-[10px]",
        // animation
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...rest}
    />
  );
});
DrawerOverlay.displayName = "DrawerOverlay";

const DrawerContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, ...rest }, forwardedRef) => {
  const focusReturn = useFocusReturn();
  // Popovers opened from inside the drawer portal into its content, so the
  // focus trap and pointer-events lock do not shut them out.
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const handleEscape = (event: KeyboardEvent) => {
    onEscapeKeyDown?.(event);
    if (escapeBelongsToNestedOverlay(event.target, container)) event.preventDefault();
  };
  const setRefs = (node: HTMLDivElement | null) => {
    setContainer(node);
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };
  return (
    <DrawerPortal>
      <DrawerOverlay>
        <DialogPrimitive.Content
          ref={setRefs}
          onOpenAutoFocus={(event) => {
            onOpenAutoFocus?.(event);
            focusReturn.onOpenAutoFocus();
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (!event.defaultPrevented) focusReturn.onCloseAutoFocus(event);
          }}
          className={cx(
            // base
            "size-full max-w-[400px] overflow-y-auto",
            "border-l border-border-button-default bg-background-primary-default",
            // animation
            "data-[state=open]:duration-200 data-[state=open]:ease-out data-[state=open]:animate-in",
            "data-[state=closed]:duration-200 data-[state=closed]:ease-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-right-full",
            "data-[state=closed]:slide-out-to-right-full",
            className,
          )}
          onEscapeKeyDown={handleEscape}
          {...rest}
        >
          <OverlayPortalContainerContext.Provider value={container}>
            <div className="relative flex size-full flex-col">{children}</div>
          </OverlayPortalContainerContext.Provider>
        </DialogPrimitive.Content>
      </DrawerOverlay>
    </DrawerPortal>
  );
});
DrawerContent.displayName = "DrawerContent";

function DrawerHeader({
  className,
  children,
  showCloseButton = true,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      className={cx("flex items-center gap-3 border-border-button-default p-5", className)}
      {...rest}
    >
      {children}

      {showCloseButton && (
        <DrawerClose asChild>
          <CloseButton aria-label="Close" size="md" />
        </DrawerClose>
      )}
    </div>
  );
}
DrawerHeader.displayName = "DrawerHeader";

const DrawerTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...rest }, forwardedRef) => {
  return (
    <DialogPrimitive.Title
      ref={forwardedRef}
      className={cx("flex-1 text-label-lg text-text-primary", className)}
      {...rest}
    />
  );
});
DrawerTitle.displayName = "DrawerTitle";

function DrawerBody({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("flex-1", className)} {...rest}>
      {children}
    </div>
  );
}
DrawerBody.displayName = "DrawerBody";

function DrawerFooter({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("flex items-center gap-4 border-border-button-default p-5", className)}
      {...rest}
    />
  );
}
DrawerFooter.displayName = "DrawerFooter";

export {
  DrawerRoot as Root,
  DrawerTrigger as Trigger,
  DrawerClose as Close,
  DrawerContent as Content,
  DrawerHeader as Header,
  DrawerTitle as Title,
  DrawerBody as Body,
  DrawerFooter as Footer,
};
