const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const root = path.join(__dirname, '..');
async function launch(data) {
  const env = { ...process.env, DISCORDDECK_TEST: '1', DISCORDDECK_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [root], env });
  const messages = [];
  app.process().stderr?.on('data', (chunk) => { messages.push(chunk.toString().slice(0, 2000)); });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => messages.push(error.message));
  try { await page.waitForSelector('[data-layout][aria-pressed]'); }
  catch (error) {
    console.log('Native startup diagnostic:', JSON.stringify({ url: page.url(), messages, dom: await page.evaluate(() => ({ title: document.title, controls: document.querySelectorAll('[data-layout]').length, text: document.body.innerText.slice(0, 1600) })).catch(() => null) }));
    await app.close(); throw error;
  }
  return { app, page };
}
async function add(page, name) {
  await page.locator('#rail-add').click();
  await page.getByLabel('表示名', { exact: true }).fill(name);
  await page.getByRole('button', { name: '追加してログイン' }).click();
  await expect(page.locator('#account-dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: `${name}を表示`, exact: true })).toBeVisible();
}
async function nativeViews(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.webContents && v.webContents !== BrowserWindow.getAllWindows()[0].webContents).map((v) => ({
    visible: v.getVisible(), bounds: v.getBounds(), id: v.webContents.id, zoom: v.webContents.getZoomFactor(), muted: v.webContents.isAudioMuted(),
    preferences: v.webContents.getLastWebPreferences(),
  })));
}
async function capture(app, name) {
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  await fs.writeFile(path.join(root, 'artifacts', name), Buffer.from(png, 'base64'));
}

test('セッションCookie・LocalStorage・IndexedDBを同じ列の次回起動へ引き継ぐ', async () => {
  test.setTimeout(120_000);
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'discorddeck-storage-e2e-'));
  const server = http.createServer((_req, res) => res.end('<!doctype html><title>Storage fixture</title><p>Offline fixture</p>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let app;
  try {
    let launched = await launch(data); app = launched.app;
    await add(launched.page, '保存テスト');
    await app.evaluate(async ({ BrowserWindow }, origin) => {
      const win = BrowserWindow.getAllWindows()[0];
      const wc = win.contentView.children.find((view) => view.webContents && view.webContents !== win.webContents).webContents;
      await wc.loadURL(origin);
      await wc.session.cookies.set({ url: 'https://discord.com', name: 'deck-session-fixture', value: 'offline-session-value', secure: true, httpOnly: true, sameSite: 'lax' });
      await wc.executeJavaScript(`(async () => {
        localStorage.setItem('deck-storage-fixture', 'offline-local-value');
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('deck-storage-fixture', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('entries');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result, transaction = db.transaction('entries', 'readwrite');
            transaction.objectStore('entries').put('offline-db-value', 'fixture');
            transaction.oncomplete = () => { db.close(); resolve(); };
            transaction.onerror = () => reject(transaction.error);
          };
        });
      })()`);
    }, origin);
    await app.close(); app = null;
    const saved = await fs.readFile(path.join(data, 'session-cookies.json'), 'utf8');
    expect(saved).not.toContain('offline-session-value');
    launched = await launch(data); app = launched.app;
    const values = await app.evaluate(async ({ BrowserWindow }, origin) => {
      const win = BrowserWindow.getAllWindows()[0];
      const wc = win.contentView.children.find((view) => view.webContents && view.webContents !== win.webContents).webContents;
      await wc.loadURL(origin);
      const cookies = await wc.session.cookies.get({ name: 'deck-session-fixture' });
      const storage = await wc.executeJavaScript(`(async () => ({
        local: localStorage.getItem('deck-storage-fixture'),
        db: await new Promise((resolve, reject) => {
          const request = indexedDB.open('deck-storage-fixture', 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('entries')) { db.close(); resolve(null); return; }
            const read = db.transaction('entries').objectStore('entries').get('fixture');
            read.onsuccess = () => { db.close(); resolve(read.result); };
            read.onerror = () => reject(read.error);
          };
        })
      }))()`);
      return { cookies: cookies.map((cookie) => cookie.value), ...storage };
    }, origin);
    expect(values).toEqual({ cookies: ['offline-session-value'], local: 'offline-local-value', db: 'offline-db-value' });
  } finally { if (app) await app.close(); await new Promise((resolve) => server.close(resolve)); }
});

test('列の操作、ネイティブ描画、セッションの分離と再起動後の保持', async () => {
  test.setTimeout(120_000);
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'discorddeck-e2e-'));
  let app;
  try {
    let launched = await launch(data); app = launched.app; let page = launched.page;
    await expect(page.locator('#welcome')).toBeVisible();
    await capture(app, 'welcome.png');
    await add(page, '仕事用'); await add(page, 'プライベート');
    await expect.poll(async () => (await nativeViews(app)).filter((v) => v.visible).length).toBe(2);
    const viewInfo = await nativeViews(app);
    expect(viewInfo[0].bounds.x + viewInfo[0].bounds.width).toBeLessThan(viewInfo[1].bounds.x);
    for (const view of viewInfo) {
      expect(view.bounds.height).toBeGreaterThan(300); expect(view.preferences.nodeIntegration).toBe(false);
      expect(view.preferences.contextIsolation).toBe(true); expect(view.preferences.sandbox).toBe(true); expect(view.preferences.preload).toMatch(/discord-preload\.cjs$/);
    }
    const isolation = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const children = w.contentView.children.filter((v) => v.webContents && v.webContents !== w.webContents);
      await children[0].webContents.session.cookies.set({ url: 'https://discord.com', name: 'deck-isolation-test', value: 'work', expirationDate: Date.now() / 1000 + 3600 });
      await children[1].webContents.session.cookies.set({ url: 'https://discord.com', name: 'deck-isolation-test', value: 'personal', expirationDate: Date.now() / 1000 + 3600 });
      await Promise.all(children.map((v) => v.webContents.session.flushStorageData()));
      return Promise.all(children.map(async (v) => ({
        cookie: (await v.webContents.session.cookies.get({ name: 'deck-isolation-test' }))[0].value,
        globals: await v.webContents.executeJavaScript('({ node: typeof require, bridge: typeof window.deck })'),
      })));
    });
    expect(isolation.map((v) => v.cookie)).toEqual(['work', 'personal']);
    expect(isolation[0].globals).toEqual({ node: 'undefined', bridge: 'undefined' });
    await capture(app, 'two-columns.png');
    await page.getByRole('button', { name: '仕事用の設定', exact: true }).click();
    await expect.poll(async () => (await nativeViews(app)).filter((v) => v.visible).length).toBe(0);
    await page.getByLabel('表示名', { exact: true }).fill('仕事 / 開発');
    await page.locator('#account-muted').check();
    await page.getByRole('button', { name: '変更を保存' }).click();
    await expect(page.getByRole('button', { name: '仕事 / 開発を表示', exact: true })).toBeVisible();
    await expect.poll(async () => (await nativeViews(app))[0].muted).toBe(true);
    await page.getByRole('button', { name: '仕事 / 開発を単独表示・解除', exact: true }).click();
    await expect(page.locator('.panel')).toHaveCount(1);
    await expect.poll(async () => (await nativeViews(app)).filter((v) => v.visible).length).toBe(1);
    await page.getByRole('button', { name: '仕事 / 開発の設定', exact: true }).click();
    await page.getByRole('button', { name: 'この列を縮小', exact: true }).click();
    await expect(page.locator('#settings-zoom')).toHaveText('75%');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await nativeViews(app))[0].zoom).toBeCloseTo(0.75);
    await add(page, 'コミュニティ');
    await page.getByRole('button', { name: '3列で表示', exact: true }).click();
    await expect(page.locator('.panel')).toHaveCount(3);
    await expect.poll(async () => (await nativeViews(app)).filter((v) => v.visible).length).toBe(3);
    await page.getByRole('button', { name: '4分割で表示', exact: true }).click();
    await expect(page.locator('#deck')).toHaveClass(/grid/);
    await capture(app, 'grid.png');
    await app.close(); app = null;
    launched = await launch(data); app = launched.app; page = launched.page;
    await expect(page.locator('.panel')).toHaveCount(3);
    await expect(page.locator('#deck')).toHaveClass(/grid/);
    const persisted = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return Promise.all(w.contentView.children.filter((v) => v.webContents && v.webContents !== w.webContents).map(async (v) => ({
        cookies: (await v.webContents.session.cookies.get({ name: 'deck-isolation-test' })).map((c) => c.value),
        muted: v.webContents.isAudioMuted(), zoom: v.webContents.getZoomFactor(),
      })));
    });
    expect(persisted[0]).toEqual({ cookies: ['work'], muted: true, zoom: 0.75 });
    expect(persisted[1].cookies).toEqual(['personal']);
    const ids = (await page.evaluate(() => window.deck.getState())).accounts.map((a) => a.id);
    await page.getByRole('button', { name: '仕事 / 開発の設定', exact: true }).click();
    await page.getByRole('button', { name: 'この列を削除', exact: true }).click();
    await page.getByRole('button', { name: '列とログイン情報を削除', exact: true }).click();
    await expect(page.locator('#account-dialog')).not.toBeVisible();
    await expect(page.locator('.panel')).toHaveCount(2);
    const removedCookies = await app.evaluate(async ({ session }, id) => session.fromPartition(`persist:discorddeck-${id}`).cookies.get({ name: 'deck-isolation-test' }), ids[0]);
    expect(removedCookies).toEqual([]);
    const otherCookies = await app.evaluate(async ({ session }, id) => session.fromPartition(`persist:discorddeck-${id}`).cookies.get({ name: 'deck-isolation-test' }), ids[1]);
    expect(otherCookies[0].value).toBe('personal');
    const config = JSON.parse(await fs.readFile(path.join(data, 'deck.json'), 'utf8'));
    expect(config.accounts).toHaveLength(2);
  } finally { if (app) await app.close(); }
});

test('表示グループの切り替え、リサイズ、読み込み失敗からの復帰', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'discorddeck-e2e-'));
  const { app, page } = await launch(data);
  try {
    await add(page, 'A'); await add(page, 'B'); await add(page, 'C');
    await expect(page.locator('.panel')).toHaveCount(1);
    await expect(page.locator('#page-label')).toHaveText('3–3 / 3');
    await page.getByRole('button', { name: '前のアカウントを表示', exact: true }).click();
    await expect(page.locator('.panel')).toHaveCount(2);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 740));
    await expect.poll(async () => (await nativeViews(app)).filter((v) => v.visible && v.bounds.width > 100 && v.bounds.height > 100).length).toBe(2);
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const v = w.contentView.children.find((v) => v.webContents && v.webContents !== w.webContents);
      v.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://discord.com', true);
    });
    await expect(page.locator('.panel').first()).toHaveAttribute('data-status', 'error');
    await expect.poll(async () => (await nativeViews(app)).filter((v) => v.visible).length).toBe(1);
    await page.getByRole('button', { name: 'Aを再読み込み', exact: true }).click();
    await expect(page.locator('.panel').first()).toHaveAttribute('data-status', 'ready');
    await expect.poll(async () => (await nativeViews(app)).filter((v) => v.visible).length).toBe(2);
    await page.getByRole('button', { name: '使い方', exact: true }).click();
    await expect(page.locator('#help-dialog')).toBeVisible();
    await expect.poll(async () => (await nativeViews(app)).filter((v) => v.visible).length).toBe(0);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await nativeViews(app)).filter((v) => v.visible).length).toBe(2);
  } finally { await app.close(); }
});
