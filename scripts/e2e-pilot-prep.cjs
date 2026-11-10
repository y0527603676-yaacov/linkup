// Local end-to-end check of the pilot-prep + accounting UI (run after e2e-journeys.cjs on the local stack).
// Never touches production: talks to the local Postgres (54329) and the local Next server (3200) only.
const { chromium, devices } = require('playwright');
const { execSync } = require('child_process');
const sql = (s) => execSync('psql -h /tmp -p 54329 -U postgres -d linkup -v ON_ERROR_STOP=1 -Atc ' + JSON.stringify(s.replace(/\s+/g, ' '))).toString().trim();
const token = (uid, email) => execSync(`node /var/tmp/lkpg/mock.cjs token ${uid} ${email}`).toString().trim();
const B = 'http://localhost:3200';
const SHOTS = process.env.SHOTS || 'shots';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OWNER = 'a0000000-0000-0000-0000-000000000001', NEWU = 'a0000000-0000-0000-0000-000000000004';

(async () => {
  const b = await chromium.launch();
  const as = async (uid, email, lang = 'he') => {
    const ctx = await b.newContext({ ...devices['iPhone 13'], locale: lang });
    await ctx.addCookies([{ name: 'sb-localhost-auth-token', value: token(uid, email), domain: 'localhost', path: '/' }, { name: 'lk_lang', value: lang, domain: 'localhost', path: '/' }]);
    const p = await ctx.newPage(); p.on('pageerror', (e) => { console.log('JS ERROR', e.message); fails++; }); return p;
  };
  const go = (p, path) => p.goto(B + path, { waitUntil: 'networkidle' });
  const submit = async (p, sel) => { await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.click(sel)]); };
  const noOverflow = async (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  sql(`insert into platform_admins(user_id) values ('${OWNER}') on conflict do nothing`);
  const store = sql("select id from organizations where name='Flow Shop'");
  const conn = sql(`select id from store_connections where org_id='${store}'`);
  const coupon = sql(`select pc.code from partner_codes pc join agreements a on a.id=pc.agreement_id where a.store_org_id='${store}' limit 1`);
  const occurred = new Date(Date.now() - 20 * 86400000).toISOString();
  sql(`select ingest_order_event('${conn}', '{"event_id":"pp-ui-1","occurred_at":"${occurred}","order":{"id":"9001","status":"completed","currency":"ILS","total":118000,"tax":18000,"shipping":0,"shipping_tax":0,"coupons":["${coupon}"],"created_at":"${new Date().toISOString()}","refunds":[]}}')`);
  sql('select approve_matured_commissions()');
  const d = new Date(); const prevMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  sql(`set session_replication_role = replica; update commission_ledger set approved_at = '${prevMonth}T12:00:00Z' where state='approved' and store_org_id='${store}'`);
  // A FOUNDING PARTNERS balance for the store (to show the offset), recorded directly in the local test DB.
  sql(`set session_replication_role = replica; insert into referral_rewards(referral_id, referrer_org_id, ledger_id, attribution_id, share_bps, amount_minor, currency, idempotency_key)
       select gen_random_uuid(), '${store}', id, attribution_id, 4000, 500, 'ILS', 'ui:wallet' from commission_ledger where store_org_id='${store}' and party_role='platform' limit 1`);

  const s = await as(OWNER, 'owner@flow.test');
  // 1. Tax profile (store admin) → pending verification
  await go(s, `/app/settings?org=${store}`);
  await s.fill('input[name=legal_name]', 'Flow Shop Ltd'); await s.selectOption('select[name=classification]', 'authorized_dealer');
  await s.fill('input[name=tax_id]', '512345678'); await s.fill('input[name=address]', 'Herzl 1, Tel Aviv');
  await submit(s, 'form#tax button.btn-primary');
  ok(sql(`select classification||'|'||(verified_at is null) from tax_profiles where org_id='${store}'`) === 'authorized_dealer|true', 'tax profile saved, awaiting verification');
  await s.screenshot({ path: `${SHOTS}/pp-settings-tax-he.png`, fullPage: true });

  // 2. Admin: gate message, preview, verify profile
  await go(s, `/app/admin?org=${store}`);
  ok((await s.content()).includes('כבויה'), 'admin: real payment requests switched off (gate message)');
  ok(await s.locator('button:has-text("הפקת דרישות תשלום לחודש")').count() === 0, 'admin: no generate button while switched off');
  await go(s, `/app/admin?org=${store}&preview=${prevMonth}`);
  ok((await s.content()).includes('אין קיזוז'), 'admin preview: offset blocked until business type is verified');
  await submit(s, `form:has(input[name=target][value="${store}"]) button:has-text("אימות")`);
  ok(sql(`select verified_at is not null from tax_profiles where org_id='${store}'`) === 't', 'admin: business details verified');
  await go(s, `/app/admin?org=${store}&preview=${prevMonth}`);
  await s.screenshot({ path: `${SHOTS}/pp-admin-preview-he.png`, fullPage: true });
  ok(sql('select count(*) from invoices') === '0', 'preview creates nothing');

  // 3. Switch on (local test DB only) → generate → VAT split recorded
  sql("update app_settings set value='true' where key='invoicing_tax_approved'");
  await go(s, `/app/admin?org=${store}`);
  await s.fill('input[name=period]', prevMonth); await submit(s, 'button:has-text("הפקת דרישות תשלום לחודש")');
  const inv = sql(`select fees_minor||'|'||vat_minor||'|'||reward_offset_minor||'|'||reward_vat_minor||'|'||total_minor||'|'||coalesce(due_at::text,'none') from invoices where store_org_id='${store}'`);
  ok(inv === '2000|360|500|90|1770|none', `payment request split: ${inv}`);
  await go(s, `/app/money?org=${store}`);
  const money = await s.content();
  ok(money.includes('ממועד מסירת הדרישה'), 'store: no due date before verified delivery');
  ok(money.includes('מע״מ על תגמול ההפניה'), 'store: reward VAT line shown separately');
  ok(money.includes('בתוספת מע״מ כדין'), 'store: fee shown "plus VAT as applicable"');
  ok(money.includes('LINKUP אינה צד'), 'store: creator-payment tax notice');

  // 4. Record delivery → due date = +14 days
  await go(s, `/app/admin?org=${store}`);
  await s.fill('input[name=reference] >> nth=0', 'email to owner');
  await submit(s, 'button:has-text("תיעוד מסירה")');
  ok(sql(`select round(extract(epoch from due_at - delivered_at)/86400) from invoices where store_org_id='${store}'`) === '14', 'delivery recorded → due in 14 days');
  ok(await s.locator('button:has-text("ביטול")').count() === 0, 'delivered request cannot be voided (button gone)');
  // 5. Record the counter-document for the offset
  await s.locator('.card:has-text("Flow Shop") summary:has-text("רישום מסמך")').click();
  const df = s.locator('.card:has-text("Flow Shop") details form');
  await df.locator('select[name=issuer]').selectOption('counterparty'); await df.locator('select[name=doc_type]').selectOption('tax_invoice');
  await df.locator('input[name=number]').fill('FS-17'); await df.locator('input[name=date]').fill(new Date().toISOString().slice(0, 10));
  await df.locator('input[name=amount]').fill('5'); await df.locator('input[name=vat]').fill('0.90');
  const valid = await df.evaluate((f) => f.checkValidity());
  if (!valid) { await s.screenshot({ path: `${SHOTS}/dbg-doc.png`, fullPage: true }); console.log('invalid fields', await df.evaluate((f) => [...f.elements].filter((e) => !e.checkValidity()).map((e) => e.name))); }
  await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle' }), df.locator('button').click()]);
  ok(sql("select doc_number||'|'||amount_minor||'|'||vat_minor from accounting_documents") === 'FS-17|500|90', 'counter-document recorded (₪5 + ₪0.90 VAT)');
  await s.screenshot({ path: `${SHOTS}/pp-admin-invoices-he.png`, fullPage: true });

  // 6. Rate increase → proposal on the store screen → decline keeps the rate
  const from = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  await s.fill('form:has(input[name=op][value=rate]) input[name=pct]', '3.5'); await s.fill('form:has(input[name=op][value=rate]) input[name=from]', from);
  await s.fill('form:has(input[name=op][value=rate]) input[name=note]', 'local test');
  await submit(s, 'form:has(input[name=op][value=rate]) button');
  await go(s, `/app/money?org=${store}`);
  ok((await s.content()).includes('הצעה לשינוי תעריף'), 'store sees the proposed increase');
  await s.screenshot({ path: `${SHOTS}/pp-money-he.png`, fullPage: true });
  ok(await noOverflow(s), 'he money page: no horizontal overflow at phone width');
  await submit(s, 'button:has-text("דחייה")');
  ok(sql(`select status from fee_terms where store_org_id='${store}' and source='rate_change'`) === 'declined', 'declined → increase not applied');

  const en = await as(OWNER, 'owner@flow.test', 'en');
  await go(en, `/app/money?org=${store}`);
  ok((await en.content()).includes('plus VAT as applicable'), 'en money page');
  ok(await noOverflow(en), 'en money page: no overflow');
  await en.screenshot({ path: `${SHOTS}/pp-money-en.png`, fullPage: true });

  // 7. Legal: center empty → publish (local test DB) → one-time acceptance → signup checkbox
  await go(s, '/legal'); ok((await s.content()).includes('בעריכה'), 'legal center: honest empty state while nothing is published');
  sql(`insert into legal_documents(doc_key, locale, version, title, body, audience, sort_order, status, published_at) values
    ('terms','he',1,'תנאי שימוש (בדיקה מקומית)','נוסח בדיקה מקומי בלבד. לא לפרסום.','all',10,'published',now()),
    ('terms','en',1,'Terms of use (local test)','Local test text only. Not for publication.','all',10,'published',now()),
    ('privacy','he',1,'מדיניות פרטיות (בדיקה מקומית)','נוסח בדיקה מקומי בלבד.','none',20,'published',now()),
    ('store-terms','he',1,'תנאים מסחריים לחנויות (בדיקה מקומית)','נוסח בדיקה מקומי בלבד.','store',30,'published',now())`);
  await go(s, `/app?org=${store}`);
  ok(s.url().includes('/legal/accept'), 'existing user is sent to the one-time acceptance screen');
  ok(await s.locator('input[name=legal]:checked').count() === 0, 'acceptance boxes start unchecked');
  await s.screenshot({ path: `${SHOTS}/pp-legal-accept-he.png`, fullPage: true });
  for (const c of await s.locator('input[name=legal]').all()) await c.check();
  await submit(s, 'button.btn-primary');
  ok(!s.url().includes('/legal/accept'), 'after accepting → back to the app');
  ok(sql(`select string_agg(doc_key||':'||acceptance_type, ',' order by doc_key) from legal_acceptances where user_id='${OWNER}'`) === 'store-terms:existing_user,terms:existing_user', 'acceptances documented (user, document, version, type, time)');
  await go(s, `/app?org=${store}`); ok(!s.url().includes('/legal/accept'), 'not asked again');
  await go(s, '/legal'); await s.screenshot({ path: `${SHOTS}/pp-legal-center-he.png`, fullPage: true });
  ok(await s.locator('a.item').count() === 3, 'legal center lists the published documents');
  await go(s, '/terms'); ok(s.url().endsWith('/legal/terms'), '/terms redirects to the published version');
  await go(en, '/legal/terms'); ok((await en.content()).includes('Local test text'), 'en document version'); await en.screenshot({ path: `${SHOTS}/pp-legal-doc-en.png`, fullPage: true });

  const n = await as(NEWU, 'newstore@flow.test');
  await go(n, '/app/new?type=store');
  ok(await n.locator('input[name=legal]').count() === 1, 'sign-up shows the unchecked terms checkbox');
  await n.fill('input[name=name]', 'Legal Shop'); await n.check('input[name=legal]');
  await submit(n, 'form.stack button.btn-primary');
  ok(sql(`select acceptance_type from legal_acceptances where user_id='${NEWU}'`) === 'signup', 'sign-up acceptance recorded');
  ok(n.url().includes('/app/connect'), 'new store lands on connect');
  ok(await n.locator('input[name=legal]').count() === 1, 'connect shows the store commercial-terms checkbox');
  await n.screenshot({ path: `${SHOTS}/pp-connect-legal-he.png`, fullPage: true });
  await n.fill('input[name=site]', 'legalshop.co.il'); await n.check('input[name=legal]'); await n.click('main form button'); await n.waitForSelector('.keybox');
  ok(sql(`select acceptance_type||'|'||(org_id is not null) from legal_acceptances where user_id='${NEWU}' and doc_key='store-terms'`) === 'store_connection|true', 'store-connection acceptance recorded with the store');

  // Clean the local test documents so nothing temporary survives even locally.
  console.log(fails ? `FAILED: ${fails}` : 'ALL PASSED');
  await b.close(); process.exit(fails ? 1 : 0);
})();
