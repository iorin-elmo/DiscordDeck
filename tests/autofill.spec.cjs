const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/discord-preload.cjs'), 'utf8');
const body = '<!doctype html><title>Discord</title><form><input type="email" name="email" aria-label="Email"><input type="password" name="password" aria-label="Password"><button type="submit">Login</button></form>';

async function fixture(page, url = 'https://discord.com/login') {
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
  await page.addInitScript((source) => {
    const handlers = {};
    window.__requests = 0; window.__submits = 0; window.__clicks = 0; window.__metadata = [];
    window.__login = { email: 'fixture@example.invalid', password: 'fixture-password', revision: 'one' };
    window.__options = (enabled = true, revision = 'one') => handlers['discord:options']?.({}, { autofill: { enabled, revision } });
    document.addEventListener('submit', (e) => { e.preventDefault(); window.__submits++; });
    document.addEventListener('click', () => { window.__clicks++; });
    new Function('require', source)(() => ({ ipcRenderer: {
      on: (name, fn) => { handlers[name] = fn; },
      send: (name, value) => { if (name === 'discord:metadata') window.__metadata.push(value); },
      invoke: async () => { window.__requests++; return window.__defer ? new Promise((resolve) => { window.__finish = (value) => resolve({ ...value }); }) : { ...window.__login }; },
    } }));
  }, source);
  await page.goto(url);
}

test('公式ログインフォームへReact相当の入力イベントで値を反映し、送信しない', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.__controlled = {};
    for (const input of document.querySelectorAll('input')) {
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      let tracked = input.value;
      Object.defineProperty(input, 'value', { get: () => native.get.call(input), set(value) { tracked = value; native.set.call(input, value); } });
      input.addEventListener('input', () => { if (input.value !== tracked) { window.__controlled[input.name] = input.value; tracked = input.value; } });
    }
    window.__options();
  });
  await expect(page.getByLabel('Email')).toHaveValue('fixture@example.invalid');
  await expect(page.getByLabel('Password')).toHaveValue('fixture-password');
  expect(await page.evaluate(() => window.__controlled)).toEqual({ email: 'fixture@example.invalid', password: 'fixture-password' });
  expect(await page.evaluate(() => [window.__submits, window.__clicks, window.__requests])).toEqual([0, 0, 1]);
  expect(await page.evaluate(() => JSON.stringify(window.__metadata).includes('fixture-password'))).toBe(false);
  await page.getByLabel('Password').fill('');
  await page.evaluate(() => window.__options());
  await expect(page.getByLabel('Password')).toHaveValue('');
});

test('ユーザーが入力済みの欄を上書きせず、削除・無効化では自分が自動入力した値だけ消す', async ({ page }) => {
  await fixture(page);
  await page.getByLabel('Email').fill('manual@example.invalid');
  await page.evaluate(() => window.__options());
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__requests)).toBe(0);
  await page.getByLabel('Email').fill('');
  await page.evaluate(() => window.__options(true, 'one'));
  await expect(page.getByLabel('Password')).toHaveValue('fixture-password');
  await page.getByLabel('Email').fill('manual@example.invalid');
  await page.evaluate(() => window.__options(false, 'two'));
  await expect(page.getByLabel('Password')).toHaveValue('');
  await expect(page.getByLabel('Email')).toHaveValue('manual@example.invalid');
});

test('保存情報の変更で自動入力を更新し、削除すると入力済みの保存情報も消す', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => window.__options());
  await expect(page.getByLabel('Password')).toHaveValue('fixture-password');
  await page.evaluate(() => {
    window.__login = { email: 'changed@example.invalid', password: 'changed-password', revision: 'two' };
    window.__options(true, 'two');
  });
  await expect(page.getByLabel('Email')).toHaveValue('changed@example.invalid');
  await expect(page.getByLabel('Password')).toHaveValue('changed-password');
  await page.evaluate(() => window.__options(false, ''));
  await expect(page.getByLabel('Email')).toHaveValue('');
  await expect(page.getByLabel('Password')).toHaveValue('');
  expect(await page.evaluate(() => window.__submits)).toBe(0);
});

test('公式以外・登録画面・追加認証では復号要求を出さない', async ({ browser }) => {
  for (const url of ['https://evil.test/login', 'https://discord.com/register', 'https://discord.com/login/mfa']) {
    const page = await browser.newPage(); await fixture(page, url);
    await page.evaluate(() => window.__options()); await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__requests)).toBe(0); await page.close();
  }
  const page = await browser.newPage(); await fixture(page);
  await page.evaluate(() => { const input = document.createElement('input'); input.autocomplete = 'one-time-code'; document.querySelector('form').append(input); window.__options(); });
  await page.waitForTimeout(500); expect(await page.evaluate(() => window.__requests)).toBe(0); await page.close();
});

test('復号待ちの間に画面移動・手入力・保存情報変更があったら古い値を入力しない', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { window.__defer = true; window.__options(); });
  await expect.poll(() => page.evaluate(() => window.__requests)).toBe(1);
  await page.evaluate(() => { history.pushState({}, '', '/register'); window.__finish(window.__login); });
  await expect(page.getByLabel('Password')).toHaveValue('');
  await page.evaluate(() => { history.pushState({}, '', '/login'); window.__options(true, 'two'); });
  await expect.poll(() => page.evaluate(() => window.__requests)).toBe(2);
  await page.getByLabel('Email').fill('manual@example.invalid');
  await page.evaluate(() => window.__finish({ ...window.__login, revision: 'two' }));
  await expect(page.getByLabel('Password')).toHaveValue('');
  await page.getByLabel('Email').fill('');
  await page.evaluate(() => window.__options(true, 'three'));
  await expect.poll(() => page.evaluate(() => window.__requests)).toBe(3);
  await page.evaluate(() => { window.__options(false, 'four'); window.__finish({ ...window.__login, revision: 'three' }); });
  await expect(page.getByLabel('Password')).toHaveValue('');
});
