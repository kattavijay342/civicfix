// Hard guard for LOCAL-only verification runs (G8 onward) — the single
// source of truth for scripts/ and e2e/ (e2e/local-supabase-guard.ts
// re-exports this file).
//
// Accepts exactly the local Supabase CLI API origin — http://127.0.0.1:54321
// or http://localhost:54321 — plus the CLI's local demo keys, and rejects
// everything else, including every hosted *.supabase.co project and any
// hosted project key. Env comes only from the process environment or
// `.env.g8-local`; there is deliberately no .env.local fallback.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
export const LOCAL_ENV_FILE = ".env.g8-local";

/**
 * Returns the reason the URL is not an allowed local Supabase API URL, or null.
 * @param {string | undefined} value
 * @returns {string | null}
 */
export function localSupabaseUrlProblem(value) {
  if (!value) return `NEXT_PUBLIC_SUPABASE_URL is not set (start with --env-file=${LOCAL_ENV_FILE})`;
  if (/supabase\.(co|in|net)/i.test(value)) return `hosted Supabase URL rejected: ${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return `not a valid URL: ${value}`;
  }
  const pathOk = url.pathname === "/" || url.pathname === "";
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname) || url.port !== "54321" || !pathOk || url.search || url.username) {
    return `only http://127.0.0.1:54321 or http://localhost:54321 is allowed, got: ${value}`;
  }
  return null;
}

/**
 * Returns the reason a Supabase API key is not a LOCAL CLI key for `role`,
 * or null. Local `supabase start` keys are JWTs issued by "supabase-demo"
 * with no project `ref`; every hosted project key names its project in
 * `ref`, so a hosted key is rejected even if the URL were somehow local.
 * @param {string} name
 * @param {string | undefined} value
 * @param {"anon" | "service_role"} role
 * @returns {string | null}
 */
export function localSupabaseKeyProblem(name, value, role) {
  if (!value) return `${name} is not set (start with --env-file=${LOCAL_ENV_FILE})`;
  let claims;
  try {
    const [, payload] = value.split(".");
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return `${name} is not a local Supabase JWT`;
  }
  if (claims.ref) return `${name} belongs to a hosted Supabase project — rejected`;
  if (claims.iss !== "supabase-demo") return `${name} was not issued by the local Supabase CLI (iss=${claims.iss})`;
  if (claims.role !== role) return `${name} has role "${claims.role}", expected "${role}"`;
  return null;
}

/**
 * Every problem with the given env for a local-only run (empty = safe).
 * @param {Record<string, string | undefined>} [env]
 * @param {{ requireAnon?: boolean, requireServiceRole?: boolean }} [options]
 * @returns {string[]}
 */
export function localSupabaseEnvProblems(env = process.env, { requireAnon = true, requireServiceRole = true } = {}) {
  return [
    localSupabaseUrlProblem(env.NEXT_PUBLIC_SUPABASE_URL),
    requireAnon ? localSupabaseKeyProblem("NEXT_PUBLIC_SUPABASE_ANON_KEY", env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "anon") : null,
    requireServiceRole ? localSupabaseKeyProblem("SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY, "service_role") : null,
  ].filter(Boolean);
}

/**
 * Loads `.env.g8-local` when the URL isn't already in the environment
 * (process.loadEnvFile never overrides values that are already set, so a
 * pre-set hosted URL is still caught below), then validates URL + keys.
 * Throws on any problem — never falls back to .env.local.
 * @param {{ requireAnon?: boolean, requireServiceRole?: boolean }} [options]
 * @returns {{ url: string, anonKey: string | undefined, serviceRoleKey: string | undefined }}
 */
export function requireLocalSupabaseEnv(options) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL === undefined) {
    try {
      process.loadEnvFile(LOCAL_ENV_FILE);
    } catch {
      throw new Error(`ABORT (local-only guard): ${LOCAL_ENV_FILE} not found and NEXT_PUBLIC_SUPABASE_URL is not set`);
    }
  }
  const problems = localSupabaseEnvProblems(process.env, options);
  if (problems.length) throw new Error(`ABORT (local-only guard): ${problems.join("; ")}`);
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/**
 * Throws unless `value` is the local Supabase API URL; returns it.
 * @param {string | undefined} [value]
 * @returns {string}
 */
export function assertLocalSupabaseUrl(value = process.env.NEXT_PUBLIC_SUPABASE_URL) {
  const problem = localSupabaseUrlProblem(value);
  if (problem) throw new Error(`ABORT (local-only guard): ${problem}`);
  return value;
}

/**
 * Scripts: exits (code 2) unless NEXT_PUBLIC_SUPABASE_URL is local; returns it.
 * @param {string | undefined} [value]
 * @returns {string}
 */
export function assertLocalSupabase(value = process.env.NEXT_PUBLIC_SUPABASE_URL) {
  try {
    return assertLocalSupabaseUrl(value);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}

/**
 * Scripts: exits (code 2) unless URL and keys are all local; returns them.
 * @param {{ requireAnon?: boolean, requireServiceRole?: boolean }} [options]
 */
export function exitUnlessLocalSupabaseEnv(options) {
  try {
    return requireLocalSupabaseEnv(options);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
