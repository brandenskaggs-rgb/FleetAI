'use strict';
// Rasterize the existing approved Link mark; no third-party image download.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const svg = await fs.readFile(path.join(root, 'assets/brand/fleet-ai-mark.svg'), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:white;width:1024px;height:1024px;display:grid;place-items:center"><div style="width:640px;height:640px">${svg}</div></body></html>`);
    await page.screenshot({ path: path.join(root, 'driver_ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png'), omitBackground: false });
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
