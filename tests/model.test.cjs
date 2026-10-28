const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HOME, isDiscordURL, channelURL, externalURL, label, createAccount, normalizeState, partitionFor, clampBounds, discordAvatarURL, customAvatar, unreadFromTitle, reorderAccounts, requestedMedia, mediaEnabled, normalizeColor, normalizeNavigation } = require('../src/model.cjs');

test('Discordの偽ドメイン・資格情報付きURLを拒否する', () => {
  for (const url of ['https://discord.com.evil.test/channels/@me', 'https://discord.com@evil.test', 'http://discord.com', 'https://user:pass@discord.com', 'javascript:alert(1)', 'file:///C:/test']) assert.equal(isDiscordURL(url), false, url);
  assert.equal(isDiscordURL(HOME), true);
});
test('再開URLにはチャンネルパスだけを保存する', () => {
  assert.equal(channelURL('https://discord.com/channels/123/456?token=secret#secret'), 'https://discord.com/channels/123/456');
  assert.equal(channelURL('https://discord.com/login?token=secret'), HOME);
  assert.equal(channelURL('https://evil.test/channels/123'), HOME);
});
test('外部起動ではOSコマンドに繋がるスキームを拒否する', () => {
  for (const url of ['file:///C:/test.exe', 'ms-settings:privacy', 'discord://test', 'javascript:alert(1)', 'https://user:pass@example.com']) assert.equal(externalURL(url), false);
  for (const url of ['https://example.com/file.pdf', 'mailto:someone@example.com']) assert.equal(externalURL(url), true);
});
test('各列の保存セッションが異なり、同じIDは再起動しても同じ保存先になる', () => {
  const a = createAccount('仕事'); const b = createAccount('私用');
  assert.notEqual(partitionFor(a.id), partitionFor(b.id));
  assert.equal(partitionFor(a.id), partitionFor(normalizeState({ accounts: [a] }).accounts[0].id));
  assert.throws(() => partitionFor('../../another-profile'));
});
test('破損・重複した設定を修復し、権限は明示的なtrueのみ許可する', () => {
  const a = createAccount('仕事');
  const state = normalizeState({ accounts: [{ ...a, zoom: 100, notifications: 'true', url: 'file:///secret' }, a, { id: '../test' }], activeId: 'unknown', mode: 'invalid', window: { width: -10 } });
  assert.equal(state.accounts.length, 1); assert.equal(state.accounts[0].zoom, 1.25); assert.equal(state.accounts[0].notifications, false);
  assert.equal(state.accounts[0].url, HOME); assert.equal(state.activeId, a.id); assert.equal(state.mode, 'columns'); assert.equal(state.window.width, 960);
});
test('表示名の検証と描画領域の範囲制限', () => {
  assert.equal(label('  仕事用  '), '仕事用');
  for (const name of ['', '  ', 'a'.repeat(33), 'name\nnew']) assert.throws(() => label(name));
  assert.deepEqual(clampBounds({ x: -5, y: 100, width: 3000, height: 1000 }, { width: 1000, height: 700 }), { x: 0, y: 100, width: 1000, height: 600 });
  assert.equal(clampBounds({ x: NaN, y: 0, width: 100, height: 100 }, { width: 1000, height: 700 }), null);
  assert.deepEqual(clampBounds({ x: 100.3, y: 200.4, width: 300.6, height: 500.8 }, { width: 1000, height: 1000 }), { x: 101, y: 201, width: 299, height: 500 });
});

test('アイコンはDiscordの画像URLまたはサイズを制限したPNGだけを保存する', () => {
  assert.equal(discordAvatarURL('https://cdn.discordapp.com/avatars/123/avatar.webp?size=512'), 'https://cdn.discordapp.com/avatars/123/avatar.webp?size=128');
  assert.equal(discordAvatarURL('https://cdn.discordapp.com/embed/avatars/1.png'), 'https://cdn.discordapp.com/embed/avatars/1.png?size=128');
  for (const value of ['https://evil.test/avatars/123/avatar.webp', 'https://cdn.discordapp.com/attachments/123/file.png', 'file:///C:/photo.png', 'https://cdn.discordapp.com.evil.test/avatars/123/avatar.png']) assert.equal(discordAvatarURL(value), null);
  assert.equal(customAvatar('data:image/svg+xml;base64,PHN2Zy8+'), null);
  assert.equal(customAvatar('data:image/png;base64,YmFk'), null);
});

test('並べ替えても既存IDとプロファイルオブジェクトを引き継ぐ', () => {
  const entries = ['A', 'B', 'C'].map(createAccount);
  const moved = reorderAccounts(entries, entries[2].id, entries[0].id, 'before');
  assert.deepEqual(moved.map((a) => a.name), ['C', 'A', 'B']);
  assert.equal(moved[0], entries[2]); assert.equal(entries[0].name, 'A');
  assert.throws(() => reorderAccounts(entries, entries[0].id, 'unknown', 'before'));
});

test('未読タイトルとメディア要求を正規化し、画面共有を通話権限に含めない', () => {
  assert.deepEqual(unreadFromTitle('(12) Discord | #general'), { unreadCount: 12, hasUnread: true });
  assert.deepEqual(unreadFromTitle('Discord'), { unreadCount: 0, hasUnread: false });
  assert.deepEqual(requestedMedia({ mediaTypes: ['audio', 'video'] }), ['audio', 'video']);
  assert.deepEqual(requestedMedia({ mediaTypes: ['screen'] }), []);
  const entry = createAccount('仕事');
  assert.equal(mediaEnabled(entry, ['audio']), true); assert.equal(mediaEnabled(entry, ['audio', 'video']), false);
  assert.equal(mediaEnabled(entry, []), false);
  const restored = normalizeState({ accounts: [{ ...entry, microphone: false, camera: true }] }).accounts[0];
  assert.equal(restored.microphone, false); assert.equal(restored.camera, true);
});

test('アプリの版番号だけをブラウザ識別文字列から外し、実際のエンジン情報を残す', () => {
  const { stableUserAgent } = require('../src/model.cjs');
  const before = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 DiscordDeck/0.6.1 Chrome/150.0.0.0 Electron/45.1.0 Safari/537.36';
  const next = before.replace('DiscordDeck/0.6.1', 'DiscordDeck/0.7.0');
  assert.equal(stableUserAgent(before), stableUserAgent(next));
  assert.match(stableUserAgent(before), /Chrome\/150\.0\.0\.0 Electron\/45\.1\.0/);
  assert.equal(stableUserAgent('DiscordDeck/0.7.0'), 'DiscordDeck');
  assert.equal(stableUserAgent(stableUserAgent(before)), stableUserAgent(before));
});

test('旧設定に本体設定の既定値を補い、機器名と同名機器の順序だけを保存する', () => {
  assert.deepEqual(normalizeState().settings, { fullscreen: false, notificationSound: true, hideOnBlur: false, inputDevice: null, outputDevice: null });
  const settings = normalizeState({ settings: { notificationSound: false, hideOnBlur: true, inputDevice: { label: '日本語マイク', ordinal: 0, deviceId: 'account-specific' }, outputDevice: { label: 'USB', ordinal: -1 } } }).settings;
  assert.deepEqual(settings, { fullscreen: false, notificationSound: false, hideOnBlur: true, inputDevice: { label: '日本語マイク', ordinal: 0 }, outputDevice: null });
});

test('任意のHEX色を正規化して設定の再読み込み後も保持する', () => {
  assert.equal(normalizeColor('#1A2B3C'), '#1a2b3c'); assert.equal(normalizeColor('abc'), '#aabbcc');
  for (const value of ['red', '#12345', '#12345678', 'url(evil)', null]) assert.equal(normalizeColor(value), null);
  const a = createAccount('A');
  assert.equal(normalizeState({ accounts: [{ ...a, color: '#123ABC' }] }).accounts[0].color, '#123abc');
});

test('移動先は限定したキーと画像URLだけを許可し、URLやスクリプトを受け取らない', () => {
  const items = normalizeNavigation([
    { key: 'home', label: 'DM', href: 'https://evil.test' },
    { key: 'guild:123', label: '  サーバー\nA ', icon: 'https://cdn.discordapp.com/icons/123/abc.webp' },
    { key: 'guild:123', label: '重複' },
    { key: 'javascript:alert(1)', label: '不正' },
    { key: 'dm:456', label: '私用', icon: 'https://evil.test/x.png' },
  ]);
  assert.deepEqual(items.map((item) => item.key), ['home', 'guild:123', 'dm:456']);
  assert.equal(items[1].label, 'サーバー A'); assert.equal(items[2].icon, null);
  assert.equal('href' in items[0], false);
});
