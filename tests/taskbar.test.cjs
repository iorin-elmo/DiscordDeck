const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeUnread, renderBadge } = require('../src/taskbar.cjs');

test('通知数を合計し、99+でも説明には実際の合計を残す', () => {
  assert.deepEqual(summarizeUnread([{ unreadCount: 5 }, { unreadCount: 7 }]), { count: 12, unknown: false, label: '12', description: '全アカウントの未読通知: 12件' });
  assert.equal(summarizeUnread([{ unreadCount: 99 }]).label, '99');
  const all = summarizeUnread(Array.from({ length: 8 }, () => ({ unreadCount: 9999 })));
  assert.equal(all.count, 79992); assert.equal(all.label, '99+'); assert.match(all.description, /79992/);
});

test('件数不明の未読を1件に換算せず、未読ゼロでは表示を消す', () => {
  assert.deepEqual(summarizeUnread([]), { count: 0, unknown: false, label: null, description: '' });
  assert.equal(summarizeUnread([{ unreadCount: 0, hasUnread: true }]).label, 'dot');
  const mixed = summarizeUnread([{ unreadCount: 5 }, { hasUnread: true }]);
  assert.equal(mixed.count, 5); assert.equal(mixed.label, '5'); assert.equal(mixed.unknown, true);
  assert.equal(summarizeUnread([{ unreadCount: NaN }, { unreadCount: -3 }, { unreadCount: '2' }]).count, 0);
});

test('描画は限定したラベルとサイズだけを受け付け、RGBAのPNGを返す', () => {
  for (const label of ['1', '12', '99', '99+', 'dot']) for (const size of [16, 32, 48]) {
    const png = renderBadge(label, size);
    assert.equal(png.subarray(1, 4).toString(), 'PNG'); assert.equal(png.readUInt32BE(16), size); assert.equal(png[25], 6);
  }
  for (const label of ['0', '100', '<svg>', null, 12]) assert.throws(() => renderBadge(label));
  assert.throws(() => renderBadge('1', 10000));
});
