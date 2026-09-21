import { chromium, type FullConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { TEST_CITIZEN } from "./fixtures";

const AUTH_STATE_PATH = path.join(__dirname, ".auth", "citizen.json");

/**
 * Signs in once, before any test file runs, and saves the session so every
 * spec can start already authenticated via `test.use({ storageState })`.
 * Doing this in globalSetup (rather than a per-file beforeAll) avoids a
 * Playwright ordering issue where a describe-level `test.use({ storageState })`
 * is resolved before that file's own beforeAll has had a chance to create it.
 */
export default async function globalSetup(config: FullConfig) {
  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });

  const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:3000";
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });

  await page.goto(`${baseURL}/sign-in`);
  await page.getByLabel("Email").fill(TEST_CITIZEN.email);
  await page.getByLabel("Password").fill(TEST_CITIZEN.password);
  await page.locator('button[type="submit"]', { hasText: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });

  await page.context().storageState({ path: AUTH_STATE_PATH });
  await browser.close();
}

export { AUTH_STATE_PATH };
