import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

const candidatePath = process.env.STOPPAGE_TAPE_CANDIDATE_PATH;

test.skip(!candidatePath, "A private candidate path is required for this gate");

test("renders the exact Live Decision Tape candidate without disclosure or overflow", async ({
  page,
}) => {
  const candidate = JSON.parse(await readFile(candidatePath!, "utf8")) as {
    candidateHash: string;
    requiredApproval: string;
    payload: Record<string, unknown>;
  };
  const preview = {
    ...candidate.payload,
    candidateHash: candidate.candidateHash,
    approvedAt: new Date().toISOString(),
    approval: { statement: candidate.requiredApproval },
  };
  await page.route("**/api/live-decision-tape", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(preview),
    }),
  );

  await page.goto("/demo");
  const panel = page.locator("section.live-tape");
  await expect(
    panel.getByRole("heading", { name: "Live Decision Tape", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("AUDIENCE MISMATCH → WITHHELD", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(/Private TxLINE capture replay/)).toBeVisible();
  await expect(panel.getByText(/Sample Certified Reopen/)).toBeVisible();
  await expect(
    panel.getByText("Callbacks after BLOCK", { exact: true }),
  ).toBeVisible();

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  const panelText = await panel.textContent();
  expect(panelText).toContain("callback 0x");
  expect(panelText).not.toMatch(/source timestamp|receivedTs/i);

  await panel.evaluate((element) => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(
      0,
      element.getBoundingClientRect().top + window.scrollY - 62,
    );
  });
  const panelTop = await panel.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  expect(panelTop).toBeGreaterThanOrEqual(61);
  expect(panelTop).toBeLessThanOrEqual(63);
  await page.screenshot({
    path: join(
      tmpdir(),
      `stoppage-live-tape-candidate-${test.info().project.name}.png`,
    ),
  });
});
