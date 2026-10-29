const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isId } = require('./model.cjs');

function validateLogin(email, password) {
  if (typeof email !== 'string' || email.trim().length > 320 || /[\u0000-\u001f\u007f]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('メールアドレスを確認してください。');
  if (typeof password !== 'string' || password.length < 1 || password.length > 4096 || /[\u0000\r\n]/.test(password)) throw new Error('パスワードを入力してください（4096文字以内）。');
  return { email: email.trim(), password };
}

class CredentialStore {
  constructor(filename, crypto) {
    this.filename = filename; this.crypto = crypto; this.entries = {}; this.invalid = false;
    try {
      if (fs.statSync(filename).size > 1024 * 1024) throw new Error('size');
      const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (raw.version !== 1 || !raw.entries || Array.isArray(raw.entries) || typeof raw.entries !== 'object') throw new Error('format');
      for (const [id, entry] of Object.entries(raw.entries)) {
        if (!isId(id) || typeof entry?.enabled !== 'boolean' || !isId(entry.revision) || typeof entry.encrypted !== 'string' || !/^[A-Za-z0-9+/]{1,65536}={0,2}$/.test(entry.encrypted)) throw new Error('entry');
        this.entries[id] = { encrypted: entry.encrypted, enabled: entry.enabled, revision: entry.revision };
      }
    } catch (error) { if (error.code !== 'ENOENT') { this.invalid = true; this.entries = {}; } }
  }
  check() { if (this.invalid) throw new Error('ログイン情報ファイルを読み込めません。保存フォルダのlogin-credentials.jsonを確認してください。'); }
  status(id) {
    const entry = this.entries[id];
    return { credentialsSaved: Boolean(entry), autofillEnabled: entry?.enabled === true, credentialsError: this.invalid };
  }
  options(id) { const entry = this.entries[id]; return { enabled: entry?.enabled === true && !this.invalid, revision: entry?.revision ?? '' }; }
  write(entries) {
    this.check();
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temp = `${this.filename}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.filename);
    this.entries = entries;
  }
  async available() {
    if (!this.crypto?.isAsyncEncryptionAvailable || !(await this.crypto.isAsyncEncryptionAvailable())) throw new Error('Windowsの暗号化機能を利用できないため、ログイン情報を保存・自動入力できません。');
  }
  async save(id, value) {
    this.check();
    if (!isId(id) || typeof value?.enabled !== 'boolean') throw new Error('ログイン情報の設定が無効です。');
    const previous = this.entries[id];
    let encrypted = previous?.encrypted;
    if (value.email !== '' || value.password !== '' || !previous) {
      const login = validateLogin(value.email, value.password);
      await this.available();
      try { encrypted = (await this.crypto.encryptStringAsync(JSON.stringify({ id, ...login }))).toString('base64'); }
      catch { throw new Error('ログイン情報を暗号化できませんでした。保存済みの情報は変更していません。'); }
    }
    this.write({ ...this.entries, [id]: { encrypted, enabled: value.enabled, revision: randomUUID() } });
  }
  remove(id) {
    this.check();
    if (!isId(id)) throw new Error('アカウントが無効です。');
    const next = { ...this.entries }; delete next[id]; this.write(next);
  }
  async readForFill(id) {
    this.check();
    const entry = this.entries[id];
    if (!entry?.enabled) return null;
    await this.available();
    try {
      const decrypted = await this.crypto.decryptStringAsync(Buffer.from(entry.encrypted, 'base64'));
      const login = JSON.parse(decrypted.result);
      if (login.id !== id) throw new Error('identity');
      const result = validateLogin(login.email, login.password);
      // Reject an in-flight request if the user changed, disabled or deleted the record.
      if (this.entries[id] !== entry || !entry.enabled) return null;
      if (decrypted.shouldReEncrypt) {
        const encrypted = (await this.crypto.encryptStringAsync(decrypted.result)).toString('base64');
        if (this.entries[id] !== entry) return null;
        this.write({ ...this.entries, [id]: { ...entry, encrypted } });
      }
      return { ...result, revision: entry.revision };
    } catch { throw new Error('保存済みのログイン情報を復号できません。ログイン情報を変更して保存し直してください。'); }
  }
}

module.exports = { CredentialStore, validateLogin };
