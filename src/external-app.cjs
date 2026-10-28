const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const path = require('node:path');
const run = promisify(execFile);

function registryValue(output, name) {
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*(.*?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/);
    if (match && (name === null || match[1].toLowerCase() === name.toLowerCase())) return match[2].trim();
  }
  return null;
}

async function resolveExternalApp(url, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return null;
  const protocol = new URL(url).protocol.slice(0, -1).toLowerCase();
  if (!['http', 'https', 'mailto'].includes(protocol)) return null;
  const execute = options.execute ?? run;
  const query = async (key, value) => {
    const result = await execute('reg.exe', ['query', key, ...(value ? ['/v', value] : ['/ve'])], { windowsHide: true, timeout: 3000, maxBuffer: 32 * 1024 });
    return registryValue(result.stdout, value);
  };
  try {
    const progId = await query(`HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${protocol}\\UserChoice`, 'ProgId');
    if (!progId || !/^[a-z0-9_.-]{1,200}$/i.test(progId)) return null;
    let command;
    try { command = await query(`HKCR\\${progId}\\shell\\open\\command`, null); } catch { /* Delegated AppX associations may have no command. */ }
    const match = command?.match(/^\s*(?:"([^"]+\.exe)"|(.+?\.exe)(?=\s|$))/i);
    const executable = match?.[1] || match?.[2];
    const executableName = executable ? path.win32.basename(executable).replace(/\.exe$/i, '').toLowerCase() : '';
    const generic = ['rundll32', 'explorer', 'applicationframehost', 'dllhost'].includes(executableName);
    const identity = executable && path.win32.isAbsolute(executable) && !generic ? `exe:${path.win32.normalize(executable).toLowerCase()}` : `progid:${progId.toLowerCase()}`;
    const names = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Mozilla Firefox', outlook: 'Outlook', thunderbird: 'Thunderbird', brave: 'Brave' };
    const name = names[executableName] || (!generic && executableName ? executableName : '既定のアプリ');
    return { key: createHash('sha256').update(identity).digest('hex'), name };
  } catch { return null; }
}

module.exports = { resolveExternalApp, registryValue };
