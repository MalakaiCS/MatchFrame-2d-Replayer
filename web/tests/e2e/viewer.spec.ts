/**
 * Browser end-to-end: sign up, upload a SYNTHETIC fixture through the UI, wait for
 * processing, then exercise the viewer (kill click, keyboard, filters, bookmark,
 * share link in a clean session, revocation) and measure load/seek timing.
 *
 *   MF_BASE_URL=http://localhost:3000 npx playwright test --trace off
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.MF_BASE_URL ?? "http://localhost:3000";
const OUT = path.resolve(import.meta.dirname, "../../test-results");
mkdirSync(OUT, { recursive: true });
const fixture = path.join(OUT, "synthetic-mirage.dem");
writeFileSync(fixture, Buffer.concat([Buffer.from("MFSYNTH1"), Buffer.from(JSON.stringify({ map: "de_mirage" }))]));

test.describe.configure({ mode: "serial" });
let replayUrl = "";
const email = `e2e-${Date.now()}@example.test`;

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/replays/);
}

test("sign up, upload and process a demo", async ({ page }) => {
  await page.goto(`${BASE}/signup`);
  await page.getByLabel("Display name").fill("Coach E2E");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/replays/);
  await expect(page.getByRole("heading", { name: "Replay library" })).toBeVisible();

  await page.goto(`${BASE}/replays/new`);
  await page.getByTestId("file-input").setInputFiles(fixture);
  await page.getByLabel("Title (optional)").fill("E2E Mirage");
  await page.getByRole("button", { name: "Upload and process" }).click();
  await expect(page.getByRole("link", { name: "Open replay" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("link", { name: "Open replay" }).click();
  await page.waitForURL((u) => /^\/replays\/[A-Za-z0-9]{12,}$/.test(u.pathname));
  replayUrl = page.url().split("?")[0];
});

test("viewer: kill click lands on the recorded tick; keyboard and filters", async ({ page }) => {
  await signIn(page);
  const t0 = Date.now();
  await page.goto(`${replayUrl}?r=r05`);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({ timeout: 15_000 });
  const interactiveMs = Date.now() - t0;

  await expect(page.locator(".ws-map")).toHaveText("Mirage");
  await expect(page.getByRole("button", { name: /^Round 5/ })).toHaveAttribute("aria-current", "true");

  // Click the first kill marker on the timeline; the scrubber must show the event's exact tick.
  const marker = page.locator('.tmark[data-kind^="kill"]').first();
  const label = await marker.getAttribute("aria-label");
  await marker.click();
  await page.getByRole("button", { name: /^Review/ }).click();
  await page.getByRole("tab", { name: "Events" }).click();
  const killRow = page.locator(".event-row[aria-label*=\"killed\"]").first();
  await expect(killRow).toBeVisible();
  const scrub = page.locator("#round-scrubber");
  const tickAfterMarker = await scrub.inputValue();
  await killRow.click();
  expect(await scrub.inputValue()).toBe(tickAfterMarker);
  expect(label).toMatch(/killed/);

  // Seek timing: 20 seeks within the loaded round.
  const seekTimes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const s = Date.now();
    await page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight");
    await expect(page.locator(".mono.muted")).toBeVisible();
    seekTimes.push(Date.now() - s);
  }

  // Keyboard: play/pause, next round, speed.
  await page.locator("canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.keyboard.press("Space");
  await page.keyboard.press("]");
  await expect(page.getByRole("button", { name: /^Round 6/ })).toHaveAttribute("aria-current", "true");
  await page.keyboard.press(".");
  await expect(page.locator("#speed")).toHaveValue("2");

  // Shortcuts are ignored while typing.
  await page.getByRole("tab", { name: /Notes/ }).click();
  await page.getByLabel(/Note at this moment/).fill("Space ] should type");
  await expect(page.getByRole("button", { name: /^Round 6/ })).toHaveAttribute("aria-current", "true");
  await expect(page.getByLabel(/Note at this moment/)).toHaveValue("Space ] should type");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".review-item", { hasText: "Space ] should type" })).toBeVisible();

  // Filters: pistol rounds keep actual round numbers; focus stays on the chip.
  await page.getByRole("button", { name: /^Filters/ }).click();
  const pistol = page.getByRole("button", { name: "Pistol", exact: true });
  await pistol.click();
  await expect(pistol).toBeFocused();
  await expect(page.locator(".round-chip")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /^Round 1 \(pistol\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Round 13 \(pistol\)/ })).toBeVisible();
  await page.getByRole("button", { name: /^Round 13/ }).click();
  await expect(page.locator(".ws-score")).toHaveText(/\d+ : \d+/);
  await expect(page.locator(".sb")).toHaveCount(2);
  await page.screenshot({ path: path.join(OUT, "viewer-round13.png") });

  writeFileSync(path.join(OUT, "perf.json"), JSON.stringify({
    interactiveMs, seekMedianMs: seekTimes.sort((a, b) => a - b)[10], seekMaxMs: Math.max(...seekTimes),
  }, null, 2));
});

test("share link opens the selected moment in a clean session; revocation blocks it", async ({ page, browser }) => {
  await signIn(page);
  await page.goto(`${replayUrl}?r=r07&t=30000`);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Create read-only link" }).click();
  const link = await page.getByLabel("Read-only link").inputValue();
  expect(link).toMatch(/r=r07&t=30000#s=/);

  const clean = await browser.newContext();
  const anon = await clean.newPage();
  await anon.goto(link);
  await expect(anon.getByText("Read-only link")).toBeVisible({ timeout: 15_000 });
  await expect(anon.getByRole("button", { name: /^Round 7/ })).toHaveAttribute("aria-current", "true");
  await expect(anon.locator("#round-scrubber")).toHaveAttribute("aria-valuetext", /0:15 into round 7/);
  await expect(anon.getByRole("tab", { name: /Notes/ })).toHaveCount(0);
  await anon.screenshot({ path: path.join(OUT, "share-view.png") });

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Revoke all links" }).click();
  await expect(page.getByRole("button", { name: "Create read-only link" })).toBeVisible();

  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto(link);
  await expect(fresh.getByRole("heading", { name: "Replay unavailable" })).toBeVisible({ timeout: 15_000 });
  await clean.close();
});

test("round link opens just that round for a signed-out visitor", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await signIn(page);
  await page.goto(`${replayUrl}?r=r04`);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "Copy link to round 4" }).click();
  await expect(page.locator(".radar-toast")).toContainText("Link to round 4 copied");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/\/replays\/[A-Za-z0-9]+\?r=r04#s=/);

  const anon = await (await browser.newContext()).newPage();
  await anon.goto(link);
  await expect(anon.getByText("Round link · round 4 only")).toBeVisible({ timeout: 15_000 });
  await expect(anon.locator(".round-chip")).toHaveCount(1);
  await expect(anon.getByRole("button", { name: /^Round 4/ })).toHaveAttribute("aria-current", "true");
  await expect(anon.getByRole("button", { name: /^Filters/ })).toHaveCount(0);
  await anon.screenshot({ path: path.join(OUT, "round-link.png") });

  // Signed-out visitors without a link are sent to the login screen.
  await anon.goto(`${BASE}/replays`);
  await anon.waitForURL(/\/login\?next=%2Freplays/);
  await anon.goto(replayUrl);
  await anon.waitForURL(/\/login\?next=/);
  await ctx.close();
});

test("public website links to sign-up and sign-in", async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("seen from above");
  await expect(page.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/signup");
  await page.screenshot({ path: path.join(OUT, "website.png"), fullPage: true });
});

test("narrow screen keeps map and playback visible", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/replays/);
  await page.goto(`${replayUrl}?r=r02`);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("canvas")).toBeInViewport();
  await page.getByRole("button", { name: "Hide rounds" }).click();
  await expect(page.locator(".round-strip")).toBeHidden();
  await page.screenshot({ path: path.join(OUT, "viewer-mobile.png"), fullPage: false });
  await ctx.close();
});
