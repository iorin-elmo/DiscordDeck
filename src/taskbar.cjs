const { deflateSync } = require('node:zlib');

function summarizeUnread(entries) {
  let count = 0, unknown = false;
  for (const entry of entries) {
    const value = Number.isSafeInteger(entry?.unreadCount) && entry.unreadCount > 0 ? Math.min(9999, entry.unreadCount) : 0;
    count += value;
    if (!value && entry?.hasUnread === true) unknown = true;
  }
  const label = count > 99 ? '99+' : count > 0 ? String(count) : unknown ? 'dot' : null;
  const description = count ? `全アカウントの未読通知: ${count}件${unknown ? '（ほかに件数不明の未読あり）' : ''}` : unknown ? '件数不明の未読通知があります' : '';
  return { count, unknown, label, description };
}

// Tiny built-in numeral masks avoid loading fonts or depending on the shell renderer.
const digits = {
  '0': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};
const narrow = { '9': ['111', '101', '101', '111', '001', '001', '111'], '+': ['000', '010', '010', '111', '010', '010', '000'] };

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([header, type, data, checksum]);
}

function renderBadge(label, size = 16) {
  if (typeof label !== 'string' || (label !== 'dot' && label !== '99+' && !/^[1-9]\d?$/.test(label))) throw new Error('Invalid badge label');
  if (!Number.isInteger(size) || size < 16 || size > 128) throw new Error('Invalid badge size');
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const font = label === '99+' ? narrow : digits, width = label === '99+' ? 3 : 5;
  const scale = label.length === 1 ? 1.5 : 1;
  const startX = Math.floor((16 - (label.length * (width + 1) - 1) * scale) / 2), startY = Math.floor((16 - 7 * scale) / 2);
  const radius = label === 'dot' ? 5 : 7.7;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let coverage = 0, white = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = (x + (sx + 0.5) / 4) * 16 / size, py = (y + (sy + 0.5) / 4) * 16 / size;
      if ((px - 8) ** 2 + (py - 8) ** 2 > radius ** 2) continue;
      coverage++;
      if (label === 'dot') continue;
      const gx = (px - startX) / scale, gy = Math.floor((py - startY) / scale), character = Math.floor(gx / (width + 1));
      const column = Math.floor(gx - character * (width + 1));
      if (character >= 0 && character < label.length && column >= 0 && column < width && font[label[character]]?.[gy]?.[column] === '1') white++;
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    if (coverage) {
      rows[offset] = Math.round((237 * (coverage - white) + 255 * white) / coverage);
      rows[offset + 1] = Math.round((66 * (coverage - white) + 255 * white) / coverage);
      rows[offset + 2] = Math.round((69 * (coverage - white) + 255 * white) / coverage);
      rows[offset + 3] = Math.round(coverage * 255 / 16);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { summarizeUnread, renderBadge };
