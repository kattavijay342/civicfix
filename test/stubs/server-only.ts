// Test-only stand-in for the real "server-only" package (see vitest.config.ts's
// resolve.alias). The real package unconditionally throws when imported —
// it relies on Next.js's bundler swapping in a no-op build for server code,
// which vitest's plain Node environment doesn't do. Tests here only ever
// exercise pure logic that happens to live in a "server-only" module, never
// anything that needs a request/browser context, so a no-op is correct.
export {};
