const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, randomUUID, createCipheriv, createDecipheriv } = require('node:crypto');
const { CredentialStore } = require('../src/credentials.cjs');

function setup() {
  const key = randomBytes(32), filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-vault-')), 'login-credentials.json');
  const crypto = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    async decryptStringAsync(bytes) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return { result: Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'), shouldReEncrypt: false }; },
  };
  return { filename, crypto, vault: new CredentialStore(filename, crypto) };
}

test('暗号化保存と再起動後の読込、変更、削除、列間の分離', async () => {
  const { filename, crypto, vault } = setup(), a = randomUUID(), b = randomUUID();
  const value = { email: 'user@example.invalid', password: ' test-password-日本語 ', enabled: true };
  await vault.save(a, value); await vault.save(b, { ...value, email: 'other@example.invalid' });
  const content = fs.readFileSync(filename, 'utf8');
  assert.equal(content.includes(value.email), false); assert.equal(content.includes(value.password), false);
  const restored = new CredentialStore(filename, crypto);
  assert.equal((await restored.readForFill(a)).password, value.password);
  await restored.save(a, { ...value, password: 'changed-password' });
  assert.equal((await restored.readForFill(a)).password, 'changed-password');
  restored.remove(a); assert.equal(await restored.readForFill(a), null);
  assert.equal((await restored.readForFill(b)).email, 'other@example.invalid');
});

test('最大長のパスワードも暗号化後の再読込で保持し、不正なメールや長さを拒否する', async () => {
  const { filename, crypto, vault } = setup(), id = randomUUID();
  const value = { email: 'user@example.invalid', password: '\u0001'.repeat(4096), enabled: true };
  await vault.save(id, value);
  assert.equal((await new CredentialStore(filename, crypto).readForFill(id)).password, value.password);
  await assert.rejects(vault.save(id, { ...value, password: 'x'.repeat(4097) }));
  await assert.rejects(vault.save(id, { ...value, email: 'user\u0000@example.invalid' }));
});

test('暗号化の利用不可・失敗時に平文へフォールバックせず、旧レコードを保持する', async () => {
  const { filename, crypto, vault } = setup(), id = randomUUID();
  await vault.save(id, { email: 'user@example.invalid', password: 'test-password', enabled: true });
  const before = fs.readFileSync(filename, 'utf8');
  crypto.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(vault.save(id, { email: 'new@example.invalid', password: 'next-password', enabled: true }));
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  crypto.isAsyncEncryptionAvailable = async () => true;
  crypto.encryptStringAsync = async () => { throw new Error('internal secret must not be returned'); };
  await assert.rejects(vault.save(id, { email: 'new@example.invalid', password: 'next-password', enabled: true }), (e) => !e.message.includes('internal secret'));
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
});

test('無効化、改変された暗号文、別の列へ入れ替えたレコード、壊れたファイルを拒否する', async () => {
  const { filename, crypto, vault } = setup(), a = randomUUID(), b = randomUUID();
  await vault.save(a, { email: 'user@example.invalid', password: 'test-password', enabled: true });
  await vault.save(a, { email: '', password: '', enabled: false }); assert.equal(await vault.readForFill(a), null);
  await vault.save(a, { email: '', password: '', enabled: true });
  const raw = JSON.parse(fs.readFileSync(filename, 'utf8')); raw.entries[b] = raw.entries[a];
  fs.writeFileSync(filename, JSON.stringify(raw));
  await assert.rejects(new CredentialStore(filename, crypto).readForFill(b));
  raw.entries[a].encrypted = Buffer.from('tampered').toString('base64'); fs.writeFileSync(filename, JSON.stringify(raw));
  await assert.rejects(new CredentialStore(filename, crypto).readForFill(a));
  fs.writeFileSync(filename, '{invalid'); const broken = new CredentialStore(filename, crypto);
  await assert.rejects(broken.save(a, { email: 'user@example.invalid', password: 'test-password', enabled: true }));
  assert.equal(fs.readFileSync(filename, 'utf8'), '{invalid');
});

test('キー更新の再暗号化と、復号エラーに秘密の文字列を含めないことを確認する', async () => {
  const { filename, crypto, vault } = setup(), id = randomUUID();
  await vault.save(id, { email: 'user@example.invalid', password: 'test-password', enabled: true });
  const before = fs.readFileSync(filename, 'utf8'), decrypt = crypto.decryptStringAsync;
  crypto.decryptStringAsync = async (value) => ({ ...await decrypt(value), shouldReEncrypt: true });
  assert.equal((await vault.readForFill(id)).email, 'user@example.invalid');
  assert.notEqual(fs.readFileSync(filename, 'utf8'), before);
  crypto.decryptStringAsync = async () => { throw new Error('test-password'); };
  await assert.rejects(vault.readForFill(id), (e) => !e.message.includes('test-password'));
});
