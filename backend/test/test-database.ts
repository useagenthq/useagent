/**
 * The one place the unit suite decides which database it owns. `prepare-db.ts`
 * (DROP + CREATE before `bun test`) and `preload.ts` (DATABASE_URL for every app
 * module) both read it, so the database that gets reset is always the database
 * the suite then runs against. Honouring TEST_DATABASE_URL here is what lets two
 * people share one Postgres server without one suite dropping the other's data.
 */
export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres@localhost:5432/useagent_test";

export function testDatabaseUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL;
}

/** The database name from the URL path. It is interpolated into DROP/CREATE
 *  DATABASE, so anything but a plain identifier is refused up front. */
export function testDatabaseName(url: string): string {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: "${url}"`);
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(name)) {
    throw new Error(`TEST_DATABASE_URL must name a plain database identifier, got "${name}"`);
  }
  return name;
}
