import pkg from 'playwright'; const { chromium } = pkg;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', err => errors.push('pageerror: ' + err.message));

await page.goto('http://localhost:5180/', { waitUntil: 'networkidle' });
const CID = '91e8a94b-5a85-4cb0-bbb1-c997a1e55c86';
await page.goto(`http://localhost:5180/conversations/${CID}`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(2000);

const barCount = await page.locator('.thread-filter-bar').count();
const badgeCount = await page.locator('.classification-badge').count();
const badgeText = badgeCount ? await page.locator('.classification-badge').first().textContent() : null;
console.log('URL after nav:', page.url());
console.log('thread-filter-bar count:', barCount);
console.log('classification-badge count:', badgeCount, 'text:', badgeText);
console.log('console errors:', errors.slice(0, 10));

await browser.close();
