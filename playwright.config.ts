import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:5175';
const desktopSpecs = /terminal-drawer\.spec\.ts/;

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
    { name: 'mobile-iphone', use: { ...devices['iPhone 13'] }, testIgnore: desktopSpecs },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' }, testIgnore: desktopSpecs },
    // The drawer spec runs on desktop; its @phone case runs in a 375px touch viewport.
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] }, testMatch: desktopSpecs, grepInvert: /@phone/ },
    { name: 'phone-chromium', use: { ...devices['iPhone 13'], browserName: 'chromium', viewport: { width: 375, height: 812 } }, testMatch: desktopSpecs, grep: /@phone/ },
  ],
  // Starts the isolated e2e API + web servers before the suite and always tears
  // them down afterward, even on failure, so no dev process is left running.
  webServer: {
    command: 'npm run e2e:serve',
    // Through the Vite proxy, so it answers only once the API is up as well as the web server.
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
