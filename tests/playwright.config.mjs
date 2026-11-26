import { defineConfig } from '@playwright/test';

const phase = process.env.LOCAL_TEX_EDITOR_TEST_PHASE || '';
if (phase && !['before-tex', 'after-tex'].includes(phase)) throw new Error(`Unknown browser test phase: ${phase}`);
const setupUISpecs = ['**/tex-setup.spec.mjs', '**/tex-management.spec.mjs'];

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: phase === 'before-tex' ? setupUISpecs : '**/*.spec.mjs',
  testIgnore: phase === 'after-tex' ? setupUISpecs : [],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  // Playwright clears outputDir when a run starts. Keep both CI phases and the installation logs available.
  outputDir: phase === 'before-tex' ? '../test-results/tex-setup-ui' : phase === 'after-tex' ? '../test-results/browser' : '../test-results',
  use: {
    browserName: 'chromium',
    headless: true,
    actionTimeout: 20_000,
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'ja-JP',
    // Request interception must reach Playwright. The browser restoration tests
    // enable service workers explicitly to exercise the offline connection page.
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
