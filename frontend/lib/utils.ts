import { cx } from "@/utils/cx";

// The vendored sidebar primitives (components/sidebar-kit) accept the Base UI
// className shape, a string or a function of component state. `cn` merges
// classes with the product's cx and keeps the function form working.
type Plain = string | null | undefined | false;

export function cn(...inputs: Plain[]): string;
export function cn<State>(
  ...inputs: Array<Plain | ((state: State) => string | undefined)>
): string | ((state: State) => string);
export function cn(
  ...inputs: Array<Plain | ((state: never) => string | undefined)>
): string | ((state: never) => string) {
  if (inputs.some((input) => typeof input === "function")) {
    return (state: never) =>
      cx(...inputs.map((input) => (typeof input === "function" ? input(state) : input)));
  }
  return cx(...(inputs as Plain[]));
}
