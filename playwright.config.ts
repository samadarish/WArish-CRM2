import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 45_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: { trace: 'retain-on-failure' }
})
