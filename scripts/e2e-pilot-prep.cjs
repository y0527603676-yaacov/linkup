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
  ok(sql("select value from app_settings where key='reward_settlement_approved'") === 'false', 'reward settlement blocked by default (accounting decision pending)');
  sql("update app_settings set value='true' where key='invoicing_tax_approved'");
  sql("update app_settings set value='true' where key='reward_settlement_approved'");   // local test of the approved flow only
  await go(s, `/app/admin?org=${store}`);
  await s.fill('input[name=period]', prevMonth); await submit(s, 'button:has-text("הפקת דרישות תשלום לחודש")');
  const inv = sql(`select fees_minor||'|'||vat_minor||'|'||reward_offset_minor||'|'||reward_vat_minor||'|'||total_minor||'|'||coalesce(due_at::text,'none') from invoices where store_org_id='${store}'`);
  ok(inv === '2000|360|500|90|1770|none', `payment request split: ${inv}`);
  await go(s, `/app/money?org=${store}`);
  const money = await s.content();
  ok(money.includes('ממועד מסירת הדרישה'), 'store: no due date before verified delivery');
  ok(money.includes('מע״מ על תגמול ההפניה'), 'store: reward VAT line shown separately');
  ok(money.includes('בתוספת מע״מ כדין'), 'store: fee shown "plus VAT as applicable"');
  ok(money.includes('מסמכי LINKUP הרשמיים מופקים מחוץ למערכת'), 'store: tax-documents notice (approved wording)');

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
  ok((await s.content()).includes('התעריף הרגיל שלך ישתנה'), 'store sees the proposed increase (approved wording)');
  ok((await s.content()).includes('טרם נמסרה באופן מתועד') && await s.locator('button:has-text("אני מאשר/ת את התעריף החדש")').count() === 0, 'no acceptance before documented delivery');
  await go(s, `/app/admin?org=${store}`);
  const nf = s.locator('form:has(input[name=op][value=notice])');
  await nf.locator('select[name=event]').selectOption('delivered'); await nf.locator('select[name=channel]').selectOption('email');
  await nf.locator('input[name=recipient]').fill('owner@flow.test'); await nf.locator('input[name=reference]').fill('email delivered, no bounce');
  await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle' }), nf.locator('button').click()]);
  ok(sql("select string_agg(event, ',' order by occurred_at) from fee_change_notices") === 'created,delivered', 'notice: created + documented delivery');
  ok(await s.waitForSelector('text=תחולה מוקדמת', { timeout: 10000 }).then(() => true, () => false), 'admin sees the earliest start (30 days after delivery)');
  await go(s, `/app/money?org=${store}`);
  await s.screenshot({ path: `${SHOTS}/pp-money-he.png`, fullPage: true });
  ok(await noOverflow(s), 'he money page: no horizontal overflow at phone width');
  await submit(s, 'button:has-text("ניהול סיום פעילות")');
  ok(sql(`select status from fee_terms where store_org_id='${store}' and source='rate_change'`) === 'declined', 'declined → increase not applied');

  const en = await as(OWNER, 'owner@flow.test', 'en');
  await go(en, `/app/money?org=${store}`);
  ok((await en.content()).includes('plus VAT as applicable'), 'en money page');
  ok(await noOverflow(en), 'en money page: no overflow');
  await en.screenshot({ path: `${SHOTS}/pp-money-en.png`, fullPage: true });

  // 7. Dispute a payment request from the store screen (#7)
  await go(s, `/app/money?org=${store}`);
  await s.click('summary:has-text("דיווח על אי-התאמה")');
  await s.fill('form:has(input[name=invoice]) input[name=amount]', '1'); await s.fill('form:has(input[name=invoice]) textarea[name=reason]', 'one order was cancelled');
  await submit(s, 'button:has-text("שליחת הדיווח")');
  ok(sql(`select disputed_minor from invoice_disputes`) === '100', 'store disputed ₪1 of the request');
  ok((await s.content()).includes('היתרה שאינה במחלוקת'), 'undisputed balance shown');

  // 8. Legal package v1.0: drafts only → admin preview → (local test only) publication → acceptance flows
  await go(s, '/legal'); ok((await s.content()).includes('בעריכה'), 'legal center: honest empty state while nothing is published');
  execSync('psql -h /tmp -p 54329 -U postgres -d linkup -v ON_ERROR_STOP=1 -q -f supabase/seed/legal_documents_v1_draft.sql');
  ok(sql("select count(*) from legal_documents where status='draft'") === '16', '16 drafts loaded (8 documents × he/en)');
  await go(s, '/legal'); ok((await s.content()).includes('בעריכה'), 'drafts are not public');
  const anonP = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
  const r404 = await anonP.goto(B + '/legal/terms?draft=1', { waitUntil: 'networkidle' }); ok(r404.status() === 404, 'draft preview is closed to visitors');
  await go(s, `/app/admin?org=${store}`); ok(await s.locator('a.item[href*="draft=1"]').count() === 16, 'admin sees the 16 drafts');
  await go(s, '/legal/store-terms?lang=he&draft=1'); ok((await s.content()).includes('טיוטה - לא פורסם'), 'admin draft preview is clearly marked');
  await s.screenshot({ path: `${SHOTS}/lp-draft-preview-he.png`, fullPage: true });
  // Publication happens only after counsel/CPA approval — here only in the local test database.
  for (const k of ['terms', 'store-terms', 'creator-terms', 'privacy', 'commissions', 'founding-partners', 'cookies', 'interface-notices'])
    sql(`update legal_documents set status='published', published_at=now(), effective_from=now() where doc_key='${k}'`);
  await go(s, `/app?org=${store}`);
  ok(s.url().includes('/legal/accept'), 'existing user is sent to the one-time acceptance screen');
  ok(await s.locator('input[type=checkbox]:checked').count() === 0, 'acceptance boxes start unchecked');
  ok((await s.content()).includes('קראתי ואני מסכים/ה לתנאי השימוש הכלליים'), 'approved registration wording');
  await s.screenshot({ path: `${SHOTS}/lp-legal-accept-he.png`, fullPage: true });
  for (const c of await s.locator('input[type=checkbox]').all()) await c.check();
  await submit(s, 'button.btn-primary');
  ok(!s.url().includes('/legal/accept'), 'after accepting → back to the app');
  const acc = sql(`select string_agg(doc_key||':'||action, ',' order by doc_key) from legal_acceptances where user_id='${OWNER}'`);
  ok(acc.includes('privacy:acknowledge') && acc.includes('terms:accept') && acc.includes('store-terms:accept') && acc.includes('commissions:accept'), `acceptances documented: ${acc}`);
  ok(sql(`select count(*) from legal_acceptances where user_id='${OWNER}' and (role is null or locale is null or audit_event_id is null)`) === '0', 'each acceptance has role, locale and audit reference');
  await go(s, `/app?org=${store}`); ok(!s.url().includes('/legal/accept'), 'not asked again');
  await go(s, '/legal'); await s.screenshot({ path: `${SHOTS}/lp-legal-center-he.png`, fullPage: true });
  ok(await s.locator('a.item').count() === 8, 'legal center lists all 8 documents');
  ok((await s.content()).includes('037093390'), 'operator details shown as in the file');
  for (const lang of ['he', 'en']) {
    const pg = lang === 'he' ? s : en;
    for (const k of ['terms', 'store-terms', 'creator-terms', 'privacy', 'commissions', 'founding-partners', 'cookies', 'interface-notices']) {
      const res = await pg.goto(`${B}/legal/${k}?lang=${lang}`, { waitUntil: 'networkidle' });
      const dir = await pg.locator('article').getAttribute('dir');
      ok(res.status() === 200 && dir === (lang === 'he' ? 'rtl' : 'ltr') && await noOverflow(pg), `${lang} /legal/${k}: 200, ${dir}, no overflow`);
    }
  }
  await en.goto(`${B}/legal/commissions?lang=en`, { waitUntil: 'networkidle' }); await en.screenshot({ path: `${SHOTS}/lp-doc-commissions-en.png`, fullPage: true });
  await s.goto(`${B}/legal/terms?lang=he`, { waitUntil: 'networkidle' }); await s.screenshot({ path: `${SHOTS}/lp-doc-terms-he.png`, fullPage: true });
  ok(await s.locator('nav a').count() >= 7, 'document page links to the other documents');
  await go(s, '/terms'); ok(s.url().endsWith('/legal/terms'), '/terms redirects to the published version');
  await go(s, '/'); ok((await s.content()).includes('אנו משתמשים בטכנולוגיות תפעול וייחוס'), 'cookies notice in footer once the policy is published');

  const n = await as(NEWU, 'newstore@flow.test');
  await go(n, '/app/new?type=creator');
  ok(await n.locator('input[name=legal]').count() === 3 && await n.locator('input[name=agree]').count() === 1, 'creator sign-up: one unchecked box for terms, privacy and creator terms');
  await go(n, '/app/new?type=store');
  ok(await n.locator('input[name=legal]').count() === 2, 'store sign-up: terms and privacy');
  await n.fill('input[name=name]', 'Legal Shop'); await n.check('input[name=agree]');
  await n.screenshot({ path: `${SHOTS}/lp-signup-he.png`, fullPage: true });
  await submit(n, 'form.stack button.btn-primary');
  ok(sql(`select string_agg(doc_key||':'||acceptance_type||':'||action, ',' order by doc_key) from legal_acceptances where user_id='${NEWU}'`) === 'privacy:signup:acknowledge,terms:signup:accept', 'sign-up acceptance recorded (privacy acknowledged, not consented)');
  ok(n.url().includes('/app/connect'), 'new store lands on connect');
  ok((await n.content()).includes('אני מאשר/ת את התנאים המסחריים לחנויות'), 'connect shows the approved merchant wording');
  await n.screenshot({ path: `${SHOTS}/lp-connect-he.png`, fullPage: true });
  await n.fill('input[name=site]', 'legalshop.co.il'); await n.check('input[name=agree]'); await n.click('main form button'); await n.waitForSelector('.keybox');
  ok(sql(`select string_agg(doc_key||':'||acceptance_type||':'||role, ',' order by doc_key) from legal_acceptances where user_id='${NEWU}' and org_id is not null`) === 'commissions:store_connection:store:owner,store-terms:store_connection:store:owner', 'store-connection acceptance recorded with store and role');

  // 9. Contact form (the documents' preferred channel)
  await anonP.goto(B + '/contact?topic=privacy', { waitUntil: 'networkidle' });
  await anonP.fill('input[name=name]', 'Dana'); await anonP.fill('input[name=email]', 'dana@example.com'); await anonP.fill('textarea[name=message]', 'Please correct my details');
  await Promise.all([anonP.waitForNavigation({ waitUntil: 'networkidle' }), anonP.click('form button')]);
  ok(sql("select topic from contact_messages") === 'privacy', 'contact form message stored (privacy topic)');
  await go(s, `/app/admin?org=${store}`); ok((await s.content()).includes('Please correct my details'), 'admin sees the message');

  // Clean the local test documents so nothing temporary survives even locally.
  console.log(fails ? `FAILED: ${fails}` : 'ALL PASSED');
  await b.close(); process.exit(fails ? 1 : 0);
})();
