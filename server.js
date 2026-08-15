const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;

/* ---------- Database ----------
 * On Vercel (TURSO_URL set) use Turso/libSQL over HTTP (persistent, serverless-safe).
 * Locally (no TURSO_URL) fall back to a file-backed SQLite via node:sqlite.
 * Both backends expose the same async interface:
 *   db.exec(sql)            -> Promise<void>   (multi-statement)
 *   db.prepare(sql).get()   -> Promise<row|undefined>
 *   db.prepare(sql).all()   -> Promise<row[]>
 *   db.prepare(sql).run()   -> Promise<{ lastInsertRowid }>
 */
function makeDb() {
  const url = process.env.TURSO_URL;
  if (url) {
    const { createClient } = require('@libsql/client/web');
    const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
    return {
      async exec(sql) { await client.executeMultiple(sql); },
      prepare(sql) {
        return {
          async get(...args) { const rs = await client.execute({ sql, args }); return rs.rows[0]; },
          async all(...args) { const rs = await client.execute({ sql, args }); return rs.rows; },
          async run(...args) { const rs = await client.execute({ sql, args }); return { lastInsertRowid: Number(rs.lastInsertRowid) }; }
        };
      }
    };
  }
  const { DatabaseSync } = require('node:sqlite');
  const isServerless = !!process.env.VERCEL;
  const dbPath = isServerless
    ? path.join(os.tmpdir(), 'labdesk.db')
    : path.join(__dirname, 'labdesk.db');
  let sqlite;
  try {
    sqlite = new DatabaseSync(dbPath);
  } catch (e) {
    if (isServerless) {
      throw new Error('TURSO_URL is not configured. Add TURSO_URL and TURSO_AUTH_TOKEN to your Vercel project env vars (the local SQLite file is not writable on Vercel).');
    }
    throw e;
  }
  if (isServerless) {
    console.warn('[pathofox] WARNING: running on Vercel without TURSO_URL — using ephemeral DB at ' + dbPath + '. Data will NOT persist. Set TURSO_URL + TURSO_AUTH_TOKEN.');
  }
  sqlite.exec('PRAGMA journal_mode = WAL;');
  return {
    async exec(sql) { sqlite.exec(sql); },
    prepare(sql) {
      const st = sqlite.prepare(sql);
      return {
        async get(...args) { return st.get(...args); },
        async all(...args) { return st.all(...args); },
        async run(...args) { const r = st.run(...args); return { lastInsertRowid: r.lastInsertRowid }; }
      };
    }
  };
}

const db = makeDb();
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'Pathofox',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  sms_key TEXT DEFAULT '',
  sms_sender TEXT DEFAULT 'PATHOFOX'
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  phone TEXT DEFAULT '',
  name TEXT DEFAULT '',
  lab_name TEXT DEFAULT '',
  lab_phone TEXT DEFAULT '',
  lab_address TEXT DEFAULT '',
  pass_hash TEXT NOT NULL,
  created TEXT,
  plan TEXT DEFAULT 'trial',
  plan_status TEXT DEFAULT 'active',
  plan_start TEXT,
  plan_end TEXT,
  lifetime INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  number TEXT,
  name TEXT,
  phone TEXT,
  age TEXT,
  gender TEXT,
  blood TEXT,
  address TEXT,
  created TEXT
);
CREATE TABLE IF NOT EXISTS tests (
  id TEXT PRIMARY KEY,
  name TEXT,
  category TEXT,
  unit TEXT,
  low REAL,
  high REAL,
  min REAL,
  max REAL,
  price REAL
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  number TEXT,
  patient_id TEXT,
  date TEXT,
  notes TEXT,
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);
CREATE TABLE IF NOT EXISTS report_tests (
  report_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  result REAL,
  PRIMARY KEY (report_id, test_id),
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  number TEXT,
  report_id TEXT,
  patient_id TEXT,
  date TEXT,
  total REAL DEFAULT 0,
  paid INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invoice_items (
  invoice_id TEXT NOT NULL,
  name TEXT,
  price REAL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  report_id TEXT,
  invoice_id TEXT,
  patient_id TEXT,
  mobile TEXT,
  method TEXT DEFAULT 'sms',
  mode TEXT DEFAULT 'simulated',
  status TEXT DEFAULT 'sent',
  message TEXT,
  pdf_url TEXT,
  token TEXT,
  created TEXT
);
`;

const ready = db.exec(SCHEMA_SQL)
  .then(() => ensureColumn('settings', 'sms_key', "sms_key TEXT DEFAULT ''"))
  .then(() => ensureColumn('settings', 'sms_sender', "sms_sender TEXT DEFAULT 'PATHOFOX'"))
  .then(() => seed())
  .catch(e => { console.error('Database initialization failed:', e.message); });

async function ensureColumn(table, name, ddl) {
  const cols = (await db.prepare('PRAGMA table_info(' + table + ')').all()).map(c => c.name);
  if (!cols.includes(name)) await db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
}

const SEED_TESTS = [
  { name: 'Hemoglobin', category: 'Hematology', unit: 'g/dL', low: 13.0, high: 17.0, price: 150 },
  { name: 'RBC Count', category: 'Hematology', unit: 'M/µL', low: 4.2, high: 5.9, price: 100 },
  { name: 'WBC Count', category: 'Hematology', unit: 'K/µL', low: 4.0, high: 11.0, price: 100 },
  { name: 'Platelet Count', category: 'Hematology', unit: 'K/µL', low: 150, high: 450, price: 120 },
  { name: 'Fasting Blood Sugar', category: 'Diabetes', unit: 'mg/dL', low: 70, high: 100, price: 80 },
  { name: 'HbA1c', category: 'Diabetes', unit: '%', low: 4.0, high: 5.6, price: 500 },
  { name: 'Total Cholesterol', category: 'Lipid Profile', unit: 'mg/dL', low: null, high: 200, price: 250 },
  { name: 'LDL Cholesterol', category: 'Lipid Profile', unit: 'mg/dL', low: null, high: 100, price: 300 },
  { name: 'HDL Cholesterol', category: 'Lipid Profile', unit: 'mg/dL', low: 40, high: null, price: 300 },
  { name: 'Triglycerides', category: 'Lipid Profile', unit: 'mg/dL', low: null, high: 150, price: 250 },
  { name: 'Uric Acid', category: 'Biochemistry', unit: 'mg/dL', low: 3.5, high: 7.2, price: 200 },
  { name: 'Creatinine', category: 'Biochemistry', unit: 'mg/dL', low: 0.6, high: 1.2, price: 150 },
  { name: 'ALT (SGPT)', category: 'Biochemistry', unit: 'U/L', low: 7, high: 56, price: 250 },
  { name: 'AST (SGOT)', category: 'Biochemistry', unit: 'U/L', low: 10, high: 40, price: 250 },
  { name: 'TSH', category: 'Thyroid', unit: 'µIU/mL', low: 0.4, high: 4.0, price: 350 },
  { name: 'Vitamin D', category: 'Biochemistry', unit: 'ng/mL', low: 30, high: 100, price: 800 },
  { name: 'Dengue NS1 Antigen', category: 'Microbiology', unit: 'Positive/Negative', low: null, high: null, price: 700 },
  { name: 'Malaria (MP Smear)', category: 'Microbiology', unit: 'Positive/Negative', low: null, high: null, price: 200 },
  { name: 'Typhoid (Widal)', category: 'Microbiology', unit: 'Titre', low: null, high: 160, price: 300 }
];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function uid() { return crypto.randomBytes(8).toString('hex'); }
function normalizePhone(p) { return String(p || '').replace(/[\s-]/g, '').replace(/^\+91/, ''); }
function isIndianMobile(s) { return /^(\+91)?[- ]?[6-9]\d{9}$/.test(String(s).replace(/[\s-]/g, '')); }
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return salt + ':' + hash;
}
function verifyPass(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const calc = crypto.scryptSync(pw, salt, 32);
    const buf = Buffer.from(hash, 'hex');
    return calc.length === buf.length && crypto.timingSafeEqual(calc, buf);
  } catch (e) { return false; }
}
async function nextNumber(prefix, table) {
  const r = await db.prepare('SELECT COUNT(*) AS c FROM ' + table).get();
  return prefix + String(r.c + 1).padStart(4, '0');
}

async function seed() {
  if ((await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c === 0) {
    await db.prepare(`INSERT INTO users (username, phone, name, lab_name, lab_phone, lab_address, pass_hash, created, plan, plan_status, plan_start, plan_end, lifetime)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('admin', '', 'Administrator', 'Pathofox', '', '', hashPass('admin123'), todayISO(), 'yearly', 'active', todayISO(), addDays(todayISO(), 365), 0);
  }
  const proUsers = await db.prepare("SELECT id FROM users WHERE plan='pro' OR lifetime=1").all();
  for (const u of proUsers) {
    await db.prepare('UPDATE users SET plan=?, plan_status=?, plan_start=?, plan_end=?, lifetime=? WHERE id=?')
      .run('yearly', 'active', todayISO(), addDays(todayISO(), 365), 0, u.id);
  }
  if ((await db.prepare('SELECT COUNT(*) AS c FROM settings').get()).c === 0) {
    await db.prepare('INSERT INTO settings (id, name, phone, email, address) VALUES (1,?,?,?,?)')
      .run('Pathofox', '+91 98765 43210', 'reports@pathofox.in', '12, MG Road, Near City Hospital, Mumbai, Maharashtra 400001');
  }
  if ((await db.prepare('SELECT COUNT(*) AS c FROM tests').get()).c === 0) {
    const st = db.prepare('INSERT INTO tests (id, name, category, unit, low, high, min, max, price) VALUES (?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < SEED_TESTS.length; i++) {
      const t = SEED_TESTS[i];
      await st.run(String(i + 1), t.name, t.category, t.unit, t.low, t.high, null, null, t.price);
    }
  }
}

function userToJson(row) {
  return {
    username: row.username,
    name: row.name,
    phone: row.phone,
    labName: row.lab_name,
    labPhone: row.lab_phone,
    labAddress: row.lab_address,
    created: row.created,
    subscription: {
      plan: row.plan,
      status: row.plan_status,
      planStart: row.plan_start,
      planEnd: row.plan_end,
      lifetime: !!row.lifetime
    }
  };
}

async function subscriptionActive(row) {
  if (row.lifetime) return true;
  if (row.plan_status !== 'active') return false;
  if (row.plan_end && row.plan_end < todayISO()) {
    await db.prepare('UPDATE users SET plan_status=? WHERE id=?').run('expired', row.id);
    return false;
  }
  return true;
}

async function getUser(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) return null;
  const s = await db.prepare('SELECT * FROM sessions WHERE token=?').get(tok);
  if (!s) return null;
  return await db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function sendErr(res, status, error, code) {
  send(res, status, { error, code });
}

async function requireAuth(req, res) {
  const user = await getUser(req);
  if (!user) { sendErr(res, 401, 'Please sign in first.', 'AUTH_REQUIRED'); return null; }
  return user;
}
async function requireSub(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (!await subscriptionActive(user)) {
    sendErr(res, 402, 'Your subscription has expired. Please choose a plan.', 'SUBSCRIPTION_EXPIRED');
    return null;
  }
  return user;
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') {
        try { resolve(JSON.parse(req.body)); } catch (e) { resolve({}); }
      } else {
        resolve(req.body);
      }
      return;
    }
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function reportsWithTests() {
  const reports = await db.prepare('SELECT * FROM reports ORDER BY date DESC, id DESC').all();
  const rt = await db.prepare('SELECT report_id, test_id, result FROM report_tests').all();
  const byReport = {};
  rt.forEach(r => { (byReport[r.report_id] = byReport[r.report_id] || []).push({ testId: r.test_id, result: r.result }); });
  return reports.map(r => ({ ...r, patientId: r.patient_id, tests: byReport[r.id] || [] }));
}
async function invoicesWithItems() {
  const invoices = await db.prepare('SELECT * FROM invoices ORDER BY date DESC, id DESC').all();
  const items = await db.prepare('SELECT invoice_id, name, price FROM invoice_items').all();
  const byInv = {};
  items.forEach(i => { (byInv[i.invoice_id] = byInv[i.invoice_id] || []).push({ name: i.name, price: i.price }); });
  return invoices.map(i => ({ ...i, reportId: i.report_id, patientId: i.patient_id, paid: !!i.paid, items: byInv[i.id] || [] }));
}
async function deliveriesJson() {
  const rows = await db.prepare('SELECT * FROM deliveries ORDER BY created DESC, id DESC').all();
  return rows.map(d => ({
    id: d.id, reportId: d.report_id, invoiceId: d.invoice_id, patientId: d.patient_id,
    mobile: d.mobile, method: d.method, mode: d.mode, status: d.status, message: d.message,
    pdfUrl: d.pdf_url, created: d.created
  }));
}

/* ---------- PDF generator (zero-dependency) ---------- */
function pstr(s) {
  let t = String(s == null ? '' : s)
    .replace(/₹/g, 'Rs.')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/µ/g, 'u')
    .replace(/[✓✦◷⚗☺▦✎]/g, '');
  let out = '';
  for (const ch of t) {
    const c = ch.codePointAt(0);
    out += String.fromCharCode(c <= 255 ? c : 63);
  }
  return out.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function assemblePdf(content) {
  const objs = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Length ' + Buffer.byteLength(content, 'latin1') + ' >>\nstream\n' + content + '\nendstream'
  ];
  let out = '%PDF-1.4\n';
  const offs = [0];
  for (let i = 1; i <= 6; i++) {
    offs[i] = Buffer.byteLength(out, 'latin1');
    out += i + ' 0 obj\n' + objs[i] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 7\n0000000000 65535 f \n';
  for (let i = 1; i <= 6; i++) out += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'latin1');
}

async function buildReportPdf(rp) {
  const pt = await db.prepare('SELECT * FROM patients WHERE id=?').get(rp.patient_id);
  const settings = await db.prepare('SELECT * FROM settings WHERE id=1').get();
  const rows = await db.prepare('SELECT rt.result AS result, t.name AS name, t.unit AS unit, t.low AS low, t.high AS high FROM report_tests rt JOIN tests t ON t.id = rt.test_id WHERE rt.report_id=?').all(rp.id);
  const X0 = 50, X1 = 220, X2 = 300, X3 = 380, X4 = 470, W = 545;
  let content = '0.3 0.3 0.3 RG 0.5 w\n';
  let y = 800;
  const P = (x, str, size, bold) => { content += `BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pstr(str)}) Tj ET\n`; };
  const C = (str, size, bold) => { const x = (595 - (pstr(str).length * size * 0.5)) / 2; P(x, str, size, bold); };
  const HR = () => { content += `${X0} ${y} m ${W} ${y} l S\n`; };
  const row = (a, b, c, d, e) => { P(X0, a, 9, false); P(X1, b, 9, false); P(X2, c, 9, false); P(X3, d, 9, false); P(X4, e, 9, false); y -= 16; };

  C(settings.name || 'Pathofox', 20, true); y -= 26;
  const sub = [settings.address, settings.phone].filter(Boolean).join('  |  ');
  if (sub) { C(sub, 9, false); y -= 18; }
  C('PATHOLOGY REPORT', 13, true); y -= 12;
  HR(); y -= 24;

  const cl = (cols, x) => { cols.forEach(([l, v]) => { P(x, l + ':', 9, true); P(x + (pstr(l + ':').length * 4.5) + 6, v, 9, false); y -= 14; }); };
  cl([['Patient', pt ? pt.name : ''], ['Age / Gender', (pt ? pt.age || '' : '') + ' / ' + (pt ? pt.gender || '' : '')], ['Mobile', pt ? pt.phone || '' : '']], X0);
  y += 42;
  cl([['Report No.', rp.number], ['Patient ID', pt ? pt.number : ''], ['Date', rp.date]], 300);
  y -= 8;
  HR(); y -= 22;

  row('Test', 'Result', 'Unit', 'Ref. Range', 'Flag');
  y -= 4;
  HR(); y -= 16;

  for (const r of rows) {
    const v = Number(r.result);
    let flag = 'Normal';
    if (r.low != null && v < r.low) flag = 'Low';
    else if (r.high != null && v > r.high) flag = 'High';
    const rr = r.low != null && r.high != null ? r.low + ' - ' + r.high
      : r.low != null ? '> ' + r.low
      : r.high != null ? '< ' + r.high : '-';
    row(r.name, String(r.result), r.unit || '', rr, flag);
  }
  y -= 8;
  HR(); y -= 22;

  if (rp.notes) { P(X0, "Doctor's Notes: " + rp.notes, 9, false); y -= 16; }

  const sy = 160;
  content += `BT /F1 10 Tf 1 0 0 1 90 ${sy} Tm (${pstr('_________________')}) Tj ET\n`;
  content += `BT /F1 8 Tf 1 0 0 1 90 ${sy - 12} Tm (${pstr('Tested By')}) Tj ET\n`;
  content += `BT /F1 10 Tf 1 0 0 1 390 ${sy} Tm (${pstr('_________________')}) Tj ET\n`;
  content += `BT /F1 8 Tf 1 0 0 1 390 ${sy - 12} Tm (${pstr('Pathologist / Authorized Signatory')}) Tj ET\n`;

  return assemblePdf(content);
}

/* ---------- SMS / delivery ---------- */
function sendSms(settings, mobile, message) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      authkey: settings.sms_key,
      mobiles: '91' + normalizePhone(mobile),
      message,
      sender: settings.sms_sender || 'PATHOFOX',
      route: '4'
    });
    const req = https.get('https://api.msg91.com/api/sendhttp.php?' + params.toString(), (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, body: body.slice(0, 200) }));
    });
    req.on('error', e => resolve({ ok: false, body: String(e.message) }));
    req.setTimeout(15000, () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, body: 'timeout' }); });
  });
}

async function sendReportPdf(rp, invoice, host, headers) {
  const pt = await db.prepare('SELECT * FROM patients WHERE id=?').get(rp.patient_id);
  const settings = await db.prepare('SELECT * FROM settings WHERE id=1').get();
  const mobile = pt && pt.phone ? normalizePhone(pt.phone) : '';
  const token = crypto.randomBytes(16).toString('hex');
  const proto = headers && headers['x-forwarded-proto'] ? String(headers['x-forwarded-proto']).split(',')[0].trim() : 'http';
  const base = proto + '://' + (host || 'localhost:3000');
  const pdfUrl = base + '/api/pdf/' + token;
  const message = 'Hello ' + (pt ? pt.name : 'Patient') + ', your report ' + rp.number + ' is ready. Download PDF: ' + pdfUrl;
  let mode = 'simulated', status = 'sent', note = '';
  if (!mobile) { status = 'failed'; note = 'No patient mobile number on file'; }
  else if (settings.sms_key) {
    mode = 'real';
    const r = await sendSms(settings, mobile, message);
    status = r.ok ? 'sent' : 'failed';
    note = r.body || '';
  }
  const did = uid();
  await db.prepare('INSERT INTO deliveries (id, report_id, invoice_id, patient_id, mobile, method, mode, status, message, pdf_url, token, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(did, rp.id, invoice ? invoice.id : null, rp.patient_id, mobile, 'sms', mode, status, message, pdfUrl, token, todayISO());
  const d = await db.prepare('SELECT * FROM deliveries WHERE id=?').get(did);
  return { ...d, reportId: d.report_id, invoiceId: d.invoice_id, patientId: d.patient_id, pdfUrl: d.pdf_url };
}

async function handle(req, res) {
  try {
    await ready;
    res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (!p.startsWith('/api')) {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const body = await readBody(req);

  /* Public PDF link (one-time token, valid 7 days) */
  const mPubPdf = p.match(/^\/api\/pdf\/([^/]+)$/);
  if (mPubPdf && req.method === 'GET') {
    const del = await db.prepare('SELECT * FROM deliveries WHERE token=?').get(mPubPdf[1]);
    if (!del) return sendErr(res, 404, 'Invalid or expired link.');
    if (new Date(del.created + 'T00:00:00').getTime() < Date.now() - 7 * 86400000) return sendErr(res, 410, 'Link expired.');
    const rp = await db.prepare('SELECT * FROM reports WHERE id=?').get(del.report_id);
    if (!rp) return sendErr(res, 404, 'Report not found.');
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="' + rp.number + '.pdf"' });
    res.end(await buildReportPdf(rp));
    return;
  }

  /* ---------- AUTH ---------- */
  if (p === '/api/auth/register' && req.method === 'POST') {
    const { name, phone, labName, labPhone, labAddress, password } = body;
    if (!name) return sendErr(res, 400, 'Full name is required.');
    if (!isIndianMobile(phone)) return sendErr(res, 400, 'Enter a valid 10-digit Indian mobile number.');
    if (!labName) return sendErr(res, 400, 'Laboratory name is required.');
    if (labPhone && !isIndianMobile(labPhone)) return sendErr(res, 400, 'Enter a valid lab mobile number.');
    if (!password || password.length < 6) return sendErr(res, 400, 'Password must be at least 6 characters.');
    const uname = normalizePhone(phone);
    const dup = await db.prepare('SELECT id FROM users WHERE username=? OR phone=?').get(uname, String(phone).trim());
    if (dup) return sendErr(res, 409, 'This phone number is already registered. Please sign in.');
    const info = await db.prepare(`INSERT INTO users (username, phone, name, lab_name, lab_phone, lab_address, pass_hash, created, plan, plan_status, plan_start, plan_end, lifetime)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`)
      .run(uname, String(phone).trim(), name, labName, labPhone, labAddress, hashPass(password), todayISO(), 'trial', 'active', todayISO(), addDays(todayISO(), 3));
    const user = await db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    const token = await createSession(user.id);
    return send(res, 200, { token, user: userToJson(user) });
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const { username, password } = body;
    const key = normalizePhone(username);
    const user = await db.prepare('SELECT * FROM users WHERE username=? OR phone=?').get(key, String(username || '').trim()) ||
                 await db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim());
    if (!user || !verifyPass(password || '', user.pass_hash)) return sendErr(res, 401, 'Invalid phone number or password.');
    const token = await createSession(user.id);
    return send(res, 200, { token, user: userToJson(user) });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const h = req.headers['authorization'] || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (tok) await db.prepare('DELETE FROM sessions WHERE token=?').run(tok);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/auth/me' && req.method === 'GET') {
    const user = await requireAuth(req, res);
    if (!user) return;
    return send(res, 200, userToJson(user));
  }

  if (p === '/api/auth/plan' && req.method === 'POST') {
    const user = await requireAuth(req, res);
    if (!user) return;
    const { plan } = body;
    const planDef = PLANS[plan];
    if (!planDef) return sendErr(res, 400, 'Unknown plan.');
    const isLifetime = planDef.days === Infinity;
    await db.prepare('UPDATE users SET plan=?, plan_status=?, plan_start=?, plan_end=?, lifetime=? WHERE id=?')
      .run(plan, 'active', todayISO(), isLifetime ? null : addDays(todayISO(), planDef.days), isLifetime ? 1 : 0, user.id);
    const fresh = await db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    return send(res, 200, userToJson(fresh));
  }

  /* ---------- DATA (subscription required) ---------- */
  const user = await requireSub(req, res);
  if (!user) return;

  if (p === '/api/sync' && req.method === 'GET') {
    return send(res, 200, {
      settings: await db.prepare('SELECT * FROM settings WHERE id=1').get(),
      patients: await db.prepare('SELECT * FROM patients ORDER BY created DESC, id DESC').all(),
      tests: await db.prepare('SELECT * FROM tests ORDER BY id').all(),
      reports: await reportsWithTests(),
      invoices: await invoicesWithItems(),
      deliveries: await deliveriesJson()
    });
  }

  if (p === '/api/settings' && req.method === 'PUT') {
    const { name, phone, email, address, smsKey, smsSender } = body;
    await db.prepare('UPDATE settings SET name=?, phone=?, email=?, address=?, sms_key=?, sms_sender=? WHERE id=1')
      .run(name || 'Pathofox', phone || '', email || '', address || '', (smsKey || '').trim(), (smsSender || 'PATHOFOX').trim());
    return send(res, 200, await db.prepare('SELECT * FROM settings WHERE id=1').get());
  }

  /* Patients */
  if (p === '/api/patients' && req.method === 'POST') {
    const { name, phone, age, gender, blood, address } = body;
    if (!name) return sendErr(res, 400, 'Patient name is required.');
    if (!isIndianMobile(phone)) return sendErr(res, 400, 'Phone number is required and must be a valid Indian mobile — it is the Patient ID.');
    const number = normalizePhone(phone);
    if (await db.prepare('SELECT id FROM patients WHERE number=?').get(number)) return sendErr(res, 409, 'A patient with this phone number already exists.');
    const id = uid();
    await db.prepare('INSERT INTO patients (id, number, name, phone, age, gender, blood, address, created) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, number, name, String(phone).trim(), age || '', gender || '', blood || '', address || '', todayISO());
    return send(res, 200, await db.prepare('SELECT * FROM patients WHERE id=?').get(id));
  }

  const mPat = p.match(/^\/api\/patients\/([^/]+)$/);
  if (mPat && req.method === 'PUT') {
    const pid = mPat[1];
    const existing = await db.prepare('SELECT * FROM patients WHERE id=?').get(pid);
    if (!existing) return sendErr(res, 404, 'Patient not found.');
    const { name, phone, age, gender, blood, address } = body;
    if (!name) return sendErr(res, 400, 'Patient name is required.');
    if (!isIndianMobile(phone)) return sendErr(res, 400, 'Phone number must be a valid Indian mobile — it is the Patient ID.');
    const number = normalizePhone(phone);
    if (await db.prepare('SELECT id FROM patients WHERE number=? AND id<>?').get(number, pid)) return sendErr(res, 409, 'A patient with this phone number already exists.');
    await db.prepare('UPDATE patients SET number=?, name=?, phone=?, age=?, gender=?, blood=?, address=? WHERE id=?')
      .run(number, name, String(phone).trim(), age || '', gender || '', blood || '', address || '', pid);
    return send(res, 200, await db.prepare('SELECT * FROM patients WHERE id=?').get(pid));
  }
  if (mPat && req.method === 'DELETE') {
    const pid = mPat[1];
    if (await db.prepare('SELECT id FROM reports WHERE patient_id=?').get(pid)) return sendErr(res, 409, 'This patient has reports. Delete those reports first.');
    await db.prepare('DELETE FROM patients WHERE id=?').run(pid);
    return send(res, 200, { ok: true });
  }

  /* Tests */
  if (p === '/api/tests' && req.method === 'POST') {
    const { name, category, unit, low, high, min, max, price } = body;
    if (!name) return sendErr(res, 400, 'Test name is required.');
    const id = uid();
    await db.prepare('INSERT INTO tests (id, name, category, unit, low, high, min, max, price) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, name, category || 'Others', unit || '', numOrNull(low), numOrNull(high), numOrNull(min), numOrNull(max), Number(price) || 0);
    return send(res, 200, await db.prepare('SELECT * FROM tests WHERE id=?').get(id));
  }
  const mTest = p.match(/^\/api\/tests\/([^/]+)$/);
  if (mTest && req.method === 'PUT') {
    const tid = mTest[1];
    const { name, category, unit, low, high, min, max, price } = body;
    if (!name) return sendErr(res, 400, 'Test name is required.');
    await db.prepare('UPDATE tests SET name=?, category=?, unit=?, low=?, high=?, min=?, max=?, price=? WHERE id=?')
      .run(name, category || 'Others', unit || '', numOrNull(low), numOrNull(high), numOrNull(min), numOrNull(max), Number(price) || 0, tid);
    return send(res, 200, await db.prepare('SELECT * FROM tests WHERE id=?').get(tid));
  }
  if (mTest && req.method === 'DELETE') {
    const tid = mTest[1];
    if (await db.prepare('SELECT id FROM report_tests WHERE test_id=?').get(tid)) return sendErr(res, 409, 'This test is used in existing reports and cannot be deleted.');
    await db.prepare('DELETE FROM tests WHERE id=?').run(tid);
    return send(res, 200, { ok: true });
  }

  /* Reports */
  if (p === '/api/reports' && req.method === 'POST') {
    const { patientId, date, notes, tests } = body;
    if (!patientId) return sendErr(res, 400, 'Please select a patient.');
    if (!Array.isArray(tests) || !tests.length) return sendErr(res, 400, 'Select at least one test with a result.');
    const rid = uid();
    const number = await nextNumber('RPT', 'reports');
    await db.prepare('INSERT INTO reports (id, number, patient_id, date, notes) VALUES (?,?,?,?,?)')
      .run(rid, number, patientId, date || todayISO(), notes || '');
    const st = db.prepare('INSERT INTO report_tests (report_id, test_id, result) VALUES (?,?,?)');
    for (const t of tests) {
      if (t.testId == null || t.result === '' || t.result === undefined || isNaN(Number(t.result))) {
        await db.prepare('DELETE FROM reports WHERE id=?').run(rid);
        return sendErr(res, 400, 'Every selected test needs a valid numeric result.');
      }
      await st.run(rid, String(t.testId), Number(t.result));
    }
    return send(res, 200, await db.prepare('SELECT * FROM reports WHERE id=?').get(rid));
  }
  const mRptPdf = p.match(/^\/api\/reports\/([^/]+)\/pdf$/);
  if (mRptPdf && req.method === 'GET') {
    const rp = await db.prepare('SELECT * FROM reports WHERE id=?').get(mRptPdf[1]);
    if (!rp) return sendErr(res, 404, 'Report not found.');
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="' + rp.number + '.pdf"' });
    res.end(await buildReportPdf(rp));
    return;
  }

  const mSend = p.match(/^\/api\/reports\/([^/]+)\/send$/);
  if (mSend && req.method === 'POST') {
    const rp = await db.prepare('SELECT * FROM reports WHERE id=?').get(mSend[1]);
    if (!rp) return sendErr(res, 404, 'Report not found.');
    const inv = await db.prepare('SELECT * FROM invoices WHERE report_id=?').get(rp.id) || null;
    if (inv && !inv.paid) return sendErr(res, 400, 'Invoice must be marked paid before sending the report.');
    const delivery = await sendReportPdf(rp, inv, req.headers.host, req.headers);
    return send(res, 200, { delivery });
  }

  const mRpt = p.match(/^\/api\/reports\/([^/]+)$/);
  if (mRpt && req.method === 'DELETE') {
    const rid = mRpt[1];
    await db.prepare('DELETE FROM deliveries WHERE report_id=?').run(rid);
    await db.prepare('DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE report_id=?)').run(rid);
    await db.prepare('DELETE FROM invoices WHERE report_id=?').run(rid);
    await db.prepare('DELETE FROM report_tests WHERE report_id=?').run(rid);
    await db.prepare('DELETE FROM reports WHERE id=?').run(rid);
    return send(res, 200, { ok: true });
  }

  /* Invoices */
  if (p === '/api/invoices' && req.method === 'POST') {
    const { reportId } = body;
    const rp = await db.prepare('SELECT * FROM reports WHERE id=?').get(reportId);
    if (!rp) return sendErr(res, 404, 'Report not found.');
    if (await db.prepare('SELECT id FROM invoices WHERE report_id=?').get(reportId)) return sendErr(res, 409, 'An invoice already exists for this report.');
    const rows = await db.prepare('SELECT t.name AS name, t.price AS price FROM report_tests rt JOIN tests t ON t.id = rt.test_id WHERE rt.report_id=?').all(reportId);
    const total = rows.reduce((s, i) => s + (Number(i.price) || 0), 0);
    const id = uid();
    const number = await nextNumber('INV', 'invoices');
    await db.prepare('INSERT INTO invoices (id, number, report_id, patient_id, date, total, paid) VALUES (?,?,?,?,?,?,0)')
      .run(id, number, reportId, rp.patient_id, todayISO(), total);
    const st = db.prepare('INSERT INTO invoice_items (invoice_id, name, price) VALUES (?,?,?)');
    for (const i of rows) {
      await st.run(id, i.name, i.price);
    }
    return send(res, 200, await db.prepare('SELECT * FROM invoices WHERE id=?').get(id));
  }
  const mInv = p.match(/^\/api\/invoices\/([^/]+)$/);
  if (mInv && req.method === 'PATCH') {
    const iid = mInv[1];
    await db.prepare('UPDATE invoices SET paid=? WHERE id=?').run(body.paid ? 1 : 0, iid);
    const inv = await db.prepare('SELECT * FROM invoices WHERE id=?').get(iid);
    let delivery = null;
    if (body.paid && inv.report_id) {
      const rp = await db.prepare('SELECT * FROM reports WHERE id=?').get(inv.report_id);
      if (rp) delivery = await sendReportPdf(rp, inv, req.headers.host, req.headers);
    }
    return send(res, 200, { invoice: { ...inv, paid: !!inv.paid }, delivery });
  }

  sendErr(res, 404, 'Endpoint not found.');
  } catch (e) {
    console.error('Request failed:', e);
    if (!res.headersSent) sendErr(res, 500, 'Internal server error. Please try again.');
    else { try { res.end(); } catch (e2) {} }
  }
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

async function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?,?,?)').run(token, userId, Date.now());
  return token;
}

const PLANS = {
  trial: { days: 3 },
  monthly: { days: 30 },
  yearly: { days: 365 }
};

function readIndexHtml() {
  const candidates = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, '..', 'index.html'),
    path.join(process.cwd(), 'index.html')
  ];
  for (const c of candidates) {
    try { return fs.readFileSync(c, 'utf8'); } catch (e) {}
  }
  console.error('Could not read index.html');
  return '';
}
let INDEX_HTML = readIndexHtml();

if (require.main === module) {
  ready.then(() => {
    const server = http.createServer(handle);
    server.listen(PORT, () => {
      console.log('');
      console.log('Pathofox server running');
      console.log('  Open: http://localhost:' + PORT);
      console.log('  Data file: labdesk.db  (SQLite)');
      console.log('  Demo admin: admin / admin123');
      console.log('');
    });
  }).catch(e => {
    console.error('Database initialization failed:', e.message);
    process.exit(1);
  });
}

module.exports = handle;
