const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const root = path.join(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'discorddeck-live-'));
  const env = { ...process.env, DISCORDDECK_TEST: '1', DISCORDDECK_LIVE: '1', DISCORDDECK_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30_000 });
    const page = await app.firstWindow();
    await page.waitForSelector('[data-layout][aria-pressed]');
    for (const name of ['接続確認 A', '接続確認 B']) {
      const result = await page.evaluate((name) => window.deck.command({ type: 'add', name }), name);
      if (!result.ok) throw new Error(result.error);
    }
    await page.waitForFunction(() => [...document.querySelectorAll('.panel')].length === 2 && [...document.querySelectorAll('.panel')].every((n) => n.dataset.status === 'ready'), undefined, { timeout: 60_000 });
    const result = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const views = w.contentView.children.filter((v) => v.webContents && v.webContents !== w.webContents);
      return Promise.all(views.map(async (v) => ({ url: v.webContents.getURL(), title: v.webContents.getTitle(), visible: v.getVisible(), isolated: v.webContents.session !== w.webContents.session })));
    });
    if (result.length !== 2 || result.some((r) => !r.url.startsWith('https://discord.com/login') || !r.visible || !r.isolated)) throw new Error(`ログイン画面を確認できませんでした: ${JSON.stringify(result)}`);
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    await fs.writeFile(path.join(root, 'artifacts/live-login.png'), Buffer.from(png, 'base64'));
    await fs.writeFile(path.join(root, 'artifacts/live-result.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log('2列の公式ログイン画面を確認しました。アカウントでのログイン・送受信は行っていません。');
  } finally { if (app) await app.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
