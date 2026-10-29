const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/discord-preload.cjs'), 'utf8');

async function fixture(page, initial = true) {
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Discord</title><form><input name="email" type="email"><input name="password" type="password"><button type="submit">Login</button></form>' }));
  await page.addInitScript(({ source, initial }) => {
    const handlers = {};
    window.__nativeGets = []; window.__creates = 0; window.__aborts = 0; window.__active = false;
    Object.defineProperty(navigator, 'userActivation', { value: { get isActive() { return window.__active; } } });
    Object.defineProperty(navigator, 'credentials', { value: {
      get(options) {
        window.__nativeGets.push({ publicKey: Boolean(options?.publicKey), mediation: options?.mediation });
        if (!window.__hold) return Promise.resolve('native-auth-result');
        return new Promise((_resolve, reject) => {
          const abort = () => { window.__aborts++; reject(options.signal.reason || new DOMException('aborted', 'AbortError')); };
          if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
        });
      },
      create: async () => { window.__creates++; return 'native-registration-result'; },
    } });
    window.PublicKeyCredential = class {};
    PublicKeyCredential.isConditionalMediationAvailable = async () => true;
    PublicKeyCredential.getClientCapabilities = async () => ({ conditionalGet: true, hybridTransport: true });
    window.__options = (suppressed, fill = false) => handlers['discord:options']({}, { media: { suppressPasskeyPrompts: suppressed, notificationSound: true }, autofill: { enabled: fill, revision: 'test' } });
    new Function('require', source)(() => ({
      contextBridge: { executeInMainWorld: ({ func, args }) => func(...args) },
      ipcRenderer: { on: (name, fn) => { handlers[name] = fn; }, send() {}, sendSync: () => ({ suppressPasskeyPrompts: initial, notificationSound: true }), invoke: async () => ({ email: 'fixture@example.invalid', password: 'fixture-password', revision: 'test' }) },
    }));
  }, { source, initial });
  await page.goto('https://discord.com/login');
}

test('初期状態で条件付き・ユーザー操作なしのパスキー取得をネイティブAPIの前に止める', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const errors = [];
    for (const mediation of ['conditional', 'optional', 'required']) {
      try { await navigator.credentials.get({ publicKey: {}, mediation }); } catch (error) { errors.push(error.name); }
    }
    window.__active = true;
    try { await navigator.credentials.get({ publicKey: {}, mediation: 'conditional' }); } catch (error) { errors.push(error.name); }
    return { errors, nativeGets: window.__nativeGets.length, conditional: await PublicKeyCredential.isConditionalMediationAvailable(), capabilities: await PublicKeyCredential.getClientCapabilities() };
  });
  expect(result).toEqual({ errors: Array(4).fill('NotAllowedError'), nativeGets: 0, conditional: false, capabilities: { conditionalGet: false, hybridTransport: true } });
});

test('手動操作直後のパスキー取得、登録、他の認証方式、ログイン以外のページは通す', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    window.__active = true;
    const manual = await navigator.credentials.get({ publicKey: {}, mediation: 'required' });
    window.__active = false;
    const password = await navigator.credentials.get({ password: true });
    const registration = await navigator.credentials.create({ publicKey: {} });
    const paths = [];
    for (const route of ['/channels/@me', '/login/mfa', '/register']) {
      history.pushState({}, '', route);
      paths.push(await navigator.credentials.get({ publicKey: {} }));
    }
    return { manual, password, registration, paths, gets: window.__nativeGets.length, creates: window.__creates };
  });
  expect(result).toEqual({ manual: 'native-auth-result', password: 'native-auth-result', registration: 'native-registration-result', paths: Array(3).fill('native-auth-result'), gets: 5, creates: 1 });
});

test('設定OFFで元の動作に戻り、ONにすると待機中の自動要求をキャンセルする', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    window.__options(false);
    const restored = await PublicKeyCredential.isConditionalMediationAvailable();
    const capabilities = await PublicKeyCredential.getClientCapabilities();
    await navigator.credentials.get({ publicKey: {}, mediation: 'conditional' });
    window.__hold = true;
    const pending = navigator.credentials.get({ publicKey: {}, mediation: 'conditional' }).catch((e) => e.name);
    window.__options(true);
    return { restored, capabilities, error: await pending, aborts: window.__aborts, calls: window.__nativeGets.length };
  });
  expect(result).toEqual({ restored: true, capabilities: { conditionalGet: true, hybridTransport: true }, error: 'NotAllowedError', aborts: 1, calls: 2 });
});

test('元のAbortSignalによるキャンセルを引き継ぐ', async ({ page }) => {
  await fixture(page, false);
  const result = await page.evaluate(async () => {
    window.__hold = true;
    const controller = new AbortController();
    const pending = navigator.credentials.get({ publicKey: {}, mediation: 'conditional', signal: controller.signal }).catch((e) => e.name);
    controller.abort();
    const error = await pending;
    window.__options(true);
    return { error, aborts: window.__aborts };
  });
  expect(result).toEqual({ error: 'AbortError', aborts: 1 });
});

test('パスキー自動要求を抑制しても保存したメールとパスワードの入力は継続する', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => window.__options(true, true));
  await expect(page.locator('input[name="email"]')).toHaveValue('fixture@example.invalid');
  await expect(page.locator('input[name="password"]')).toHaveValue('fixture-password');
  expect(await page.evaluate(async () => {
    try { await navigator.credentials.get({ publicKey: {}, mediation: 'conditional' }); } catch (e) { return e.name; }
  })).toBe('NotAllowedError');
  expect(await page.evaluate(() => window.__nativeGets.length)).toBe(0);
});
