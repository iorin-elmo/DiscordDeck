const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateManager } = require('../src/updates.cjs');

function setup() {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { updater.checks = (updater.checks || 0) + 1; };
  updater.downloadUpdate = async () => { updater.downloads = (updater.downloads || 0) + 1; };
  updater.quitAndInstall = (...args) => { updater.installArgs = args; };
  const manager = new UpdateManager({ updater, version: '0.10.0' });
  return { updater, manager };
}

test('更新は明示した確認・ダウンロード・再起動だけで進み、連打を抑える', async () => {
  const { updater, manager } = setup();
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false); assert.equal(updater.allowPrerelease, false); assert.equal(updater.disableWebInstaller, true);
  assert.throws(() => manager.beginInstall()); await manager.download(); assert.equal(updater.downloads, undefined);
  await Promise.all([manager.check(), manager.check()]); assert.equal(updater.checks, 1);
  updater.emit('update-available', { version: '0.11.0', path: 'private-path', releaseNotes: '<script>untrusted</script>' });
  assert.equal(manager.snapshot().phase, 'available'); assert.equal(updater.downloads, undefined);
  assert.equal(JSON.stringify(manager.snapshot()).includes('private-path'), false);
  await Promise.all([manager.download(), manager.download()]); assert.equal(updater.downloads, 1);
  updater.emit('download-progress', { percent: 52.8 }); assert.equal(manager.snapshot().progress, 52);
  updater.emit('download-progress', { percent: NaN }); assert.equal(manager.snapshot().progress, 52);
  updater.emit('update-downloaded', { version: '0.9.0' }); assert.equal(manager.snapshot().phase, 'downloading');
  updater.emit('update-downloaded', { version: '0.11.0', downloadedFile: 'secret-cache-path' });
  assert.equal(manager.snapshot().phase, 'downloaded'); assert.equal(manager.snapshot().progress, 100);
  assert.equal(updater.installArgs, undefined); await manager.check(); assert.equal(updater.checks, 1);
  manager.beginInstall(); assert.throws(() => manager.beginInstall());
  manager.quitAndInstall(); assert.deepEqual(updater.installArgs, [false, true]);
});

test('未公開・通信・検証エラーは詳細を渡さず、再確認できる', async () => {
  const { updater, manager } = setup();
  updater.checkForUpdates = async () => { throw Object.assign(new Error('secret url?token=private'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }); };
  await manager.check(); assert.equal(manager.snapshot().phase, 'error'); assert.match(manager.snapshot().error, /公開済み/);
  updater.checkForUpdates = async () => updater.emit('update-not-available', { version: '0.10.0' });
  await manager.check(); assert.equal(manager.snapshot().phase, 'current');
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.11.0' });
  await manager.check();
  updater.downloadUpdate = async () => { const error = Object.assign(new Error('secret install path'), { code: 'ERR_SHA512_CHECKSUM_MISMATCH' }); updater.emit('error', error); throw error; };
  await manager.download(); assert.equal(manager.snapshot().phase, 'error');
  assert.equal(JSON.stringify(manager.snapshot()).includes('secret'), false);
  assert.throws(() => manager.beginInstall()); assert.equal(updater.installArgs, undefined);
  await manager.check(); assert.equal(manager.snapshot().phase, 'available');
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '0.11.0' });
  await manager.download(); manager.beginInstall();
  updater.quitAndInstall = () => updater.emit('error', new Error('private installer path'));
  assert.throws(() => manager.quitAndInstall()); assert.equal(manager.snapshot().phase, 'error');
});

test('非対応版では更新APIを呼ばず、不正なリリース情報も受け入れない', async () => {
  const unavailable = new UpdateManager({ updater: null, version: '0.10.0', unavailable: 'Setup版が必要です。' });
  await unavailable.check(); await unavailable.download(); assert.throws(() => unavailable.beginInstall());
  assert.equal(unavailable.snapshot().enabled, false);
  const { manager, updater } = setup(); await manager.check();
  updater.emit('update-available', { version: '<img src=x onerror=alert(1)>' });
  assert.equal(manager.snapshot().phase, 'error'); assert.equal(manager.snapshot().latestVersion, '');
  const copy = manager.snapshot(); copy.phase = 'downloaded'; assert.equal(manager.snapshot().phase, 'error');
});

test('実際のNSIS更新ライブラリでダウンロードを完了し、改変ファイルのSHA-512不一致を拒否する', async (t) => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
  const { createHash } = require('node:crypto');
  const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
  const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
  const { NodeHttpExecutor } = require('builder-util/out/nodeHttpExecutor');
  const { HttpExecutor } = require('builder-util-runtime');
  const expected = Buffer.from('Not an executable. Offline updater test fixture.');
  let corrupt = false;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/latest.yml')) {
      const sha512 = createHash('sha512').update(expected).digest('base64');
      res.end(`version: 0.11.0\nfiles:\n  - url: fixture-Setup.exe\n    sha512: ${sha512}\n    size: ${expected.length}\npath: fixture-Setup.exe\nsha512: ${sha512}\nreleaseDate: '2026-10-30T00:00:00Z'\n`);
    } else { res.end(corrupt ? Buffer.from('Modified file that must never be accepted.') : expected); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const modified of [false, true]) {
    corrupt = modified;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discorddeck-update-'));
    const url = `http://127.0.0.1:${server.address().port}`;
    const config = path.join(root, 'app-update.yml');
    fs.writeFileSync(config, `provider: generic\nurl: ${url}\nupdaterCacheDirName: fixture-cache\n`);
    const adapter = { version: '0.10.0', name: 'DiscordDeck', isPackaged: true, appUpdateConfigPath: config, userDataPath: root, baseCachePath: root, whenReady: async () => {}, onQuit() { throw Error('No automatic install allowed'); }, quit() { throw Error('Test must never quit/install'); } };
    const updater = new NsisUpdater(null, adapter);
    // Exercise the actual download/checksum pipeline; replace only Electron's native HTTP transport.
    const executor = new ElectronHttpExecutor();
    executor.createRequest = NodeHttpExecutor.prototype.createRequest;
    executor.addRedirectHandlers = HttpExecutor.prototype.addRedirectHandlers;
    updater.httpExecutor = executor;
    updater.disableDifferentialDownload = true;
    const manager = new UpdateManager({ updater, version: '0.10.0' });
    await manager.check(); assert.equal(manager.snapshot().phase, 'available');
    await manager.download();
    assert.equal(manager.snapshot().phase, modified ? 'error' : 'downloaded');
    if (!modified) assert.deepEqual(fs.readFileSync(updater.installerPath), expected);
    else { assert.throws(() => manager.beginInstall()); assert.equal(updater.installerPath, null); }
  }
});
