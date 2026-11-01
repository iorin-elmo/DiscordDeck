// A real navigation runs the page's trusted beforeunload/unload handlers.
// Flushing first and destroying WebContents skips data that the page writes on exit.
function preparePageForExit(contents, timeout = 5000) {
  if (contents.isDestroyed() || contents.getURL() === 'about:blank') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false;
    const allowExit = (event) => event.preventDefault();
    const destroyed = () => finish();
    const timer = setTimeout(() => {
      try { if (!contents.isDestroyed()) contents.stop?.(); } catch { /* Still finish the bounded exit. */ }
      finish(new Error('ページの終了処理が完了しませんでした。'));
    }, timeout);
    function finish(error) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      contents.off('will-prevent-unload', allowExit); contents.off('destroyed', destroyed);
      if (error) reject(error); else resolve();
    }
    // The user already chose to close/update the app. Let the page save, then leave.
    contents.on('will-prevent-unload', allowExit);
    contents.once('destroyed', destroyed);
    try { Promise.resolve(contents.loadURL('about:blank')).then(() => finish(), (error) => finish(contents.isDestroyed() ? undefined : error)); }
    catch (error) { finish(error); }
  });
}

module.exports = { preparePageForExit };
