const { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, shell, Menu, nativeImage, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveExternalApp } = require('./external-app.cjs');
const { CredentialStore } = require('./credentials.cjs');
const { SessionCookieStore } = require('./session-cookies.cjs');
const { preparePageForExit } = require('./lifecycle.cjs');
const { summarizeUnread, renderBadge } = require('./taskbar.cjs');
const { UpdateManager, RELEASES_URL } = require('./updates.cjs');
const { HOME, COLORS, MODES, MAX_ACCOUNTS, isDiscordURL, channelURL, externalURL, label, createAccount, normalizeState, partitionFor, clampBounds, discordAvatarURL, customAvatar, unreadFromTitle, reorderAccounts, requestedMedia, mediaEnabled, displayText, normalizeNavigation, normalizeColor, appSettings, audioDevice, stableUserAgent } = require('./model.cjs');

app.setName('DiscordDeck');
// Match the installer's shortcut identity across versions and executable paths.
if (process.platform === 'win32') app.setAppUserModelId('local.discorddeck.desktop');
const testing = !app.isPackaged && process.env.DISCORDDECK_TEST === '1';
const dataDirectory = testing ? (process.env.DISCORDDECK_TEST_DATA || app.getPath('userData')) : path.join(app.getPath('appData'), 'DiscordDeck');
fs.mkdirSync(dataDirectory, { recursive: true });
app.setPath('userData', dataDirectory);
app.setPath('sessionData', dataDirectory);
app.userAgentFallback = stableUserAgent(app.userAgentFallback);
const configPath = path.join(app.getPath('userData'), 'deck.json');
const credentials = new CredentialStore(path.join(dataDirectory, 'login-credentials.json'), safeStorage);
const sessionCookies = new SessionCookieStore(path.join(dataDirectory, 'session-cookies.json'), safeStorage);
const shellPath = path.join(__dirname, 'index.html');
const shellURL = pathToFileURL(shellPath).href;
const discordCompactCSS = fs.readFileSync(path.join(__dirname, 'discord-compact.css'), 'utf8');
const views = new Map();
const statuses = new Map();
const metadata = new Map();
const titleUnread = new Map();
const overlayImages = new Map();
let overlayKey;
let overlayWarning = false;
const mediaGrants = new Map();
const mediaPrompts = new Map();
const pendingNavigation = new Map();
let navigationSerial = 0;
let win;
let state;
let updates;
let saveTimer;
let startupWarning;
let modalOpen = false;
let openingLink = false;
let busy = false;
let shuttingDown = false;
let shutdownComplete = false;
let shutdownPromise;
const storageTimers = new Map();
const storageFlushes = new Map();
const restoringSessions = new Map();
let storageInterval;
let storageWarning = false;
let scanDeadline = 0;
let scanGranted = false;

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const restored = normalizeState(raw);
    // Re-enable the corrected server menu once when upgrading from the earlier fallback behavior.
    if (raw.serverMenuRevision !== 1) restored.accounts.forEach((entry) => { entry.compactServers = true; });
    return restored;
  }
  catch (error) {
    if (error.code !== 'ENOENT') {
      const backup = `${configPath}.invalid-${Date.now()}`;
      try { fs.copyFileSync(configPath, backup); }
      catch { throw new Error('設定ファイルのバックアップを作成できませんでした。書き込み権限を確認してください。'); }
      startupWarning = `設定を読み込めなかったため初期状態で起動しました。元の設定は ${backup} に保存しました。`;
    }
    return normalizeState();
  }
}

function save() {
  clearTimeout(saveTimer);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temp = `${configPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, configPath);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { save(); } catch { notify('設定を保存できませんでした。保存先の空き容量と権限を確認してください。'); }
  }, 350);
}

function privacyHidden() { return Boolean(state.settings.hideOnBlur && win && !win.isFocused()); }
function mediaOptions() { return { ...state.settings, privacyHidden: privacyHidden() }; }
function unreadFor(id) {
  const dom = metadata.get(id), title = titleUnread.get(id);
  const unreadCount = Math.max(dom?.unreadCount ?? 0, title?.unreadCount ?? 0);
  return { unreadCount, hasUnread: unreadCount > 0 || dom?.hasUnread === true || title?.hasUnread === true };
}
function updateTaskbarBadge(force = false) {
  if (process.platform !== 'win32' || !win || win.isDestroyed() || !state) return;
  const summary = state.settings.taskbarBadge ? summarizeUnread(state.accounts.map((entry) => unreadFor(entry.id))) : { label: null, description: '' };
  const key = JSON.stringify([summary.label, summary.description]);
  if (!force && key === overlayKey) return;
  try {
    let image = null;
    if (summary.label) {
      image = overlayImages.get(summary.label);
      if (!image) {
        image = nativeImage.createFromBuffer(renderBadge(summary.label));
        for (const scaleFactor of [2, 3]) image.addRepresentation({ scaleFactor, buffer: renderBadge(summary.label, 16 * scaleFactor) });
        if (image.isEmpty()) throw new Error('Invalid badge image');
        overlayImages.set(summary.label, image);
      }
    }
    win.setOverlayIcon(image, summary.description);
    overlayKey = key;
  } catch {
    overlayKey = undefined;
    if (!overlayWarning) { overlayWarning = true; console.warn('DiscordDeck: taskbar badge could not be updated.'); }
  }
}
function snapshot() {
  return { ...state, updates: updates?.snapshot(), privacyHidden: privacyHidden(), accounts: state.accounts.map((a) => ({ ...a, ...metadata.get(a.id), ...unreadFor(a.id), ...credentials.status(a.id), status: statuses.get(a.id) ?? 'loading' })), maxAccounts: MAX_ACCOUNTS, colors: COLORS };
}
function emit() { if (win && !win.isDestroyed()) { updateTaskbarBadge(); win.webContents.send('deck:state', snapshot()); } }
function notify(message) { if (win && !win.isDestroyed()) win.webContents.send('deck:notice', message); }
function status(id, value) { if (!views.has(id)) return; statuses.set(id, value); emit(); }

function account(id) {
  const found = state.accounts.find((a) => a.id === id);
  if (!found) throw new Error('アカウントが見つかりません。');
  return found;
}

function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== shellURL) {
    throw new Error('許可されていない操作です。');
  }
}

function remoteEntry(event) {
  const pair = [...views].find(([, view]) => view.webContents === event.sender);
  return pair && event.senderFrame === event.sender.mainFrame && isDiscordURL(event.senderFrame?.url) ? state.accounts.find((a) => a.id === pair[0]) : null;
}

function sendAppearance(entry) {
  const contents = views.get(entry.id)?.webContents;
  if (contents && !contents.isDestroyed()) contents.send('discord:options', { compactHeader: entry.compactHeader, compactServers: entry.compactServers, autofill: credentials.options(entry.id), media: mediaOptions() });
}

function updatePrivacy() {
  if (privacyHidden()) hideViews();
  for (const entry of state.accounts) sendAppearance(entry);
  emit();
  win.webContents.send('deck:layout');
}

function applyFullscreen() {
  if (win.isFullScreen() === state.settings.fullscreen) return;
  hideViews();
  win.setFullScreen(state.settings.fullscreen);
}

function fullscreenInput(event, input) {
  if (shuttingDown || input.type !== 'keyDown' || input.key !== 'F11' || input.isAutoRepeat || input.control || input.meta || input.alt || input.shift) return false;
  event.preventDefault();
  state.settings.fullscreen = !state.settings.fullscreen;
  applyFullscreen(); scheduleSave(); emit();
  return true;
}

async function openExternal(url) {
  if (!externalURL(url) || openingLink || !win || win.isDestroyed()) return;
  openingLink = true;
  try {
    const parsed = new URL(url);
    const destination = await resolveExternalApp(url);
    if (destination && state.externalApps.includes(destination.key)) { await shell.openExternal(url); return; }
    const answer = await dialog.showMessageBox(win, {
      type: 'question', title: '外部リンクを開く', message: destination ? `${destination.name}で開きますか？` : '既定のブラウザ・メールアプリで開きますか？',
      detail: `${parsed.protocol === 'mailto:' ? 'メールアドレス' : 'リンク先'}: ${url.slice(0, 500)}`, buttons: ['開く', 'キャンセル'], defaultId: 1, cancelId: 1, noLink: true,
      ...(destination ? { checkboxLabel: '次回からは表示しない', checkboxChecked: false } : {}),
    });
    if (answer.response === 0) {
      await shell.openExternal(url);
      if (destination && answer.checkboxChecked) {
        state.externalApps = [...new Set([...state.externalApps, destination.key])].slice(-64);
        try { save(); } catch { notify('外部アプリの許可を保存できませんでした。'); }
      }
    }
  } catch { notify('外部リンクを開けませんでした。'); }
  finally { openingLink = false; }
}

function configureSession(ses, id) {
  ses.cookies.on('changed', (_event, cookie) => {
    if (!views.has(id)) return;
    if (cookie && ['discord.com', '.discord.com'].includes(cookie.domain) && !restoringSessions.has(ses)) {
      try { sessionCookies.invalidate(id); } catch { warnStorage(); }
    }
    scheduleStorageFlush(ses);
  });
  const owned = (contents, origin) => contents === views.get(id)?.webContents && isDiscordURL(origin) && isDiscordURL(contents?.getURL());
  ses.setPermissionCheckHandler((contents, permission, origin, details = {}) => {
    const entry = state.accounts.find((a) => a.id === id);
    if (!entry || !owned(contents, origin)) return false;
    if (permission === 'notifications') return entry.notifications;
    if (permission === 'speaker-selection') return Boolean(state.settings.outputDevice && mediaGrants.get(id)?.has('audio'));
    if (permission === 'media') {
      const types = ['audio', 'video'].includes(details.mediaType) ? [details.mediaType] : ['audio', 'video'];
      return mediaEnabled(entry, types) && types.every((type) => mediaGrants.get(id)?.has(type));
    }
    return false;
  });
  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const entry = state.accounts.find((a) => a.id === id);
    if (!entry || !owned(contents, details?.requestingUrl)) return callback(false);
    if (permission === 'notifications') return callback(entry.notifications);
    if (permission === 'speaker-selection') return callback(Boolean(state.settings.outputDevice && mediaGrants.get(id)?.has('audio')));
    if (permission !== 'media') return callback(false);
    const types = requestedMedia(details);
    if (!mediaEnabled(entry, types)) return callback(false);
    const granted = () => types.every((type) => mediaGrants.get(id)?.has(type));
    try {
      if (!granted()) {
        if (!mediaPrompts.has(id)) {
          const prompt = dialog.showMessageBox(win, {
            type: 'question', title: '通話のアクセス許可',
            message: `${entry.name}で${types.map((type) => type === 'audio' ? 'マイク' : 'カメラ').join('・')}を使用しますか？`,
            detail: 'Discord公式画面からの要求です。この起動中は許可を記憶します。Windows側のアクセス許可も必要です。',
            buttons: ['許可する', '許可しない'], defaultId: 1, cancelId: 1, noLink: true,
          }).then((answer) => {
            if (answer.response === 0 && owned(contents, details.requestingUrl) && mediaEnabled(state.accounts.find((a) => a.id === id), types)) {
              const saved = mediaGrants.get(id) ?? new Set();
              types.forEach((type) => saved.add(type)); mediaGrants.set(id, saved);
            }
          }).finally(() => mediaPrompts.delete(id));
          mediaPrompts.set(id, prompt);
        }
        await mediaPrompts.get(id);
      }
      callback(Boolean(owned(contents, details.requestingUrl) && mediaEnabled(state.accounts.find((a) => a.id === id), types) && granted()));
    } catch { callback(false); }
  });
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event, item) => {
    if (!win || win.isDestroyed()) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: '添付ファイルを保存', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    item.on('done', (_event, result) => { if (result !== 'completed' && result !== 'cancelled') notify('ファイルを保存できませんでした。'); });
  });
}

function createView(entry) {
  const ses = session.fromPartition(partitionFor(entry.id));
  const view = new WebContentsView({ webPreferences: {
    session: ses, preload: path.join(__dirname, 'discord-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false,
    navigateOnDragDrop: false, spellcheck: true,
    additionalArguments: [`--discorddeck-media=${Buffer.from(JSON.stringify(mediaOptions())).toString('base64')}`],
  } });
  view.setBackgroundColor('#313338');
  // WebContentsView paints above the HTML shell; the shell's overflow cannot clip it.
  view.setBorderRadius(9);
  view.setVisible(false);
  views.set(entry.id, view);
  configureSession(ses, entry.id);
  win.contentView.addChildView(view);
  const wc = view.webContents;
  wc.setZoomFactor(entry.zoom);
  wc.setAudioMuted(entry.muted);
  wc.on('devtools-opened', () => wc.send('discord:devtools-state', true));
  wc.on('devtools-closed', () => wc.send('discord:devtools-state', false));
  wc.on('page-title-updated', (_event, title) => {
    const next = unreadFromTitle(title);
    const previous = titleUnread.get(entry.id);
    if (previous?.unreadCount !== next.unreadCount || previous?.hasUnread !== next.hasUnread) {
      titleUnread.set(entry.id, next); emit();
    }
  });
  wc.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (event, url) => {
    if (!isDiscordURL(url)) { event.preventDefault(); void openExternal(url); }
  });
  wc.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isDiscordURL(url)) { event.preventDefault(); void openExternal(url); }
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());
  const remember = (_event, url) => {
    if (isDiscordURL(url) && new URL(url).pathname.startsWith('/channels/')) {
      const current = state.accounts.find((a) => a.id === entry.id);
      if (current) { current.url = channelURL(url); scheduleSave(); }
    }
  };
  wc.on('did-navigate', remember);
  wc.on('did-navigate-in-page', (event, url, isMainFrame) => { if (isMainFrame) { remember(event, url); scheduleStorageFlush(ses); } });
  wc.on('did-start-loading', () => status(entry.id, 'loading'));
  wc.on('did-finish-load', () => { wc.setZoomFactor(account(entry.id).zoom); status(entry.id, 'ready'); scheduleStorageFlush(ses); });
  wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { view.setVisible(false); status(entry.id, 'error'); }
  });
  wc.on('render-process-gone', () => { view.setVisible(false); status(entry.id, 'crashed'); });
  wc.on('focus', () => {
    if (state.activeId !== entry.id) { state.activeId = entry.id; scheduleSave(); emit(); }
  });
  wc.on('before-input-event', (event, input) => {
    if (fullscreenInput(event, input)) return;
    if ((input.control || input.meta) && !input.alt && ['r', 'R'].includes(input.key)) {
      event.preventDefault(); wc.reload();
    }
  });
  const ready = sessionCookies.restore(entry.id, ses, () => views.get(entry.id) === view && !wc.isDestroyed()).catch(() => {
    notify('一部のCookieを復元できませんでした。Discordからログアウトしている場合は再ログインしてください。');
  });
  restoringSessions.set(ses, ready);
  void ready.then(() => {
    if (restoringSessions.get(ses) === ready) restoringSessions.delete(ses);
    if (shuttingDown || views.get(entry.id) !== view || wc.isDestroyed()) return;
    if (testing && process.env.DISCORDDECK_LIVE !== '1') return wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<html lang="ja"><body style="background:#313338;color:#eee;font-family:sans-serif"><h1>独立セッションのテスト</h1><p>ここにDiscord公式Web版が表示されます。</p><input aria-label="セッション確認"></body></html>')}`);
    return wc.loadURL(entry.url);
  }).catch(() => status(entry.id, 'error'));
  return view;
}

function hideViews() { for (const view of views.values()) view.setVisible(false); }

function warnStorage() {
  if (!storageWarning) { storageWarning = true; notify('ログイン状態を保存できませんでした。保存先の空き容量と書き込み権限を確認してください。'); }
}
function flushSession(ses) {
  const run = async () => {
    ses.flushStorageData();
    await ses.cookies.flushStore();
    if (restoringSessions.has(ses)) await restoringSessions.get(ses);
    const id = [...views].find(([, view]) => view.webContents.session === ses)?.[0];
    if (id) await sessionCookies.capture(id, ses);
  };
  const previous = storageFlushes.get(ses);
  const work = previous ? previous.catch(() => {}).then(run) : run();
  storageFlushes.set(ses, work);
  const cleanup = () => { if (storageFlushes.get(ses) === work) storageFlushes.delete(ses); };
  void work.then(cleanup, cleanup);
  return work;
}
function checkpointSessions() {
  if (shuttingDown) return;
  const sessions = [...new Set([...views.values()].map((view) => view.webContents.session))];
  void Promise.allSettled(sessions.map(flushSession)).then((results) => { if (results.some((result) => result.status === 'rejected')) warnStorage(); });
}
function checkpointBeforeSystemEnd() {
  // Windows may terminate the process without close/before-quit. Do not block the user's restart.
  try { if (state) save(); } catch { warnStorage(); }
  checkpointSessions();
}

function scheduleStorageFlush(ses) {
  if (shuttingDown || storageTimers.has(ses)) return;
  storageTimers.set(ses, setTimeout(() => {
    storageTimers.delete(ses);
    void flushSession(ses).catch(warnStorage);
  }, 2000));
}

function shutdown(afterFlush) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  clearInterval(storageInterval);
  clearTimeout(saveTimer);
  for (const timer of storageTimers.values()) clearTimeout(timer);
  storageTimers.clear();
  hideViews();
  let settingsFailed = false;
  if (state) { try { save(); } catch { settingsFailed = true; } }
  const sessions = [...new Set([...views.values()].map((view) => view.webContents.session))];
  const pages = [...views.values()].map((view) => ({ contents: view.webContents, url: view.webContents.getURL() }));
  shutdownPromise = Promise.allSettled(pages.map(({ contents }) => preparePageForExit(contents))).then(async (prepared) => {
    if (prepared.some((result) => result.status === 'rejected')) settingsFailed = true;
    const results = await Promise.allSettled(sessions.map(flushSession));
    // The page's exit handlers have completed before Chromium storage is flushed.
    if (results.some((result) => result.status === 'rejected')) {
      console.warn('DiscordDeck: session persistence failed during shutdown.');
      if (afterFlush) settingsFailed = true;
    }
    if (afterFlush && settingsFailed) throw Object.assign(new Error('更新前の保存に失敗しました。'), { code: 'DECK_UPDATE_SAVE_FAILED' });
    shutdownComplete = true;
    if (afterFlush) afterFlush(); else app.quit();
  }).catch((error) => {
    shuttingDown = false; shutdownComplete = false; shutdownPromise = undefined;
    for (const { contents, url } of pages) if (!contents.isDestroyed() && contents.getURL() === 'about:blank' && isDiscordURL(url)) void contents.loadURL(url).catch(() => {});
    startStorageCheckpoints();
    emit(); if (win && !win.isDestroyed()) win.webContents.send('deck:layout');
    throw error;
  });
  return shutdownPromise;
}

function registerIPC() {
  ipcMain.on('discord:view-options', (event) => {
    event.returnValue = remoteEntry(event) ? { devToolsOpen: event.sender.isDevToolsOpened() } : null;
  });
  ipcMain.on('discord:storage-dirty', (event) => {
    if (remoteEntry(event)) scheduleStorageFlush(event.sender.session);
  });
  ipcMain.on('discord:passkey-policy-error', (event) => {
    if (remoteEntry(event)) notify('パスキーの自動表示を抑制できませんでした。列を再読み込みしてください。');
  });
  ipcMain.handle('discord:credentials', async (event) => {
    const entry = remoteEntry(event);
    const url = event.senderFrame?.url;
    const allowed = () => !shuttingDown && entry && !event.sender.isDestroyed() && remoteEntry(event) === entry && event.senderFrame.url === url && event.sender.getURL() === url && /^\/login\/?$/.test(new URL(url).pathname);
    if (!entry || !allowed()) return null;
    try {
      const login = await credentials.readForFill(entry.id);
      const current = credentials.options(entry.id);
      return allowed() && current.enabled && current.revision === login?.revision ? login : null;
    } catch {
      notify('ログイン情報を自動入力できませんでした。列の「…」から保存済みの情報を確認してください。');
      return null;
    }
  });
  // One synchronous, in-memory read before Discord's scripts run; never exposed to the page.
  ipcMain.on('discord:media-options', (event) => { event.returnValue = remoteEntry(event) ? mediaOptions() : null; });
  ipcMain.on('discord:media-notice', (event, code) => {
    if (!remoteEntry(event)) return;
    const messages = { input: '本体設定で指定したマイクが見つかりません。接続を確認するか、既定に戻してください。', output: '本体設定のスピーカーへ切り替えられませんでした。機器の接続とマイクの使用許可を確認してください。', unavailable: 'Discordへ音声・通知の本体設定を適用できませんでした。列を再読み込みしてください。' };
    if (messages[code]) notify(messages[code]);
  });
  ipcMain.on('discord:name-diagnostics', (event, value) => {
    const entry = remoteEntry(event);
    if (!entry || !Array.isArray(value)) return;
    const allowed = ['class', 'role', 'data-list-item-id', 'data-dnd-name', 'aria-label', 'aria-labelledby', 'aria-describedby', 'title'];
    const describe = (node) => ({ tag: displayText(node?.tag, 20), attributes: Object.fromEntries(allowed.map((name) => [name, displayText(node?.attributes?.[name], 100)]).filter(([, text]) => text)) });
    const entries = value.slice(0, 20).filter((item) => typeof item?.key === 'string' && /^guild:\d{1,24}$/.test(item.key)).map((item) => ({
      key: item.key,
      nodes: (Array.isArray(item.nodes) ? item.nodes : []).slice(0, 5).map(describe),
      children: (Array.isArray(item.children) ? item.children : []).slice(0, 12).map(describe),
    }));
    if (!entries.length) return;
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(configPath), `server-name-diagnostics-${entry.id}.json`), JSON.stringify({ recordedAt: new Date().toISOString(), entries }, null, 2), 'utf8');
    } catch { /* Diagnostics must never interrupt normal use. */ }
  });
  ipcMain.on('discord:ready', (event) => {
    const entry = remoteEntry(event);
    if (!entry) return;
    void event.sender.insertCSS(discordCompactCSS, { cssOrigin: 'user' }).then(() => sendAppearance(entry)).catch(() => notify('Discordの表示をまとめられませんでした。通常表示で操作してください。'));
  });
  ipcMain.on('discord:navigation-result', (event, value) => {
    const entry = remoteEntry(event);
    if (!entry || typeof value?.ok !== 'boolean') return;
    const pending = pendingNavigation.get(entry.id);
    if (!pending || pending.key !== value.key || pending.serial !== value.serial) return;
    pendingNavigation.delete(entry.id);
    if (!value.ok) {
      entry.compactServers = false; sendAppearance(entry); scheduleSave(); emit();
      notify('移動先を確認できなかったため、Discordのサーバー一覧を表示しました。');
    }
  });
  ipcMain.on('discord:metadata', (event, value) => {
    const entry = remoteEntry(event);
    if (!entry || !value || typeof value !== 'object') return;
    const id = entry.id;
    const avatar = discordAvatarURL(value.avatar);
    if (!Number.isInteger(value.unreadCount) || value.unreadCount < 0 || value.unreadCount > 9999 || typeof value.hasUnread !== 'boolean') return;
    // Unknown avatar formats must not suppress unread updates. Never save an untrusted image URL.
    if ((value.avatar === null || avatar) && entry.discordAvatar !== avatar) { entry.discordAvatar = avatar; scheduleSave(); }
    metadata.set(id, { unreadCount: value.unreadCount, hasUnread: value.hasUnread || value.unreadCount > 0, channelTitle: displayText(value.channelTitle), navigation: normalizeNavigation(value.navigation), headerAvailable: value.headerAvailable === true, serversAvailable: value.serversAvailable === true });
    emit();
  });
  ipcMain.handle('deck:get', (event) => { trusted(event); return snapshot(); });
  ipcMain.handle('deck:command', async (event, command) => {
    trusted(event);
    if (shuttingDown) return { ok: false, error: '終了処理中です。' };
    if (busy) return { ok: false, error: '処理が完了するまでお待ちください。' };
    busy = true;
    try {
      if (!command || typeof command !== 'object') throw new Error('無効な操作です。');
      switch (command.type) {
        case 'update-check': void updates.check(); return { ok: true, state: snapshot() };
        case 'update-download': void updates.download(); return { ok: true, state: snapshot() };
        case 'update-install':
          updates.beginInstall();
          setImmediate(() => { void shutdown(() => updates.quitAndInstall()).catch((error) => updates.fail(error)); });
          return { ok: true, state: snapshot() };
        case 'update-releases': await openExternal(RELEASES_URL); return { ok: true, state: snapshot() };
        case 'credentials-save': {
          const entry = account(command.id);
          await credentials.save(entry.id, command);
          sendAppearance(entry);
          break;
        }
        case 'credentials-delete': {
          const entry = account(command.id);
          credentials.remove(entry.id);
          sendAppearance(entry);
          break;
        }
        case 'settings': {
          const value = command.settings;
          if (!value || ('fullscreen' in value && typeof value.fullscreen !== 'boolean') || ('taskbarBadge' in value && typeof value.taskbarBadge !== 'boolean') || ('suppressPasskeyPrompts' in value && typeof value.suppressPasskeyPrompts !== 'boolean') || typeof value.notificationSound !== 'boolean' || typeof value.hideOnBlur !== 'boolean' || !['inputDevice', 'outputDevice'].every((key) => value[key] === null || audioDevice(value[key]))) throw new Error('本体設定の値が無効です。');
          state.settings = appSettings({ ...value, fullscreen: value.fullscreen ?? state.settings.fullscreen, taskbarBadge: value.taskbarBadge ?? state.settings.taskbarBadge, suppressPasskeyPrompts: value.suppressPasskeyPrompts ?? state.settings.suppressPasskeyPrompts });
          applyFullscreen();
          updatePrivacy();
          break;
        }
        case 'begin-device-scan':
          if (!modalOpen) throw new Error('本体設定を開いてから操作してください。');
          scanDeadline = Date.now() + 60000; scanGranted = false;
          return { ok: true, state: snapshot() };
        case 'end-device-scan':
          scanDeadline = 0; scanGranted = false;
          return { ok: true, state: snapshot() };
        case 'add': {
          if (state.accounts.length >= MAX_ACCOUNTS) throw new Error(`最大${MAX_ACCOUNTS}アカウントまで追加できます。`);
          const entry = createAccount(command.name, state.accounts.length);
          state.accounts.push(entry); state.activeId = entry.id;
          createView(entry);
          break;
        }
        case 'update': {
          const entry = account(command.id);
          const nextName = label(command.name);
          const nextColor = normalizeColor(command.color);
          if (!nextColor) throw new Error('カラーコードは #RRGGBB または #RGB で指定してください。');
          if ('avatar' in command && command.avatar !== null && !customAvatar(command.avatar)) throw new Error('アイコンの画像が無効です。');
          const revokeMedia = (entry.microphone && command.microphone === false) || (entry.camera && command.camera === false);
          entry.name = nextName; entry.color = nextColor;
          entry.muted = command.muted === true; entry.notifications = command.notifications === true;
          if (typeof command.microphone === 'boolean') entry.microphone = command.microphone;
          if (typeof command.camera === 'boolean') entry.camera = command.camera;
          if (typeof command.compactHeader === 'boolean') entry.compactHeader = command.compactHeader;
          if (typeof command.compactServers === 'boolean') entry.compactServers = command.compactServers;
          if ('avatar' in command) {
            entry.avatar = command.avatar;
          }
          if (!entry.microphone) mediaGrants.get(entry.id)?.delete('audio');
          if (!entry.camera) mediaGrants.get(entry.id)?.delete('video');
          views.get(entry.id).webContents.setAudioMuted(entry.muted);
          if (revokeMedia) { statuses.set(entry.id, 'loading'); views.get(entry.id).webContents.reload(); }
          sendAppearance(entry);
          break;
        }
        case 'appearance': {
          const entry = account(command.id);
          if (typeof command.compactHeader !== 'boolean' || typeof command.compactServers !== 'boolean') throw new Error('無効な表示設定です。');
          entry.compactHeader = command.compactHeader; entry.compactServers = command.compactServers;
          sendAppearance(entry);
          break;
        }
        case 'navigate': {
          const entry = account(command.id);
          if (!metadata.get(entry.id)?.navigation?.some((item) => item.key === command.key)) throw new Error('移動先が変わりました。メニューを開き直してください。');
          const view = views.get(entry.id);
          if (!isDiscordURL(view.webContents.getURL())) throw new Error('Discordの読み込み後に操作してください。');
          const request = { key: command.key, serial: ++navigationSerial };
          pendingNavigation.set(entry.id, request);
          view.webContents.send('discord:navigate', request);
          state.activeId = entry.id;
          break;
        }
        case 'choose-avatar': {
          account(command.id);
          const result = await dialog.showOpenDialog(win, { title: 'アカウントのアイコンを選択', properties: ['openFile'], filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
          if (result.canceled || !result.filePaths[0]) return { ok: true, state: snapshot(), canceled: true };
          const file = result.filePaths[0];
          if (fs.statSync(file).size > 10 * 1024 * 1024) throw new Error('10MB以下の画像を選択してください。');
          const image = nativeImage.createFromPath(file);
          if (image.isEmpty()) throw new Error('この画像を読み込めませんでした。PNGまたはJPEGでお試しください。');
          const size = image.getSize(); const side = Math.min(size.width, size.height);
          const avatar = image.crop({ x: Math.floor((size.width - side) / 2), y: Math.floor((size.height - side) / 2), width: side, height: side }).resize({ width: 128, height: 128 }).toDataURL();
          if (!customAvatar(avatar)) throw new Error('画像をアイコンに変換できませんでした。');
          return { ok: true, state: snapshot(), avatar };
        }
        case 'reorder':
          state.accounts = reorderAccounts(state.accounts, command.id, command.targetId, command.placement);
          break;
        case 'remove': {
          const entry = account(command.id);
          credentials.remove(entry.id);
          sessionCookies.invalidate(entry.id);
          const view = views.get(entry.id);
          view.setVisible(false);
          const ses = view.webContents.session;
          clearTimeout(storageTimers.get(ses)); storageTimers.delete(ses);
          win.contentView.removeChildView(view);
          view.webContents.close();
          views.delete(entry.id); statuses.delete(entry.id);
          metadata.delete(entry.id); titleUnread.delete(entry.id); mediaGrants.delete(entry.id);
          pendingNavigation.delete(entry.id);
          // Remove the metadata even if clearing the Chromium profile fails, so it cannot be reused accidentally.
          state.accounts = state.accounts.filter((a) => a.id !== entry.id);
          if (state.activeId === entry.id) state.activeId = state.accounts[0]?.id ?? null;
          save();
          emit();
          try {
            if (restoringSessions.has(ses)) await restoringSessions.get(ses);
            if (storageFlushes.has(ses)) await storageFlushes.get(ses).catch(() => {});
            await ses.closeAllConnections();
            await ses.clearStorageData();
            await ses.clearCache();
          } catch {
            throw new Error('列は削除しましたが、一部の保存データを消去できませんでした。保存フォルダを確認してください。');
          }
          break;
        }
        case 'layout':
          if (!MODES.includes(command.mode)) throw new Error('無効な表示方法です。');
          state.mode = command.mode;
          if (command.columnCount === 2 || command.columnCount === 3) state.columnCount = command.columnCount;
          hideViews();
          break;
        case 'activate':
          account(command.id); state.activeId = command.id;
          break;
        case 'focus':
          account(command.id); state.activeId = command.id; state.mode = state.mode === 'focus' ? 'columns' : 'focus'; hideViews();
          break;
        case 'zoom': {
          const entry = account(command.id);
          if (!Number.isFinite(command.zoom)) throw new Error('無効な表示倍率です。');
          entry.zoom = Math.max(0.5, Math.min(1.25, Math.round(command.zoom * 100) / 100));
          views.get(entry.id).webContents.setZoomFactor(entry.zoom);
          break;
        }
        case 'reload':
          account(command.id); statuses.set(command.id, 'loading'); views.get(command.id).webContents.reload();
          break;
        case 'home': {
          const entry = account(command.id); entry.url = HOME;
          if (!testing) await views.get(entry.id).webContents.loadURL(HOME);
          break;
        }
        case 'data-folder': await shell.openPath(app.getPath('userData')); break;
        case 'reset-external-permissions': state.externalApps = []; break;
        default: throw new Error('対応していない操作です。');
      }
      save(); emit();
      return { ok: true, state: snapshot() };
    } catch (error) {
      emit();
      return { ok: false, error: error.message || '操作を完了できませんでした。' };
    } finally { busy = false; }
  });
  ipcMain.on('deck:modal', (event, open) => {
    trusted(event); modalOpen = open === true;
    if (modalOpen) hideViews();
    else { scanDeadline = 0; scanGranted = false; }
  });
  ipcMain.on('deck:bounds', (event, items) => {
    trusted(event);
    if (!Array.isArray(items) || items.length > MAX_ACCOUNTS) return;
    const size = win.getContentBounds();
    const visible = new Set();
    if (!shuttingDown && !modalOpen && !win.isMinimized() && !privacyHidden()) {
      for (const item of items) {
        const view = views.get(item.id);
        const bounds = clampBounds(item, size);
        if (!view || !bounds || ['error', 'crashed'].includes(statuses.get(item.id))) continue;
        view.setBounds(bounds); view.setVisible(true); visible.add(item.id);
      }
    }
    for (const [id, view] of views) if (!visible.has(id)) view.setVisible(false);
  });
}

async function createWindow() {
  win = new BrowserWindow({
    ...state.window, fullscreen: state.settings.fullscreen, minWidth: 960, minHeight: 680, backgroundColor: '#101116', title: 'DiscordDeck', icon: path.join(__dirname, 'assets', 'app-icon.ico'), show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, navigateOnDragDrop: false },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('before-input-event', fullscreenInput);
  const scanning = (contents) => contents === win?.webContents && contents.mainFrame.url === shellURL && modalOpen && Date.now() < scanDeadline;
  win.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details = {}) => scanning(contents) && scanGranted && ((permission === 'media' && details.mediaType === 'audio') || permission === 'speaker-selection'));
  win.webContents.session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (!scanning(contents) || details?.requestingUrl !== shellURL || permission !== 'media' || requestedMedia(details).join(',') !== 'audio') return callback(false);
    try {
      const answer = await dialog.showMessageBox(win, { type: 'question', title: '音声機器の確認', message: 'マイクを一時的に使用して、機器名を取得しますか？', detail: '取得が終わり次第マイクを停止します。音声の録音・送信は行いません。', buttons: ['許可する', '許可しない'], defaultId: 1, cancelId: 1, noLink: true });
      scanGranted = answer.response === 0 && scanning(contents);
      callback(scanGranted);
    } catch { callback(false); }
  });
  win.on('blur', updatePrivacy);
  win.on('focus', updatePrivacy);
  win.on('resize', () => {
    hideViews();
    if (!win.isMaximized() && !win.isMinimized()) {
      const { width, height } = win.getNormalBounds(); state.window = { width, height }; scheduleSave();
    }
    win.webContents.send('deck:layout');
  });
  const syncFullscreen = () => {
    state.settings.fullscreen = win.isFullScreen();
    hideViews(); scheduleSave(); emit(); win.webContents.send('deck:layout');
  };
  win.on('enter-full-screen', syncFullscreen);
  win.on('leave-full-screen', syncFullscreen);
  win.on('minimize', hideViews);
  win.on('restore', () => { win.webContents.send('deck:layout'); updateTaskbarBadge(true); });
  win.on('query-session-end', checkpointBeforeSystemEnd);
  win.on('session-end', checkpointBeforeSystemEnd);
  win.on('close', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void shutdown();
  });
  win.on('closed', () => {
    clearInterval(storageInterval);
    for (const view of views.values()) { if (!view.webContents.isDestroyed()) view.webContents.close(); }
    views.clear(); win = null;
  });
  for (const entry of state.accounts) createView(entry);
  await win.loadFile(shellPath);
  win.show();
  startStorageCheckpoints();
  updateTaskbarBadge(true);
  if (startupWarning) notify(startupWarning);
  if (sessionCookies.recovered) notify('Cookieの補助保存ファイルを読み込めなかったため、元ファイルを保管して再作成します。既存のブラウザ保存データはそのまま使用します。');
}

function startStorageCheckpoints() {
  clearInterval(storageInterval);
  storageInterval = setInterval(checkpointSessions, 15_000);
  storageInterval.unref?.();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    state = readState();
    const installed = process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE && fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall DiscordDeck.exe'));
    updates = new UpdateManager({ updater: installed ? require('electron-updater').autoUpdater : null, version: app.getVersion(), unavailable: app.isPackaged ? 'アプリ内更新はインストーラー版で使えます。配布ページからSetup.exeを入れてください。' : '開発版ではアプリ内更新を実行しません。', onChange: emit });
    Menu.setApplicationMenu(null); registerIPC(); await createWindow();
  }).catch((error) => { dialog.showErrorBox('DiscordDeckを起動できません', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void shutdown();
  });
}
