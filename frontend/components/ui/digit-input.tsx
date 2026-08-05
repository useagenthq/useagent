// AlignUI DigitInput v0.0.0

import * as React from 'react';
import OtpInput, { OTPInputProps } from 'react-otp-input';

import { cnExt } from '@/utils/cn';

type OtpOptions = Omit<OTPInputProps, 'renderInput'>;

type DigitInputProps = {
  className?: string;
  disabled?: boolean;
  hasError?: boolean;
} & OtpOptions;

function DigitInput({
  className,
  disabled,
  hasError,
  ...rest
}: DigitInputProps) {
  return (
    <OtpInput
      containerStyle={cnExt('flex w-full items-center gap-2.5', className)}
      skipDefaultStyles
      renderInput={(inputProps) => (
        <DigitInputSlot
          disabled={disabled}
          hasError={hasError}
          {...inputProps}
        />
      )}
      {...rest}
    />
  );
}
DigitInput.displayName = 'DigitInput';

const DigitInputSlot = React.forwardRef<
  React.ComponentRef<'input'>,
  React.ComponentPropsWithoutRef<'input'> & {
    hasError?: boolean;
  }
>(({ className, hasError, ...rest }, forwardedRef) => {
  return (
    <input
      ref={forwardedRef}
      className={cnExt(
        'h-16 w-full min-w-0 rounded-10 bg-bg-white-0 text-center text-title-h5 text-text-strong-950 shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200',
        'transition duration-200 ease-out',
        // hover
        'hover:bg-bg-weak-50 hover:shadow-none hover:ring-transparent',
        // focus
        'focus:shadow-button-important-focus focus:outline-none focus:ring-stroke-strong-950',
        // selection
        'selection:bg-none',
        // disabled
        'disabled:bg-bg-weak-50 disabled:text-text-disabled-300 disabled:shadow-none disabled:ring-transparent',
        {
          'ring-error-base hover:ring-error-base focus:ring-error-base focus:shadow-button-error-focus':
            hasError,
        },
        className,
      )}
      {...rest}
    />
  );
});
DigitInputSlot.displayName = 'DigitInputSlot';

export { DigitInput as Root };
