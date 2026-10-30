const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { renderBadge } = require('../src/taskbar.cjs');

test('生成PNGを実ブラウザで復号し、透過と赤白の表示を確認する', async ({ page }) => {
  const items = ['1', '12', '99', '99+', 'dot'].flatMap((label) => [16, 32, 48].map((size) => ({ label, size, data: `data:image/png;base64,${renderBadge(label, size).toString('base64')}` })));
  await page.setContent('<body style="background:#17191f;color:white;font:14px sans-serif;display:flex;gap:20px;flex-wrap:wrap;padding:25px"></body>');
  const results = await page.evaluate(async (items) => {
    const results = [];
    for (const item of items) {
      const image = new Image(); image.src = item.data; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = item.size;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, item.size, item.size).data;
      let white = 0, red = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] && pixels[i] > 240 && pixels[i + 1] > 230) white++;
        if (pixels[i + 3] && pixels[i] > 200 && pixels[i + 1] < 100) red++;
      }
      results.push({ ...item, data: undefined, width: image.naturalWidth, height: image.naturalHeight, cornerAlpha: pixels[3], white, red });
      const box = document.createElement('div'); box.style.cssText = 'width:130px;height:100px;display:grid;place-items:center;align-content:center;gap:10px'; box.append(image, `${item.label} / ${item.size}px`); document.body.append(box);
    }
    return results;
  }, items);
  for (const result of results) {
    expect(result.width).toBe(result.size); expect(result.height).toBe(result.size); expect(result.cornerAlpha).toBe(0); expect(result.red).toBeGreaterThan(0);
    if (result.label !== 'dot') expect(result.white).toBeGreaterThan(0);
  }
  fs.mkdirSync(path.join(__dirname, '../artifacts'), { recursive: true });
  await page.screenshot({ path: 'artifacts/taskbar-badge-preview.png' });
});
