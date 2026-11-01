const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { SessionCookieStore, sessionCookie } = require('../src/session-cookies.cjs');

const cookie = (value = 'fixture-session-value') => ({ name: 'session-fixture', value, domain: '.discord.com', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax', session: true });
function setup() {
  const key = randomBytes(32), filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-session-cookies-')), 'session-cookies.json');
  const crypto = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    async decryptStringAsync(data) { const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return { result: Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8') }; },
  };
  return { filename, crypto, store: new SessionCookieStore(filename, crypto), id: randomUUID() };
}
function session(items = []) {
  const writes = [];
  return { writes, cookies: { get: async () => items, set: async (value) => { writes.push(value); } } };
}

test('セッションCookieだけを暗号化して再起動後に復元し、期限付きCookieと別ドメインは補助保存しない', async () => {
  const { filename, crypto, store, id } = setup();
  await store.capture(id, session([cookie(), { ...cookie('persistent'), session: false, expirationDate: Date.now() / 1000 + 600 }, { ...cookie('foreign'), domain: '.example.invalid' }]));
  const raw = fs.readFileSync(filename, 'utf8');
  assert.equal(raw.includes('fixture-session-value'), false); assert.equal(raw.includes('session-fixture'), false);
  assert.equal(JSON.stringify([...store.fingerprints.values()]).includes('fixture-session'), false);
  const target = session(); await new SessionCookieStore(filename, crypto).restore(id, target);
  assert.equal(target.writes.length, 1);
  assert.deepEqual(target.writes[0], { url: 'https://discord.com/', name: 'session-fixture', value: 'fixture-session-value', path: '/', domain: '.discord.com', secure: true, httpOnly: true, sameSite: 'lax' });
  assert.equal(target.writes[0].expirationDate, undefined);
});

test('現在のCookieを上書きせず、host-only・HttpOnly・SameSiteなどの属性を引き継ぐ', async () => {
  const { store, id } = setup();
  await store.capture(id, session([cookie()]));
  const existing = session([{ ...cookie('current-value'), domain: 'discord.com', session: false }]);
  await store.restore(id, existing); assert.deepEqual(existing.writes, []);
  store.invalidate(id);
  await store.capture(id, session([{ ...cookie(), domain: 'discord.com', hostOnly: true, sameSite: 'strict', path: '/login' }]));
  const target = session(); await store.restore(id, target);
  assert.equal(target.writes[0].domain, undefined); assert.equal(target.writes[0].sameSite, 'strict'); assert.equal(target.writes[0].path, '/login');
});

test('ログアウトと削除で前の保存を直ちに無効化し、再起動しても復元しない', async () => {
  const { filename, crypto, store, id } = setup();
  await store.capture(id, session([cookie()])); store.invalidate(id);
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).entries[id], undefined);
  const target = session(); await new SessionCookieStore(filename, crypto).restore(id, target);
  assert.equal(target.writes.length, 0);
  await store.capture(id, session([cookie()])); await store.capture(id, session());
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).entries[id], undefined);
});

test('保存待ちの間にログアウト・列削除があっても古いCookieを書き戻さない', async () => {
  const { filename, crypto, store, id } = setup();
  let finish;
  const original = crypto.encryptStringAsync;
  crypto.encryptStringAsync = async (value) => { await new Promise((resolve) => { finish = resolve; }); return original(value); };
  const pending = store.capture(id, session([cookie()])); await new Promise(setImmediate);
  store.invalidate(id); finish(); await pending;
  assert.equal(fs.existsSync(filename), false);
});

test('アカウントを入れ替えた暗号文・改変・削除中の復元を拒否する', async () => {
  const { filename, crypto, store, id } = setup();
  await store.capture(id, session([cookie()])); const other = randomUUID();
  const raw = JSON.parse(fs.readFileSync(filename, 'utf8')); raw.entries[other] = raw.entries[id];
  fs.writeFileSync(filename, JSON.stringify(raw));
  const restored = new SessionCookieStore(filename, crypto), target = session();
  await assert.rejects(restored.restore(other, target)); assert.equal(target.writes.length, 0);
  await restored.restore(id, target, () => false); assert.equal(target.writes.length, 0);
  const bytes = Buffer.from(raw.entries[id], 'base64'); bytes[bytes.length - 1] ^= 1; raw.entries[id] = bytes.toString('base64');
  fs.writeFileSync(filename, JSON.stringify(raw)); await assert.rejects(new SessionCookieStore(filename, crypto).restore(id, target));
});

test('暗号化が使えない場合は平文へ切り替えず、壊れたファイルは保管して再作成できる', async () => {
  const { filename, crypto, store, id } = setup();
  crypto.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(store.capture(id, session([cookie()]))); assert.equal(fs.existsSync(filename), false);
  await store.capture(id, session([{ ...cookie(), session: false }])); assert.equal(fs.existsSync(filename), false);
  fs.writeFileSync(filename, '{broken');
  const recovered = new SessionCookieStore(filename, crypto);
  assert.equal(recovered.recovered, true);
  assert.equal(fs.readdirSync(path.dirname(filename)).some((name) => name.startsWith('session-cookies.json.invalid-')), true);
  crypto.isAsyncEncryptionAvailable = async () => true;
  await recovered.capture(id, session([cookie()])); assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).version, 1);
});

test('補助保存するCookieの範囲とサイズ・属性を制限する', () => {
  assert.ok(sessionCookie(cookie()));
  for (const patch of [{ domain: '.evil-discord.com' }, { path: '/\r\n' }, { name: 'a=b' }, { sameSite: 'unexpected' }, { partitionKey: { topLevelSite: 'https://example.invalid' } }, { value: 'x'.repeat(16385) }]) assert.equal(sessionCookie({ ...cookie(), ...patch }), null);
});
