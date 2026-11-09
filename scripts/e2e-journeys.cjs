const { chromium, devices } = require('playwright');
const { execSync } = require('child_process');
const sql = (s) => execSync('psql -h /tmp -p 54329 -U postgres -d linkup -Atc ' + JSON.stringify(s)).toString().trim();
const B = 'http://localhost:3200';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const as = async (tokn, lang = 'he') => { const ctx = await b.newContext({ ...devices['iPhone 13'], locale: lang });
    await ctx.addCookies([{ name: 'sb-localhost-auth-token', value: tokn, domain: 'localhost', path: '/' }, { name: 'lk_lang', value: lang, domain: 'localhost', path: '/' }]);
    const p = await ctx.newPage(); p.on('pageerror', e => { console.log('JS ERROR', e.message); fails++; }); return { ctx, p }; };
  const go = async (p, path) => { await p.goto(B + path, { waitUntil: 'networkidle' }); };
  const submit = async (p, sel) => { await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click(sel)]); };

  // 1. Store owner: sign-up → connect → offer → campaign → invite creator
  const { p: s } = await as('base64-eyJhY2Nlc3NfdG9rZW4iOiJleUpoYkdjaU9pSklVekkxTmlJc0luUjVjQ0k2SWtwWFZDSjkuZXlKemRXSWlPaUpoTURBd01EQXdNQzB3TURBd0xUQXdNREF0TURBd01DMHdNREF3TURBd01EQXdNREVpTENKbGJXRnBiQ0k2SW05M2JtVnlRR1pzYjNjdWRHVnpkQ0lzSW5KdmJHVWlPaUpoZFhSb1pXNTBhV05oZEdWa0lpd2lZWFZrSWpvaVlYVjBhR1Z1ZEdsallYUmxaQ0lzSW1WNGNDSTZNVGM1TkRnMU1EUXhNbjAuT0liekJNZzN2cElPcW5PSDAzZEt1OHQ3MDBhWlVkZUZTZTZzWXdyWGxlYyIsInRva2VuX3R5cGUiOiJiZWFyZXIiLCJleHBpcmVzX2luIjo2MDQ4MDAsImV4cGlyZXNfYXQiOjE3OTQ4NTA0MTIsInJlZnJlc2hfdG9rZW4iOiJyLWEwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMSIsInVzZXIiOnsiaWQiOiJhMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJlbWFpbCI6Im93bmVyQGZsb3cudGVzdCIsImF1ZCI6ImF1dGhlbnRpY2F0ZWQiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImFwcF9tZXRhZGF0YSI6e30sInVzZXJfbWV0YWRhdGEiOnt9LCJjcmVhdGVkX2F0IjoiMjAyNi0xMS0wOVQxNzozMzozMi41MDNaIn19');
  await go(s, '/app/new?type=store'); await s.fill('input[name=name]', 'Flow Shop'); await s.fill('input[name=website]', 'flowshop.co.il');
  await submit(s, 'form button.btn-primary');
  ok(s.url().includes('/app/connect'), 'store: sign-up lands on connect');
  await s.click('main form button'); await s.waitForTimeout(3000); await s.screenshot({ path: 'shots/dbg-connect.png' }); await s.waitForSelector('.keybox');
  const key = await s.locator('.keybox').textContent(); ok(/^lk_[0-9a-f]{32}_[0-9a-f]{64}$/.test(key.trim()), 'store: connection key shown once');
  const storeId = sql("select id from organizations where name='Flow Shop'");
  const conn = sql("select id from store_connections where org_id='" + storeId + "'");
  sql("select plugin_sync('" + conn + "','0.3.0')");
  sql("select plugin_sync_products('" + conn + "', '[{\"id\":\"9\",\"name\":\"Gold ring\",\"price\":39900,\"currency\":\"ILS\",\"in_stock\":true}]'::jsonb)");
  await go(s, '/app?org=' + storeId); ok((await s.locator('.next h2').textContent()).includes('הצעה'), 'store: next action after connect = publish offer');
  await go(s, '/app/offer?org=' + storeId); await submit(s, 'button[name=status][value=live]');
  ok(sql("select status from opportunities where store_org_id='" + storeId + "' and kind='standing'") === 'live', 'store: offer published');
  await s.fill('input[name=title] >> nth=1', 'Flash week'); await submit(s, 'button:has-text("הפעלת הקמפיין")');
  ok(sql("select count(*) from opportunities where store_org_id='" + storeId + "' and kind='campaign' and status='live'") === '1', 'LAUNCH: campaign created from UI');
  await go(s, '/app/invite?org=' + storeId); await s.fill('input[name=name]', 'Dana'); await submit(s, 'main form button.btn-primary');
  const link = (await s.locator('.keybox').textContent()).trim(); ok(/\/o\/[0-9a-f]{24}$/.test(link), 'invite: partnership link created');
  ok(await s.locator('a.btn-wa').count() === 1, 'invite: WhatsApp share button');

  // 2. Creator accepts the invite with a new activity → coupon → creative
  const { p: c } = await as('base64-eyJhY2Nlc3NfdG9rZW4iOiJleUpoYkdjaU9pSklVekkxTmlJc0luUjVjQ0k2SWtwWFZDSjkuZXlKemRXSWlPaUpoTURBd01EQXdNQzB3TURBd0xUQXdNREF0TURBd01DMHdNREF3TURBd01EQXdNRElpTENKbGJXRnBiQ0k2SW1OeVpXRjBiM0pBWm14dmR5NTBaWE4wSWl3aWNtOXNaU0k2SW1GMWRHaGxiblJwWTJGMFpXUWlMQ0poZFdRaU9pSmhkWFJvWlc1MGFXTmhkR1ZrSWl3aVpYaHdJam94TnprME9EVXdOREV5ZlEuVjNKXzJsTVBsLVloQXBiblVSY25Nbmc5Q1czWkNraXZwMF9ob1hkVWlFUSIsInRva2VuX3R5cGUiOiJiZWFyZXIiLCJleHBpcmVzX2luIjo2MDQ4MDAsImV4cGlyZXNfYXQiOjE3OTQ4NTA0MTIsInJlZnJlc2hfdG9rZW4iOiJyLWEwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMiIsInVzZXIiOnsiaWQiOiJhMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDIiLCJlbWFpbCI6ImNyZWF0b3JAZmxvdy50ZXN0IiwiYXVkIjoiYXV0aGVudGljYXRlZCIsInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiYXBwX21ldGFkYXRhIjp7fSwidXNlcl9tZXRhZGF0YSI6e30sImNyZWF0ZWRfYXQiOiIyMDI2LTExLTA5VDE3OjMzOjMyLjUyOFoifX0');
  await c.goto(link.replace(/^https?:\/\/[^/]+/, B), { waitUntil: 'networkidle' });
  await c.fill('input[name=name]', 'Dana Creates'); await submit(c, 'form.card button');
  const creatorId = sql("select id from organizations where name='Dana Creates'");
  ok(sql("select count(*) from agreements where creator_org_id='" + creatorId + "' and store_org_id='" + storeId + "'") === '1', 'creator: invite accepted → partnership');
  ok(sql("select count(*) from opportunity_applications ap join opportunities o on o.id=ap.opportunity_id where o.kind='campaign' and ap.creator_org_id='" + creatorId + "'") === '1', 'LAUNCH: invited creator auto-enrolled in live campaign?');
  await go(c, '/app/partnerships?org=' + creatorId); const cc = (await c.locator('.codebig').first().textContent()).trim(); ok(cc.length >= 4, 'creator: personal coupon ' + cc);
  await go(c, '/app/share?org=' + creatorId + '&code=' + cc + '&f=story'); await c.waitForTimeout(1500);
  ok(await c.locator('img.story-preview').count() === 1, 'creative: story image generated');
  await go(c, '/app/share?org=' + creatorId + '&code=' + cc + '&f=whatsapp'); ok((await c.locator('p[style*="pre-wrap"]').textContent()).includes(cc), 'creative: WhatsApp text contains coupon');

  // 3. Combined user: the creator adds a store activity and switches
  await go(c, '/app/new?type=store'); await c.fill('input[name=name]', 'Dana Boutique'); await submit(c, 'form button.btn-primary');
  await go(c, '/app?org=' + creatorId); const menu = await c.locator('.switcher .menu').textContent(); ok(menu.includes('Dana Boutique'), 'combined user: both activities in switcher');

  // 4. Viral invite: creator's personal link → new user signs up a store → referral recorded
  const rc = sql("select referral_code from organizations where id='" + creatorId + "'");
  const { p: n } = await as('base64-eyJhY2Nlc3NfdG9rZW4iOiJleUpoYkdjaU9pSklVekkxTmlJc0luUjVjQ0k2SWtwWFZDSjkuZXlKemRXSWlPaUpoTURBd01EQXdNQzB3TURBd0xUQXdNREF0TURBd01DMHdNREF3TURBd01EQXdNRFFpTENKbGJXRnBiQ0k2SW01bGQzTjBiM0psUUdac2IzY3VkR1Z6ZENJc0luSnZiR1VpT2lKaGRYUm9aVzUwYVdOaGRHVmtJaXdpWVhWa0lqb2lZWFYwYUdWdWRHbGpZWFJsWkNJc0ltVjRjQ0k2TVRjNU5EZzFNRFF4TW4wLmF3NHhPSmRSdWdUOGhyS1NEaFdxR3hoLXdDSy0wQmlWZlVhZjJMYmI5UkEiLCJ0b2tlbl90eXBlIjoiYmVhcmVyIiwiZXhwaXJlc19pbiI6NjA0ODAwLCJleHBpcmVzX2F0IjoxNzk0ODUwNDEyLCJyZWZyZXNoX3Rva2VuIjoici1hMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDQiLCJ1c2VyIjp7ImlkIjoiYTAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDA0IiwiZW1haWwiOiJuZXdzdG9yZUBmbG93LnRlc3QiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhcHBfbWV0YWRhdGEiOnt9LCJ1c2VyX21ldGFkYXRhIjp7fSwiY3JlYXRlZF9hdCI6IjIwMjYtMTEtMDlUMTc6MzM6MzIuNTcyWiJ9fQ');
  await go(n, '/join/' + rc + '?to=store'); ok(n.url().endsWith('/stores'), 'viral: /join link lands on stores page');
  await go(n, '/app/new?type=store'); ok((await n.locator('.badge-brand').count()) === 1, 'viral: "invited by" shown at sign-up');
  await n.fill('input[name=name]', 'Referred Store'); await submit(n, 'form button.btn-primary');
  ok(sql("select r.program||'/'||r.status||'/'||r.reward_bps from referrals r join organizations o on o.id=r.referred_org_id where o.name='Referred Store'") === 'founding_partners/active/4000', 'viral: referral recorded with 40% terms');

  // 5. Store staff: invited by email, joins, sees no money
  await go(s, '/app/team?org=' + storeId); await s.fill('input[name=email]', 'staff@flow.test'); await submit(s, 'main form.card button');
  const tlink = (await s.locator('.keybox').textContent()).trim();
  const { p: st } = await as('base64-eyJhY2Nlc3NfdG9rZW4iOiJleUpoYkdjaU9pSklVekkxTmlJc0luUjVjQ0k2SWtwWFZDSjkuZXlKemRXSWlPaUpoTURBd01EQXdNQzB3TURBd0xUQXdNREF0TURBd01DMHdNREF3TURBd01EQXdNRE1pTENKbGJXRnBiQ0k2SW5OMFlXWm1RR1pzYjNjdWRHVnpkQ0lzSW5KdmJHVWlPaUpoZFhSb1pXNTBhV05oZEdWa0lpd2lZWFZrSWpvaVlYVjBhR1Z1ZEdsallYUmxaQ0lzSW1WNGNDSTZNVGM1TkRnMU1EUXhNbjAuV2pObU1vQnd0bVJPRXBXc3g4bW8yU3MwU0JOelVkb090X1V1djgxbUZ0YyIsInRva2VuX3R5cGUiOiJiZWFyZXIiLCJleHBpcmVzX2luIjo2MDQ4MDAsImV4cGlyZXNfYXQiOjE3OTQ4NTA0MTIsInJlZnJlc2hfdG9rZW4iOiJyLWEwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMyIsInVzZXIiOnsiaWQiOiJhMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDMiLCJlbWFpbCI6InN0YWZmQGZsb3cudGVzdCIsImF1ZCI6ImF1dGhlbnRpY2F0ZWQiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImFwcF9tZXRhZGF0YSI6e30sInVzZXJfbWV0YWRhdGEiOnt9LCJjcmVhdGVkX2F0IjoiMjAyNi0xMS0wOVQxNzozMzozMi41NTBaIn19');
  await st.goto(tlink.replace(/^https?:\/\/[^/]+/, B), { waitUntil: 'networkidle' }); await submit(st, 'main form button, .card form button');
  ok(st.url().includes('/app?org=' + storeId), 'staff: joined the store team');
  const nav = await st.locator('.bottom-nav').innerText(); ok(!nav.includes('תשלומים'), 'staff: no payments tab');
  await go(st, '/app/money?org=' + storeId); const mtxt = await st.locator('main').innerText();
  ok(!/₪/.test(mtxt) || mtxt.includes('אין לך הרשאה'), 'staff: money page shows no amounts');
  await go(st, '/app/team?org=' + storeId); ok(!st.url().includes('/app/team'), 'staff: team page redirects');
  await go(st, '/app/offer?org=' + storeId); ok(await st.locator('button[name=status]').count() === 0, 'staff: cannot publish/change offer');

  // 6. English pass on the main creator screens
  const { p: e } = await as('base64-eyJhY2Nlc3NfdG9rZW4iOiJleUpoYkdjaU9pSklVekkxTmlJc0luUjVjQ0k2SWtwWFZDSjkuZXlKemRXSWlPaUpoTURBd01EQXdNQzB3TURBd0xUQXdNREF0TURBd01DMHdNREF3TURBd01EQXdNRElpTENKbGJXRnBiQ0k2SW1OeVpXRjBiM0pBWm14dmR5NTBaWE4wSWl3aWNtOXNaU0k2SW1GMWRHaGxiblJwWTJGMFpXUWlMQ0poZFdRaU9pSmhkWFJvWlc1MGFXTmhkR1ZrSWl3aVpYaHdJam94TnprME9EVXdOREV5ZlEuVjNKXzJsTVBsLVloQXBiblVSY25Nbmc5Q1czWkNraXZwMF9ob1hkVWlFUSIsInRva2VuX3R5cGUiOiJiZWFyZXIiLCJleHBpcmVzX2luIjo2MDQ4MDAsImV4cGlyZXNfYXQiOjE3OTQ4NTA0MTIsInJlZnJlc2hfdG9rZW4iOiJyLWEwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMiIsInVzZXIiOnsiaWQiOiJhMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDIiLCJlbWFpbCI6ImNyZWF0b3JAZmxvdy50ZXN0IiwiYXVkIjoiYXV0aGVudGljYXRlZCIsInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiYXBwX21ldGFkYXRhIjp7fSwidXNlcl9tZXRhZGF0YSI6e30sImNyZWF0ZWRfYXQiOiIyMDI2LTExLTA5VDE3OjMzOjMyLjUyOFoifX0', 'en');
  for (const path of ['/app', '/app/catalog', '/app/partnerships', '/app/rewards']) { await go(e, path + '?org=' + creatorId); ok(await e.evaluate(() => document.dir === 'ltr' && document.documentElement.scrollWidth <= innerWidth + 1), 'en: ' + path + ' LTR, no overflow'); }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); await b.close();
})();
