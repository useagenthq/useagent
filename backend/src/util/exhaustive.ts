/**
 * Compile-time exhaustiveness guard for discriminated unions. Passing a value
 * that TypeScript cannot narrow to `never` is a build error, so adding a new
 * variant to a union forces every switch that uses this to handle it. Reaching
 * it at runtime (a value outside the declared union) throws a classified error
 * rather than silently falling through.
 */
export function assertNever(value: never, context = "unhandled variant"): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}
