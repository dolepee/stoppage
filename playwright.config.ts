import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.STOPPAGE_TEST_URL;
const baseURL = externalBaseUrl ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    colorScheme: "dark",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile-chromium",
      use: { viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "pnpm start",
        url: `${baseURL}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
