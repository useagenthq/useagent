import type { ChipProps } from "@/components/base/badges/chip";
import { Label } from "@/components/base/input/label";
import type { ChipColor } from "@/app/knowledge/knowledge-data";

/**
 * Shared BoardUI recipes used across the skills / playbooks / knowledge pages.
 * One source: the page redesigns each needed the same tag-palette mapping and
 * textarea treatment, and per-page copies drift.
 */

/** Legacy tag palette (knowledge ChipColor) mapped onto the base Chip colors. */
export const CHIP_COLOR: Record<ChipColor, NonNullable<ChipProps["color"]>> = {
  gray: "gray",
  blue: "blue",
  orange: "yellow",
  red: "rose",
  green: "lime",
  yellow: "yellow",
  purple: "purple",
  sky: "cyan",
  pink: "rose",
  teal: "cyan",
};

/** BoardUI-styled multiline field (input.tsx recipe adapted to a textarea). */
export const TEXTAREA_FIELD =
  "w-full resize-y rounded-2lg bg-background-tertiary-default p-2 pl-3 font-sans text-body-regular text-text-primary outline-none ring-2 ring-inset ring-transparent transition-[box-shadow] placeholder:text-text-tertiary hover:ring-border-button-hover focus:ring-border-button-active disabled:cursor-not-allowed disabled:opacity-60";

/** Labeled section textarea used by the skill and playbook editors. */
export function SectionTextarea({
  id,
  label,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        rows={3}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={TEXTAREA_FIELD}
      />
    </div>
  );
}
