const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { normalizeState, createAccount, COLORS } = require('../src/model.cjs');
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=';

// This adapter tests the local UI only. It does not emulate Chromium sessions or prove native view behavior.
async function setup(page, accounts = []) {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const initial = { ...normalizeState({ accounts }), accounts: accounts.map((a) => ({ ...a, status: 'ready' })), colors: COLORS, maxAccounts: 8 };
  await page.addInitScript((initial) => {
    let state = initial;
    const calls = [];
    let onState;
    window.__calls = calls;
    window.__privacy = (hidden) => { state.privacyHidden = hidden; onState?.(state); };
    window.__fullscreen = (value) => { state.settings = { ...state.settings, fullscreen: value }; onState?.(state); };
    window.__updateAccount = (id, patch) => { Object.assign(state.accounts.find((a) => a.id === id), patch); onState?.(state); };
    // contextBridge exposes a non-configurable global. A top-level `const deck` must not shadow it.
    Object.defineProperty(window, 'deck', { configurable: false, writable: false, value: {
      getState: async () => state,
      command: async (value) => {
        calls.push(value);
        if (value.type === 'settings') state.settings = value.settings;
        if (value.type === 'layout') { state.mode = value.mode; if (value.columnCount) state.columnCount = value.columnCount; }
        if (value.type === 'focus') { state.activeId = value.id; state.mode = state.mode === 'focus' ? 'columns' : 'focus'; }
        if (value.type === 'activate') state.activeId = value.id;
        if (value.type === 'update') Object.assign(state.accounts.find((a) => a.id === value.id), value);
        if (value.type === 'appearance') Object.assign(state.accounts.find((a) => a.id === value.id), { compactHeader: value.compactHeader, compactServers: value.compactServers });
        if (value.type === 'zoom') state.accounts.find((a) => a.id === value.id).zoom = value.zoom;
        if (value.type === 'remove') { state.accounts = state.accounts.filter((a) => a.id !== value.id); state.activeId = state.accounts[0]?.id ?? null; }
        if (value.type === 'reorder') {
          const moved = state.accounts.find((a) => a.id === value.id);
          state.accounts = state.accounts.filter((a) => a.id !== value.id);
          const index = state.accounts.findIndex((a) => a.id === value.targetId) + (value.placement === 'after' ? 1 : 0);
          state.accounts.splice(index, 0, moved);
        }
        if (value.type === 'choose-avatar') return { ok: true, state, avatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=' };
        if (value.type === 'add') return { ok: false, error: '接続のテストエラー' };
        onState?.(state);
        return { ok: true, state };
      },
      setBounds: (bounds) => { window.__bounds = bounds; },
      setModal: (open) => { window.__modal = open; },
      onState: (callback) => { onState = callback; }, onNotice: () => {}, onLayout: () => {},
    } });
  }, initial);
  await page.goto(pathToFileURL(path.join(__dirname, '../src/index.html')).href);
  await expect(page.locator('[data-layout][aria-pressed]').first()).toBeVisible();
  expect(pageErrors).toEqual([]);
}

test('フルスクリーンを設定から保存・解除でき、受信更新で編集が消えず、F11相当の状態変更にも同期する', async ({ page }) => {
  const account = createAccount('A'); await setup(page, [account]);
  await page.getByRole('button', { name: '本体設定', exact: true }).click();
  await expect(page.locator('#settings-fullscreen')).not.toBeChecked();
  await page.locator('#settings-fullscreen').check();
  await page.evaluate((id) => window.__updateAccount(id, { unreadCount: 2 }), account.id);
  await expect(page.locator('#settings-fullscreen')).toBeChecked();
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  expect(await page.evaluate(() => window.__calls.find((value) => value.type === 'settings').settings.fullscreen)).toBe(true);
  await page.getByRole('button', { name: '本体設定', exact: true }).click();
  await expect(page.locator('#settings-fullscreen')).toBeChecked();
  await page.locator('#settings-sound').uncheck();
  await page.evaluate(() => window.__fullscreen(false));
  await expect(page.locator('#settings-fullscreen')).not.toBeChecked();
  await expect(page.locator('#settings-sound')).not.toBeChecked();
  await page.locator('#settings-fullscreen').check(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '本体設定', exact: true }).click();
  await expect(page.locator('#settings-fullscreen')).not.toBeChecked();
  await page.screenshot({ path: 'artifacts/fullscreen-settings.png' });
});

test('歯車から本体設定を保存し、秘匿表示で名前・会話・設定を隠して復帰する', async ({ page }) => {
  await setup(page, [createAccount('秘密のアカウント')]);
  const gear = await page.locator('#settings-button').boundingBox(), help = await page.locator('#help-button').boundingBox();
  expect(gear.y).toBeLessThan(help.y);
  await page.getByRole('button', { name: '本体設定', exact: true }).click();
  await expect(page.locator('#settings-sound')).toBeChecked();
  await page.locator('#settings-sound').uncheck(); await page.locator('#settings-privacy').check();
  await page.screenshot({ path: 'artifacts/app-settings.png' });
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  expect(await page.evaluate(() => window.__calls.find((value) => value.type === 'settings').settings)).toEqual({ fullscreen: false, notificationSound: false, hideOnBlur: true, inputDevice: null, outputDevice: null });
  await page.getByRole('button', { name: '本体設定', exact: true }).click();
  await expect(page.locator('#settings-sound')).not.toBeChecked();
  await page.evaluate(() => window.__privacy(true));
  await expect(page.locator('#privacy-screen')).toBeVisible();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await expect(page.getByRole('button', { name: '秘密のアカウントを表示', exact: true })).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__bounds.length)).toBe(0);
  await page.screenshot({ path: 'artifacts/privacy-hidden.png' });
  await page.evaluate(() => window.__privacy(false));
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__bounds.length)).toBe(1);
});

test('音声機器の取得後にマイクを停止し、同名機器とキャンセルを扱う', async ({ page }) => {
  await page.addInitScript(() => {
    window.__stopped = false;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: () => { window.__stopped = true; } }] }),
      enumerateDevices: async () => [
        { kind: 'audioinput', label: 'USBマイク', deviceId: 'default' },
        { kind: 'audioinput', label: 'USBマイク', deviceId: '1' },
        { kind: 'audioinput', label: 'USBマイク', deviceId: '2' },
        { kind: 'audiooutput', label: 'スピーカー', deviceId: '3' },
      ],
    } });
  });
  await setup(page);
  await page.getByRole('button', { name: '本体設定', exact: true }).click();
  expect(await page.evaluate(() => window.__calls.some((v) => v.type === 'begin-device-scan'))).toBe(false);
  await page.getByRole('button', { name: 'デバイス一覧を更新', exact: true }).click();
  await expect(page.locator('#device-status')).toContainText('一覧を更新しました');
  expect(await page.evaluate(() => window.__stopped)).toBe(true);
  await page.locator('#settings-input').selectOption({ label: 'USBマイク (2)' });
  await page.locator('#settings-output').selectOption({ label: 'スピーカー' });
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  expect(await page.evaluate(() => window.__calls.find((v) => v.type === 'settings').settings)).toMatchObject({ inputDevice: { label: 'USBマイク', ordinal: 1 }, outputDevice: { label: 'スピーカー', ordinal: 0 } });
  await page.getByRole('button', { name: '本体設定', exact: true }).click();
  await page.locator('#settings-sound').uncheck(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '本体設定', exact: true }).click();
  await expect(page.locator('#settings-sound')).toBeChecked();
});

test('初期画面、追加フォーム、操作失敗時の表示', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#deck')).toBeHidden();
  await page.screenshot({ path: 'artifacts/welcome.png' });
  await page.getByRole('button', { name: '最初のアカウントを追加', exact: true }).click();
  await expect(page.locator('#account-dialog')).toBeVisible();
  expect(await page.evaluate(() => window.__modal)).toBe(true);
  await page.getByLabel('表示名', { exact: true }).fill('仕事用');
  await page.getByRole('button', { name: '追加してログイン', exact: true }).click();
  await expect(page.locator('#form-error')).toHaveText('接続のテストエラー');
  expect(await page.evaluate(() => window.__calls.at(-1))).toEqual({ type: 'add', name: '仕事用' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.__modal)).toBe(false);
});

test('列のレイアウトと設定のUI、モーダル表示、削除確認', async ({ page }) => {
  const accounts = ['仕事用', 'プライベート', 'コミュニティ'].map(createAccount);
  await setup(page, accounts);
  await expect(page.locator('.panel')).toHaveCount(2);
  await page.getByRole('button', { name: '3列で表示', exact: true }).click();
  await expect(page.locator('.panel')).toHaveCount(3);
  await expect.poll(async () => (await page.evaluate(() => window.__bounds)).length).toBe(3);
  await page.screenshot({ path: 'artifacts/three-columns-shell.png' });
  await page.getByRole('button', { name: '仕事用の設定', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.__bounds)).length).toBe(0);
  await page.getByLabel('表示名', { exact: true }).fill('仕事 / 開発');
  await page.locator('#account-muted').check(); await page.locator('#account-notifications').check();
  await page.getByRole('radio', { name: 'アクセントカラー 2', exact: true }).check();
  await page.screenshot({ path: 'artifacts/account-settings.png' });
  await page.getByRole('button', { name: '変更を保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '仕事 / 開発を表示', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__calls.find((c) => c.type === 'update'))).toEqual({ type: 'update', id: accounts[0].id, name: '仕事 / 開発', color: COLORS[1], muted: true, notifications: true, microphone: true, camera: false, compactHeader: true, compactServers: true, avatar: null });
  await page.getByRole('button', { name: '仕事 / 開発を単独表示・解除', exact: true }).click();
  await expect(page.locator('.panel')).toHaveCount(1);
  await page.getByRole('button', { name: '仕事 / 開発の設定', exact: true }).click();
  await page.getByRole('button', { name: 'この列を縮小', exact: true }).click();
  await expect(page.locator('#settings-zoom')).toHaveText('75%');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '4分割で表示', exact: true }).click();
  await expect(page.locator('.panel')).toHaveCount(3);
  await page.getByRole('button', { name: '仕事 / 開発の設定', exact: true }).click();
  await page.getByRole('button', { name: 'この列を削除', exact: true }).click();
  await expect(page.locator('#remove-confirmation')).toBeVisible();
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await expect(page.locator('#account-form')).toBeVisible();
  await page.getByRole('button', { name: 'この列を削除', exact: true }).click();
  await page.getByRole('button', { name: '列とログイン情報を削除', exact: true }).click();
  await expect(page.locator('.panel')).toHaveCount(2);
  await expect(page.locator('#account-dialog')).not.toBeVisible();
  await page.setViewportSize({ width: 960, height: 680 });
  const bounds = await page.locator('.panel-body').evaluateAll((nodes) => nodes.map((n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }));
  for (const r of bounds) { expect(r.width).toBeGreaterThan(300); expect(r.height).toBeGreaterThan(200); expect(r.right).toBeLessThanOrEqual(960); expect(r.bottom).toBeLessThanOrEqual(680); }
});

test('上部バーを削除して操作を左に集め、8アカウントでも分割操作と未読表示を維持する', async ({ page }) => {
  const accounts = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(createAccount);
  await setup(page, accounts);
  await expect(page.locator('.workspace-heading,.footer,.topbar,.wordmark')).toHaveCount(0);
  await expect(page.locator('.rail .layout-picker [data-layout]')).toHaveCount(3);
  await expect(page.locator('.app-main [data-layout]')).toHaveCount(0);
  await expect(page.locator('.rail-bottom .version')).toHaveText(`v${require('../package.json').version}`);
  await expect(page.locator('.panel-body').first()).toHaveCSS('border-bottom-left-radius', '9px');
  const body = await page.locator('.panel-body').first().boundingBox();
  expect(body.y).toBeLessThan(60); expect(body.height).toBeGreaterThan(880);
  const nav = page.getByRole('button', { name: 'Bを表示', exact: true });
  await page.evaluate((id) => window.__updateAccount(id, { hasUnread: true, unreadCount: 5 }), accounts[1].id);
  await expect(nav.locator('.unread-badge')).toBeVisible(); await expect(nav.locator('.unread-badge')).toHaveText('5');
  await page.evaluate((id) => window.__updateAccount(id, { hasUnread: true, unreadCount: 0 }), accounts[1].id);
  await expect(nav.locator('.unread-badge')).toHaveClass(/dot/);
  await page.screenshot({ path: 'artifacts/compact-workspace.png' });
  await page.evaluate((id) => window.__updateAccount(id, { hasUnread: false, unreadCount: 0 }), accounts[1].id);
  await expect(nav.locator('.unread-badge')).toBeHidden();
  await page.setViewportSize({ width: 960, height: 680 });
  for (const button of await page.locator('.rail [data-layout]').all()) {
    const bounds = await button.boundingBox(); expect(bounds.x).toBeLessThan(78); expect(bounds.y + bounds.height).toBeLessThan(680);
  }
  await page.getByRole('button', { name: 'Hを表示', exact: true }).click();
  await expect(page.locator('#page-label')).toHaveText('7–8 / 8');
  await page.getByRole('button', { name: '前のアカウントを表示', exact: true }).click();
  await expect(page.locator('#page-label')).toHaveText('5–6 / 8');
  await page.screenshot({ path: 'artifacts/left-rail-min.png' });
});

test('独自アイコンの保存・自動アイコンへの復帰・ドラッグと設定での並べ替え', async ({ page }) => {
  const accounts = ['A', 'B', 'C'].map(createAccount);
  await setup(page, accounts);
  await page.getByRole('button', { name: 'Aの設定', exact: true }).click();
  await page.getByRole('button', { name: '画像を選ぶ', exact: true }).click();
  await expect(page.locator('#avatar-preview img')).toHaveAttribute('src', PIXEL);
  await page.locator('#account-camera').check();
  await page.getByRole('button', { name: '変更を保存', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Aを表示', exact: true }).locator('img')).toHaveAttribute('src', PIXEL);
  await page.getByRole('button', { name: 'Aの設定', exact: true }).click();
  await page.getByRole('button', { name: 'Discordのアイコンに戻す', exact: true }).click();
  await page.getByRole('button', { name: '下に移動', exact: true }).click();
  await expect(page.locator('.account-nav').first()).toHaveAttribute('data-id', accounts[1].id);
  await page.getByRole('button', { name: '変更を保存', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Aを表示', exact: true }).locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cを表示', exact: true }).dragTo(page.getByRole('button', { name: 'Bを表示', exact: true }));
  await expect(page.locator('.account-nav').first()).toHaveAttribute('data-id', accounts[2].id);
  await page.getByRole('button', { name: 'Cを表示', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('.account-nav').nth(1)).toHaveAttribute('data-id', accounts[2].id);
  expect(await page.evaluate(() => window.__calls.find((c) => c.type === 'update').camera)).toBe(true);
});

test('下部バーと名前下の状態表示を削除し、倍率と任意HEX色を設定で操作する', async ({ page }) => {
  const accounts = ['A', 'B'].map(createAccount);
  await setup(page, accounts);
  await expect(page.locator('.panel-footer,.panel-status')).toHaveCount(0);
  await page.getByRole('button', { name: 'Aの設定', exact: true }).click();
  await page.getByRole('button', { name: 'この列を縮小', exact: true }).click();
  await expect(page.locator('#settings-zoom')).toHaveText('75%');
  await page.getByLabel('カラーコード', { exact: true }).fill('#173acf');
  await expect(page.locator('#color-preview')).toHaveCSS('border-top-color', 'rgb(23, 58, 207)');
  await page.getByRole('button', { name: '変更を保存', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Aを表示', exact: true })).toHaveCSS('border-top-color', 'rgb(23, 58, 207)');
  const header = page.locator('.panel-header').first();
  await expect(header).toHaveCSS('background-image', /rgba\(23, 58, 207, 0\.18\)/);
  await page.screenshot({ path: 'artifacts/integrated-columns.png' });
});

test('中央タイトルと左上のサーバー・DMメニュー、検索と元の表示への復元', async ({ page }) => {
  const accounts = ['A', 'B'].map(createAccount);
  accounts[0].channelTitle = 'ダイレクトメッセージ';
  accounts[0].navigation = [{ key: 'home', kind: 'home', label: 'ダイレクトメッセージ' }, { key: 'guild:123', kind: 'guild', label: '開発サーバー' }, { key: 'dm:456', kind: 'dm', label: '友だち' }];
  await setup(page, accounts);
  await expect(page.locator('.panel-context').first()).toHaveText('ダイレクトメッセージ');
  await page.getByRole('button', { name: 'Aのサーバー・DMメニュー', exact: true }).click();
  await expect(page.locator('#navigation-dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '友だちへ移動', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ダイレクトメッセージへ移動', exact: true }).locator('use')).toHaveAttribute('href', '#i-mail');
  await page.getByLabel('移動先を検索', { exact: true }).fill('開発');
  await expect(page.locator('.navigation-item')).toHaveCount(1);
  await page.screenshot({ path: 'artifacts/server-menu.png' });
  await page.getByRole('button', { name: '開発サーバーへ移動', exact: true }).click();
  await expect(page.locator('#navigation-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.__calls.findLast((item) => item.type === 'navigate'))).toEqual({ type: 'navigate', id: accounts[0].id, key: 'guild:123' });
  await page.getByRole('button', { name: 'Aのサーバー・DMメニュー', exact: true }).click();
  await page.getByRole('button', { name: 'Discordの元の一覧・上部バーを表示', exact: true }).click();
  expect(await page.evaluate(() => window.__calls.findLast((item) => item.type === 'appearance'))).toEqual({ type: 'appearance', id: accounts[0].id, compactHeader: false, compactServers: false });
});
