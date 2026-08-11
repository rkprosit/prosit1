const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const db = new DatabaseSync(path.join(__dirname, 'labdesk.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'Pathofox',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT ''
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
`);

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
function nextNumber(prefix, table) {
  const r = db.prepare('SELECT COUNT(*) AS c FROM ' + table).get();
  return prefix + String(r.c + 1).padStart(4, '0');
}

function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
    db.prepare(`INSERT INTO users (username, phone, name, lab_name, lab_phone, lab_address, pass_hash, created, plan, plan_status, plan_start, plan_end, lifetime)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('admin', '', 'Administrator', 'Pathofox', '', '', hashPass('admin123'), todayISO(), 'pro', 'active', todayISO(), null, 1);
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM settings').get().c === 0) {
    db.prepare('INSERT INTO settings (id, name, phone, email, address) VALUES (1,?,?,?,?)')
      .run('Pathofox', '+91 98765 43210', 'reports@pathofox.in', '12, MG Road, Near City Hospital, Mumbai, Maharashtra 400001');
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM tests').get().c === 0) {
    const st = db.prepare('INSERT INTO tests (id, name, category, unit, low, high, min, max, price) VALUES (?,?,?,?,?,?,?,?,?)');
    SEED_TESTS.forEach((t, i) => st.run(String(i + 1), t.name, t.category, t.unit, t.low, t.high, null, null, t.price));
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

function subscriptionActive(row) {
  if (row.lifetime) return true;
  if (row.plan_status !== 'active') return false;
  if (row.plan_end && row.plan_end < todayISO()) {
    db.prepare('UPDATE users SET plan_status=? WHERE id=?').run('expired', row.id);
    return false;
  }
  return true;
}

function getUser(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(tok);
  if (!s) return null;
  return db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function sendErr(res, status, error, code) {
  send(res, status, { error, code });
}

function requireAuth(req, res) {
  const user = getUser(req);
  if (!user) { sendErr(res, 401, 'Please sign in first.', 'AUTH_REQUIRED'); return null; }
  return user;
}
function requireSub(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!subscriptionActive(user)) {
    sendErr(res, 402, 'Your subscription has expired. Please choose a plan.', 'SUBSCRIPTION_EXPIRED');
    return null;
  }
  return user;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function reportsWithTests() {
  const reports = db.prepare('SELECT * FROM reports ORDER BY date DESC, id DESC').all();
  const rt = db.prepare('SELECT report_id, test_id, result FROM report_tests').all();
  const byReport = {};
  rt.forEach(r => { (byReport[r.report_id] = byReport[r.report_id] || []).push({ testId: r.test_id, result: r.result }); });
  return reports.map(r => ({ ...r, tests: byReport[r.id] || [] }));
}
function invoicesWithItems() {
  const invoices = db.prepare('SELECT * FROM invoices ORDER BY date DESC, id DESC').all();
  const items = db.prepare('SELECT invoice_id, name, price FROM invoice_items').all();
  const byInv = {};
  items.forEach(i => { (byInv[i.invoice_id] = byInv[i.invoice_id] || []).push({ name: i.name, price: i.price }); });
  return invoices.map(i => ({ ...i, paid: !!i.paid, items: byInv[i.id] || [] }));
}

async function handle(req, res) {
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

  /* ---------- AUTH ---------- */
  if (p === '/api/auth/register' && req.method === 'POST') {
    const { name, phone, labName, labPhone, labAddress, password } = body;
    if (!name) return sendErr(res, 400, 'Full name is required.');
    if (!isIndianMobile(phone)) return sendErr(res, 400, 'Enter a valid 10-digit Indian mobile number.');
    if (!labName) return sendErr(res, 400, 'Laboratory name is required.');
    if (labPhone && !isIndianMobile(labPhone)) return sendErr(res, 400, 'Enter a valid lab mobile number.');
    if (!password || password.length < 6) return sendErr(res, 400, 'Password must be at least 6 characters.');
    const uname = normalizePhone(phone);
    const dup = db.prepare('SELECT id FROM users WHERE username=? OR phone=?').get(uname, String(phone).trim());
    if (dup) return sendErr(res, 409, 'This phone number is already registered. Please sign in.');
    const info = db.prepare(`INSERT INTO users (username, phone, name, lab_name, lab_phone, lab_address, pass_hash, created, plan, plan_status, plan_start, plan_end, lifetime)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`)
      .run(uname, String(phone).trim(), name, labName, labPhone, labAddress, hashPass(password), todayISO(), 'trial', 'active', todayISO(), addDays(todayISO(), 14));
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    const token = createSession(user.id);
    return send(res, 200, { token, user: userToJson(user) });
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const { username, password } = body;
    const key = normalizePhone(username);
    const user = db.prepare('SELECT * FROM users WHERE username=? OR phone=?').get(key, String(username || '').trim()) ||
                 db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim());
    if (!user || !verifyPass(password || '', user.pass_hash)) return sendErr(res, 401, 'Invalid phone number or password.');
    const token = createSession(user.id);
    return send(res, 200, { token, user: userToJson(user) });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const h = req.headers['authorization'] || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (tok) db.prepare('DELETE FROM sessions WHERE token=?').run(tok);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/auth/me' && req.method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) return;
    return send(res, 200, userToJson(user));
  }

  if (p === '/api/auth/plan' && req.method === 'POST') {
    const user = requireAuth(req, res);
    if (!user) return;
    const { plan } = body;
    const planDef = PLANS[plan];
    if (!planDef) return sendErr(res, 400, 'Unknown plan.');
    const isLifetime = planDef.days === Infinity;
    db.prepare('UPDATE users SET plan=?, plan_status=?, plan_start=?, plan_end=?, lifetime=? WHERE id=?')
      .run(plan, 'active', todayISO(), isLifetime ? null : addDays(todayISO(), planDef.days), isLifetime ? 1 : 0, user.id);
    const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    return send(res, 200, userToJson(fresh));
  }

  /* ---------- DATA (subscription required) ---------- */
  const user = requireSub(req, res);
  if (!user) return;

  if (p === '/api/sync' && req.method === 'GET') {
    return send(res, 200, {
      settings: db.prepare('SELECT id, name, phone, email, address FROM settings WHERE id=1').get(),
      patients: db.prepare('SELECT * FROM patients ORDER BY created DESC, id DESC').all(),
      tests: db.prepare('SELECT * FROM tests ORDER BY id').all(),
      reports: reportsWithTests(),
      invoices: invoicesWithItems()
    });
  }

  if (p === '/api/settings' && req.method === 'PUT') {
    const { name, phone, email, address } = body;
    db.prepare('UPDATE settings SET name=?, phone=?, email=?, address=? WHERE id=1')
      .run(name || 'Pathofox', phone || '', email || '', address || '');
    return send(res, 200, db.prepare('SELECT id, name, phone, email, address FROM settings WHERE id=1').get());
  }

  /* Patients */
  if (p === '/api/patients' && req.method === 'POST') {
    const { name, phone, age, gender, blood, address } = body;
    if (!name) return sendErr(res, 400, 'Patient name is required.');
    if (!isIndianMobile(phone)) return sendErr(res, 400, 'Phone number is required and must be a valid Indian mobile — it is the Patient ID.');
    const number = normalizePhone(phone);
    if (db.prepare('SELECT id FROM patients WHERE number=?').get(number)) return sendErr(res, 409, 'A patient with this phone number already exists.');
    const id = uid();
    db.prepare('INSERT INTO patients (id, number, name, phone, age, gender, blood, address, created) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, number, name, String(phone).trim(), age || '', gender || '', blood || '', address || '', todayISO());
    return send(res, 200, db.prepare('SELECT * FROM patients WHERE id=?').get(id));
  }

  const mPat = p.match(/^\/api\/patients\/([^/]+)$/);
  if (mPat && req.method === 'PUT') {
    const pid = mPat[1];
    const existing = db.prepare('SELECT * FROM patients WHERE id=?').get(pid);
    if (!existing) return sendErr(res, 404, 'Patient not found.');
    const { name, phone, age, gender, blood, address } = body;
    if (!name) return sendErr(res, 400, 'Patient name is required.');
    if (!isIndianMobile(phone)) return sendErr(res, 400, 'Phone number must be a valid Indian mobile — it is the Patient ID.');
    const number = normalizePhone(phone);
    if (db.prepare('SELECT id FROM patients WHERE number=? AND id<>?').get(number, pid)) return sendErr(res, 409, 'A patient with this phone number already exists.');
    db.prepare('UPDATE patients SET number=?, name=?, phone=?, age=?, gender=?, blood=?, address=? WHERE id=?')
      .run(number, name, String(phone).trim(), age || '', gender || '', blood || '', address || '', pid);
    return send(res, 200, db.prepare('SELECT * FROM patients WHERE id=?').get(pid));
  }
  if (mPat && req.method === 'DELETE') {
    const pid = mPat[1];
    if (db.prepare('SELECT id FROM reports WHERE patient_id=?').get(pid)) return sendErr(res, 409, 'This patient has reports. Delete those reports first.');
    db.prepare('DELETE FROM patients WHERE id=?').run(pid);
    return send(res, 200, { ok: true });
  }

  /* Tests */
  if (p === '/api/tests' && req.method === 'POST') {
    const { name, category, unit, low, high, min, max, price } = body;
    if (!name) return sendErr(res, 400, 'Test name is required.');
    const id = uid();
    db.prepare('INSERT INTO tests (id, name, category, unit, low, high, min, max, price) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, name, category || 'Others', unit || '', numOrNull(low), numOrNull(high), numOrNull(min), numOrNull(max), Number(price) || 0);
    return send(res, 200, db.prepare('SELECT * FROM tests WHERE id=?').get(id));
  }
  const mTest = p.match(/^\/api\/tests\/([^/]+)$/);
  if (mTest && req.method === 'PUT') {
    const tid = mTest[1];
    const { name, category, unit, low, high, min, max, price } = body;
    if (!name) return sendErr(res, 400, 'Test name is required.');
    db.prepare('UPDATE tests SET name=?, category=?, unit=?, low=?, high=?, min=?, max=?, price=? WHERE id=?')
      .run(name, category || 'Others', unit || '', numOrNull(low), numOrNull(high), numOrNull(min), numOrNull(max), Number(price) || 0, tid);
    return send(res, 200, db.prepare('SELECT * FROM tests WHERE id=?').get(tid));
  }
  if (mTest && req.method === 'DELETE') {
    const tid = mTest[1];
    if (db.prepare('SELECT id FROM report_tests WHERE test_id=?').get(tid)) return sendErr(res, 409, 'This test is used in existing reports and cannot be deleted.');
    db.prepare('DELETE FROM tests WHERE id=?').run(tid);
    return send(res, 200, { ok: true });
  }

  /* Reports */
  if (p === '/api/reports' && req.method === 'POST') {
    const { patientId, date, notes, tests } = body;
    if (!patientId) return sendErr(res, 400, 'Please select a patient.');
    if (!Array.isArray(tests) || !tests.length) return sendErr(res, 400, 'Select at least one test with a result.');
    const rid = uid();
    const number = nextNumber('RPT', 'reports');
    db.prepare('INSERT INTO reports (id, number, patient_id, date, notes) VALUES (?,?,?,?,?)')
      .run(rid, number, patientId, date || todayISO(), notes || '');
    const st = db.prepare('INSERT INTO report_tests (report_id, test_id, result) VALUES (?,?,?)');
    for (const t of tests) {
      if (t.testId == null || t.result === '' || t.result === undefined || isNaN(Number(t.result))) {
        db.prepare('DELETE FROM reports WHERE id=?').run(rid);
        return sendErr(res, 400, 'Every selected test needs a valid numeric result.');
      }
      st.run(rid, String(t.testId), Number(t.result));
    }
    return send(res, 200, db.prepare('SELECT * FROM reports WHERE id=?').get(rid));
  }
  const mRpt = p.match(/^\/api\/reports\/([^/]+)$/);
  if (mRpt && req.method === 'DELETE') {
    const rid = mRpt[1];
    db.prepare('DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE report_id=?)').run(rid);
    db.prepare('DELETE FROM invoices WHERE report_id=?').run(rid);
    db.prepare('DELETE FROM report_tests WHERE report_id=?').run(rid);
    db.prepare('DELETE FROM reports WHERE id=?').run(rid);
    return send(res, 200, { ok: true });
  }

  /* Invoices */
  if (p === '/api/invoices' && req.method === 'POST') {
    const { reportId } = body;
    const rp = db.prepare('SELECT * FROM reports WHERE id=?').get(reportId);
    if (!rp) return sendErr(res, 404, 'Report not found.');
    if (db.prepare('SELECT id FROM invoices WHERE report_id=?').get(reportId)) return sendErr(res, 409, 'An invoice already exists for this report.');
    const rows = db.prepare('SELECT t.name AS name, t.price AS price FROM report_tests rt JOIN tests t ON t.id = rt.test_id WHERE rt.report_id=?').all(reportId);
    const total = rows.reduce((s, i) => s + (Number(i.price) || 0), 0);
    const id = uid();
    const number = nextNumber('INV', 'invoices');
    db.prepare('INSERT INTO invoices (id, number, report_id, patient_id, date, total, paid) VALUES (?,?,?,?,?,?,0)')
      .run(id, number, reportId, rp.patient_id, todayISO(), total);
    const st = db.prepare('INSERT INTO invoice_items (invoice_id, name, price) VALUES (?,?,?)');
    rows.forEach(i => st.run(id, i.name, i.price));
    return send(res, 200, db.prepare('SELECT * FROM invoices WHERE id=?').get(id));
  }
  const mInv = p.match(/^\/api\/invoices\/([^/]+)$/);
  if (mInv && req.method === 'PATCH') {
    const iid = mInv[1];
    db.prepare('UPDATE invoices SET paid=? WHERE id=?').run(body.paid ? 1 : 0, iid);
    return send(res, 200, db.prepare('SELECT * FROM invoices WHERE id=?').get(iid));
  }

  sendErr(res, 404, 'Endpoint not found.');
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?,?,?)').run(token, userId, Date.now());
  return token;
}

const PLANS = {
  trial: { days: 14 },
  monthly: { days: 30 },
  yearly: { days: 365 },
  pro: { days: Infinity }
};

let INDEX_HTML = '';
try {
  INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
} catch (e) {
  console.error('Could not read index.html', e.message);
}

seed();

const server = http.createServer(handle);
server.listen(PORT, () => {
  console.log('');
  console.log('Pathofox server running');
  console.log('  Open: http://localhost:' + PORT);
  console.log('  Data file: labdesk.db  (SQLite)');
  console.log('  Demo admin: admin / admin123');
  console.log('');
});
