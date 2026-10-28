// IPC stays in the isolated sandbox. The page-world hook below only controls browser media APIs.
// Never reads messages or credentials.
const { ipcRenderer, contextBridge } = require('electron');

// Self-contained because contextBridge serializes this function into the page world.
function installMediaPolicy(initial) {
  const key = Symbol.for('discorddeck.media');
  if (window[key]) { window[key].update(initial); return; }
  let prefs = initial;
  const devices = navigator.mediaDevices;
  const enumerate = devices?.enumerateDevices?.bind(devices);
  const capture = devices?.getUserMedia?.bind(devices);
  const proto = HTMLMediaElement.prototype;
  const play = proto.play;
  const sink = proto.setSinkId;
  const muted = Object.getOwnPropertyDescriptor(proto, 'muted');
  const outputs = new Set();
  const tracked = new WeakSet();
  const requestedSinks = new WeakMap();
  const originalMute = new WeakMap();
  const notices = new Set();
  const notifications = new Set();
  const contextSinks = new Map();
  let deviceList = [];
  let listedAt = 0;
  let listing;
  let routing;
  function warn(code) {
    if (notices.has(code)) return;
    notices.add(code);
    window.dispatchEvent(new CustomEvent('discorddeck:media-notice', { detail: code }));
  }
  function track(element) {
    if (!tracked.has(element)) { tracked.add(element); outputs.add(new WeakRef(element)); }
  }
  function isNotification(element) {
    if (element.srcObject || element.tagName !== 'AUDIO') return false;
    try {
      const url = new URL(element.currentSrc || element.src, location.href);
      // Discord's WebAudioSound class uses first-party static MP3 assets.
      // Attachments, soundboard CDN media and MediaStreams do not match this path.
      return url.origin === 'https://discord.com' && /^\/assets\/[^/]+\.(?:mp3|ogg|wav)$/i.test(url.pathname);
    } catch { return false; }
  }
  function muteNotification(element) {
    if (!muted) return;
    if (!prefs.notificationSound && isNotification(element)) {
      if (!originalMute.has(element)) originalMute.set(element, muted.get.call(element));
      muted.set.call(element, true);
    } else if (originalMute.has(element)) {
      muted.set.call(element, originalMute.get(element)); originalMute.delete(element);
    }
  }
  if (muted?.set) Object.defineProperty(proto, 'muted', { ...muted, set(value) {
    if (!prefs.notificationSound && isNotification(this)) { originalMute.set(this, Boolean(value)); muted.set.call(this, true); }
    else muted.set.call(this, value);
  } });
  async function deviceInventory(force = false) {
    // Chromium may defer enumeration until a hidden document becomes visible.
    // Background ringing must keep playing using the last known device mapping.
    if (!enumerate || document.visibilityState === 'hidden') return deviceList;
    if (!force && Date.now() - listedAt < 2000) return deviceList;
    if (!listing) {
      listing = enumerate().then((items) => { deviceList = items; listedAt = Date.now(); return items; }).finally(() => { listing = undefined; });
    }
    let timeout;
    try { return await Promise.race([listing, new Promise((resolve) => { timeout = setTimeout(() => resolve(deviceList), 750); })]); }
    finally { clearTimeout(timeout); }
  }
  async function resolve(choice, kind, force = false) {
    const list = await deviceInventory(force);
    return list.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label === choice.label)[choice.ordinal]?.deviceId;
  }
  async function route(element) {
    track(element);
    muteNotification(element);
    const set = element instanceof HTMLMediaElement ? sink : element.__discordDeckNativeSink;
    if (!set) { if (prefs.outputDevice) warn('output'); return; }
    const choice = prefs.outputDevice;
    try {
      const id = choice ? await resolve(choice, 'audiooutput') : (requestedSinks.get(element) ?? '');
      if (prefs.outputDevice !== choice) return;
      if (id === undefined) { warn('output'); return; }
      if (element.sinkId !== id) await set.call(element, id);
    } catch { if (choice) warn('output'); }
  }
  function routeAll() {
    for (const element of document.querySelectorAll('audio,video')) track(element);
    for (const ref of outputs) {
      const element = ref.deref();
      if (!element || element.state === 'closed') outputs.delete(ref);
      else void route(element);
    }
  }
  proto.play = function (...args) {
    track(this); muteNotification(this);
    // Wait for the selected output before the first sample; routing failures keep playback usable.
    return route(this).then(() => play.apply(this, args));
  };
  if (sink) proto.setSinkId = async function (id) {
    requestedSinks.set(this, id); track(this);
    if (!prefs.outputDevice) return sink.call(this, id);
    return route(this);
  };
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Native = window[name];
    if (!Native) continue;
    const nativeSink = contextSinks.has(Native.prototype) ? contextSinks.get(Native.prototype) : Native.prototype.setSinkId;
    if (nativeSink && !Object.hasOwn(Native.prototype, '__discordDeckPatched')) {
      contextSinks.set(Native.prototype, nativeSink);
      Object.defineProperty(Native.prototype, '__discordDeckPatched', { value: true });
      Native.prototype.setSinkId = function (id) {
        requestedSinks.set(this, id);
        return prefs.outputDevice ? route(this) : nativeSink.call(this, id);
      };
    }
    window[name] = new Proxy(Native, { construct(target, args) {
      const context = Reflect.construct(target, args);
      Object.defineProperty(context, '__discordDeckNativeSink', { value: nativeSink });
      requestedSinks.set(context, args[0]?.sinkId ?? '');
      track(context); void route(context);
      return context;
    } });
  }
  if (capture) devices.getUserMedia = async function (constraints) {
    const choice = prefs.inputDevice;
    if (!constraints?.audio || !choice) {
      const stream = await capture(constraints);
      try { await deviceInventory(true); } catch { /* Output routing reports its own failure. */ }
      routeAll(); return stream;
    }
    let stream;
    try {
      let id = await resolve(choice, 'audioinput');
      // Device labels are unavailable before the first explicit microphone permission.
      if (!id) {
        stream = await capture(constraints);
        id = await resolve(choice, 'audioinput', true);
      }
      if (!id) { warn('input'); throw new DOMException('指定したマイクが見つかりません。', 'NotFoundError'); }
      if (stream?.getAudioTracks().every((t) => t.getSettings().deviceId === id)) { routeAll(); return stream; }
      const selected = await capture({ ...constraints, audio: { ...(typeof constraints.audio === 'object' ? constraints.audio : {}), deviceId: { exact: id } }, ...(stream ? { video: false } : {}) });
      if (stream) {
        for (const track of stream.getAudioTracks()) { track.stop(); stream.removeTrack(track); }
        for (const track of selected.getAudioTracks()) stream.addTrack(track);
      }
      try { await deviceInventory(true); } catch { /* Preserve the successfully captured stream. */ }
      routeAll(); return stream || selected;
    } catch (error) { stream?.getTracks().forEach((t) => t.stop()); throw error; }
  };
  devices?.addEventListener('devicechange', () => { listedAt = 0; routeAll(); });
  document.addEventListener('visibilitychange', routeAll);
  document.addEventListener('play', (event) => { void route(event.target); }, true);
  document.addEventListener('loadedmetadata', (event) => { void route(event.target); }, true);
  if (window.Notification) {
    const Native = window.Notification;
    window.Notification = new Proxy(Native, { construct(target, args) {
      const [title, options = {}] = args;
      const value = { ...options, ...(!prefs.notificationSound ? { silent: true } : {}) };
      if (prefs.privacyHidden) {
        for (const property of ['icon', 'image', 'badge', 'data', 'actions']) delete value[property];
        value.body = '新しい通知があります。';
      }
      const notification = Reflect.construct(target, [prefs.privacyHidden ? 'DiscordDeck' : title, value]);
      notifications.add(notification);
      notification.addEventListener('close', () => notifications.delete(notification), { once: true });
      return notification;
    } });
  }
  Object.defineProperty(window, key, { value: { update(value) {
    prefs = value; notices.clear();
    if (prefs.privacyHidden) { for (const item of notifications) item.close(); notifications.clear(); }
    // Coalesce frequent focus/appearance updates.
    clearTimeout(routing); routing = setTimeout(routeAll, 0);
  } } });
}

if (window.top === window && location.origin === 'https://discord.com') {
  let policyWarning = false;
  const applyMedia = (value) => {
    if (!contextBridge?.executeInMainWorld) return;
    try { contextBridge.executeInMainWorld({ func: installMediaPolicy, args: [value] }); }
    catch { if (!policyWarning) { policyWarning = true; ipcRenderer.send('discord:media-notice', 'unavailable'); } }
  };
  let media = { notificationSound: true, hideOnBlur: false, privacyHidden: false, inputDevice: null, outputDevice: null };
  try {
    const argument = typeof process !== 'undefined' && process.argv?.find((value) => value.startsWith('--discorddeck-media='));
    if (argument) media = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(argument.split('=')[1]), (char) => char.charCodeAt(0))));
    const current = ipcRenderer.sendSync?.('discord:media-options');
    if (current) media = current;
  } catch { /* Safe defaults if startup options cannot be decoded. */ }
  applyMedia(media);
  window.addEventListener('discorddeck:media-notice', (event) => { if (event.detail === 'input' || event.detail === 'output') ipcRenderer.send('discord:media-notice', event.detail); });
  let previous = '';
  let timer;
  let options = { compactHeader: false, compactServers: false };
  let targets = new Map();
  let previousDiagnostics = '';
  const knownNames = new Map();
  const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  function serverArea() {
    const tree = document.querySelector('[data-list-id="guildsnav"]');
    return tree?.closest('[class*="guilds_"], nav[aria-label*="Servers"], nav[aria-label*="サーバー"]') || document.querySelector('[class*="guilds_"], nav[aria-label*="Servers"], nav[aria-label*="サーバー"]') || tree;
  }

  function accessibleName(node, boundary) {
    const candidates = [];
    const add = (value, quality) => { const label = clean(value); if (label && !/^guildsnav___/.test(label)) candidates.push({ label, quality }); };
    const related = (element, attribute) => (element.getAttribute(attribute) || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    const ownId = node.getAttribute('data-list-item-id') || node.closest('[data-list-item-id^="guildsnav___"]')?.getAttribute('data-list-item-id');
    // Discord puts the exact name on a drag wrapper ABOVE the clickable tree item.
    for (let parent = node, depth = 0; parent && parent !== boundary && depth < 6; parent = parent.parentElement, depth++) {
      if (depth && [...parent.querySelectorAll('[data-list-item-id^="guildsnav___"]')].some((item) => { const id = item.getAttribute('data-list-item-id'); return /^guildsnav___(?:\d+|folder[_-][\w-]+)$/.test(id) && id !== ownId; })) break;
      add(parent.getAttribute('data-dnd-name'), 100 - depth);
    }
    for (const element of node.querySelectorAll('[data-dnd-name]')) add(element.getAttribute('data-dnd-name'), 90);
    add(related(node, 'aria-labelledby'), 88);
    // The current guild icon renders its name as a screen-reader-only child span,
    // rather than an aria-label or image alt attribute.
    for (const element of node.querySelectorAll('[class*="hiddenVisually"], [class*="visuallyHidden"], [class*="srOnly"], .sr-only')) add(element.textContent, 85);
    for (const element of node.querySelectorAll('span')) {
      const style = getComputedStyle(element);
      if (style.position === 'absolute' && Number.parseFloat(style.width) <= 1 && Number.parseFloat(style.height) <= 1 && (style.clip !== 'auto' || style.clipPath !== 'none' || style.overflow === 'hidden')) add(element.textContent, 84);
    }
    add(node.getAttribute('aria-label'), 80);
    for (const element of node.querySelectorAll('[aria-labelledby], [aria-label]')) {
      add(related(element, 'aria-labelledby'), 78); add(element.getAttribute('aria-label'), 75);
    }
    add(node.getAttribute('title'), 70);
    add(node.querySelector('img[alt]')?.alt, 65);
    add(node.querySelector('svg title')?.textContent, 60);
    add(related(node, 'aria-describedby'), 55);
    return candidates.sort((a, b) => b.quality - a.quality)[0] || { label: '', quality: 0 };
  }

  function titlebar() {
    const marked = document.querySelector('[data-discorddeck-header]');
    if (marked) return { bar: marked, title: marked.querySelector('[class*="title_"]') };
    for (const title of document.querySelectorAll('[class*="bar_"] > [class*="title_"], [class*="titleBar_"] [class*="title_"]')) {
      const bar = title.closest('[class*="bar_"], [class*="titleBar_"]');
      const rect = bar.getBoundingClientRect();
      if (rect.top >= -1 && rect.top <= 60 && rect.height <= 64 && clean(title.textContent)) return { bar, title };
    }
    return { bar: null, title: null };
  }

  function navigation(servers) {
    const items = [{ key: 'home', kind: 'home', label: 'ダイレクトメッセージ', icon: null }];
    const next = new Map();
    const positions = new Map();
    const qualities = new Map();
    const clickTarget = (node) => node.matches('a,button,[role="button"],[role="treeitem"]') ? node : node.querySelector('a,button,[role="button"],[role="treeitem"]') || node;
    const home = servers?.querySelector('[data-list-item-id="guildsnav___home"], a[href="/channels/@me"], [role="treeitem"][aria-label="ダイレクトメッセージ"], [role="treeitem"][aria-label="Direct Messages"]') || document.querySelector('[data-list-item-id="guildsnav___home"], a[href="/channels/@me"]');
    if (home) next.set('home', clickTarget(home));
    const add = (node, key, kind, fallback) => {
      const image = node.querySelector('img');
      const found = accessibleName(node, servers);
      const existing = positions.get(key);
      if (existing !== undefined && found.quality <= qualities.get(key)) return;
      if (found.label) knownNames.set(key, found.label);
      const label = found.label || knownNames.get(key) || fallback;
      next.set(key, clickTarget(node));
      const item = { key, kind, label, icon: image?.currentSrc || image?.src || null };
      if (existing !== undefined) items[existing] = item;
      else { positions.set(key, items.length); items.push(item); }
      qualities.set(key, found.quality);
    };
    if (servers) for (const node of servers.querySelectorAll('[data-list-item-id^="guildsnav___"], a[href^="/channels/"]')) {
      const id = node.getAttribute('data-list-item-id') ?? '';
      const guild = id.match(/^guildsnav___(\d+)$/) || node.getAttribute('href')?.match(/^\/channels\/(\d+)(?:\/\d+)?\/?$/);
      const folder = id.match(/^guildsnav___folder[_-]([\w-]{1,80})$/);
      if (guild) add(node, `guild:${guild[1]}`, 'guild', '名前を取得できないサーバー');
      else if (folder) add(node, `folder:${folder[1]}`, 'folder', 'サーバーフォルダ');
    }
    targets = next;
    const missing = items.filter((item) => item.kind === 'guild' && item.label === '名前を取得できないサーバー').slice(0, 20);
    if (missing.length) {
      const attributeNames = ['class', 'role', 'data-list-item-id', 'data-dnd-name', 'aria-label', 'aria-labelledby', 'aria-describedby', 'title'];
      const describe = (node) => ({ tag: node.tagName, attributes: Object.fromEntries(attributeNames.map((name) => [name, clean(node.getAttribute(name))]).filter(([, value]) => value)) });
      const entries = missing.map((item) => {
        const node = next.get(item.key);
        const nodes = [];
        for (let current = node, depth = 0; current && current !== servers && depth < 5; current = current.parentElement, depth++) nodes.push(describe(current));
        return { key: item.key, nodes, children: node ? [...node.querySelectorAll('span,[role],[aria-label]')].slice(0, 12).map(describe) : [] };
      });
      const signature = JSON.stringify(entries);
      if (signature !== previousDiagnostics) { previousDiagnostics = signature; ipcRenderer.send('discord:name-diagnostics', entries); }
    }
    return items.slice(0, 300);
  }

  ipcRenderer.on('discord:options', (_event, value) => {
    options = { compactHeader: value?.compactHeader === true, compactServers: value?.compactServers === true };
    if (value?.media) applyMedia(value.media);
    schedule();
  });
  ipcRenderer.on('discord:navigate', (_event, value) => {
    const key = typeof value?.key === 'string' ? value.key : '';
    const serial = value?.serial;
    const node = targets.get(key);
    if (!node?.isConnected || !location.pathname.startsWith('/channels/')) {
      ipcRenderer.send('discord:navigation-result', { key, serial, ok: false }); return;
    }
    try { node.click(); }
    catch { ipcRenderer.send('discord:navigation-result', { key, serial, ok: false }); return; }
    schedule();
    setTimeout(() => {
      const [, id] = key.split(':');
      const ok = key === 'home' ? /^\/channels\/@me\/?$/.test(location.pathname) : key.startsWith('guild:') ? location.pathname.split('/')[2] === id : key.startsWith('dm:') ? location.pathname === `/channels/@me/${id}` : key.startsWith('folder:');
      ipcRenderer.send('discord:navigation-result', { key, serial, ok });
    }, 1500);
  });
  const avatarSelectors = [
    'section[aria-label="User area"] [class*="avatarWrapper_"] img',
    'section[aria-label="ユーザーエリア"] [class*="avatarWrapper_"] img',
    '[class*="panels_"] [class*="avatarWrapper_"] img',
  ];
  function collect() {
    timer = undefined;
    if (!document.documentElement) { schedule(); return; }
    let avatar = null;
    for (const selector of avatarSelectors) {
      const image = document.querySelector(selector);
      if (image) { avatar = image.currentSrc || image.src; break; }
    }
    const titleCount = document.title.match(/^\s*[([](\d{1,7})[)\]]/);
    let unreadCount = titleCount ? Math.min(9999, Number(titleCount[1])) : 0;
    let hasUnread = unreadCount > 0 || /^\s*[•●]/.test(document.title);
    const inApp = location.pathname.startsWith('/channels/');
    const servers = serverArea();
    if (servers) {
      let badges = 0;
      for (const badge of servers.querySelectorAll('[class*="numberBadge_"]')) {
        if (/^\d+\+?$/.test(badge.textContent.trim())) badges += Number.parseInt(badge.textContent, 10);
      }
      unreadCount = Math.min(9999, Math.max(unreadCount, badges));
      // Discord's small server pill indicates unread activity. Selected/hovered server pills are taller.
      const unreadPill = [...servers.querySelectorAll('[class*="pill_"] > span')].some((pill) => Number.parseFloat(pill.style.height) === 8);
      hasUnread = hasUnread || unreadCount > 0 || unreadPill;
    }
    const { bar, title } = inApp ? titlebar() : { bar: null, title: null };
    const items = inApp ? navigation(servers) : [];
    if (!inApp) targets.clear();
    if (bar) bar.setAttribute('data-discorddeck-header', '');
    if (bar?.parentElement) bar.parentElement.setAttribute('data-discorddeck-header-layout', '');
    if (servers && inApp) servers.setAttribute('data-discorddeck-servers', '');
    if (servers?.parentElement && inApp) servers.parentElement.setAttribute('data-discorddeck-server-layout', '');
    const canHideServers = Boolean(inApp && servers && (targets.has('home') || items.some((item) => item.kind === 'guild' || item.kind === 'folder')));
    document.documentElement.setAttribute('data-discorddeck-hide-header', String(Boolean(options.compactHeader && bar)));
    document.documentElement.setAttribute('data-discorddeck-hide-servers', String(Boolean(options.compactServers && canHideServers)));
    const metadata = { avatar, unreadCount, hasUnread, channelTitle: clean(title?.textContent), navigation: items, headerAvailable: Boolean(bar), serversAvailable: canHideServers };
    const key = JSON.stringify(metadata);
    if (key !== previous) { previous = key; ipcRenderer.send('discord:metadata', metadata); }
  }
  function schedule() { if (!timer) timer = setTimeout(collect, 400); }
  window.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'style', 'aria-label', 'aria-labelledby', 'aria-describedby', 'data-dnd-name', 'data-list-item-id'], characterData: true });
    collect();
    ipcRenderer.send('discord:ready');
  }, { once: true });
  // Hidden columns remain monitored. Polling also catches CSS-driven changes without observing messages.
  setInterval(schedule, 5000);
}
