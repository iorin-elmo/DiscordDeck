const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveExternalApp, registryValue } = require('../src/external-app.cjs');

test('Windowsの関連付けから同じアプリをまとめ、既定アプリが変われば別の許可にする', async () => {
  let browser = 'ChromeHTML';
  const commands = { ChromeHTML: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -- "%1"', MSEdgeHTM: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" "%1"', OutlookURL: '"C:\\Program Files\\Office\\OUTLOOK.EXE" -c IPM.Note /m "%1"' };
  const execute = async (_file, args) => {
    const key = args[1];
    if (key.includes('UrlAssociations')) return { stdout: `    ProgId    REG_SZ    ${key.includes('mailto') ? 'OutlookURL' : browser}\r\n` };
    const progId = key.split('\\')[1];
    return { stdout: `    (Default)    REG_SZ    ${commands[progId]}\r\n` };
  };
  const options = { platform: 'win32', execute };
  const https = await resolveExternalApp('https://example.com/a', options);
  const http = await resolveExternalApp('http://another.test/b', options);
  const mail = await resolveExternalApp('mailto:someone@example.com', options);
  assert.equal(https.key, http.key); assert.notEqual(https.key, mail.key);
  assert.equal(mail.name, 'Outlook'); assert.equal(https.name, 'Google Chrome');
  browser = 'MSEdgeHTM';
  assert.notEqual((await resolveExternalApp('https://example.com', options)).key, https.key);
});

test('関連付けを識別できない場合や対象外スキームでは許可を記憶しない', async () => {
  assert.equal(registryValue('    ProgId    REG_SZ    MSEdgeHTM', 'ProgId'), 'MSEdgeHTM');
  const options = { platform: 'win32', execute: async () => { throw new Error('unavailable'); } };
  assert.equal(await resolveExternalApp('https://example.com', options), null);
  assert.equal(await resolveExternalApp('file:///C:/file.exe', options), null);
  assert.equal(await resolveExternalApp('https://example.com', { platform: 'linux' }), null);
});
