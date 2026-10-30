const RELEASES_URL = 'https://github.com/iorin-elmo/DiscordDeck/releases/latest';
const versionText = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : '';

class UpdateManager {
  constructor({ updater, version, unavailable = '', onChange = () => {} }) {
    this.updater = updater;
    this.onChange = onChange;
    this.state = { enabled: Boolean(updater), phase: 'idle', currentVersion: version, latestVersion: '', progress: 0, error: '', unavailable };
    if (!updater) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    // URLs, local installer paths and release text never cross into the renderer.
    updater.logger = null;
    updater.on('update-available', (info) => {
      if (this.state.phase !== 'checking') return;
      const latestVersion = versionText(info?.version);
      if (!latestVersion) { this.fail(); return; }
      this.set({ phase: 'available', latestVersion, error: '' });
    });
    updater.on('update-not-available', (info) => {
      if (this.state.phase === 'checking') this.set({ phase: 'current', latestVersion: versionText(info?.version), error: '' });
    });
    updater.on('download-progress', (info) => {
      if (this.state.phase !== 'downloading' || !Number.isFinite(info?.percent)) return;
      const progress = Math.max(0, Math.min(100, Math.floor(info.percent)));
      if (progress !== this.state.progress) this.set({ progress });
    });
    updater.on('update-downloaded', (info) => {
      if (this.state.phase === 'downloading' && info?.version === this.state.latestVersion) this.set({ phase: 'downloaded', progress: 100, error: '' });
    });
    updater.on('error', (error) => this.fail(error));
  }
  snapshot() { return { ...this.state }; }
  set(patch) { Object.assign(this.state, patch); this.onChange(); }
  fail(error) {
    const missing = ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'].includes(error?.code);
    this.set({ phase: 'error', error: error?.code === 'DECK_UPDATE_SAVE_FAILED' ? '更新前にログイン状態や設定を保存できませんでした。空き容量と書き込み権限を確認してください。' : missing ? '公開済みの更新がまだありません。配布ページを確認してください。' : '更新に失敗しました。ネット接続と空き容量を確認して、もう一度お試しください。' });
  }
  async check() {
    if (!this.updater || !['idle', 'current', 'available', 'error'].includes(this.state.phase)) return;
    this.set({ phase: 'checking', error: '', latestVersion: '', progress: 0 });
    try { await this.updater.checkForUpdates(); } catch (error) { this.fail(error); }
  }
  async download() {
    if (!this.updater || this.state.phase !== 'available') return;
    this.set({ phase: 'downloading', progress: 0, error: '' });
    try { await this.updater.downloadUpdate(); } catch (error) { this.fail(error); }
  }
  beginInstall() {
    if (!this.updater || this.state.phase !== 'downloaded') throw new Error('更新ファイルをダウンロードしてから操作してください。');
    this.set({ phase: 'installing', error: '' });
  }
  quitAndInstall() {
    this.updater.quitAndInstall(false, true);
    if (this.state.phase !== 'installing') throw new Error('インストーラーを起動できませんでした。');
  }
}

module.exports = { UpdateManager, RELEASES_URL };
