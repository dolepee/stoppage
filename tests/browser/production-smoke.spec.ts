import { existsSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

const approvedTapePublished = existsSync("data/public/live-decision-tape.json");

test.describe("Stoppage release browser gate", () => {
  test("does not promise real proof when the approved claim is unavailable", async ({
    page,
  }) => {
    await page.route("**/api/public-claim**", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ status: "UNAVAILABLE" }),
      });
    });

    await page.goto("/demo");
    await expect(
      page.getByText("Real TxLINE proof below", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText(
        "approved real TxLINE evidence appears below when available.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "No metrics are substituted when the approved claim cannot be read.",
        { exact: true },
      ),
    ).toBeVisible();
  });

  test("blocks, certifies and rejects tampering without layout or browser errors", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const browserErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const origin = new URL(
      test.info().project.use.baseURL ?? "http://127.0.0.1:4173",
    ).origin;

    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (failedRequest) => {
      if (failedRequest.url().startsWith(origin)) {
        const intentionallySupersededGateRequest =
          [`${origin}/api/agent-gate`, `${origin}/api/permit-keys`].includes(
            failedRequest.url(),
          ) && failedRequest.failure()?.errorText === "net::ERR_ABORTED";
        if (intentionallySupersededGateRequest) return;
        failedRequests.push(
          `${failedRequest.method()} ${failedRequest.url()}: ${failedRequest.failure()?.errorText ?? "unknown"}`,
        );
      }
    });

    await page.goto("/");
    await expect(page).toHaveTitle("Home · Stoppage");
    await expect(
      page.getByRole("heading", {
        name: "Agents decide. Stoppage permits.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Interactive · simulated data", { exact: true }),
    ).toBeVisible();
    if (approvedTapePublished) {
      await expect(
        page.getByText("20 capture replays · 0 unsafe callbacks", {
          exact: true,
        }),
      ).toBeVisible();
    }

    const primaryNavigation = page.getByRole("navigation", {
      name: "Primary navigation",
    });
    for (const label of ["Home", "Demo", "Evidence", "System"]) {
      await expect(
        primaryNavigation.getByRole("link", { name: label, exact: true }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("link", { name: "Skip to main content" }),
    ).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    await expectMinimumNavigationText(page);

    await page
      .getByRole("link", { name: "Test an agent request", exact: true })
      .click();
    await expect(page).toHaveURL(/\/demo$/);
    await expect(page).toHaveTitle("Demo · Stoppage");
    await expectNoHorizontalOverflow(page);
    if (
      (await page
        .getByRole("button", { name: "Test the firewall", exact: true })
        .count()) > 0
    ) {
      await expect(
        page.getByText("Demo ready · permanent what-if", { exact: true }),
      ).toBeVisible();
      await expect(
        page
          .locator(".state-node.active")
          .getByText("REOPENED", { exact: true }),
      ).toHaveCount(0);
    }
    if (approvedTapePublished) {
      await expect(
        page.getByRole("heading", {
          name: "Live Decision Tape",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText("VERIFIED → CALLBACK EXECUTED", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("AUDIENCE MISMATCH → WITHHELD", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Callbacks after BLOCK", { exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        page.getByRole("heading", {
          name: "Recorded agent enforcement evidence",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText("No human-approved live decision tape is published.", {
          exact: true,
        }),
      ).toBeVisible();
    }

    await page
      .getByRole("button", { name: /Test the firewall|Test again/ })
      .click();
    await page.waitForTimeout(1_000);
    await expect(
      page.locator(".state-node.active").getByText("REOPENED", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Agent action blocked", { exact: true }),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      page
        .locator(".execution-stage")
        .getByText("VENUE CALL EXECUTED", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .locator(".execution-stage .venue-call-result")
        .getByText("VENUE CALL WITHHELD", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Test again", exact: true }),
    ).toBeVisible({ timeout: 35_000 });
    await expect(
      page.getByText("VENUE CALL EXECUTED", { exact: true }).first(),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Run 6 execution attacks", exact: true })
      .click();
    await expect(
      page.getByText("6/6 EXECUTION ATTACKS REJECTED", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/Verified locally by @stoppage\/sdk/),
    ).toBeVisible();

    await primaryNavigation
      .getByRole("link", { name: "Evidence", exact: true })
      .click();
    await expect(page).toHaveURL(/\/evidence$/);
    await expect(page).toHaveTitle("Evidence · Stoppage");
    await expectCanonical(page, "/evidence");
    await expect(
      page.getByRole("heading", {
        name: "External builder-run SDK check",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Argentina–England · completed World Cup match", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("@Ridwannurudeen", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "External repository", exact: true }),
    ).toHaveAttribute(
      "href",
      "https://github.com/Ridwannurudeen/stoppage-sdk-external-check",
    );
    await expect(
      page.getByRole("link", { name: "Hosted Actions run", exact: true }),
    ).toHaveAttribute(
      "href",
      "https://github.com/Ridwannurudeen/stoppage-sdk-external-check/actions/runs/29603337409",
    );
    await expect(page.getByText("6/6 rejected", { exact: true })).toBeVisible();
    await expect(page.getByText("1 execution", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await primaryNavigation
      .getByRole("link", { name: "System", exact: true })
      .click();
    await expect(page).toHaveURL(/\/system$/);
    await expect(page).toHaveTitle("System · Stoppage");
    await expectCanonical(page, "/system");
    await expect(
      page.getByText("Simulated inputs", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Separate score proof", { exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const openapi = await request.get("/openapi.json");
    expect(openapi.status()).toBe(200);
    const contract = (await openapi.json()) as {
      paths?: Record<string, unknown>;
    };
    expect(Object.keys(contract.paths ?? {}).sort()).toEqual([
      "/api/agent-context",
      "/api/agent-gate",
      "/api/judge-bundle",
      "/api/live-decision-tape",
      "/api/permit-keys",
      "/api/public-claim",
    ]);

    const context = await request.get("/api/agent-context");
    expect(context.status()).toBe(200);
    await expect(context.json()).resolves.toMatchObject({
      version: 2,
      dataMode: "SYNTHETIC",
      sequence: 12,
      market: "1X2",
      subjectHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      quoteHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });

    const keys = await request.get("/api/permit-keys");
    expect(keys.status()).toBe(200);
    await expect(keys.json()).resolves.toMatchObject({
      version: 1,
      issuer: "stoppage",
      keys: [{ alg: "Ed25519", use: "sig", status: "ACTIVE" }],
    });

    const claim = await request.get("/api/public-claim");
    expect(claim.status()).toBe(200);
    await expect(claim.json()).resolves.toMatchObject({
      version: 3,
      status: "AVAILABLE",
      featuredMatch: {
        label: "Argentina–England · completed World Cup match",
        completeProtectedWindows: 3,
        preResolutionRepricesInvalidated: 3,
        postResolutionCertifiedReopens: 3,
      },
      holdout: { fixtures: 5, completeProtectedWindows: 21 },
    });

    const tape = await request.get("/api/live-decision-tape");
    if (approvedTapePublished) {
      expect(tape.status()).toBe(200);
      await expect(tape.json()).resolves.toMatchObject({
        version: 1,
        status: "AVAILABLE",
        evidenceType: "RECORDED_BUILDER_ATTESTED_TXLINE_DECISION_TAPE",
        hostingClaim: "RECORDED_CAPTURE_NOT_HOSTED_UPTIME",
        timingDisclosure:
          "PERMIT_ISSUED_AT_IS_ENFORCEMENT_EXECUTION_TIME_NOT_FEED_TIME",
        counters: {
          capturedRequests: 20,
          blockedRequests: 10,
          verifiedPermits: 10,
          callbacksAfterBlock: 0,
          callbacksWithoutVerifiedPermit: 0,
          crossAgentPermitTheftsRejected: 10,
        },
      });
    } else {
      expect(tape.status()).toBe(404);
    }

    const judgeBundle = await request.get("/api/judge-bundle");
    if (approvedTapePublished) {
      expect(judgeBundle.status()).toBe(200);
      await expect(judgeBundle.json()).resolves.toMatchObject({
        version: 1,
        status: "AVAILABLE",
        publicClaim: { available: true },
        liveDecisionTape: { available: true },
      });
    } else {
      expect(judgeBundle.status()).toBe(404);
    }

    expect(browserErrors).toEqual(
      approvedTapePublished
        ? []
        : [
            "Failed to load resource: the server responded with a status of 404 (Not Found)",
          ],
    );
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function expectMinimumNavigationText(page: Page) {
  const sizes = await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link")
    .evaluateAll((links) =>
      links.map((link) => Number.parseFloat(getComputedStyle(link).fontSize)),
    );
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11);
}

async function expectCanonical(page: Page, path: string) {
  await expect
    .poll(() => page.locator('link[rel="canonical"]').getAttribute("href"))
    .toBe(`https://stoppage-txline.vercel.app${path}`);
}
