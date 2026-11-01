const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { preparePageForExit } = require('../src/lifecycle.cjs');
function page() {
  const contents = new EventEmitter();
  Object.assign(contents, { isDestroyed: () => false, getURL: () => 'https://discord.com/channels/@me', stop() { this.stopped = true; } });
  return contents;
}
test('実際のナビゲーション完了を待ち、終了前にサイトの書き戻し処理を通す', async () => {
  const contents = page(); let finish, prepared = false;
  contents.loadURL = (url) => { assert.equal(url, 'about:blank'); return new Promise((resolve) => { finish = () => { contents.saved = true; resolve(); }; }); };
  const pending = preparePageForExit(contents).then(() => { prepared = true; });
  await new Promise(setImmediate); assert.equal(prepared, false);
  finish(); await pending; assert.equal(contents.saved, true); assert.equal(prepared, true);
  assert.equal(contents.listenerCount('will-prevent-unload'), 0);
});
test('ユーザーが終了を選んだ場合はページの終了ハンドラーを実行して離脱を許可する', async () => {
  const contents = page(); let allowed = false;
  contents.loadURL = async () => contents.emit('will-prevent-unload', { preventDefault() { allowed = true; } });
  await preparePageForExit(contents); assert.equal(allowed, true);
});
test('壊れたページや停止したレンダラーで無期限に終了を待たず、待機リスナーを片付ける', async () => {
  const contents = page(); contents.loadURL = () => new Promise(() => {});
  await assert.rejects(preparePageForExit(contents, 10)); assert.equal(contents.stopped, true);
  assert.equal(contents.listenerCount('destroyed'), 0);
  contents.loadURL = async () => { throw Error('navigation failure'); };
  await assert.rejects(preparePageForExit(contents));
});
test('既に破棄された画面や空白ページではナビゲーションしない', async () => {
  const contents = page(); contents.loadURL = () => { throw Error('must not navigate'); };
  contents.isDestroyed = () => true; await preparePageForExit(contents);
  contents.isDestroyed = () => false; contents.getURL = () => 'about:blank'; await preparePageForExit(contents);
});
