const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/discord-preload.cjs'), 'utf8');
const compactCSS = fs.readFileSync(path.join(__dirname, '../src/discord-compact.css'), 'utf8');

test('公式画面のユーザー欄と未読表示を読み取り、既読・ログアウトを反映する', async ({ page }) => {
  // An offline fixture at the allowed origin; no account or Discord API is accessed.
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>(3) Discord</title><section aria-label="User area"><div class="avatarWrapper_test"><img src="https://cdn.discordapp.com/avatars/123/self.webp"></div></section><nav data-list-id="guildsnav"><span class="numberBadge_test">3</span><div class="pill_test"><span style="height:8px"></span></div></nav><main><img src="https://cdn.discordapp.com/avatars/999/other.webp"><p>この本文は送信しない</p></main>' }));
  await page.addInitScript((source) => {
    window.__metadata = [];
    new Function('require', source)((name) => {
      if (name !== 'electron') throw new Error(name);
      return { ipcRenderer: { on() {}, send: (channel, data) => { if (channel === 'discord:metadata') window.__metadata.push({ channel, data }); } } };
    });
  }, source);
  await page.goto('https://discord.com/channels/@me');
  await expect.poll(() => page.evaluate(() => window.__metadata.at(-1)?.data)).toMatchObject({ avatar: 'https://cdn.discordapp.com/avatars/123/self.webp', unreadCount: 3, hasUnread: true });
  await page.evaluate(() => { document.title = 'Discord'; document.querySelector('.numberBadge_test').remove(); document.querySelector('.pill_test span').style.height = '40px'; });
  await expect.poll(() => page.evaluate(() => window.__metadata.at(-1)?.data.hasUnread)).toBe(false);
  await page.evaluate(() => document.querySelector('section').remove());
  await expect.poll(() => page.evaluate(() => window.__metadata.at(-1)?.data.avatar)).toBe(null);
  expect(await page.evaluate(() => JSON.stringify(window.__metadata).includes('この本文は送信しない'))).toBe(false);
});

async function compactFixture(page, routePath = '/channels/@me') {
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><title>Discord</title><style>
  :root{--custom-app-top-bar-height:32px;--custom-guild-list-width:72px}body{margin:0}.base_test{display:grid;height:100vh;grid-template-columns:var(--custom-guild-list-width) 1fr;grid-template-rows:var(--custom-app-top-bar-height) 1fr}.bar_test{grid-column:1/-1;height:32px}.guilds_test{grid-column:1;grid-row:2;width:var(--custom-guild-list-width)}.content_test{grid-column:2;grid-row:2}
  </style></head><body><div class="base_test"><div class="bar_test"><div class="title_test">ダイレクトメッセージ</div></div><div class="guilds_test"><div data-list-item-id="guildsnav___home"><a href="/channels/@me">DM</a></div><div data-list-id="guildsnav"><div data-list-item-id="guildsnav___123"><a data-dnd-name="開発サーバー" href="/channels/123/456">開発</a></div><div data-list-item-id="guildsnav___folder_99" aria-label="趣味"><button id="folder-button">フォルダ</button></div></div></div><section class="content_test"><div class="privateChannels_test"><a href="/channels/@me/987" aria-label="友だち">友だち</a></div><main>このメッセージ本文は送らない</main></section></div></body></html>` }));
  await page.addInitScript((source) => {
    const handlers = {};
    window.__messages = [];
    window.__deliver = (channel, value) => handlers[channel]?.({}, value);
    new Function('require', source)(() => ({ ipcRenderer: { on: (channel, callback) => { handlers[channel] = callback; }, send: (channel, value) => window.__messages.push({ channel, value }) } }));
  }, source);
  await page.goto(`https://discord.com${routePath}`);
  await page.addStyleTag({ content: compactCSS });
  await page.evaluate(() => {
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a');
      if (link) { event.preventDefault(); history.pushState({}, '', link.getAttribute('href')); document.querySelector('.title_test').textContent = link.textContent; }
    });
    document.querySelector('#folder-button').addEventListener('click', () => {
      const item = document.createElement('div'); item.dataset.listItemId = 'guildsnav___456'; item.setAttribute('aria-label', 'ゲーム'); item.innerHTML = '<a href="/channels/456/789">ゲーム</a>';
      document.querySelector('[data-list-id="guildsnav"]').append(item);
    });
    window.__deliver('discord:options', { compactHeader: true, compactServers: true });
  });
}

test('Discordの上部と一覧をまとめて余白を詰め、元の画面でサーバー・DMを移動できる', async ({ page }) => {
  await compactFixture(page);
  await expect(page.locator('html')).toHaveAttribute('data-discorddeck-hide-header', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-discorddeck-hide-servers', 'true');
  await expect(page.locator('.bar_test')).toBeHidden(); await expect(page.locator('.guilds_test')).toBeHidden();
  const layout = await page.locator('.content_test').boundingBox();
  expect(layout.x).toBe(0); expect(layout.y).toBe(0);
  const retainedSize = await page.locator('.guilds_test').evaluate((node) => ({ width: node.clientWidth, height: node.clientHeight }));
  expect(retainedSize.width).toBe(72); expect(retainedSize.height).toBeGreaterThan(500);
  const metadata = () => page.evaluate(() => window.__messages.findLast((item) => item.channel === 'discord:metadata')?.value);
  await expect.poll(async () => (await metadata())?.navigation.map((item) => item.key)).toEqual(['home', 'guild:123', 'folder:99']);
  expect((await metadata()).navigation.find((item) => item.key === 'guild:123').label).toBe('開発サーバー');
  expect((await metadata()).channelTitle).toBe('ダイレクトメッセージ');
  await page.evaluate(() => window.__deliver('discord:navigate', { key: 'guild:123', serial: 1 }));
  await expect(page).toHaveURL('https://discord.com/channels/123/456');
  await expect.poll(async () => (await metadata())?.channelTitle).toBe('開発');
  await page.evaluate(() => window.__deliver('discord:navigate', { key: 'folder:99', serial: 2 }));
  await expect.poll(async () => (await metadata())?.navigation.some((item) => item.key === 'guild:456')).toBe(true);
  await page.evaluate(() => window.__deliver('discord:navigate', { key: 'dm:987', serial: 3 }));
  await expect(page).toHaveURL('https://discord.com/channels/123/456');
  await page.evaluate(() => window.__deliver('discord:navigate', { key: 'home', serial: 4 }));
  await expect(page).toHaveURL('https://discord.com/channels/@me');
  await page.evaluate(() => window.__deliver('discord:options', { compactHeader: false, compactServers: false }));
  await expect(page.locator('.bar_test')).toBeVisible(); await expect(page.locator('.guilds_test')).toBeVisible();
  const restored = await page.locator('.content_test').boundingBox(); expect(restored.x).toBe(72); expect(restored.y).toBe(32);
  expect(JSON.stringify(await metadata()).includes('このメッセージ本文は送らない')).toBe(false);
});

test('ログインページは統合表示にせず、不明な移動先はクリックしない', async ({ page }) => {
  await compactFixture(page, '/login');
  await expect(page.locator('html')).toHaveAttribute('data-discorddeck-hide-header', 'false');
  await expect(page.locator('.bar_test')).toBeVisible(); await expect(page.locator('.guilds_test')).toBeVisible();
  await page.evaluate(() => window.__deliver('discord:navigate', { key: 'guild:999', serial: 10 }));
  const result = await page.evaluate(() => window.__messages.findLast((item) => item.channel === 'discord:navigation-result')?.value);
  expect(result).toEqual({ key: 'guild:999', serial: 10, ok: false });
  await expect(page).toHaveURL('https://discord.com/login');
});

test('実際のアイコン構造に合わせ、親の名前・読み上げ用テキスト・後から見つかった名前を取得する', async ({ page }) => {
  await compactFixture(page);
  await page.evaluate(() => {
    document.querySelector('[data-list-id="guildsnav"]').innerHTML = `
      <div data-dnd-name="正式なサーバー名"><div role="treeitem" data-list-item-id="guildsnav___111"><span class="hiddenVisually_b18fe2">正式なサーバー名, 未読があります</span><img alt=" "></div></div>
      <div role="treeitem" data-list-item-id="guildsnav___222"><span class="hiddenVisually_b18fe2">読み上げ用の名前</span><div aria-hidden="true">読名</div><img alt=" "></div>
      <div data-list-item-id="guildsnav___333"><div role="treeitem" aria-labelledby="referenced-server"><img alt=" "></div></div><span id="referenced-server">参照されたサーバー名</span>
      <div data-list-item-id="guildsnav___444"></div><div data-dnd-name="後から取得した名前"><div role="treeitem" data-list-item-id="guildsnav___444"></div></div>
      <div role="treeitem" data-list-item-id="guildsnav___555"><span class="hiddenVisually_b18fe2">2026</span><img alt=" "></div>
      <div data-dnd-name="共有フォルダ"><div role="treeitem" data-list-item-id="guildsnav___666"><span class="hiddenVisually_b18fe2">サーバーA</span></div><div role="treeitem" data-list-item-id="guildsnav___777"><span class="hiddenVisually_b18fe2">サーバーB</span></div></div>`;
  });
  const names = () => page.evaluate(() => window.__messages.findLast((item) => item.channel === 'discord:metadata')?.value.navigation.filter((item) => item.kind === 'guild').map((item) => item.label));
  await expect.poll(names).toEqual(['正式なサーバー名', '読み上げ用の名前', '参照されたサーバー名', '後から取得した名前', '2026', 'サーバーA', 'サーバーB']);
  await page.evaluate(() => { document.querySelector('[data-list-item-id="guildsnav___222"] span').textContent = '変更後の名前'; });
  await expect.poll(async () => (await names())[1]).toBe('変更後の名前');
});
