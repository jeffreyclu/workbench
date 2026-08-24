import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:5175';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'mobile-iphone', use: { ...devices['iPhone 13'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
  // Starts the isolated e2e API + web servers before the suite and always tears
  // them down afterward, even on failure, so no dev process is left running.
  webServer: {
    command: 'npm run e2e:serve',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
