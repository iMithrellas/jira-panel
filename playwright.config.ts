import { defineConfig } from '@playwright/test';

const baseURL = process.env.GRAFANA_DEV_URL || 'http://127.0.0.1:3300';
const url = new URL(baseURL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
  throw new Error('Browser tests must target a local development Grafana.');
}

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  expect: { timeout: 20000 },
  workers: 1,
  use: { baseURL, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: 'list',
});
