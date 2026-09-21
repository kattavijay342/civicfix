import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Phase 4 Step 6 — automated test suite, pure-logic unit tests.
 *
 * Scope: this covers validation, formatting, scoring, and other pure/
 * deterministic logic (src/lib/**\/*.test.ts) that runs with no live
 * service. It deliberately does NOT attempt to mock Supabase's
 * auth/RLS/Postgres behavior — that would test the mock, not the real
 * authorization boundary. The AUTH/AUTHORIZATION/DATABASE coverage the
 * Phase 4 spec asks for instead lives in scripts/verify-*.mjs and
 * scripts/security-audit.mjs, which already run against a real Supabase
 * project with real RLS policies (see README's "npm run test:live" note
 * and the Phase 4 report for why that split is the honest option here).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
      "server-only": path.resolve(rootDir, "./test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.test.ts", "src/lib/supabase/**"],
    },
  },
});
