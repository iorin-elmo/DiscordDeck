const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');

// Exercise the actual main-process command and security logic with an Electron API double.
// Native Chromium, cookie persistence and view rendering require tests/app.spec.cjs on an OS that allows Electron.
async function boot(options = {}) {
  const data = options.data || fs.mkdtempSync(path.join(os.tmpdir(), 'discorddeck-main-'));
  if (options.initialState) fs.writeFileSync(path.join(data, 'deck.json'), JSON.stringify(options.initialState), 'utf8');
  const handlers = new Map(); const listeners = new Map(); const sessions = new Map(); const windows = []; const links = [];
  class Contents extends EventEmitter {
    constructor(preferences = {}) { super(); this.preferences = preferences; this.session = preferences.session ?? getSession('shell'); this.mainFrame = { url: '' }; this.destroyed = false; }
    setZoomFactor(value) { this.zoom = value; }
    setAudioMuted(value) { this.muted = value; }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
    getURL() { return this.mainFrame.url; }
    async loadURL(url) { this.mainFrame.url = url; this.emit('did-start-loading'); queueMicrotask(() => this.emit('did-finish-load')); }
    send(channel, value) { this.messages ??= []; this.messages.push({ channel, value }); }
    async insertCSS(css) { this.insertedCSS = css; return 'style'; }
    reload() { this.reloaded = true; }
    close() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }
  function getSession(key) {
    if (sessions.has(key)) return sessions.get(key);
    const ses = new EventEmitter();
    ses.cookies = new EventEmitter();
    ses.cookies.flushStore = async () => { ses.cookieFlushes = (ses.cookieFlushes || 0) + 1; };
    Object.assign(ses, {
      flushStorageData() { this.storageFlushes = (this.storageFlushes || 0) + 1; },
      setPermissionCheckHandler(fn) { this.check = fn; }, setPermissionRequestHandler(fn) { this.request = fn; }, setDevicePermissionHandler(fn) { this.device = fn; },
      async closeAllConnections() { this.disconnected = true; }, async clearStorageData() { this.storageCleared = true; }, async clearCache() { this.cacheCleared = true; },
    });
    sessions.set(key, ses); return ses;
  }
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new Contents(options.webPreferences);
      this.fullscreen = options.fullscreen === true;
      this.contentView = { children: [], addChildView(view) { this.children.push(view); }, removeChildView(view) { this.children = this.children.filter((v) => v !== view); } };
      windows.push(this);
    }
    removeMenu() {} show() {} focus() {} restore() {}
    isFocused() { return this.focused !== false; }
    isDestroyed() { return false; } isMinimized() { return false; } isMaximized() { return false; }
    isFullScreen() { return this.fullscreen; }
    setFullScreen(value) { if (this.fullscreen === value) return; this.fullscreen = value; this.emit('resize'); this.emit(value ? 'enter-full-screen' : 'leave-full-screen'); }
    getNormalBounds() { return { width: this.options.width, height: this.options.height }; }
    getBounds() { return this.fullscreen ? { width: 1920, height: 1080 } : this.getNormalBounds(); }
    getContentBounds() { return this.getBounds(); }
    async loadFile(file) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href; }
  }
  class View {
    constructor(options) { this.webContents = new Contents(options.webPreferences); }
    setBackgroundColor() {} setBorderRadius(value) { this.radius = value; } setVisible(value) { this.visible = value; } setBounds(value) { this.bounds = value; }
  }
  const app = new EventEmitter();
  app.paths = new Map();
  Object.assign(app, { userAgentFallback: `Mozilla/5.0 DiscordDeck/${options.version || '0.6.1'} Chrome/150.0.0.0 Electron/45.1.0`, setName() {}, setPath(name, value) { this.paths.set(name, value); }, getPath: () => data, isPackaged: false, requestSingleInstanceLock: () => true, whenReady: async () => {}, quit() { this.quitCalls = (this.quitCalls || 0) + 1; } });
  const electron = {
    app, BrowserWindow: Window, WebContentsView: View, session: { fromPartition: getSession }, Menu: { setApplicationMenu() {} },
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), on: (key, fn) => listeners.set(key, fn) },
    dialog: { async showMessageBox() { return { response: 1 }; }, showErrorBox(_title, message) { throw new Error(message); } },
    shell: { async openExternal(url) { links.push(url); }, async openPath() {} },
    safeStorage: {
      async isAsyncEncryptionAvailable() { return true; },
      async encryptStringAsync(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
      async decryptStringAsync(bytes) { const cipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 7), bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return { result: Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'), shouldReEncrypt: false }; },
    },
  };
  const mainPath = path.join(__dirname, '../src/main.cjs'); const realRequire = createRequire(mainPath);
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
    require: (name) => name === 'electron' ? electron : name === './external-app.cjs' ? { resolveExternalApp: options.resolveExternalApp ?? (async () => ({ key: '1'.repeat(64), name: 'ブラウザ' })) } : realRequire(name), __dirname: path.dirname(mainPath),
    process: { env: { DISCORDDECK_TEST: '1' } }, Buffer, URL, console, setTimeout, clearTimeout,
  }, { filename: mainPath });
  await new Promise(setImmediate);
  const win = windows[0];
  assert.ok(win);
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  return {
    data, win, sessions, handlers, listeners, event, links, electron,
    get: () => handlers.get('deck:get')(event),
    command: (value) => handlers.get('deck:command')(event, value),
    cleanup: () => { app.emit('before-quit', { preventDefault() {} }); win.emit('closed'); },
  };
}

test('ログイン情報を保存・変更・削除し、対応する公式ログイン画面にだけ返す', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' }); await ctx.command({ type: 'add', name: 'B' });
    const [a, b] = ctx.get().accounts;
    const wc = ctx.win.contentView.children[0].webContents, other = ctx.win.contentView.children[1].webContents;
    const request = () => ctx.handlers.get('discord:credentials')({ sender: wc, senderFrame: wc.mainFrame });
    assert.equal((await ctx.command({ type: 'credentials-save', id: a.id, email: 'first@example.invalid', password: 'fixture-password-A', enabled: true })).ok, true);
    assert.equal(ctx.get().accounts[0].credentialsSaved, true);
    assert.equal(JSON.stringify(ctx.get()).includes('fixture-password'), false);
    assert.equal(JSON.stringify(ctx.get()).includes('first@example.invalid'), false);
    assert.equal(fs.readFileSync(path.join(ctx.data, 'deck.json'), 'utf8').includes('fixture-password'), false);
    assert.equal(fs.readFileSync(path.join(ctx.data, 'login-credentials.json'), 'utf8').includes('fixture-password'), false);
    wc.mainFrame.url = 'https://discord.com/login?redirect_to=%2Fchannels%2F%40me';
    assert.equal((await request()).email, 'first@example.invalid');
    const subframe = { sender: wc, senderFrame: { url: wc.mainFrame.url } };
    assert.equal(await ctx.handlers.get('discord:credentials')(subframe), null);
    assert.equal(await ctx.handlers.get('discord:credentials')(ctx.event), null);
    other.mainFrame.url = 'https://discord.com/login';
    assert.equal(await ctx.handlers.get('discord:credentials')({ sender: other, senderFrame: other.mainFrame }), null);
    for (const url of ['https://evil.test/login', 'https://discord.com/register', 'https://discord.com/channels/@me']) { wc.mainFrame.url = url; assert.equal(await request(), null); }
    wc.mainFrame.url = 'https://discord.com/login';
    await ctx.command({ type: 'credentials-save', id: a.id, email: 'changed@example.invalid', password: 'fixture-password-B', enabled: true });
    assert.equal((await request()).password, 'fixture-password-B');
    await ctx.command({ type: 'credentials-save', id: a.id, email: '', password: '', enabled: false });
    assert.equal(await request(), null); assert.equal(ctx.get().accounts[0].credentialsSaved, true);
    await ctx.command({ type: 'credentials-delete', id: a.id });
    assert.equal(await request(), null); assert.equal(ctx.get().accounts[0].credentialsSaved, false);
    assert.equal(ctx.get().accounts[1].id, b.id);
  } finally { ctx.cleanup(); }
});

test('復号中の画面移動・削除で認証情報を返さず、暗号化不可時は平文保存しない', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' });
    const id = ctx.get().accounts[0].id, wc = ctx.win.contentView.children[0].webContents;
    await ctx.command({ type: 'credentials-save', id, email: 'first@example.invalid', password: 'fixture-password-A', enabled: true });
    wc.mainFrame.url = 'https://discord.com/login';
    let finish;
    ctx.electron.safeStorage.decryptStringAsync = () => new Promise((resolve) => { finish = resolve; });
    const pending = ctx.handlers.get('discord:credentials')({ sender: wc, senderFrame: wc.mainFrame });
    await new Promise(setImmediate);
    wc.mainFrame.url = 'https://discord.com/channels/@me';
    finish({ result: JSON.stringify({ id, email: 'first@example.invalid', password: 'fixture-password-A' }) });
    assert.equal(await pending, null);
    wc.mainFrame.url = 'https://discord.com/login';
    const removed = ctx.handlers.get('discord:credentials')({ sender: wc, senderFrame: wc.mainFrame });
    await new Promise(setImmediate);
    await ctx.command({ type: 'credentials-delete', id });
    finish({ result: JSON.stringify({ id, email: 'first@example.invalid', password: 'fixture-password-A' }) });
    assert.equal(await removed, null);
    ctx.electron.safeStorage.isAsyncEncryptionAvailable = async () => false;
    const result = await ctx.command({ type: 'credentials-save', id, email: 'first@example.invalid', password: 'fixture-password-A', enabled: true });
    assert.equal(result.ok, false); assert.equal(ctx.get().accounts[0].credentialsSaved, false);
    assert.equal(fs.readFileSync(path.join(ctx.data, 'login-credentials.json'), 'utf8').includes('fixture-password'), false);
  } finally { ctx.cleanup(); }
});

test('列の削除時は、その列の保存ログイン情報も削除する', async () => {
  const ctx = await boot();
  try {
    for (const name of ['A', 'B']) await ctx.command({ type: 'add', name });
    const [a, b] = ctx.get().accounts;
    for (const entry of [a, b]) await ctx.command({ type: 'credentials-save', id: entry.id, email: `${entry.name}@example.invalid`, password: 'fixture-password', enabled: true });
    assert.equal((await ctx.command({ type: 'remove', id: a.id })).ok, true);
    const raw = JSON.parse(fs.readFileSync(path.join(ctx.data, 'login-credentials.json'), 'utf8'));
    assert.equal(raw.entries[a.id], undefined); assert.ok(raw.entries[b.id]);
  } finally { ctx.cleanup(); }
});

test('アプリ更新で保存先・列のセッション識別子・ブラウザ識別文字列を変えない', async () => {
  const first = await boot({ version: '0.6.1' });
  let second;
  try {
    await first.command({ type: 'add', name: 'A' });
    const ids = first.get().accounts.map((a) => a.id);
    const ua = first.electron.app.userAgentFallback;
    first.cleanup(); await new Promise(setImmediate);
    second = await boot({ data: first.data, version: '0.7.0' });
    assert.equal(second.get().accounts.map((a) => a.id).join(), ids.join());
    assert.equal([...second.sessions.keys()].filter((key) => key.startsWith('persist:')).join(), [...first.sessions.keys()].filter((key) => key.startsWith('persist:')).join());
    assert.equal(second.electron.app.paths.get('userData'), first.data);
    assert.equal(second.electron.app.paths.get('sessionData'), first.data);
    assert.equal(second.electron.app.userAgentFallback, ua);
  } finally { if (second) second.cleanup(); else first.cleanup(); }
});

test('ウィンドウを閉じる前に全セッションを保存し、Cookie書き込みの完了を待つ', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' }); await ctx.command({ type: 'add', name: 'B' });
    const entries = ctx.win.contentView.children;
    let finish;
    entries[1].webContents.session.cookies.flushStore = () => new Promise((resolve) => { finish = resolve; });
    let prevented = 0;
    ctx.win.emit('close', { preventDefault() { prevented++; } });
    assert.equal(prevented, 1);
    assert.equal(ctx.electron.app.quitCalls || 0, 0);
    for (const entry of entries) { assert.equal(entry.webContents.destroyed, false); assert.equal(entry.webContents.session.storageFlushes, 1); }
    ctx.electron.app.emit('before-quit', { preventDefault() { prevented++; } });
    assert.equal(prevented, 2);
    assert.equal(entries[0].webContents.session.storageFlushes, 1);
    assert.equal((await ctx.command({ type: 'add', name: '終了中の追加' })).ok, false);
    finish(); await new Promise(setImmediate);
    assert.equal(ctx.electron.app.quitCalls, 1);
    assert.equal(entries[0].webContents.session.cookieFlushes, 1);
    ctx.win.emit('close', { preventDefault() { prevented++; } }); assert.equal(prevented, 2);
  } finally { ctx.cleanup(); }
});

test('一つの保存失敗で他のセッションの保存や終了を止めない', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' }); await ctx.command({ type: 'add', name: 'B' });
    const entries = ctx.win.contentView.children;
    entries[0].webContents.session.cookies.flushStore = async () => { throw new Error('disk unavailable'); };
    ctx.win.emit('close', { preventDefault() {} }); await new Promise(setImmediate);
    assert.equal(entries[1].webContents.session.cookieFlushes, 1);
    assert.equal(ctx.electron.app.quitCalls, 1);
  } finally { ctx.cleanup(); }
});

test('フルスクリーンの保存・解除・再起動と通常サイズの保持で列を作り直さない', async () => {
  const ctx = await boot();
  let restarted;
  try {
    await ctx.command({ type: 'add', name: 'A' });
    const view = ctx.win.contentView.children[0];
    const id = ctx.get().accounts[0].id;
    const normal = ctx.win.getBounds();
    assert.equal(ctx.get().settings.fullscreen, false);
    assert.equal((await ctx.command({ type: 'settings', settings: { ...ctx.get().settings, fullscreen: true } })).ok, true);
    assert.equal(ctx.win.isFullScreen(), true);
    assert.equal(ctx.win.contentView.children[0], view);
    assert.equal(view.webContents.destroyed, false);
    assert.equal(ctx.get().window.width, normal.width); assert.equal(ctx.get().window.height, normal.height);
    assert.equal((await ctx.command({ type: 'settings', settings: { ...ctx.get().settings, fullscreen: 'true' } })).ok, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.data, 'deck.json'), 'utf8')).settings.fullscreen, true);
    ctx.cleanup(); await new Promise(setImmediate);
    restarted = await boot({ data: ctx.data });
    assert.equal(restarted.win.isFullScreen(), true); assert.equal(restarted.win.options.fullscreen, true);
    assert.equal(restarted.get().accounts[0].id, id);
    await restarted.command({ type: 'settings', settings: { ...restarted.get().settings, fullscreen: false } });
    assert.equal(restarted.win.isFullScreen(), false);
    assert.equal(restarted.get().window.width, normal.width); assert.equal(restarted.get().window.height, normal.height);
  } finally { if (restarted) restarted.cleanup(); else ctx.cleanup(); }
});

test('F11を管理画面とDiscordの両方で扱い、修飾キーと連打を無視して設定と表示領域を同期する', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' });
    const wc = ctx.win.contentView.children[0].webContents;
    const key = { type: 'keyDown', key: 'F11' }; let prevented = 0;
    const event = { preventDefault() { prevented++; } };
    for (const patch of [{ type: 'keyUp' }, { isAutoRepeat: true }, { control: true }, { alt: true }, { meta: true }, { shift: true }]) ctx.win.webContents.emit('before-input-event', event, { ...key, ...patch });
    assert.equal(prevented, 0); assert.equal(ctx.win.isFullScreen(), false);
    ctx.win.webContents.emit('before-input-event', event, key);
    assert.equal(prevented, 1); assert.equal(ctx.get().settings.fullscreen, true); assert.equal(ctx.win.isFullScreen(), true);
    wc.emit('before-input-event', event, key);
    assert.equal(prevented, 2); assert.equal(ctx.get().settings.fullscreen, false); assert.equal(ctx.win.isFullScreen(), false);
    // Native/OS transitions also update the setting and ask the shell to recompute native bounds.
    ctx.win.setFullScreen(true);
    assert.equal(ctx.get().settings.fullscreen, true);
    assert.equal(ctx.win.webContents.messages.at(-1).channel, 'deck:layout');
    const entry = ctx.get().accounts[0];
    ctx.listeners.get('deck:modal')(ctx.event, true);
    ctx.listeners.get('deck:bounds')(ctx.event, [{ id: entry.id, x: 80, y: 50, width: 1800, height: 1000 }]);
    assert.equal(ctx.win.contentView.children[0].visible, false);
  } finally { ctx.cleanup(); }
});

test('本体設定を保存し、通知音を通話全体のミュートから分離する', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' });
    const settings = { fullscreen: false, notificationSound: false, hideOnBlur: true, inputDevice: { label: 'USBマイク', ordinal: 0 }, outputDevice: { label: 'USBスピーカー', ordinal: 1 } };
    assert.equal((await ctx.command({ type: 'settings', settings })).ok, true);
    const saved = JSON.parse(fs.readFileSync(path.join(ctx.data, 'deck.json'), 'utf8'));
    assert.deepEqual(saved.settings, settings);
    const contents = ctx.win.contentView.children[0].webContents;
    assert.equal(contents.muted, false);
    assert.equal(contents.messages.at(-1).channel, 'discord:options');
    assert.equal(contents.messages.at(-1).value.media.notificationSound, false);
    contents.mainFrame.url = 'https://discord.com/channels/@me';
    const early = { sender: contents, senderFrame: contents.mainFrame };
    ctx.listeners.get('discord:media-options')(early);
    assert.equal(early.returnValue.notificationSound, false);
    const outsider = { sender: contents, senderFrame: { url: contents.mainFrame.url } };
    ctx.listeners.get('discord:media-options')(outsider); assert.equal(outsider.returnValue, null);
    assert.equal((await ctx.command({ type: 'settings', settings: { ...settings, inputDevice: { label: 'bad', ordinal: -1 } } })).ok, false);
    assert.equal(ctx.get().settings.inputDevice.label, 'USBマイク');
  } finally { ctx.cleanup(); }
});

test('フォーカスを外すと列を隠し、古い描画要求を拒否し、戻ると復帰できる', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' });
    await ctx.command({ type: 'settings', settings: { ...ctx.get().settings, hideOnBlur: true } });
    const entry = ctx.get().accounts[0], view = ctx.win.contentView.children[0];
    const rects = [{ id: entry.id, x: 100, y: 50, width: 600, height: 500 }];
    ctx.listeners.get('deck:bounds')(ctx.event, rects); assert.equal(view.visible, true);
    ctx.win.focused = false; ctx.win.emit('blur');
    assert.equal(ctx.get().privacyHidden, true); assert.equal(view.visible, false);
    ctx.listeners.get('deck:bounds')(ctx.event, rects); assert.equal(view.visible, false);
    assert.equal(view.webContents.messages.at(-1).value.media.privacyHidden, true);
    ctx.win.focused = true; ctx.win.emit('focus');
    assert.equal(ctx.get().privacyHidden, false);
    ctx.listeners.get('deck:bounds')(ctx.event, rects); assert.equal(view.visible, true);
    ctx.win.focused = false; ctx.win.emit('blur');
    await ctx.command({ type: 'settings', settings: { ...ctx.get().settings, hideOnBlur: false } });
    ctx.listeners.get('deck:bounds')(ctx.event, rects); assert.equal(view.visible, true);
  } finally { ctx.cleanup(); }
});

test('機器一覧の取得許可は設定モーダル中のローカル画面の音声要求だけに限定する', async () => {
  const ctx = await boot();
  try {
    const contents = ctx.win.webContents, ses = contents.session;
    const details = { requestingUrl: contents.getURL(), mediaTypes: ['audio'] };
    const request = async (sender = contents, value = details) => { let allowed; await ses.request(sender, 'media', (ok) => { allowed = ok; }, value); return allowed; };
    ctx.electron.dialog.showMessageBox = async () => ({ response: 0 });
    assert.equal(await request(), false);
    assert.equal((await ctx.command({ type: 'begin-device-scan' })).ok, false);
    ctx.listeners.get('deck:modal')(ctx.event, true);
    assert.equal((await ctx.command({ type: 'begin-device-scan' })).ok, true);
    assert.equal(await request(contents, { ...details, mediaTypes: ['video'] }), false);
    assert.equal(await request(contents, { ...details, requestingUrl: 'https://evil.test' }), false);
    assert.equal(await request({ mainFrame: contents.mainFrame }), false);
    assert.equal(await request(), true);
    assert.equal(ses.check(contents, 'media', 'file://', { mediaType: 'audio' }), true);
    assert.equal(ses.check(contents, 'media', 'file://', { mediaType: 'video' }), false);
    await ctx.command({ type: 'end-device-scan' });
    assert.equal(await request(), false);
    assert.equal(ses.check(contents, 'media', 'file://', { mediaType: 'audio' }), false);
  } finally { ctx.cleanup(); }
});

test('メイン処理は追加した列ごとに別セッションを割り当て、設定をUTF-8で保存する', async () => {
  const ctx = await boot();
  try {
    assert.equal((await ctx.command({ type: 'add', name: '仕事用' })).ok, true);
    assert.equal((await ctx.command({ type: 'add', name: '私用' })).ok, true);
    const entries = ctx.get().accounts;
    const views = ctx.win.contentView.children;
    assert.equal(views.length, 2); assert.notEqual(views[0].webContents.session, views[1].webContents.session);
    assert.equal(views[0].radius, 9);
    assert.equal(path.basename(views[0].webContents.preferences.preload), 'discord-preload.cjs');
    assert.equal(views[0].webContents.preferences.nodeIntegration, false);
    assert.equal(views[0].webContents.preferences.sandbox, true);
    const stored = JSON.parse(fs.readFileSync(path.join(ctx.data, 'deck.json'), 'utf8'));
    assert.deepEqual(stored.accounts.map((a) => a.name), ['仕事用', '私用']);
    assert.equal(stored.accounts[0].id, entries[0].id);
    assert.equal((await ctx.command({ type: 'update', id: entries[0].id, name: '開発', color: entries[0].color, muted: true, notifications: true })).ok, true);
    assert.equal(views[0].webContents.muted, true);
    assert.equal(views[1].webContents.muted, false);
  } finally { ctx.cleanup(); }
});

test('リモート画面・サブフレーム・遷移後の画面からのIPCを拒否する', async () => {
  const ctx = await boot();
  try {
    const handler = ctx.handlers.get('deck:command');
    await assert.rejects(() => handler({ sender: {}, senderFrame: ctx.event.senderFrame }, { type: 'add', name: '不正' }), /許可/);
    await assert.rejects(() => handler({ sender: ctx.event.sender, senderFrame: { url: ctx.event.senderFrame.url } }, { type: 'add', name: '不正' }), /許可/);
    ctx.event.senderFrame.url = 'https://discord.com';
    await assert.rejects(() => handler(ctx.event, { type: 'add', name: '不正' }), /許可/);
    assert.equal(ctx.win.contentView.children.length, 0);
  } finally { ctx.cleanup(); }
});

test('通知権限は明示的に許可した列のDiscordだけに与え、デバイスは許可しない', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: '仕事用' });
    const entry = ctx.get().accounts[0]; const contents = ctx.win.contentView.children[0].webContents; const ses = contents.session;
    contents.mainFrame.url = 'https://discord.com/channels/@me';
    assert.equal(ses.check(contents, 'notifications', 'https://discord.com'), false);
    await ctx.command({ type: 'update', id: entry.id, name: entry.name, color: entry.color, notifications: true });
    assert.equal(ses.check(contents, 'notifications', 'https://discord.com'), true);
    assert.equal(ses.check(contents, 'notifications', 'https://discord.com.evil.test'), false);
    assert.equal(ses.check({}, 'notifications', 'https://discord.com'), false);
    assert.equal(ses.check(contents, 'media', 'https://discord.com'), false);
    assert.equal(ses.device({}), false);
    let result;
    ses.request(contents, 'notifications', (value) => { result = value; }, { requestingUrl: 'https://evil.test' });
    assert.equal(result, false);
  } finally { ctx.cleanup(); }
});

test('モーダル中は古い描画要求でもネイティブの列を表示しない', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: '仕事用' });
    const entry = ctx.get().accounts[0]; const view = ctx.win.contentView.children[0];
    const rects = [{ id: entry.id, x: 100, y: 200, width: 700, height: 600 }];
    ctx.listeners.get('deck:bounds')(ctx.event, rects);
    assert.equal(view.visible, true);
    ctx.listeners.get('deck:modal')(ctx.event, true);
    ctx.listeners.get('deck:bounds')(ctx.event, rects);
    assert.equal(view.visible, false);
    ctx.listeners.get('deck:modal')(ctx.event, false);
    ctx.listeners.get('deck:bounds')(ctx.event, rects);
    assert.equal(view.visible, true);
  } finally { ctx.cleanup(); }
});

test('列を削除すると対象だけの保存データとキャッシュを消す', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: '仕事用' }); await ctx.command({ type: 'add', name: '私用' });
    const [a, b] = ctx.get().accounts;
    const removed = ctx.win.contentView.children[0].webContents;
    const other = ctx.win.contentView.children[1].webContents;
    assert.equal((await ctx.command({ type: 'remove', id: a.id })).ok, true);
    assert.equal(removed.destroyed, true); assert.equal(removed.session.storageCleared, true); assert.equal(removed.session.cacheCleared, true);
    assert.equal(other.destroyed, false); assert.equal(other.session.storageCleared, undefined);
    assert.equal(ctx.get().accounts.length, 1); assert.equal(ctx.get().activeId, b.id);
  } finally { ctx.cleanup(); }
});

test('並べ替えの保存でログインセッションを作り直さない', async () => {
  const ctx = await boot();
  try {
    for (const name of ['A', 'B', 'C']) await ctx.command({ type: 'add', name });
    const entries = ctx.get().accounts; const views = [...ctx.win.contentView.children];
    assert.equal((await ctx.command({ type: 'reorder', id: entries[2].id, targetId: entries[0].id, placement: 'before' })).ok, true);
    assert.equal(ctx.get().accounts.map((a) => a.name).join(','), 'C,A,B');
    assert.equal(ctx.win.contentView.children[0], views[0]);
    assert.equal(ctx.win.contentView.children[2], views[2]);
    const stored = JSON.parse(fs.readFileSync(path.join(ctx.data, 'deck.json'), 'utf8'));
    assert.deepEqual(stored.accounts.map((a) => a.id), [entries[2].id, entries[0].id, entries[1].id]);
  } finally { ctx.cleanup(); }
});

test('本人のDiscordメインフレームからの未読とアイコンだけを受け付ける', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' }); await ctx.command({ type: 'add', name: 'B' });
    const contents = ctx.win.contentView.children[0].webContents; contents.mainFrame.url = 'https://discord.com/channels/@me';
    const event = { sender: contents, senderFrame: contents.mainFrame };
    const handler = ctx.listeners.get('discord:metadata');
    const value = { avatar: 'https://cdn.discordapp.com/avatars/123/test.webp', unreadCount: 3, hasUnread: true };
    handler(event, value);
    assert.equal(ctx.get().accounts[0].unreadCount, 3); assert.equal(ctx.get().accounts[1].unreadCount, undefined);
    assert.equal(ctx.get().accounts[0].discordAvatar, 'https://cdn.discordapp.com/avatars/123/test.webp?size=128');
    handler(ctx.event, { ...value, unreadCount: 99 });
    handler({ sender: contents, senderFrame: { url: contents.mainFrame.url } }, { ...value, unreadCount: 98 });
    handler(event, { ...value, avatar: 'https://evil.test/x.png', unreadCount: 97 });
    assert.equal(ctx.get().accounts[0].unreadCount, 97);
    assert.equal(ctx.get().accounts[0].discordAvatar, 'https://cdn.discordapp.com/avatars/123/test.webp?size=128');
    handler(event, { avatar: null, unreadCount: 0, hasUnread: false });
    assert.equal(ctx.get().accounts[0].hasUnread, false); assert.equal(ctx.get().accounts[0].discordAvatar, null);
  } finally { ctx.cleanup(); }
});

test('通話はアカウントごとに確認し、カメラ・別オリジン・画面共有を一括許可しない', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' }); await ctx.command({ type: 'add', name: 'B' });
    const entries = ctx.get().accounts;
    const contents = ctx.win.contentView.children[0].webContents; const other = ctx.win.contentView.children[1].webContents;
    contents.mainFrame.url = 'https://discord.com/channels/@me'; other.mainFrame.url = contents.mainFrame.url;
    const ses = contents.session; let prompts = 0;
    ctx.electron.dialog.showMessageBox = async () => { prompts++; return { response: 0 }; };
    const request = (permission, details) => new Promise((resolve) => ses.request(contents, permission, resolve, { requestingUrl: 'https://discord.com', ...details }));
    assert.equal(ses.check(contents, 'media', 'https://discord.com', { mediaType: 'audio' }), false);
    assert.equal(await request('media', { mediaTypes: ['video'] }), false); assert.equal(prompts, 0);
    assert.equal(await request('media', { mediaTypes: ['audio'] }), true); assert.equal(prompts, 1);
    assert.equal(ses.check(contents, 'media', 'https://discord.com', { mediaType: 'audio' }), true);
    assert.equal(other.session.check(other, 'media', 'https://discord.com', { mediaType: 'audio' }), false);
    assert.equal(await request('media', { mediaTypes: ['audio'], requestingUrl: 'https://evil.test' }), false);
    assert.equal(await request('display-capture', { mediaTypes: ['video'] }), false);
    assert.equal(await request('media', { mediaTypes: ['audio'] }), true); assert.equal(prompts, 1);
    await ctx.command({ type: 'update', id: entries[0].id, name: 'A', color: entries[0].color, microphone: false });
    assert.equal(await request('media', { mediaTypes: ['audio'] }), false); assert.equal(contents.reloaded, true);
  } finally { ctx.cleanup(); }
});

test('取得済みの移動先だけを対応する列で操作し、失敗時には元の一覧を復元する', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' }); await ctx.command({ type: 'add', name: 'B' });
    const [a, b] = ctx.get().accounts;
    const contents = ctx.win.contentView.children[0].webContents;
    contents.mainFrame.url = 'https://discord.com/channels/@me';
    const event = { sender: contents, senderFrame: contents.mainFrame };
    ctx.listeners.get('discord:ready')(event); await new Promise(setImmediate);
    assert.ok(contents.insertedCSS.includes('data-discorddeck-hide-header'));
    ctx.listeners.get('discord:metadata')(event, { avatar: null, unreadCount: 0, hasUnread: false, channelTitle: 'ダイレクトメッセージ', navigation: [{ key: 'guild:123', label: 'サーバーA' }] });
    contents.emit('page-title-updated', {}, '(3) Discord');
    assert.equal(ctx.get().accounts[0].navigation[0].key, 'guild:123');
    assert.equal((await ctx.command({ type: 'navigate', id: a.id, key: 'guild:999' })).ok, false);
    assert.equal((await ctx.command({ type: 'navigate', id: b.id, key: 'guild:123' })).ok, false);
    assert.equal((await ctx.command({ type: 'navigate', id: a.id, key: 'guild:123' })).ok, true);
    const request = contents.messages.findLast((item) => item.channel === 'discord:navigate').value;
    ctx.listeners.get('discord:navigation-result')(event, { ...request, serial: request.serial - 1, ok: false });
    assert.equal(ctx.get().accounts[0].compactServers, true);
    ctx.listeners.get('discord:navigation-result')(event, { ...request, ok: false });
    assert.equal(ctx.get().accounts[0].compactServers, false);
    assert.equal(ctx.get().accounts[1].compactServers, true);
  } finally { ctx.cleanup(); }
});

test('カラーコードと表示統合の設定を保存して対象列だけに通知する', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' });
    const entry = ctx.get().accounts[0];
    const result = await ctx.command({ type: 'update', id: entry.id, name: 'A', color: '#abc', compactHeader: false, compactServers: false });
    assert.equal(result.ok, true);
    const stored = JSON.parse(fs.readFileSync(path.join(ctx.data, 'deck.json'), 'utf8'));
    assert.equal(stored.accounts[0].color, '#aabbcc'); assert.equal(stored.accounts[0].compactHeader, false);
    const options = ctx.win.contentView.children[0].webContents.messages.findLast((item) => item.channel === 'discord:options').value;
    assert.equal(options.compactServers, false);
  } finally { ctx.cleanup(); }
});

test('外部アプリはチェック付きで開いた場合だけ記憶し、別アプリとリセット後は確認する', async () => {
  let appKey = '1'.repeat(64);
  const ctx = await boot({ resolveExternalApp: async () => ({ key: appKey, name: 'ブラウザ' }) });
  try {
    await ctx.command({ type: 'add', name: 'A' });
    const contents = ctx.win.contentView.children[0].webContents;
    const prompts = [];
    const answers = [{ response: 1, checkboxChecked: true }, { response: 0, checkboxChecked: false }, { response: 0, checkboxChecked: true }, { response: 1, checkboxChecked: true }, { response: 1, checkboxChecked: false }];
    ctx.electron.dialog.showMessageBox = async (_window, options) => { prompts.push(options); return answers.shift(); };
    const open = async (url) => { contents.openHandler({ url }); await new Promise(setImmediate); };
    await open('https://example.com/cancel');
    assert.equal(ctx.links.length, 0); assert.equal(ctx.get().externalApps.length, 0);
    await open('https://example.com/once');
    assert.equal(ctx.links.length, 1); assert.equal(ctx.get().externalApps.length, 0);
    await open('https://example.com/remember');
    assert.equal(ctx.get().externalApps[0], appKey);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.data, 'deck.json'), 'utf8')).externalApps[0], appKey);
    await open('https://another.example/allowed');
    assert.equal(prompts.length, 3); assert.equal(ctx.links.length, 3);
    assert.equal(prompts[0].checkboxLabel, '次回からは表示しない');
    appKey = '2'.repeat(64);
    await open('https://example.com/new-app');
    assert.equal(prompts.length, 4); assert.equal(ctx.get().externalApps.length, 1);
    await ctx.command({ type: 'reset-external-permissions' });
    appKey = '1'.repeat(64); await open('https://example.com/reset');
    assert.equal(prompts.length, 5); assert.equal(ctx.get().externalApps.length, 0);
  } finally { ctx.cleanup(); }
});

test('旧版で表示に戻っていたサーバー一覧を更新時だけ統合し、以後の明示設定は保持する', async () => {
  const { createAccount } = require('../src/model.cjs');
  const entry = { ...createAccount('A'), compactServers: false };
  const old = await boot({ initialState: { accounts: [entry] } });
  try { assert.equal(old.get().accounts[0].compactServers, true); assert.equal(old.get().serverMenuRevision, 1); }
  finally { old.cleanup(); }
  const current = await boot({ initialState: { serverMenuRevision: 1, accounts: [entry] } });
  try { assert.equal(current.get().accounts[0].compactServers, false); }
  finally { current.cleanup(); }
});

test('名前取得の診断はDiscordの対象フレームからの限定属性だけをローカル保存する', async () => {
  const ctx = await boot();
  try {
    await ctx.command({ type: 'add', name: 'A' });
    const contents = ctx.win.contentView.children[0].webContents; contents.mainFrame.url = 'https://discord.com/channels/@me';
    const entry = ctx.get().accounts[0];
    const payload = [{ key: 'guild:123', nodes: [{ tag: 'DIV', attributes: { role: 'treeitem', 'data-dnd-name': 'サーバー名', password: 'must-not-save' }, innerHTML: 'must-not-save' }] }];
    const handler = ctx.listeners.get('discord:name-diagnostics');
    handler(ctx.event, payload);
    const file = path.join(ctx.data, `server-name-diagnostics-${entry.id}.json`);
    assert.equal(fs.existsSync(file), false);
    handler({ sender: contents, senderFrame: contents.mainFrame }, payload);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('must-not-save'), false); assert.equal(text.includes('サーバー名'), true);
  } finally { ctx.cleanup(); }
});
