const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/discord-preload.cjs'), 'utf8');

async function fixture(page, origin = 'https://discord.com') {
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage fixture</title><p>Offline fixture</p>' }));
  await page.addInitScript((source) => {
    window.__calls = [];
    const handlers = {};
    Object.defineProperty(window, 'outerWidth', { configurable: true, get: () => 2400 });
    Object.defineProperty(window, 'outerHeight', { configurable: true, get: () => 1400 });
    window.__devtools = (value) => handlers['discord:devtools-state']?.({}, value);
    new Function('require', source)(() => ({
      contextBridge: { executeInMainWorld: ({ func, args }) => func(...args) },
      ipcRenderer: { on: (name, callback) => { handlers[name] = callback; }, send: (channel, ...args) => window.__calls.push({ channel, args }), sendSync: () => ({ notificationSound: true, devToolsOpen: false }), invoke: async () => null },
    }));
  }, source);
  await page.goto(origin + '/channels/@me');
}

test('カラムの大きさを外寸として扱い、実際に開発者ツールを開いた場合は元の外寸に戻す', async ({ page }) => {
  await fixture(page);
  expect(await page.evaluate(() => [outerWidth === innerWidth, outerHeight === innerHeight])).toEqual([true, true]);
  await page.evaluate(() => window.__devtools(true));
  expect(await page.evaluate(() => [outerWidth, outerHeight])).toEqual([2400, 1400]);
  await page.evaluate(() => window.__devtools(false));
  expect(await page.evaluate(() => [outerWidth === innerWidth, outerHeight === innerHeight])).toEqual([true, true]);
});

test('LocalStorage・SessionStorageの変更を値なしで通知し、標準APIの結果と例外を保つ', async ({ page }) => {
  await fixture(page);
  expect(await page.evaluate(() => {
    const result = localStorage.setItem('fixture-key', 'fixture-private-value');
    return { result: typeof result, value: localStorage.getItem('fixture-key') };
  })).toEqual({ result: 'undefined', value: 'fixture-private-value' });
  await expect.poll(() => page.evaluate(() => window.__calls.filter((call) => call.channel === 'discord:storage-dirty').length)).toBe(1);
  expect(await page.evaluate(() => {
    try { Storage.prototype.setItem.call({}, 'x', 'y'); return false; } catch (error) { return error instanceof TypeError; }
  })).toBe(true);
  await page.evaluate(() => { localStorage.removeItem('fixture-key'); sessionStorage.setItem('fixture-key', 'other-private-value'); localStorage.clear(); });
  await expect.poll(() => page.evaluate(() => window.__calls.filter((call) => call.channel === 'discord:storage-dirty').length)).toBe(2);
  const signals = await page.evaluate(() => window.__calls.filter((call) => call.channel === 'discord:storage-dirty'));
  expect(signals.every((call) => call.args.length === 0)).toBe(true);
  expect(JSON.stringify(signals)).not.toContain('private-value');
});

test('非Discordページではストレージを監視せず、pagehideはDiscordで即座に通知する', async ({ page }) => {
  await fixture(page, 'https://example.invalid');
  await page.evaluate(() => { localStorage.setItem('fixture', 'value'); window.dispatchEvent(new Event('pagehide')); });
  expect(await page.evaluate(() => window.__calls)).toEqual([]);
  await page.goto('https://discord.com/channels/@me');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => window.__calls.filter((call) => call.channel === 'discord:storage-dirty').length)).toBe(1);
});
