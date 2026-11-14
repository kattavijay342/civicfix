import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  localSupabaseEnvProblems,
  localSupabaseKeyProblem,
  localSupabaseUrlProblem,
  requireLocalSupabaseEnv,
} from "../../scripts/lib/local-supabase-guard.mjs";

/**
 * Offline tests for the LOCAL-Supabase-only guard shared by the G8 scripts,
 * every G1–G8 E2E spec and playwright.config.ts. No network, no database.
 */
const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const LOCAL_ANON = jwt({ iss: "supabase-demo", role: "anon", exp: 1983812996 });
const LOCAL_SERVICE = jwt({ iss: "supabase-demo", role: "service_role", exp: 1983812996 });
const HOSTED_SERVICE = jwt({ iss: "supabase", ref: "abcdefghijklmnopqrst", role: "service_role", exp: 1983812996 });

describe("localSupabaseUrlProblem", () => {
  it.each(["http://127.0.0.1:54321", "http://localhost:54321", "http://127.0.0.1:54321/"])("allows %s", (url) => {
    expect(localSupabaseUrlProblem(url)).toBeNull();
  });

  it.each([
    ["https://abcdefghijklmnop.supabase.co", /hosted Supabase URL rejected/],
    ["http://abcdefghijklmnop.supabase.co", /hosted Supabase URL rejected/],
    ["http://localhost:54322", /only http:\/\/127\.0\.0\.1:54321/],
    ["https://localhost:54321", /only http:\/\/127\.0\.0\.1:54321/],
    ["http://10.0.0.5:54321", /only http:\/\/127\.0\.0\.1:54321/],
    ["http://localhost:54321/rest/v1", /only http:\/\/127\.0\.0\.1:54321/],
    ["http://localhost:54321?x=1", /only http:\/\/127\.0\.0\.1:54321/],
    ["http://user@localhost:54321", /only http:\/\/127\.0\.0\.1:54321/],
    ["http://127.0.0.1:54321.evil.com", /not a valid URL|only http/],
    ["http://localhost", /only http:\/\/127\.0\.0\.1:54321/],
    ["", /is not set/],
    [undefined, /is not set/],
  ])("rejects %s", (url, reason) => {
    expect(localSupabaseUrlProblem(url)).toMatch(reason);
  });
});

describe("localSupabaseKeyProblem", () => {
  it("accepts the local CLI demo keys for their own role", () => {
    expect(localSupabaseKeyProblem("anon", LOCAL_ANON, "anon")).toBeNull();
    expect(localSupabaseKeyProblem("service", LOCAL_SERVICE, "service_role")).toBeNull();
  });
  it("rejects a hosted project key (has a project ref)", () => {
    expect(localSupabaseKeyProblem("service", HOSTED_SERVICE, "service_role")).toMatch(/hosted Supabase project/);
  });
  it("rejects missing, malformed, wrong-issuer and wrong-role keys", () => {
    expect(localSupabaseKeyProblem("k", undefined, "anon")).toMatch(/is not set/);
    expect(localSupabaseKeyProblem("k", "", "anon")).toMatch(/is not set/);
    expect(localSupabaseKeyProblem("k", "not-a-jwt", "anon")).toMatch(/not a local Supabase JWT/);
    expect(localSupabaseKeyProblem("k", jwt({ iss: "someone-else", role: "anon" }), "anon")).toMatch(/not issued by the local/);
    expect(localSupabaseKeyProblem("k", LOCAL_ANON, "service_role")).toMatch(/expected "service_role"/);
  });
});

describe("localSupabaseEnvProblems", () => {
  const good = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_ANON_KEY: LOCAL_ANON, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE };
  it("is empty for a fully local env", () => {
    expect(localSupabaseEnvProblems(good)).toEqual([]);
  });
  it("reports every problem at once", () => {
    const problems = localSupabaseEnvProblems({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: HOSTED_SERVICE });
    expect(problems).toHaveLength(3);
  });
  it("can skip the anon key when a caller only needs the service role", () => {
    expect(localSupabaseEnvProblems({ ...good, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined }, { requireAnon: false })).toEqual([]);
  });
});

describe("requireLocalSupabaseEnv — never falls back to .env.local", () => {
  const KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  let saved: Record<string, string | undefined>;
  let cwd: string;
  let dir: string;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    cwd = process.cwd();
    dir = mkdtempSync(path.join(tmpdir(), "g8-guard-"));
    process.chdir(dir);
    // A hosted-looking .env.local that must NEVER be picked up.
    writeFileSync(
      ".env.local",
      `NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijklmnop.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${LOCAL_ANON}\nSUPABASE_SERVICE_ROLE_KEY=${HOSTED_SERVICE}\n`
    );
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("throws when .env.g8-local is absent, even though .env.local exists", () => {
    expect(() => requireLocalSupabaseEnv()).toThrow(/\.env\.g8-local not found/);
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
  });

  it("loads .env.g8-local and returns the local values", () => {
    writeFileSync(
      ".env.g8-local",
      `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${LOCAL_ANON}\nSUPABASE_SERVICE_ROLE_KEY=${LOCAL_SERVICE}\n`
    );
    expect(requireLocalSupabaseEnv()).toEqual({ url: "http://127.0.0.1:54321", anonKey: LOCAL_ANON, serviceRoleKey: LOCAL_SERVICE });
  });

  it("a hosted URL already in the environment is rejected, not replaced", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
    writeFileSync(".env.g8-local", "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n");
    expect(() => requireLocalSupabaseEnv()).toThrow(/hosted Supabase URL rejected/);
  });

  it("rejects a local URL paired with a hosted service-role key", () => {
    writeFileSync(
      ".env.g8-local",
      `NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${LOCAL_ANON}\nSUPABASE_SERVICE_ROLE_KEY=${HOSTED_SERVICE}\n`
    );
    expect(() => requireLocalSupabaseEnv()).toThrow(/hosted Supabase project/);
  });
});
