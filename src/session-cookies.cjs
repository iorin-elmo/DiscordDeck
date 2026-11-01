const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isId } = require('./model.cjs');

function sessionCookie(cookie) {
  if (!cookie || cookie.session !== true || !['discord.com', '.discord.com'].includes(cookie.domain) || cookie.partitionKey) return null;
  if (typeof cookie.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(cookie.name) || typeof cookie.value !== 'string' || cookie.value.length > 16384) return null;
  if (typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || cookie.path.length > 2048 || /[\u0000-\u001f\u007f]/.test(cookie.path)) return null;
  if (typeof cookie.secure !== 'boolean' || typeof cookie.httpOnly !== 'boolean' || typeof cookie.hostOnly !== 'boolean' || !['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite)) return null;
  return { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, hostOnly: cookie.hostOnly, sameSite: cookie.sameSite, session: true };
}
const cookieKey = (cookie) => JSON.stringify([cookie.domain.replace(/^\./, ''), cookie.path, cookie.name]);

// Electron 45 does not persist/restore session-only cookies, even with persist: partitions.
// Keep those cookies encrypted, while LocalStorage/IndexedDB and expiring cookies stay in Chromium.
class SessionCookieStore {
  constructor(filename, crypto) {
    this.filename = filename; this.crypto = crypto; this.entries = {}; this.revisions = new Map();
    this.fingerprints = new Map(); this.recovered = false; this.disabled = false;
    try {
      if (fs.statSync(filename).size > 4 * 1024 * 1024) throw Error('size');
      const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) throw Error('format');
      for (const [id, encrypted] of Object.entries(raw.entries)) {
        if (!isId(id) || typeof encrypted !== 'string' || !/^[A-Za-z0-9+/]{1,524288}={0,2}$/.test(encrypted)) throw Error('entry');
        this.entries[id] = encrypted;
      }
    } catch (error) {
      this.entries = {};
      if (error.code !== 'ENOENT') {
        this.recovered = true;
        try { fs.copyFileSync(filename, `${filename}.invalid-${Date.now()}`); } catch { this.disabled = true; }
      }
    }
  }
  write(entries) {
    if (this.disabled) throw Error('Session cookie storage is unavailable');
    const body = JSON.stringify({ version: 1, entries });
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw Error('Session cookie storage is full');
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temp = `${this.filename}.tmp`, fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, body, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.filename); this.entries = entries;
  }
  invalidate(id) {
    if (!isId(id)) throw Error('Invalid account');
    this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
    this.fingerprints.delete(id);
    // Remove the previous checkpoint synchronously: a logout must not be resurrected after a crash.
    if (Object.hasOwn(this.entries, id)) { const next = { ...this.entries }; delete next[id]; this.write(next); }
  }
  async available() {
    if (!this.crypto?.isAsyncEncryptionAvailable || !(await this.crypto.isAsyncEncryptionAvailable())) throw Error('Session cookie encryption is unavailable');
  }
  async capture(id, session) {
    if (!isId(id)) throw Error('Invalid account');
    const revision = this.revisions.get(id) || 0;
    const cookies = (await session.cookies.get({ domain: 'discord.com' })).map(sessionCookie).filter(Boolean).sort((a, b) => cookieKey(a).localeCompare(cookieKey(b)));
    if ((this.revisions.get(id) || 0) !== revision) return;
    if (cookies.length > 128) throw Error('Too many session cookies');
    if (!cookies.length) {
      if (this.entries[id]) { const next = { ...this.entries }; delete next[id]; this.write(next); }
      this.fingerprints.delete(id); return;
    }
    const plain = JSON.stringify({ type: 'discorddeck-session-cookies', id, cookies });
    if (Buffer.byteLength(plain) > 256 * 1024) throw Error('Session cookies are too large');
    const fingerprint = createHash('sha256').update(plain).digest('hex');
    if (this.fingerprints.get(id) === fingerprint) return;
    await this.available();
    const encrypted = (await this.crypto.encryptStringAsync(plain)).toString('base64');
    if ((this.revisions.get(id) || 0) !== revision) return;
    this.write({ ...this.entries, [id]: encrypted }); this.fingerprints.set(id, fingerprint);
  }
  async restore(id, session, active = () => true) {
    if (!isId(id)) throw Error('Invalid account');
    const entry = this.entries[id], revision = this.revisions.get(id) || 0;
    if (!entry || this.disabled) return;
    const current = () => active() && this.entries[id] === entry && (this.revisions.get(id) || 0) === revision;
    await this.available();
    const decrypted = await this.crypto.decryptStringAsync(Buffer.from(entry, 'base64'));
    const raw = JSON.parse(decrypted.result);
    if (raw.type !== 'discorddeck-session-cookies' || raw.id !== id || !Array.isArray(raw.cookies) || raw.cookies.length > 128 || raw.cookies.some((cookie) => !sessionCookie(cookie))) throw Error('Invalid session cookie checkpoint');
    const present = new Set((await session.cookies.get({ domain: 'discord.com' })).map(cookieKey));
    for (const cookie of raw.cookies) {
      if (!current()) return;
      if (present.has(cookieKey(cookie))) continue;
      const details = { url: `https://discord.com${cookie.path}`, name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite };
      if (!cookie.hostOnly) details.domain = cookie.domain;
      await session.cookies.set(details); present.add(cookieKey(cookie));
    }
  }
}

module.exports = { SessionCookieStore, sessionCookie };
