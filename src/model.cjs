const { randomUUID } = require('node:crypto');

const HOME = 'https://discord.com/channels/@me';
const COLORS = ['#8b91ff', '#5dd9c1', '#ffb86b', '#f18ec4', '#8fc7ff', '#c6abff'];
const MODES = ['columns', 'grid', 'focus'];
const MAX_ACCOUNTS = 8;
const isId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

function isDiscordURL(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://discord.com' && !url.username && !url.password;
  } catch { return false; }
}

function channelURL(value) {
  if (!isDiscordURL(value)) return HOME;
  const url = new URL(value);
  return /^\/channels\/(?:@me|\d+)(?:\/\d+){0,2}\/?$/.test(url.pathname) ? `https://discord.com${url.pathname}` : HOME;
}

function externalURL(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function label(value) {
  if (typeof value !== 'string') throw new Error('表示名を入力してください。');
  const clean = value.trim();
  if (!clean || clean.length > 32 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error('表示名は1〜32文字で入力してください。');
  return clean;
}

function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1].toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
}

function createAccount(name, index = 0) {
  return { id: randomUUID(), name: label(name), color: COLORS[index % COLORS.length], zoom: 0.8, muted: false, notifications: false, microphone: true, camera: false, compactHeader: true, compactServers: true, avatar: null, discordAvatar: null, url: HOME };
}

function discordAvatarURL(value) {
  try {
    const url = new URL(value);
    if (!['https://cdn.discordapp.com', 'https://media.discordapp.net'].includes(url.origin) || url.username || url.password) return null;
    if (!/^\/(?:avatars\/\d+\/[\w-]+|embed\/avatars\/\d+|guilds\/\d+\/users\/\d+\/avatars\/[\w-]+)\.(?:png|jpe?g|webp|gif)$/.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}?size=128`;
  } catch { return null; }
}

function customAvatar(value) {
  if (typeof value !== 'string' || value.length > 300_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? value : null;
}

function unreadFromTitle(title) {
  const match = typeof title === 'string' && title.match(/^\s*[([](\d{1,7})[)\]]/);
  const count = match ? Math.min(9999, Number(match[1])) : 0;
  return { unreadCount: count, hasUnread: count > 0 || /^\s*[•●]/.test(title ?? '') };
}

function reorderAccounts(accounts, id, targetId, placement) {
  if (!accounts.some((a) => a.id === id) || !accounts.some((a) => a.id === targetId) || !['before', 'after'].includes(placement)) throw new Error('並べ替え先が無効です。');
  if (id === targetId) return accounts;
  const result = accounts.filter((a) => a.id !== id);
  const index = result.findIndex((a) => a.id === targetId) + (placement === 'after' ? 1 : 0);
  result.splice(index, 0, accounts.find((a) => a.id === id));
  return result;
}

function requestedMedia(details) {
  return Array.isArray(details?.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio' || t === 'video') ? [...new Set(details.mediaTypes)] : [];
}

function mediaEnabled(entry, types) {
  return Boolean(entry && types.length > 0 && types.every((t) => t === 'audio' ? entry.microphone : t === 'video' && entry.camera));
}

function navigationIconURL(value) {
  const avatar = discordAvatarURL(value);
  if (avatar) return avatar;
  try {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const url = new URL(value);
    if (!['https://cdn.discordapp.com', 'https://media.discordapp.net'].includes(url.origin) || url.username || url.password) return null;
    if (!/^\/icons\/\d+\/[\w-]+\.(?:png|jpe?g|webp|gif)$/.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}?size=64`;
  } catch { return null; }
}

function displayText(value, limit = 100) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function normalizeNavigation(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 300).flatMap((item) => {
    if (!item || typeof item.key !== 'string' || seen.has(item.key)) return [];
    const kind = item.key === 'home' ? 'home' : /^guild:\d{1,24}$/.test(item.key) ? 'guild' : /^dm:\d{1,24}$/.test(item.key) ? 'dm' : /^folder:[\w-]{1,80}$/.test(item.key) ? 'folder' : null;
    const name = displayText(item.label, 100);
    if (!kind || !name) return [];
    seen.add(item.key);
    return [{ key: item.key, kind, label: name, icon: navigationIconURL(item.icon) }];
  });
}

function audioDevice(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 256 || /[\u0000-\u001f\u007f]/.test(value.label) || !Number.isInteger(value.ordinal) || value.ordinal < 0 || value.ordinal > 63) return null;
  return { label: value.label, ordinal: value.ordinal };
}

function appSettings(value = {}) {
  return { fullscreen: value?.fullscreen === true, taskbarBadge: value?.taskbarBadge !== false, suppressPasskeyPrompts: value?.suppressPasskeyPrompts !== false, notificationSound: value?.notificationSound !== false, hideOnBlur: value?.hideOnBlur === true, inputDevice: audioDevice(value?.inputDevice), outputDevice: audioDevice(value?.outputDevice) };
}

function normalizeState(raw = {}) {
  const seen = new Set();
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).filter((a) => {
    if (!a || !isId(a.id) || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  }).slice(0, MAX_ACCOUNTS).map((a, i) => {
    let name;
    try { name = label(a.name); } catch { name = `アカウント ${i + 1}`; }
    return {
      id: a.id, name, color: normalizeColor(a.color) ?? COLORS[i % COLORS.length],
      zoom: Number.isFinite(a.zoom) ? Math.max(0.5, Math.min(1.25, Math.round(a.zoom * 100) / 100)) : 0.8,
      muted: a.muted === true, notifications: a.notifications === true,
      microphone: a.microphone !== false, camera: a.camera === true,
      compactHeader: a.compactHeader !== false, compactServers: a.compactServers !== false,
      avatar: customAvatar(a.avatar), discordAvatar: discordAvatarURL(a.discordAvatar), url: channelURL(a.url),
    };
  });
  return {
    version: 1, serverMenuRevision: 1, settings: appSettings(raw.settings), accounts, mode: MODES.includes(raw.mode) ? raw.mode : 'columns', columnCount: raw.columnCount === 3 ? 3 : 2,
    externalApps: Array.isArray(raw.externalApps) ? [...new Set(raw.externalApps.filter((key) => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)))].slice(-64) : [],
    activeId: accounts.some((a) => a.id === raw.activeId) ? raw.activeId : (accounts[0]?.id ?? null),
    window: {
      width: Number.isFinite(raw.window?.width) ? Math.round(Math.max(960, Math.min(3840, raw.window.width))) : 1540,
      height: Number.isFinite(raw.window?.height) ? Math.round(Math.max(680, Math.min(2160, raw.window.height))) : 960,
    },
  };
}

function partitionFor(id) {
  if (!isId(id)) throw new Error('無効なアカウントIDです。');
  return `persist:discorddeck-${id}`;
}

function stableUserAgent(value) {
  // Keep the real Chromium/Electron versions; only our UI release number is irrelevant to the browser identity.
  return value.replace(/(^|\s)DiscordDeck\/[^\s()]+(?=\s|$)/gi, '$1DiscordDeck');
}

function clampBounds(rect, size) {
  if (!rect || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]))) return null;
  // Round inward so native content never covers the column's one-pixel border.
  const x = Math.max(0, Math.ceil(rect.x));
  const y = Math.max(0, Math.ceil(rect.y));
  const width = Math.min(Math.floor(rect.x + rect.width), size.width) - x;
  const height = Math.min(Math.floor(rect.y + rect.height), size.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

module.exports = { HOME, COLORS, MODES, MAX_ACCOUNTS, isId, isDiscordURL, channelURL, externalURL, label, createAccount, normalizeState, partitionFor, clampBounds, discordAvatarURL, customAvatar, unreadFromTitle, reorderAccounts, requestedMedia, mediaEnabled, navigationIconURL, displayText, normalizeNavigation, normalizeColor, appSettings, audioDevice, stableUserAgent };
