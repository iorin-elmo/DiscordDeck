const { defineConfig } = require('@playwright/test');
const fs = require('node:fs');
const candidates = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
module.exports = defineConfig({
  testDir: './tests', testMatch: ['ui.spec.cjs', 'observer.spec.cjs', 'media.spec.cjs', 'autofill.spec.cjs', 'passkey.spec.cjs', 'taskbar.spec.cjs', 'storage.spec.cjs'], timeout: 30_000, workers: 1, reporter: 'list',
  use: { viewport: { width: 1540, height: 960 }, launchOptions: { executablePath: process.env.DISCORDDECK_BROWSER || candidates.find((p) => fs.existsSync(p)) }, trace: 'retain-on-failure' },
});
