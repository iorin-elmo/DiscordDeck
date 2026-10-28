const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests', testMatch: 'app.spec.cjs', timeout: 45_000, workers: 1, reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
