// Local end-to-end check of creator settlement and automatic LINKUP-fee collection (simulated provider).
// Run after e2e-journeys.cjs on the local stack, with the web app started with BILLING_SIMULATION=true,
// BILLING_CRON_SECRET=local-cron and SUPABASE_SERVICE_ROLE_KEY=<local service token>. No real money, no network.
const { chromium, devices } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const sql = (s) => execSync('psql -h /tmp -p 54329 -U postgres -d linkup -v ON_ERROR_STOP=1 -Atc ' + JSON.stringify(s.replace(/\s+/g, ' '))).toString().trim();
const token = (uid, email) => execSync(`node /var/tmp/lkpg/mock.cjs token ${uid} ${email}`).toString().trim();
const B = 'http://localhost:3200';
const SHOTS = process.env.SHOTS || 'shots';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OWNER = 'a0000000-0000-0000-0000-000000000001', CREATOR = 'a0000000-0000-0000-0000-000000000002';

(async () => {
  const b = await chromium.launch();
  const as = async (uid, email, lang = 'he') => {
    const ctx = await b.newContext({ ...devices['iPhone 13'], locale: lang });
    await ctx.addCookies([{ name: 'sb-localhost-auth-token', value: token(uid, email), domain: 'localhost', path: '/' }, { name: 'lk_lang', value: lang, domain: 'localhost', path: '/' }]);
    const p = await ctx.newPage(); p.on('pageerror', (e) => { console.log('JS ERROR', e.message); fails++; }); return p;
  };
  const go = (p, path) => p.goto(B + path, { waitUntil: 'networkidle' });
  const submit = async (p, sel) => { await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click(sel)]); };
  const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  const store = sql("select id from organizations where name='Flow Shop'");
  const creator = sql("select id from organizations where name='Dana Creates'");
  const conn = sql(`select id from store_connections where org_id='${store}'`);
  const coupon = sql(`select pc.code from partner_codes pc join agreements a on a.id=pc.agreement_id where a.store_org_id='${store}' and a.creator_org_id='${creator}' limit 1`);
  for (const id of ['7001', '7002']) sql(`select ingest_order_event('${conn}', '{"event_id":"st-${id}","occurred_at":"${new Date(Date.now() - 30 * 864e5).toISOString()}","order":{"id":"${id}","status":"completed","currency":"ILS","total":118000,"tax":18000,"shipping":0,"shipping_tax":0,"coupons":["${coupon}"],"created_at":"${new Date().toISOString()}","refunds":[]}}')`);
  sql('select approve_matured_commissions()');
  sql(`set session_replication_role = replica; update commission_ledger set approved_at = now() - interval '20 days' where state='approved' and store_org_id='${store}'`);

  // 1. Creator: dashboard, payment details
  const c = await as(CREATOR, 'creator@flow.test');
  await go(c, `/app/money?org=${creator}`);
  const cm = await c.content();
  ok(cm.includes('באיחור') && cm.includes('לתשלום'), 'creator sees amount to pay and overdue');
  await c.fill('input[name=holder]', 'Dana Cohen'); await c.fill('input[name=bank]', '12'); await c.fill('input[name=branch]', '634'); await c.fill('input[name=account]', '123456');
  await submit(c, 'button:has-text("שמירת הפרטים")');
  ok(sql(`select method||'|'||bank_code from creator_payout_details where org_id='${creator}'`) === 'bank_transfer|12', 'creator payment details saved');
  await c.screenshot({ path: `${SHOTS}/st-creator-money-he.png`, fullPage: true });
  ok(await noOverflow(c), 'creator money page: no overflow');

  // 2. Store: pay page — details shown, nothing recorded by viewing or copying
  const s = await as(OWNER, 'owner@flow.test');
  await go(s, `/app/money?org=${store}`);
  ok(await s.locator('a:has-text("שלמי למשפיענית")').count() >= 1, 'store sees the "pay the creator" button');
  await go(s, await s.locator('a:has-text("שלמי למשפיענית")').first().getAttribute('href'));
  const pc = await s.content();
  ok(pc.includes('123456') && pc.includes('אינן תשלום'), 'pay page shows bank details and the "copying is not paying" warning');
  ok(sql('select count(*) from creator_payouts') === '0', 'viewing the pay page records no payment');
  ok(sql("select count(*) from audit_events where action='payout_details.viewed'") === '1', 'viewing the details is audited');
  await s.screenshot({ path: `${SHOTS}/st-pay-he.png`, fullPage: true });
  // partial payment + proof
  fs.writeFileSync('/tmp/claude-proof.pdf', '%PDF-1.4 local proof');
  await s.fill('input[name=amount]', '10'); await s.fill('input[name=reference]', 'TR-77');
  await s.setInputFiles('input[name=proof]', '/tmp/claude-proof.pdf');
  await submit(s, 'button:has-text("דיווח על התשלום")');
  ok(sql('select amount_minor||\'|\'||creator_status from creator_payouts') === '1000|awaiting', 'partial payment reported (₪10), awaiting confirmation');
  ok(sql('select count(*) from payout_proofs') === '1', 'proof attached');
  ok((await s.content()).includes('החנות דיווחה על תשלום'), 'store sees "store reported a payment"');

  // 3. Creator disputes, store answers, creator confirms
  await go(c, `/app/money?org=${creator}`);
  await c.fill('input[name=reason]', 'not in my account yet');
  await submit(c, 'button:has-text("לא התקבל או לא תואם")');
  ok(sql('select creator_status from creator_payouts') === 'disputed', 'creator reported not received');
  await go(s, `/app/money?org=${store}`);
  await s.fill('input[name=response]', 'Sent Monday, ref TR-77'); await submit(s, 'button:has-text("שליחת תשובה")');
  await go(c, `/app/money?org=${creator}`);
  await submit(c, 'button:has-text("קיבלתי")');
  ok(sql('select creator_status from creator_payouts') === 'confirmed', 'creator confirmed receipt');

  // 4. Statement (both sides) + CSV + proof download
  await go(s, `/app/money/statement?org=${store}&with=${creator}`);
  const st = await s.content();
  ok(st.includes('אינו מסמך מס') && st.includes('TR-77'), 'statement: not a tax document, payments listed');
  await s.screenshot({ path: `${SHOTS}/st-statement-he.png`, fullPage: true });
  await go(c, `/app/money/statement?org=${creator}&with=${store}&kind=request`);
  ok((await c.content()).includes('דרישת תשלום – אינה חשבונית מס'), 'creator payment request (not a tax invoice)');
  const csv = await c.request.get(`${B}/app/money/csv?org=${creator}&with=${store}`);
  ok(csv.status() === 200 && (await csv.text()).includes('payment'), 'CSV download');
  const proofId = sql('select id from payout_proofs');
  ok((await c.request.get(`${B}/app/money/proof/${proofId}?org=${creator}`)).status() === 200, 'creator can open the proof');

  // 5. LINKUP fee: payment method via the simulated hosted page, automatic charge by the worker
  sql(`insert into platform_admins(user_id) values ('${OWNER}') on conflict do nothing`);
  sql(`set session_replication_role = replica; update commission_ledger set approved_at = date_trunc('month', now()) - interval '5 days' where party_role='platform' and state='approved'`);
  sql("update app_settings set value='true' where key='invoicing_tax_approved'");
  const prev = new Date(); const pm = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  sql(`set request.jwt.claim.sub = '${OWNER}'; select generate_invoices('${pm}')`);
  const inv = sql(`select id from invoices where store_org_id='${store}'`);
  sql(`set request.jwt.claim.sub = '${OWNER}'; select mark_invoice_delivered('${inv}', 'email', 'local', null)`);
  await go(s, `/app/money?org=${store}`);
  await go(s, await s.locator('a:has-text("הגדרת אמצעי תשלום")').first().getAttribute('href'));
  await s.screenshot({ path: `${SHOTS}/st-sim-checkout-he.png`, fullPage: true });
  await s.check('input[name=agree]'); await submit(s, 'button:has-text("שמירה")');
  ok((await s.content()).includes('•••• 4242'), 'masked card shown on the store screen');
  ok(sql(`select charge_timing||'|'||charge_days from billing_payment_methods where store_org_id='${store}' and status='active'`) === 'days_after_delivery|0', 'store chose the charge timing');
  const runIt = () => s.request.post(`${B}/api/billing/run`, { headers: { authorization: 'Bearer local-cron' } }).then((r) => r.json());
  ok((await runIt()).scheduled === 0, 'master switch off → worker does nothing');
  sql("update app_settings set value='true' where key='auto_collection_enabled'");
  const r1 = await runIt();
  ok(r1.scheduled === 1 && r1.charged === 1 && r1.documents === 1, `worker scheduled, charged and recorded the tax document (${JSON.stringify(r1)})`);
  ok(sql(`select status from invoices where id='${inv}'`) === 'paid', 'payment request paid automatically');
  ok((await s.request.post(`${B}/api/billing/run`)).status() === 403, 'worker endpoint refuses calls without the secret');

  // 6. Owner: finance dashboard and exceptions
  await go(s, `/app/admin?org=${store}`);
  const ad = await s.content();
  ok(ad.includes('דשבורד פיננסי') && ad.includes('חריגים לטיפול'), 'admin finance dashboard and exceptions queue');
  await s.screenshot({ path: `${SHOTS}/st-admin-finance-he.png`, fullPage: true });
  const en = await as(OWNER, 'owner@flow.test', 'en');
  await go(en, `/app/money?org=${store}`); ok(await noOverflow(en), 'en store money page: no overflow');
  await en.screenshot({ path: `${SHOTS}/st-store-money-en.png`, fullPage: true });

  console.log(fails ? `FAILED: ${fails}` : 'ALL PASSED');
  await b.close(); process.exit(fails ? 1 : 0);
})();
