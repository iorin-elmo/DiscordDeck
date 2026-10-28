const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/discord-preload.cjs'), 'utf8');

// Real browser prototypes and the actual preload policy; device capture/routing are doubles.
async function fixture(page, salt = 'account-A', initial = null) {
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Discord</title><body></body>' }));
  await page.addInitScript(({ source, salt, initial }) => {
    const handlers = {};
    window.__deliverMedia = (patch) => handlers['discord:options']({}, { media: { notificationSound: true, privacyHidden: false, inputDevice: null, outputDevice: null, ...patch } });
    window.__notices = []; window.__plays = []; window.__captures = []; window.__notifications = []; window.__tracks = [];
    window.__labels = true;
    window.__enumerations = 0;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__hidden ? 'hidden' : 'visible' });
    const list = [
      { kind: 'audioinput', label: 'USBマイク', deviceId: `${salt}-mic` },
      { kind: 'audioinput', label: 'USBマイク', deviceId: `${salt}-mic-2` },
      { kind: 'audiooutput', label: 'スピーカー', deviceId: `${salt}-speaker` },
    ];
    const sinks = new WeakMap();
    Object.defineProperty(HTMLMediaElement.prototype, 'sinkId', { configurable: true, get() { return sinks.get(this) || ''; } });
    HTMLMediaElement.prototype.setSinkId = async function (id) { sinks.set(this, id); };
    HTMLMediaElement.prototype.play = async function () { window.__plays.push({ src: this.src, muted: this.muted, sink: this.sinkId }); };
    class Context { constructor() { this.sinkId = ''; } async setSinkId(id) { this.sinkId = id; } }
    window.AudioContext = window.webkitAudioContext = Context;
    class NotificationDouble extends EventTarget {
      constructor(title, options) { super(); this.title = title; this.options = options; window.__notifications.push(this); }
      close() { this.closed = true; this.dispatchEvent(new Event('close')); }
    }
    window.Notification = NotificationDouble;
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => { window.__enumerations++; return list.map((d) => ({ ...d, label: window.__labels ? d.label : '' })); } });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, writable: true, value: async (constraints) => {
      window.__captures.push(constraints); window.__labels = true;
      const id = constraints.audio?.deviceId?.exact || `${salt}-default`;
      const track = { stopped: false, getSettings: () => ({ deviceId: id }), stop() { this.stopped = true; } };
      window.__tracks.push(track);
      const tracks = [track];
      return { getTracks: () => tracks, getAudioTracks: () => tracks, removeTrack(t) { tracks.splice(tracks.indexOf(t), 1); }, addTrack(t) { tracks.push(t); } };
    } });
    new Function('require', source)(() => ({
      contextBridge: { executeInMainWorld: ({ func, args }) => func(...args) },
      ipcRenderer: { sendSync: () => initial, on: (channel, handler) => { handlers[channel] = handler; }, send: (channel, value) => { if (channel === 'discord:media-notice') window.__notices.push(value); } },
    }));
  }, { source, salt, initial });
  await page.goto('https://discord.com/channels/@me');
}

test('通知音だけを消し、通話・添付音声・動画をミュートせず、ONで復帰する', async ({ page }) => {
  await fixture(page, 'account-A', { notificationSound: false, privacyHidden: false, inputDevice: null, outputDevice: null });
  const result = await page.evaluate(async () => {
    const alert = new Audio('https://discord.com/assets/message.mp3');
    const attachment = new Audio('https://cdn.discordapp.com/attachments/1/2/clip.mp3');
    const call = new Audio(); call.srcObject = new MediaStream();
    const video = document.createElement('video'); video.src = 'https://discord.com/assets/demo.mp3';
    await Promise.all([alert.play(), attachment.play(), call.play(), video.play()]);
    alert.muted = false;
    const off = [alert.muted, attachment.muted, call.muted, video.muted];
    window.__deliverMedia({ notificationSound: true }); await alert.play();
    return { off, on: alert.muted };
  });
  expect(result).toEqual({ off: [true, false, false, false], on: false });
});

test('OS通知の消音と秘匿、表示済み通知の終了を反映する', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(() => {
    const old = new Notification('secret', { body: 'message', icon: 'https://cdn.discordapp.com/a.png' });
    window.__deliverMedia({ notificationSound: false, privacyHidden: true });
    const hidden = new Notification('secret', { body: 'message', icon: 'https://cdn.discordapp.com/a.png', data: { secret: true } });
    return { closed: old.closed, title: hidden.title, options: hidden.options };
  });
  expect(result).toEqual({ closed: true, title: 'DiscordDeck', options: { body: '新しい通知があります。', silent: true } });
});

test('共通の機器名をアカウント固有IDへ変換し、HTML音声とAudioContextの出力を切り替える', async ({ browser }) => {
  for (const salt of ['account-A', 'account-B']) {
    const page = await browser.newPage();
    await fixture(page, salt);
    const result = await page.evaluate(async () => {
      window.__deliverMedia({ inputDevice: { label: 'USBマイク', ordinal: 1 }, outputDevice: { label: 'スピーカー', ordinal: 0 } });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
      const audio = new Audio(); await audio.setSinkId('discord-choice'); await audio.play();
      const context = new webkitAudioContext(); await context.setSinkId('discord-choice');
      const selected = { mic: stream.getAudioTracks()[0].getSettings().deviceId, audio: audio.sinkId, context: context.sinkId, captures: window.__captures };
      window.__deliverMedia({}); await audio.play(); await context.setSinkId('discord-choice');
      return { selected, restored: [audio.sinkId, context.sinkId] };
    });
    expect(result.selected.mic).toBe(`${salt}-mic-2`);
    expect(result.selected.audio).toBe(`${salt}-speaker`);
    expect(result.selected.context).toBe(`${salt}-speaker`);
    expect(result.selected.captures).toEqual([{ audio: { echoCancellation: true, deviceId: { exact: `${salt}-mic-2` } }, video: false }]);
    expect(result.restored).toEqual(['discord-choice', 'discord-choice']);
    await page.close();
  }
});

test('初回許可後に指定マイクへ切り替え、取得不能なら一時マイクを停止して失敗する', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    window.__labels = false;
    window.__deliverMedia({ inputDevice: { label: 'USBマイク', ordinal: 0 } });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const stopped = window.__tracks[0].stopped;
    window.__deliverMedia({ inputDevice: { label: '切断されたマイク', ordinal: 0 } });
    let error;
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { error = e.name; }
    return { stopped, id: stream.getAudioTracks()[0].getSettings().deviceId, error, failedTrackStopped: window.__tracks.at(-1).stopped, notices: window.__notices };
  });
  expect(result).toEqual({ stopped: true, id: 'account-A-mic', error: 'NotFoundError', failedTrackStopped: true, notices: ['input'] });
});

test('非表示中は機器一覧の再取得を待たず通知音を再生し、機器変更でマイクを起動しない', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const settings = { outputDevice: { label: 'スピーカー', ordinal: 0 } };
    window.__deliverMedia(settings);
    const audio = new Audio('https://discord.com/assets/message.mp3'); await audio.play();
    const enumerations = window.__enumerations;
    window.__hidden = true;
    window.__deliverMedia({ ...settings, privacyHidden: true, inputDevice: { label: 'USBマイク', ordinal: 0 } });
    await audio.play();
    return { enumerations, after: window.__enumerations, sink: audio.sinkId, captures: window.__captures.length, plays: window.__plays.length };
  });
  expect(result.after).toBe(result.enumerations);
  expect(result.sink).toBe('account-A-speaker'); expect(result.captures).toBe(0); expect(result.plays).toBe(2);
});
