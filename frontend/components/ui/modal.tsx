// AlignUI Modal v0.0.0

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { RiCloseLine, type RemixiconComponentType } from '@remixicon/react';

import { cnExt } from '@/utils/cn';
import * as CompactButton from '@/components/ui/compact-button';

const ModalRoot = DialogPrimitive.Root;
const ModalTrigger = DialogPrimitive.Trigger;
const ModalClose = DialogPrimitive.Close;
const ModalPortal = DialogPrimitive.Portal;

const ModalOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...rest }, forwardedRef) => {
  return (
    <DialogPrimitive.Overlay
      ref={forwardedRef}
      className={cnExt(
        // base
        'fixed inset-0 z-50 flex flex-col items-center justify-center overflow-y-auto bg-overlay p-4 backdrop-blur-[10px]',
        // animation
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...rest}
    />
  );
});
ModalOverlay.displayName = 'ModalOverlay';

const ModalContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    overlayClassName?: string;
    showClose?: boolean;
  }
>(
  (
    { className, overlayClassName, children, showClose = true, ...rest },
    forwardedRef,
  ) => {
    return (
      <ModalPortal>
        <ModalOverlay className={overlayClassName}>
          <DialogPrimitive.Content
            ref={forwardedRef}
            className={cnExt(
              // base
              'relative w-full max-w-[400px]',
              'rounded-20 bg-bg-white-0 shadow-regular-md',
              // focus
              'focus:outline-none',
              // animation
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
              'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
              className,
            )}
            {...rest}
          >
            {children}
            {showClose && (
              <ModalClose asChild>
                <CompactButton.Root
                  variant='ghost'
                  size='large'
                  className='absolute right-4 top-4'
                >
                  <CompactButton.Icon as={RiCloseLine} />
                </CompactButton.Root>
              </ModalClose>
            )}
          </DialogPrimitive.Content>
        </ModalOverlay>
      </ModalPortal>
    );
  },
);
ModalContent.displayName = 'ModalContent';

function ModalHeader({
  className,
  children,
  icon: Icon,
  title,
  description,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  icon?: RemixiconComponentType;
  title?: string;
  description?: string;
}) {
  return (
    <div
      className={cnExt(
        'relative flex items-start gap-3.5 py-4 pl-5 pr-14 before:absolute before:inset-x-0 before:bottom-0 before:border-b before:border-stroke-soft-200',
        className,
      )}
      {...rest}
    >
      {children || (
        <>
          {Icon && (
            <div className='flex size-10 shrink-0 items-center justify-center rounded-full bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200'>
              <Icon className='size-5 text-text-sub-600' />
            </div>
          )}
          {(title || description) && (
            <div className='flex-1 space-y-1'>
              {title && <ModalTitle>{title}</ModalTitle>}
              {description && (
                <ModalDescription>{description}</ModalDescription>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
ModalHeader.displayName = 'ModalHeader';

const ModalTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...rest }, forwardedRef) => {
  return (
    <DialogPrimitive.Title
      ref={forwardedRef}
      className={cnExt('text-label-sm text-text-strong-950', className)}
      {...rest}
    />
  );
});
ModalTitle.displayName = 'ModalTitle';

const ModalDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...rest }, forwardedRef) => {
  return (
    <DialogPrimitive.Description
      ref={forwardedRef}
      className={cnExt('text-paragraph-xs text-text-sub-600', className)}
      {...rest}
    />
  );
});
ModalDescription.displayName = 'ModalDescription';

function ModalBody({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cnExt('p-5', className)} {...rest} />;
}
ModalBody.displayName = 'ModalBody';

function ModalFooter({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cnExt(
        'flex items-center justify-between gap-3 border-t border-stroke-soft-200 px-5 py-4',
        className,
      )}
      {...rest}
    />
  );
}

ModalFooter.displayName = 'ModalFooter';

export {
  ModalRoot as Root,
  ModalTrigger as Trigger,
  ModalClose as Close,
  ModalPortal as Portal,
  ModalOverlay as Overlay,
  ModalContent as Content,
  ModalHeader as Header,
  ModalTitle as Title,
  ModalDescription as Description,
  ModalBody as Body,
  ModalFooter as Footer,
};
