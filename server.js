const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const dbPath = path.join(__dirname, 'dt1.db');
const SNAPSHOT_KEY = 'dt1:sqlite:snapshot:v1';
let db;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  res.on('finish', () => {
    persistDatabaseSnapshot().catch((err) => console.error('SQLite snapshot failed:', err.message));
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.money = (n) => (Number(n) || 0).toFixed(2);

function daysUntil(exp) {
  return Math.ceil((new Date(exp) - new Date()) / (1000 * 60 * 60 * 24));
}

function getStatusClass(exp) {
  if (!exp) return 'red';
  const days = daysUntil(exp);
  if (days < 15) return 'red';
  if (days <= 45) return 'yellow';
  return 'green';
}

function getStatusText(exp) {
  if (!exp) return 'Missing';
  const days = daysUntil(exp);
  if (days < 0) return 'Expired';
  if (days < 15) return 'Expiring ≤14 days';
  if (days <= 45) return 'Expiring ≤45 days';
  return 'Active';
}

app.locals.getStatusClass = getStatusClass;
app.locals.getStatusText = getStatusText;

function loadStatusLabel(status, settlementStatus) {
  if (status === 'approved' && settlementStatus === 'approved') return 'Settled';
  if (status === 'approved') return 'Approved (Pending Settlement)';
  if (status === 'submitted') return 'Submitted';
  if (status === 'draft') return 'Draft';
  return status || 'Draft';
}

function loadOriginLabel(load) {
  if (!load) return '';
  if (load.entry_mode === 'entered') return 'Entered by Admin for Driver';
  if (load.entry_mode === 'assigned' && load.status === 'draft') return 'Assigned by Admin (Driver Draft)';
  if (load.status === 'submitted' || load.status === 'approved') return 'Submitted by Driver';
  if (load.entry_mode === 'assigned') return 'Assigned by Admin (Driver Draft)';
  return '';
}

function weekBounds(dateStr) {
  if (!dateStr) return null;
  const date = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const monday = new Date(date);
  monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const iso = (value) => {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  };
  const label = (value) => value.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const range = `${label(monday)} - ${label(sunday)}`;
  return {
    start: iso(monday),
    end: iso(sunday),
    range,
    title: `Driver Load Summary - Week of ${range}`
  };
}

function settlementWeekLabel(dateStr) {
  const week = weekBounds(dateStr);
  return week ? `week of ${week.range}` : '';
}

function calcDriverPay(load) {
  const qty = Number(load.weight_quantity) || 0;
  const rate = Number(load.rate) || 0;
  const percentage = Number(load.pay_percentage) || 0;
  const linehaul = qty * rate;
  const flat = load && load.driver_pay_type === 'flat';
  const base = flat ? (Number(load.driver_flat_rate) || 0) : linehaul * (percentage / 100);
  const drive = Number(load.has_drive_time) ? (Number(load.drive_time_amount) || 0) : 0;
  const self = Number(load.has_self_load) ? (Number(load.self_load_amount) || 0) : 0;
  const basis = flat
    ? `Flat Daily Rate: $${base.toFixed(2)}`
    : `${percentage}% of $${linehaul.toFixed(2)}`;
  return { linehaul, base, drive, self, pay: base + drive + self, percentage, flat, basis };
}

function payVisible(load) {
  return !!(load && (load.status === 'approved' || load.settlement_status === 'approved'));
}

function annotatePay(load) {
  load.payInfo = calcDriverPay(load);
  load.showPay = payVisible(load);
  return load;
}

function driverWeekGroups(driverId) {
  const loads = attachTickets(db.prepare(loadQuery + `
    WHERE l.driver_id = ? AND IFNULL(l.settlement_status, '') != 'approved'
    ORDER BY l.load_date DESC, l.id DESC
  `).all(driverId)).map(annotatePay);
  const weeks = new Map();
  const undated = [];
  loads.forEach((load) => {
    const week = weekBounds(load.load_date);
    if (!week) {
      undated.push(load);
      return;
    }
    if (!weeks.has(week.start)) weeks.set(week.start, { ...week, loads: [] });
    weeks.get(week.start).loads.push(load);
  });
  const summarize = (group) => {
    group.count = group.loads.length;
    group.collapsed = group.loads.length > 1;
    group.qty = group.loads.reduce((sum, load) => sum + (Number(load.weight_quantity) || 0), 0);
    group.approvedPay = group.loads.reduce((sum, load) => sum + (load.showPay ? load.payInfo.pay : 0), 0);
    group.approvedCount = group.loads.filter((load) => load.status === 'approved').length;
    group.submittedCount = group.loads.filter((load) => load.status === 'submitted').length;
    group.draftCount = group.loads.filter((load) => load.status === 'draft').length;
    return group;
  };
  return {
    weeks: Array.from(weeks.values()).sort((a, b) => b.start.localeCompare(a.start)).map(summarize),
    undated: undated.length ? summarize({ title: 'Undated loads', loads: undated, start: '', end: '', range: '' }) : null
  };
}

function ticketFileKind(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  return 'file';
}

function auditStamp(value) {
  if (!value) return '';
  const text = String(value).trim();
  const iso = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC'
  });
}

const LOGIN_ALIASES = {
  'logan.dt1@mail.grokbot.com': 'david.dt1@mail.grokbot.com'
};

function loginEmail(email) {
  const trimmed = String(email || '').trim();
  return LOGIN_ALIASES[trimmed.toLowerCase()] || trimmed;
}

function actorName(req) {
  return (req.session.user && req.session.user.name) || 'Unknown';
}

function logAudit(req, action, entityType, entityId, detail) {
  const name = actorName(req);
  db.prepare(`
    INSERT INTO audit_log (actor_id, actor_name, action, entity_type, entity_id, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.session.user ? req.session.user.id : null, name, action, entityType, entityId || null, detail || null);
  return name;
}

function loadAudit(loadId) {
  return db.prepare(`
    SELECT actor_name, action, detail, created_at
    FROM audit_log
    WHERE entity_type = 'load' AND entity_id = ?
    ORDER BY id DESC
  `).all(loadId);
}

app.locals.loadStatusLabel = loadStatusLabel;
app.locals.loadOriginLabel = loadOriginLabel;
app.locals.settlementWeekLabel = settlementWeekLabel;
app.locals.ticketFileKind = ticketFileKind;
app.locals.auditStamp = auditStamp;

app.use((req, res, next) => {
  const png = path.join(__dirname, 'public', 'logo.png');
  res.locals.logoSrc = fs.existsSync(png) ? '/logo.png' : '/logo.svg';
  next();
});

// File upload setup
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});
const upload = multer({ storage });

app.use(session({
  secret: process.env.SESSION_SECRET || 'dt1-logistics-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function ensureColumn(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    // Existing databases already have the column; keep startup working.
  }
}

function composeName(firstName, middleInitial, lastName) {
  return [firstName, middleInitial, lastName].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

function splitStoredName(name, middleInitial) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: '', last_name: '' };
  const middle = String(middleInitial || '').trim().replace(/\.$/, '');
  const rest = parts.slice(1);
  if (middle && middle.length === 1 && rest.length && rest[0].replace(/\.$/, '') === middle) {
    rest.shift();
  }
  return { first_name: parts[0], last_name: rest.join(' ') };
}

function backfillUserNames() {
  const people = db.prepare('SELECT id, name, first_name, middle_initial, last_name, app_language FROM users').all();
  const fillNames = db.prepare('UPDATE users SET first_name = ?, last_name = ?, name = ? WHERE id = ?');
  const forceEnglish = db.prepare("UPDATE users SET app_language = 'English' WHERE id = ?");
  people.forEach((person) => {
    const first = String(person.first_name || '').trim();
    const last = String(person.last_name || '').trim();
    if (!first && !last && String(person.name || '').trim()) {
      const split = splitStoredName(person.name, person.middle_initial);
      fillNames.run(split.first_name, split.last_name, composeName(split.first_name, person.middle_initial, split.last_name), person.id);
    }
    if (person.app_language !== 'English') forceEnglish.run(person.id);
  });
}

function parseStoredAddress(value) {
  const text = String(value || '').trim();
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const region = parts[parts.length - 1].match(/^([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);
    if (region) {
      return {
        address: parts.slice(0, -2).join(', '),
        city: parts[parts.length - 2],
        state: region[1].toUpperCase(),
        zip: region[2] || ''
      };
    }
  }
  return { address: text, city: '', state: '', zip: '' };
}

function normalizeState(value) {
  const state = String(value || '').trim();
  return state.length === 2 ? state.toUpperCase() : state;
}

function bodyHas(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

function keptText(body, key, existing) {
  if (!bodyHas(body, key)) return existing ? existing[key] : null;
  return blankToNull(body[key]);
}

function readAddressParts(body, existing) {
  const pick = (key, normalize) => {
    if (!bodyHas(body, key)) return existing ? (existing[key] || '') : '';
    const value = String(body[key] || '').trim();
    return normalize ? normalize(value) : value;
  };
  return {
    address: pick('address'),
    city: pick('city'),
    state: pick('state', normalizeState),
    zip: pick('zip')
  };
}

function backfillUserAddresses() {
  const people = db.prepare('SELECT id, address, city, state, zip FROM users').all();
  const fill = db.prepare('UPDATE users SET address = ?, city = ?, state = ?, zip = ? WHERE id = ?');
  people.forEach((person) => {
    const city = String(person.city || '').trim();
    const state = String(person.state || '').trim();
    const zip = String(person.zip || '').trim();
    if (city || state || zip || !String(person.address || '').trim()) return;
    const parsed = parseStoredAddress(person.address);
    if (!parsed.city && !parsed.state && !parsed.zip) return;
    fill.run(parsed.address, parsed.city, parsed.state, parsed.zip, person.id);
  });
}

// Initialize database tables
function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'driver')),
      name TEXT,
      first_name TEXT,
      middle_initial TEXT,
      last_name TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      pay_percentage REAL,
      hire_date DATE,
      dob DATE,
      profile_pic TEXT,
      status TEXT DEFAULT 'active',
      must_change_password INTEGER DEFAULT 0,
      temp_password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address_line1 TEXT,
      address_line2 TEXT,
      poc_name TEXT,
      poc_phone TEXT,
      poc_email TEXT,
      terms TEXT DEFAULT 'Net 30',
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      project_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      default_rate REAL NOT NULL DEFAULT 0,
      has_fuel_surcharge INTEGER DEFAULT 0,
      has_drive_time INTEGER DEFAULT 0,
      default_drive_time_amount REAL DEFAULT 0,
      default_driver_pay_type TEXT DEFAULT 'percentage',
      default_driver_flat_rate REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS loads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT,
      load_date DATE,
      driver_id INTEGER,
      truck_id INTEGER,
      project_id INTEGER,
      description TEXT,
      origin TEXT,
      destination TEXT,
      notes TEXT,
      rejection_reason TEXT,
      weight_quantity REAL,
      rate REAL DEFAULT 0,
      has_fuel_surcharge INTEGER DEFAULT 0,
      has_drive_time INTEGER DEFAULT 0,
      drive_time_amount REAL DEFAULT 0,
      has_self_load INTEGER DEFAULT 0,
      self_load_amount REAL DEFAULT 0,
      driver_pay_type TEXT DEFAULT 'percentage',
      driver_flat_rate REAL DEFAULT 0,
      status TEXT DEFAULT 'draft',
      submitted_by INTEGER,
      approved_by INTEGER,
      approved_by_name TEXT,
      approved_at DATETIME,
      rejected_by INTEGER,
      rejected_by_name TEXT,
      rejected_at DATETIME,
      updated_by INTEGER,
      updated_by_name TEXT,
      updated_at DATETIME,
      settlement_status TEXT,
      created_by_role TEXT,
      entry_mode TEXT,
      missing_info_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES users(id),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS driver_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id INTEGER,
      doc_type TEXT CHECK(doc_type IN ('cdl', 'medical_card')),
      filename TEXT,
      original_name TEXT,
      expiration_date DATE,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      load_id INTEGER,
      filename TEXT,
      original_name TEXT,
      category TEXT,
      file_blob BLOB,
      uploaded_by INTEGER,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sharepoint_status TEXT DEFAULT 'pending',
      FOREIGN KEY (load_id) REFERENCES loads(id)
    );

    CREATE TABLE IF NOT EXISTS fuel_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      effective_date DATE,
      central_atlantic_rate REAL,
      base_rate REAL DEFAULT 4.00,
      surcharge_percent REAL,
      updated_by TEXT,
      updated_by_id INTEGER,
      updated_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('truck', 'trailer')),
      number TEXT,
      description TEXT,
      vin TEXT,
      year TEXT,
      make TEXT,
      model TEXT,
      status TEXT DEFAULT 'active',
      ownership TEXT,
      registration_expiration DATE,
      inspection_expiration DATE,
      maintenance_status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS compliance_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      expiration_date DATE,
      notes TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_date DATE,
      uploaded_by INTEGER,
      filename TEXT,
      original_name TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS driver_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id INTEGER NOT NULL,
      week_start DATE NOT NULL,
      week_end DATE NOT NULL,
      status TEXT DEFAULT 'approved',
      approved_by INTEGER,
      approved_by_name TEXT,
      approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(driver_id, week_start)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      actor_name TEXT,
      action TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS receipt_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER,
      equipment_type TEXT,
      description TEXT,
      amount REAL,
      FOREIGN KEY (receipt_id) REFERENCES receipts(id)
    );

    CREATE TABLE IF NOT EXISTS communications_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id INTEGER,
      driver_name TEXT,
      driver_email TEXT,
      driver_phone TEXT,
      channels TEXT,
      subject TEXT,
      message_body TEXT,
      email_status TEXT,
      sms_status TEXT,
      sent_by INTEGER,
      sent_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe upgrades for databases created before these columns existed.
  ensureColumn('users', 'first_name', 'TEXT');
  ensureColumn('users', 'middle_initial', 'TEXT');
  ensureColumn('users', 'last_name', 'TEXT');
  ensureColumn('users', 'phone', 'TEXT');
  ensureColumn('users', 'address', 'TEXT');
  ensureColumn('users', 'city', 'TEXT');
  ensureColumn('users', 'state', 'TEXT');
  ensureColumn('users', 'zip', 'TEXT');
  ensureColumn('users', 'hire_date', 'DATE');
  ensureColumn('users', 'dob', 'DATE');
  ensureColumn('users', 'profile_pic', 'TEXT');
  ensureColumn('users', 'app_language', "TEXT DEFAULT 'English'");
  ensureColumn('users', 'temp_password', 'TEXT');

  ensureColumn('loads', 'project_id', 'INTEGER');
  ensureColumn('loads', 'rate', 'REAL DEFAULT 0');
  ensureColumn('loads', 'has_fuel_surcharge', 'INTEGER DEFAULT 0');
  ensureColumn('loads', 'has_drive_time', 'INTEGER DEFAULT 0');
  ensureColumn('loads', 'drive_time_amount', 'REAL DEFAULT 0');
  ensureColumn('loads', 'has_self_load', 'INTEGER DEFAULT 0');
  ensureColumn('loads', 'self_load_amount', 'REAL DEFAULT 0');
  ensureColumn('loads', 'origin', 'TEXT');
  ensureColumn('loads', 'destination', 'TEXT');
  ensureColumn('loads', 'notes', 'TEXT');
  ensureColumn('loads', 'rejection_reason', 'TEXT');
  ensureColumn('loads', 'settlement_status', 'TEXT');
  ensureColumn('loads', 'approved_by_name', 'TEXT');
  ensureColumn('loads', 'rejected_by', 'INTEGER');
  ensureColumn('loads', 'rejected_by_name', 'TEXT');
  ensureColumn('loads', 'rejected_at', 'DATETIME');
  ensureColumn('loads', 'updated_by', 'INTEGER');
  ensureColumn('loads', 'updated_by_name', 'TEXT');
  ensureColumn('loads', 'updated_at', 'DATETIME');
  ensureColumn('loads', 'created_by_role', 'TEXT');
  ensureColumn('loads', 'entry_mode', 'TEXT');
  ensureColumn('loads', 'missing_info_note', 'TEXT');
  ensureColumn('loads', 'driver_pay_type', "TEXT DEFAULT 'percentage'");
  ensureColumn('loads', 'driver_flat_rate', 'REAL DEFAULT 0');
  ensureColumn('projects', 'default_driver_pay_type', "TEXT DEFAULT 'percentage'");
  ensureColumn('projects', 'default_driver_flat_rate', 'REAL DEFAULT 0');
  ensureColumn('documents', 'file_blob', 'BLOB');
  ensureColumn('equipment', 'vin', 'TEXT');
  ensureColumn('equipment', 'year', 'TEXT');
  ensureColumn('equipment', 'make', 'TEXT');
  ensureColumn('equipment', 'model', 'TEXT');
  ensureColumn('equipment', 'status', "TEXT DEFAULT 'active'");
  ensureColumn('fuel_rates', 'updated_by', 'TEXT');
  ensureColumn('fuel_rates', 'updated_by_id', 'INTEGER');
  ensureColumn('fuel_rates', 'updated_at', 'DATETIME');
  ensureColumn('driver_settlements', 'approved_by_name', 'TEXT');
  ensureColumn('equipment', 'registration_expiration', 'DATE');
  ensureColumn('equipment', 'inspection_expiration', 'DATE');
  ensureColumn('equipment', 'maintenance_status', "TEXT DEFAULT 'active'");

  const complianceCount = db.prepare('SELECT COUNT(*) AS n FROM compliance_items').get().n;
  if (!complianceCount) {
    const insertCompliance = db.prepare('INSERT INTO compliance_items (name) VALUES (?)');
    ['FMCSA', 'HVUT', 'UCR', 'IFTA', 'Insurance'].forEach((name) => insertCompliance.run(name));
  }

  // Seed admin accounts if they do not exist yet. Matching is case-insensitive.
  const adminPassword = bcrypt.hashSync('changeme123', 10);
  const findAdmin = db.prepare('SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))');
  const insertAdmin = db.prepare(`
    INSERT INTO users (email, password, role, name, first_name, last_name, app_language, status)
    VALUES (?, ?, 'admin', ?, ?, ?, 'English', 'active')
  `);
  [
    ['admin@dt1logistics.com', 'Administrator', 'Administrator', ''],
    ['kammy@dt1logistics.com', 'Kammy', 'Kammy', ''],
    ['kammy.hall@gmail.com', 'Kammy Hall', 'Kammy', 'Hall']
  ].forEach(([email, name, firstName, lastName]) => {
    if (!findAdmin.get(email)) insertAdmin.run(email, adminPassword, name, firstName, lastName);
  });

  // Logan's login is separate from Kammy's. A later password change on /profile updates only that user.
  const loganEmail = 'david.dt1@mail.grokbot.com';
  const logan = db.prepare('SELECT id, password FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))').get(loganEmail);
  const needsLoganPassword = !logan || !String(logan.password || '').trim();
  if (needsLoganPassword) {
    const loganPassword = bcrypt.hashSync(process.env.LOGAN_TMS_PASSWORD || 'LoganDT1Ops2026!', 10);
    if (!logan) insertAdmin.run(loganEmail, loganPassword, 'Logan (Operations Manager)', 'Logan', 'Operations Manager');
    else db.prepare('UPDATE users SET password = ? WHERE id = ?').run(loganPassword, logan.id);
  }

  db.prepare('DELETE FROM fuel_rates WHERE central_atlantic_rate IS NULL OR surcharge_percent IS NULL').run();
  const validFuel = db.prepare(`
    SELECT COUNT(*) AS n FROM fuel_rates
    WHERE central_atlantic_rate IS NOT NULL AND surcharge_percent IS NOT NULL
  `).get().n;
  if (!validFuel) {
    db.prepare(`
      INSERT INTO fuel_rates (
        effective_date, central_atlantic_rate, base_rate, surcharge_percent, updated_by, updated_at
      ) VALUES ('2026-10-19', 6.508, 4.00, 2.508, 'Logan (Operations Manager)', CURRENT_TIMESTAMP)
    `).run();
  }

  db.prepare(`
    UPDATE loads
    SET approved_by_name = (SELECT name FROM users WHERE users.id = loads.approved_by)
    WHERE approved_by IS NOT NULL AND (approved_by_name IS NULL OR approved_by_name = '')
  `).run();

  backfillUserNames();
  backfillUserAddresses();
  backfillDocumentBlobs();
}

function flagValue(value) {
  return value === '1' || value === 'on' || value === 'true' || value === 1 || value === true;
}

function projectNaming(customerName, rawProjectName) {
  const customer = String(customerName || '').trim();
  let projectName = String(rawProjectName || '').trim();
  const prefix = `${customer} - `;
  if (customer && projectName.toLowerCase().startsWith(prefix.toLowerCase())) {
    projectName = projectName.slice(prefix.length).trim();
  }
  const displayName = customer ? `${customer} - ${projectName}` : projectName;
  return { projectName, displayName };
}

function refreshProjectDisplayNames(customerId) {
  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId);
  if (!customer) return;
  const projects = db.prepare('SELECT id, project_name FROM projects WHERE customer_id = ?').all(customerId);
  const update = db.prepare('UPDATE projects SET display_name = ? WHERE id = ?');
  for (const project of projects) {
    const { displayName } = projectNaming(customer.name, project.project_name);
    update.run(displayName, project.id);
  }
}

function readCustomer(body, existing) {
  const text = (key) => bodyHas(body, key) ? String(body[key] || '').trim() : (existing ? (existing[key] || '') : '');
  const terms = text('terms') || 'Net 30';
  let status = existing ? (existing.status || 'active') : 'active';
  if (bodyHas(body, 'status')) status = body.status === 'inactive' ? 'inactive' : 'active';
  return {
    name: text('name'),
    address_line1: text('address_line1'),
    address_line2: text('address_line2'),
    poc_name: text('poc_name'),
    poc_phone: text('poc_phone'),
    poc_email: text('poc_email'),
    terms,
    status
  };
}

function readProject(body, customer, existing) {
  const naming = projectNaming(customer.name, bodyHas(body, 'project_name') ? body.project_name : (existing ? existing.project_name : ''));
  const defaultRate = bodyHas(body, 'default_rate') && String(body.default_rate).trim() !== ''
    ? parseFloat(body.default_rate)
    : (existing ? Number(existing.default_rate) : NaN);
  const hasFuel = bodyHas(body, 'has_fuel_surcharge') || !existing
    ? (flagValue(body.has_fuel_surcharge) ? 1 : 0)
    : (Number(existing.has_fuel_surcharge) ? 1 : 0);
  const hasDrive = bodyHas(body, 'has_drive_time') || !existing
    ? (flagValue(body.has_drive_time) ? 1 : 0)
    : (Number(existing.has_drive_time) ? 1 : 0);
  let driveAmount = bodyHas(body, 'default_drive_time_amount') ? parseFloat(body.default_drive_time_amount) : (existing ? Number(existing.default_drive_time_amount) : 0);
  if (!hasDrive || !Number.isFinite(driveAmount)) driveAmount = 0;
  let error = null;
  if (!naming.projectName) error = 'Project name is required';
  else if (!Number.isFinite(defaultRate)) error = 'Default rate is required';
  return {
    projectName: naming.projectName,
    displayName: naming.displayName,
    defaultRate: Number.isFinite(defaultRate) ? defaultRate : 0,
    hasFuel,
    hasDrive,
    driveAmount,
    payType: bodyHas(body, 'default_driver_pay_type')
      ? (body.default_driver_pay_type === 'flat' ? 'flat' : 'percentage')
      : (existing && existing.default_driver_pay_type === 'flat' ? 'flat' : 'percentage'),
    flatRate: bodyHas(body, 'default_driver_flat_rate') && String(body.default_driver_flat_rate).trim() !== ''
      ? (Number.isFinite(parseFloat(body.default_driver_flat_rate)) ? parseFloat(body.default_driver_flat_rate) : 0)
      : (existing ? (Number(existing.default_driver_flat_rate) || 0) : 0),
    status: bodyHas(body, 'status') ? (body.status === 'inactive' ? 'inactive' : 'active') : (existing ? (existing.status || 'active') : 'active'),
    error
  };
}

function activeProjects() {
  return db.prepare(`
    SELECT p.*
    FROM projects p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.status = 'active' AND c.status = 'active'
    ORDER BY p.display_name
  `).all();
}

function loadFormData(user, load) {
  let drivers = [];
  if (user.role === 'admin') {
    drivers = db.prepare("SELECT id, name, status FROM users WHERE role = 'driver' AND (status IS NULL OR status = 'active') ORDER BY name").all();
    if (load && load.driver_id && !drivers.some((driver) => String(driver.id) === String(load.driver_id))) {
      const current = db.prepare("SELECT id, name, status FROM users WHERE id = ? AND role = 'driver'").get(load.driver_id);
      if (current) drivers.unshift(current);
    }
  }
  let trucks = db.prepare("SELECT id, number, description, status FROM equipment WHERE type = 'truck' AND (status IS NULL OR status = 'active') ORDER BY number").all();
  if (load && load.truck_id && !trucks.some((truck) => String(truck.id) === String(load.truck_id))) {
    const current = db.prepare("SELECT id, number, description, status FROM equipment WHERE id = ? AND type = 'truck'").get(load.truck_id);
    if (current) trucks.unshift(current);
  }
  return { drivers, projects: activeProjects(), trucks };
}

function submittedLoadGaps(load, hasFile) {
  const gaps = [];
  if (!load.driver_id) gaps.push('Driver');
  if (!load.truck_id) gaps.push('Truck');
  if (!load.project_id) gaps.push('Customer / Project');
  if (!load.load_date) gaps.push('Load Date');
  if (!String(load.ticket_number || '').trim()) gaps.push('Ticket #');
  const flatPay = load.driver_pay_type === 'flat';
  if (!flatPay && (load.weight_quantity == null || Number(load.weight_quantity) <= 0)) gaps.push('Qty/Wet Ton');
  if (!flatPay && (load.rate == null || Number(load.rate) <= 0)) gaps.push('Rate');
  if (!hasFile) gaps.push('Load Ticket/BOL file');
  return gaps;
}

app.locals.submittedLoadGaps = submittedLoadGaps;

function resolveLoadEntry(req, existing) {
  const isAdmin = req.session.user.role === 'admin';
  const action = req.body.action || 'submit';
  if (!isAdmin) {
    return {
      status: action === 'draft' ? 'draft' : 'submitted',
      entryMode: existing && existing.entry_mode ? existing.entry_mode : 'driver',
      createdByRole: existing && existing.created_by_role ? existing.created_by_role : 'driver',
      approveNow: false,
      auditAction: action === 'draft' ? 'Saved draft' : 'Submitted',
      auditDetail: action === 'draft' ? 'Driver saved a draft' : 'Submitted by Driver'
    };
  }
  if (action === 'save') {
    return {
      status: existing ? existing.status : 'draft',
      entryMode: existing && existing.entry_mode ? existing.entry_mode : 'entered',
      createdByRole: existing && existing.created_by_role ? existing.created_by_role : 'admin',
      approveNow: false,
      auditAction: 'Edited',
      auditDetail: 'Admin edited the load'
    };
  }
  if (action === 'draft') {
    return {
      status: 'draft',
      entryMode: 'assigned',
      createdByRole: 'admin',
      approveNow: false,
      auditAction: 'Assigned to Driver',
      auditDetail: `Assigned to Driver by ${actorName(req)}`
    };
  }
  if (action === 'approve') {
    return {
      status: 'approved',
      entryMode: 'entered',
      createdByRole: existing && existing.created_by_role ? existing.created_by_role : 'admin',
      approveNow: true,
      auditAction: 'Submitted and approved',
      auditDetail: `Entered by Admin for Driver by ${actorName(req)}`
    };
  }
  return {
    status: 'submitted',
    entryMode: 'entered',
    createdByRole: existing && existing.created_by_role ? existing.created_by_role : 'admin',
    approveNow: false,
    auditAction: 'Entered for Driver',
    auditDetail: `Entered by Admin for Driver by ${actorName(req)}`
  };
}

const loadQuery = `
  SELECT l.*, u.name as driver_name, u.pay_percentage,
         p.display_name as project_display, p.project_name as project_short_name,
         c.name as customer_name, c.address_line1, c.address_line2,
         c.poc_name, c.poc_phone, c.poc_email, c.terms
  FROM loads l
  LEFT JOIN users u ON l.driver_id = u.id
  LEFT JOIN projects p ON l.project_id = p.id
  LEFT JOIN customers c ON c.id = p.customer_id
`;

// Routes
function blankToNull(value) {
  const text = String(value || '').trim();
  return text || null;
}

function pushAlert(alerts, level, category, name, detail, href) {
  if (level === 'red' || level === 'yellow') {
    alerts.push({ level, category, name, detail, href });
  }
}

function rankLevel(level) {
  if (level === 'red') return 0;
  if (level === 'yellow') return 1;
  return 2;
}

function assessLoad(load, hasFile) {
  let level = 'green';
  const notes = [];
  const bump = (next, note) => {
    if (rankLevel(next) < rankLevel(level)) level = next;
    notes.push(note);
  };
  if (load.status === 'submitted') bump('yellow', 'Pending review');
  if (!hasFile && !load.ticket_number) bump('red', 'Missing ticket number and ticket file');
  else if (!hasFile) bump('yellow', 'Missing ticket file');
  else if (!load.ticket_number) bump('yellow', 'Missing ticket number');
  const rateMissing = load.driver_pay_type !== 'flat' && (load.rate == null || Number(load.rate) === 0);
  if (rateMissing && load.status !== 'draft') {
    bump(load.status === 'approved' ? 'red' : 'yellow', 'Rate not set');
  }
  return { level, detail: notes.length ? notes.join(' · ') : 'Active' };
}

function assessEquipment(item) {
  let level = 'green';
  const notes = [];
  const bump = (next, note) => {
    if (rankLevel(next) < rankLevel(level)) level = next;
    notes.push(note);
  };
  if (item.maintenance_status === 'out_of_service') bump('red', 'Out of service');
  else if (item.maintenance_status === 'maintenance') bump('yellow', 'In maintenance');
  if (item.registration_expiration) {
    const registrationLevel = getStatusClass(item.registration_expiration);
    if (registrationLevel === 'green') notes.push(`Registration active · ${item.registration_expiration}`);
    else bump(registrationLevel, `Registration ${getStatusText(item.registration_expiration).toLowerCase()} · ${item.registration_expiration}`);
  }
  if (item.inspection_expiration) {
    const inspectionLevel = getStatusClass(item.inspection_expiration);
    if (inspectionLevel === 'green') notes.push(`Inspection active · ${item.inspection_expiration}`);
    else bump(inspectionLevel, `Inspection ${getStatusText(item.inspection_expiration).toLowerCase()} · ${item.inspection_expiration}`);
  }
  if (!notes.length) notes.push('Active');
  return { level, detail: notes.join(' · ') };
}

function collectDriverLevels(driverId, hrefs) {
  const links = hrefs || {};
  const levels = [];
  const docs = db.prepare('SELECT * FROM driver_documents WHERE driver_id = ?').all(driverId);
  [['cdl', 'CDL License'], ['medical_card', 'Medical Card']].forEach(([kind, label]) => {
    const doc = docs.find((item) => item.doc_type === kind);
    const exp = doc ? doc.expiration_date : null;
    levels.push({
      level: getStatusClass(exp),
      name: label,
      detail: `${getStatusText(exp)}${exp ? ' · ' + exp : ''}`,
      href: links.docHref || ''
    });
  });

  if (links.documentsOnly) {
    levels.sort((a, b) => rankLevel(a.level) - rankLevel(b.level) || a.name.localeCompare(b.name));
    return levels;
  }

  const equipment = db.prepare(`
    SELECT DISTINCT e.*
    FROM loads l
    JOIN equipment e ON e.id = l.truck_id
    WHERE l.driver_id = ?
    ORDER BY e.number
  `).all(driverId);
  equipment.forEach((item) => {
    const assessed = assessEquipment(item);
    const label = `${item.type === 'trailer' ? 'Trailer' : 'Truck'} ${item.number || ''}`.trim();
    levels.push({
      level: assessed.level,
      name: label,
      detail: `Equipment · ${assessed.detail}`,
      href: links.equipHref || ''
    });
  });

  const loads = db.prepare(loadQuery + ' WHERE l.driver_id = ? ORDER BY l.load_date DESC, l.id DESC').all(driverId);
  const docMap = {};
  db.prepare('SELECT load_id, COUNT(*) AS n FROM documents GROUP BY load_id').all().forEach((row) => {
    docMap[row.load_id] = row.n;
  });
  loads.forEach((load) => {
    const assessed = assessLoad(load, (docMap[load.id] || 0) > 0);
    levels.push({
      level: assessed.level,
      name: load.ticket_number || `Load #${load.id}`,
      detail: `Load · ${assessed.detail}`,
      href: links.loadHref || ''
    });
  });

  levels.sort((a, b) => rankLevel(a.level) - rankLevel(b.level) || a.name.localeCompare(b.name));
  return levels;
}

function collectAlerts(user) {
  const alerts = [];
  const drivers = user.role === 'admin'
    ? db.prepare("SELECT id, name, email FROM users WHERE role = 'driver' AND (status IS NULL OR status = 'active') ORDER BY name").all()
    : db.prepare('SELECT id, name, email FROM users WHERE id = ?').all(user.id);
  const docsFor = db.prepare('SELECT * FROM driver_documents WHERE driver_id = ?');
  drivers.forEach((driver) => {
    const docs = docsFor.all(driver.id);
    [['cdl', 'CDL License'], ['medical_card', 'Medical Card']].forEach(([kind, label]) => {
      const doc = docs.find((item) => item.doc_type === kind);
      const exp = doc ? doc.expiration_date : null;
      const href = user.role === 'admin' ? `/drivers/${driver.id}` : '/profile';
      pushAlert(
        alerts,
        getStatusClass(exp),
        'Driver Document',
        `${driver.name || driver.email} — ${label}`,
        `${getStatusText(exp)}${exp ? ' · ' + exp : ''}`,
        href
      );
    });
  });

  if (user.role === 'admin') {
    db.prepare('SELECT * FROM compliance_items ORDER BY name').all().forEach((item) => {
      pushAlert(
        alerts,
        getStatusClass(item.expiration_date),
        'Compliance',
        item.name,
        `${getStatusText(item.expiration_date)}${item.expiration_date ? ' · ' + item.expiration_date : ''}`,
        '/compliance'
      );
    });
    db.prepare('SELECT * FROM equipment ORDER BY type, number').all().forEach((item) => {
      const label = `${item.type === 'trailer' ? 'Trailer' : 'Truck'} ${item.number || ''}`.trim();
      if (item.maintenance_status === 'out_of_service') {
        pushAlert(alerts, 'red', 'Equipment', label, 'Out of service', '/equipment');
      } else if (item.maintenance_status === 'maintenance') {
        pushAlert(alerts, 'yellow', 'Equipment', label, 'In maintenance', '/equipment');
      }
      if (item.registration_expiration) {
        pushAlert(
          alerts,
          getStatusClass(item.registration_expiration),
          'Equipment',
          `${label} registration`,
          `${getStatusText(item.registration_expiration)} · ${item.registration_expiration}`,
          '/equipment'
        );
      }
      if (item.inspection_expiration) {
        pushAlert(
          alerts,
          getStatusClass(item.inspection_expiration),
          'Equipment',
          `${label} inspection`,
          `${getStatusText(item.inspection_expiration)} · ${item.inspection_expiration}`,
          '/equipment'
        );
      }
    });
  }

  const loads = user.role === 'admin'
    ? db.prepare(loadQuery + ' ORDER BY l.created_at DESC').all()
    : db.prepare(loadQuery + ' WHERE l.driver_id = ? ORDER BY l.created_at DESC').all(user.id);
  const docMap = {};
  db.prepare('SELECT load_id, COUNT(*) AS n FROM documents GROUP BY load_id').all().forEach((row) => {
    docMap[row.load_id] = row.n;
  });
  loads.forEach((load) => {
    const href = `/loads/${load.id}`;
    const who = load.driver_name || 'Unassigned';
    const name = `Load #${load.id} (${who})`;
    const note = String(load.missing_info_note || '').trim();
    if (user.role === 'admin' && note) {
      pushAlert(alerts, 'red', 'Load', name, `Missing info flag: ${note}`, href);
    }
    if (load.status === 'draft') return;
    const hasFile = (docMap[load.id] || 0) > 0;
    if (user.role === 'admin' && load.status === 'submitted') {
      const gaps = submittedLoadGaps(load, hasFile);
      if (gaps.length) {
        const onlyTruck = gaps.length === 1 && gaps[0] === 'Truck';
        pushAlert(alerts, onlyTruck ? 'yellow' : 'red', 'Load', name, `Submitted load missing: ${gaps.join(', ')}`, href);
      } else {
        pushAlert(alerts, 'yellow', 'Load', name, 'Pending review', href);
      }
      return;
    }
    const title = load.ticket_number || name;
    if (!hasFile && !load.ticket_number) {
      pushAlert(alerts, 'red', 'Load', title, 'Missing ticket number and ticket file', href);
    } else if (!hasFile) {
      pushAlert(alerts, 'yellow', 'Load', title, 'Missing ticket file', href);
    } else if (!load.ticket_number) {
      pushAlert(alerts, 'yellow', 'Load', title, 'Missing ticket number', href);
    }
    const rateMissing = load.driver_pay_type !== 'flat' && (load.rate == null || Number(load.rate) === 0);
    if (rateMissing && load.status !== 'draft') {
      pushAlert(alerts, load.status === 'approved' ? 'red' : 'yellow', 'Load', title, 'Rate not set', href);
    }
  });

  alerts.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'red' ? -1 : 1;
    return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
  });
  return {
    alerts,
    redCount: alerts.filter((item) => item.level === 'red').length,
    yellowCount: alerts.filter((item) => item.level === 'yellow').length
  };
}

function renderDashboard(req, res) {
  if (!req.session.user) return res.render('login');
  if (req.session.user.must_change_password) return res.redirect('/change-password');
  if (req.session.user.role === 'driver') {
    const levels = collectDriverLevels(req.session.user.id, { docHref: '/profile', documentsOnly: true });
    const grouped = driverWeekGroups(req.session.user.id);
    return res.render('dashboard', {
      user: req.session.user,
      levels,
      redCount: levels.filter((item) => item.level === 'red').length,
      yellowCount: levels.filter((item) => item.level === 'yellow').length,
      greenCount: levels.filter((item) => item.level === 'green').length,
      weekGroups: grouped.weeks,
      undatedLoads: grouped.undated
    });
  }
  const attention = collectAlerts(req.session.user);
  res.render('dashboard', { user: req.session.user, ...attention });
}

app.get('/', renderDashboard);
app.get('/dashboard', renderDashboard);

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login');
});

app.post('/login', (req, res) => {
  const email = loginEmail(req.body.email || '');
  const password = (req.body.password || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))').get(email);
  if (user && password && bcrypt.compareSync(password, user.password)) {
    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      must_change_password: user.must_change_password
    };
    if (user.must_change_password) {
      return res.redirect('/change-password');
    }
    res.redirect('/');
  } else {
    res.render('login', { error: 'Invalid credentials' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Middleware to require login and handle forced password change
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  if (req.session.user.must_change_password && req.path !== '/change-password') {
    return res.redirect('/change-password');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  if (req.session.user.must_change_password && req.path !== '/change-password') {
    return res.redirect('/change-password');
  }
  if (req.session.user.role !== 'admin') return res.redirect('/');
  next();
}

app.get('/change-password', requireAuth, (req, res) => {
  res.render('change-password', { user: req.session.user });
});

app.post('/change-password', requireAuth, (req, res) => {
  const bcrypt = require('bcryptjs');
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.render('change-password', { user: req.session.user, error: 'Password must be at least 6 characters' });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password = ?, must_change_password = 0, temp_password = NULL WHERE id = ?').run(hash, req.session.user.id);
  req.session.user.must_change_password = 0;
  res.redirect('/');
});

// Customers and projects (admin)
app.get('/customers', requireAdmin, (req, res) => {
  const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
  const projects = db.prepare('SELECT * FROM projects ORDER BY display_name').all();
  const projectsByCustomer = {};
  projects.forEach((project) => {
    if (!projectsByCustomer[project.customer_id]) projectsByCustomer[project.customer_id] = [];
    projectsByCustomer[project.customer_id].push(project);
  });
  res.render('customers', { user: req.session.user, customers, projectsByCustomer });
});

app.get('/customers/new', requireAdmin, (req, res) => {
  res.render('customer-form', { user: req.session.user, customer: { terms: 'Net 30', status: 'active' } });
});

app.post('/customers', requireAdmin, (req, res) => {
  const customer = readCustomer(req.body);
  if (!customer.name) {
    return res.status(400).render('customer-form', { user: req.session.user, customer, error: 'Customer name is required' });
  }
  const result = db.prepare(`
    INSERT INTO customers (name, address_line1, address_line2, poc_name, poc_phone, poc_email, terms, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customer.name, customer.address_line1, customer.address_line2, customer.poc_name, customer.poc_phone, customer.poc_email, customer.terms, customer.status);
  res.redirect('/customers/' + result.lastInsertRowid);
});

app.get('/customers/:id', requireAdmin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/customers');
  const projects = db.prepare('SELECT * FROM projects WHERE customer_id = ? ORDER BY project_name').all(customer.id);
  res.render('customer-detail', { user: req.session.user, customer, projects });
});

app.get('/customers/:id/edit', requireAdmin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/customers');
  res.render('customer-form', { user: req.session.user, customer });
});

app.post('/customers/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.redirect('/customers');
  const customer = { ...readCustomer(req.body, existing), id: existing.id };
  if (!customer.name) {
    return res.status(400).render('customer-form', { user: req.session.user, customer, error: 'Customer name is required' });
  }
  db.prepare(`
    UPDATE customers
    SET name = ?, address_line1 = ?, address_line2 = ?, poc_name = ?, poc_phone = ?, poc_email = ?, terms = ?, status = ?
    WHERE id = ?
  `).run(customer.name, customer.address_line1, customer.address_line2, customer.poc_name, customer.poc_phone, customer.poc_email, customer.terms, customer.status, existing.id);
  refreshProjectDisplayNames(existing.id);
  res.redirect('/customers/' + existing.id);
});

app.post('/customers/:id/projects', requireAdmin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/customers');
  const parsed = readProject(req.body, customer);
  const projects = db.prepare('SELECT * FROM projects WHERE customer_id = ? ORDER BY project_name').all(customer.id);
  if (parsed.error) {
    return res.status(400).render('customer-detail', {
      user: req.session.user,
      customer,
      projects,
      error: parsed.error,
      draft: req.body
    });
  }
  db.prepare(`
    INSERT INTO projects (
      customer_id, project_name, display_name, default_rate, has_fuel_surcharge,
      has_drive_time, default_drive_time_amount, default_driver_pay_type, default_driver_flat_rate, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customer.id, parsed.projectName, parsed.displayName, parsed.defaultRate, parsed.hasFuel, parsed.hasDrive, parsed.driveAmount, parsed.payType, parsed.flatRate, parsed.status);
  res.redirect('/customers/' + customer.id);
});

app.get('/projects', requireAdmin, (req, res) => {
  const projects = db.prepare(`
    SELECT p.*, c.name as customer_name
    FROM projects p
    JOIN customers c ON c.id = p.customer_id
    ORDER BY c.name, p.project_name
  `).all();
  res.render('projects', { user: req.session.user, projects });
});

app.get('/projects/new', requireAdmin, (req, res) => {
  const customers = db.prepare("SELECT id, name FROM customers WHERE status = 'active' ORDER BY name").all();
  const project = { customer_id: req.query.customer_id || '', default_rate: '', status: 'active' };
  res.render('project-form', { user: req.session.user, project, customers });
});

app.post('/projects', requireAdmin, (req, res) => {
  const customers = db.prepare("SELECT id, name FROM customers WHERE status = 'active' ORDER BY name").all();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.body.customer_id);
  if (!customer) {
    return res.status(400).render('project-form', {
      user: req.session.user,
      project: req.body,
      customers,
      error: 'Select a customer'
    });
  }
  const parsed = readProject(req.body, customer);
  if (parsed.error) {
    return res.status(400).render('project-form', {
      user: req.session.user,
      project: { ...req.body, customer_id: customer.id },
      customers,
      error: parsed.error
    });
  }
  db.prepare(`
    INSERT INTO projects (
      customer_id, project_name, display_name, default_rate, has_fuel_surcharge,
      has_drive_time, default_drive_time_amount, default_driver_pay_type, default_driver_flat_rate, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customer.id, parsed.projectName, parsed.displayName, parsed.defaultRate, parsed.hasFuel, parsed.hasDrive, parsed.driveAmount, parsed.payType, parsed.flatRate, parsed.status);
  res.redirect('/customers/' + customer.id);
});

app.get('/projects/:id/edit', requireAdmin, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.redirect('/projects');
  const customers = db.prepare('SELECT id, name FROM customers ORDER BY name').all();
  res.render('project-form', { user: req.session.user, project, customers });
});

app.post('/projects/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.redirect('/projects');
  const customers = db.prepare('SELECT id, name FROM customers ORDER BY name').all();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.body.customer_id || existing.customer_id);
  if (!customer) {
    return res.status(400).render('project-form', {
      user: req.session.user,
      project: { ...existing, ...req.body },
      customers,
      error: 'Select a customer'
    });
  }
  const parsed = readProject(req.body, customer, existing);
  if (parsed.error) {
    return res.status(400).render('project-form', {
      user: req.session.user,
      project: { ...existing, ...req.body, id: existing.id },
      customers,
      error: parsed.error
    });
  }
  db.prepare(`
    UPDATE projects
    SET customer_id = ?, project_name = ?, display_name = ?, default_rate = ?,
        has_fuel_surcharge = ?, has_drive_time = ?, default_drive_time_amount = ?,
        default_driver_pay_type = ?, default_driver_flat_rate = ?, status = ?
    WHERE id = ?
  `).run(customer.id, parsed.projectName, parsed.displayName, parsed.defaultRate, parsed.hasFuel, parsed.hasDrive, parsed.driveAmount, parsed.payType, parsed.flatRate, parsed.status, existing.id);
  res.redirect('/customers/' + customer.id);
});

// Loads routes
function ticketRows(loadId) {
  return db.prepare('SELECT id, load_id, filename, original_name, category FROM documents WHERE load_id = ? ORDER BY id').all(loadId);
}

function attachTickets(loads) {
  const files = db.prepare('SELECT id, load_id, filename, original_name FROM documents ORDER BY id').all();
  const byLoad = {};
  files.forEach((file) => {
    if (!byLoad[file.load_id]) byLoad[file.load_id] = [];
    byLoad[file.load_id].push(file);
  });
  loads.forEach((load) => {
    load.tickets = byLoad[load.id] || [];
  });
  return loads;
}

function canViewLoad(req, load) {
  if (!req.session.user || !load) return false;
  if (req.session.user.role === 'admin') return true;
  return String(load.driver_id) === String(req.session.user.id);
}

function fileContentType(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  return types[ext] || 'application/octet-stream';
}

function safeDownloadName(name) {
  return String(name || 'ticket').replace(/[\r\n"]/g, '') || 'ticket';
}

function storedTicketPath(file) {
  if (!file || !file.filename) return null;
  const root = path.resolve(uploadDir);
  const full = path.resolve(root, path.basename(file.filename));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function removeStoredTicket(file) {
  if (!file) return;
  const full = storedTicketPath(file);
  db.prepare('DELETE FROM documents WHERE id = ?').run(file.id);
  if (full && fs.existsSync(full)) fs.unlinkSync(full);
}

function removeSelectedTickets(loadId, body) {
  const raw = body.remove_tickets;
  const ids = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  ids.forEach((id) => {
    const file = db.prepare('SELECT * FROM documents WHERE id = ? AND load_id = ?').get(id, loadId);
    if (file) removeStoredTicket(file);
  });
}

app.get('/loads', requireAuth, (req, res) => {
  if (req.session.user.role === 'driver') {
    const grouped = driverWeekGroups(req.session.user.id);
    return res.render('loads', {
      user: req.session.user,
      loads: [],
      weekGroups: grouped.weeks,
      undatedLoads: grouped.undated,
      deleted: req.query.deleted === '1'
    });
  }
  const loads = attachTickets(db.prepare(loadQuery + ' ORDER BY l.created_at DESC').all()).map(annotatePay);
  res.render('loads', { user: req.session.user, loads, weekGroups: [], undatedLoads: null, deleted: req.query.deleted === '1' });
});

app.post('/loads/:id/approve', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/loads');
  const result = db.prepare(`
    UPDATE loads
    SET status = 'approved', approved_by = ?, approved_by_name = ?, approved_at = CURRENT_TIMESTAMP,
        rejection_reason = NULL, rejected_by = NULL, rejected_by_name = NULL, rejected_at = NULL
    WHERE id = ? AND status = 'submitted'
  `).run(req.session.user.id, actorName(req), req.params.id);
  if (result.changes) logAudit(req, 'Approved', 'load', req.params.id, 'Load approved');
  res.redirect(`/loads/${req.params.id}${result.changes ? '?saved=approved' : ''}`);
});

app.post('/loads/:id/reject', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/loads');
  const reason = String(req.body.rejection_reason || '').trim();
  const result = db.prepare(`
    UPDATE loads
    SET status = 'draft', rejection_reason = ?, approved_by = NULL, approved_by_name = NULL, approved_at = NULL,
        settlement_status = NULL, rejected_by = ?, rejected_by_name = ?, rejected_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('submitted', 'approved')
  `).run(reason || null, req.session.user.id, actorName(req), req.params.id);
  if (result.changes) logAudit(req, 'Rejected', 'load', req.params.id, reason || 'Sent back to draft');
  res.redirect(`/loads/${req.params.id}${result.changes ? '?saved=rejected' : ''}`);
});

app.post('/loads/:id/delete', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/loads');
  const load = db.prepare('SELECT id FROM loads WHERE id = ?').get(req.params.id);
  if (!load) return res.redirect('/loads');
  ticketRows(load.id).forEach((file) => removeStoredTicket(file));
  db.prepare('DELETE FROM documents WHERE load_id = ?').run(load.id);
  db.prepare('DELETE FROM loads WHERE id = ?').run(load.id);
  res.redirect('/loads?deleted=1');
});

app.get('/loads/:id/files/:fileId', requireAuth, (req, res) => {
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.id);
  if (!canViewLoad(req, load)) return res.status(404).send('Not found');
  const file = db.prepare('SELECT * FROM documents WHERE id = ? AND load_id = ?').get(req.params.fileId, load.id);
  if (!file) return res.status(404).send('Not found');
  const download = req.query.download === '1' || ticketFileKind(file.original_name || file.filename) === 'file';
  res.setHeader('Content-Type', fileContentType(file.original_name || file.filename));
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${safeDownloadName(file.original_name || file.filename)}"`);
  const full = storedTicketPath(file);
  if (full && fs.existsSync(full)) return res.sendFile(full);
  if (file.file_blob) return res.send(Buffer.isBuffer(file.file_blob) ? file.file_blob : Buffer.from(file.file_blob));
  return res.status(404).send('Not found');
});

function findActiveProject(projectId) {
  const id = parseInt(projectId, 10);
  if (!Number.isInteger(id)) return null;
  return db.prepare(`
    SELECT p.*
    FROM projects p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.id = ? AND p.status = 'active' AND c.status = 'active'
  `).get(id) || null;
}

function buildLoadValues(req, project, existing) {
  const body = req.body || {};
  const isDriver = req.session.user.role === 'driver';
  let rate;
  if (!bodyHas(body, 'rate') || String(body.rate).trim() === '') {
    if (existing && existing.rate != null && existing.rate !== '') rate = Number(existing.rate) || 0;
    else rate = project ? (Number(project.default_rate) || 0) : 0;
  } else {
    rate = parseFloat(body.rate);
    if (!Number.isFinite(rate)) {
      if (existing && existing.rate != null && existing.rate !== '') rate = Number(existing.rate) || 0;
      else rate = project ? (Number(project.default_rate) || 0) : 0;
    }
  }

  let hasFuel;
  if (isDriver) {
    if (existing && existing.has_fuel_surcharge != null && existing.has_fuel_surcharge !== '') {
      hasFuel = Number(existing.has_fuel_surcharge) ? 1 : 0;
    } else {
      hasFuel = project && project.has_fuel_surcharge ? 1 : 0;
    }
  } else if (!bodyHas(body, 'has_fuel_surcharge') && existing && !Object.prototype.hasOwnProperty.call(body, 'action')) {
    hasFuel = Number(existing.has_fuel_surcharge) ? 1 : 0;
  } else {
    hasFuel = flagValue(body.has_fuel_surcharge) ? 1 : 0;
  }

  const hasDrive = flagValue(body.has_drive_time) ? 1 : 0;
  const hasSelf = flagValue(body.has_self_load) ? 1 : 0;
  let driveAmount = parseFloat(body.drive_time_amount);
  if (!hasDrive) driveAmount = 0;
  else if (!Number.isFinite(driveAmount)) {
    if (existing && existing.drive_time_amount != null) driveAmount = Number(existing.drive_time_amount) || 0;
    else driveAmount = project ? (Number(project.default_drive_time_amount) || 0) : 0;
  }
  let selfAmount = parseFloat(body.self_load_amount);
  if (!hasSelf) selfAmount = 0;
  else if (!Number.isFinite(selfAmount) || selfAmount === 0) {
    if (existing && Number(existing.self_load_amount) > 0) selfAmount = Number(existing.self_load_amount);
    else selfAmount = 20;
  }

  let weight = existing ? existing.weight_quantity : null;
  if (bodyHas(body, 'weight_quantity') && String(body.weight_quantity).trim() !== '') {
    const parsed = parseFloat(body.weight_quantity);
    if (Number.isFinite(parsed)) weight = parsed;
  }

  let payType = 'percentage';
  if (!isDriver && bodyHas(body, 'driver_pay_type')) {
    payType = body.driver_pay_type === 'flat' ? 'flat' : 'percentage';
  } else if (existing && existing.driver_pay_type) {
    payType = existing.driver_pay_type === 'flat' ? 'flat' : 'percentage';
  } else if (project && project.default_driver_pay_type === 'flat') {
    payType = 'flat';
  }
  let flatRate = 0;
  if (!isDriver && bodyHas(body, 'driver_flat_rate')) {
    const parsed = parseFloat(body.driver_flat_rate);
    flatRate = Number.isFinite(parsed) ? parsed : (existing ? (Number(existing.driver_flat_rate) || 0) : 0);
  } else if (existing && existing.driver_flat_rate != null) {
    flatRate = Number(existing.driver_flat_rate) || 0;
  } else if (project && project.default_driver_flat_rate != null) {
    flatRate = Number(project.default_driver_flat_rate) || 0;
  }
  if (payType === 'flat' && (weight == null || weight === '')) weight = 1;

  const driverId = isDriver
    ? ((existing && existing.driver_id) || req.session.user.id)
    : (bodyHas(body, 'driver_id') ? (body.driver_id || null) : (existing ? existing.driver_id : null));

  let truckId = existing ? existing.truck_id : null;
  if (bodyHas(body, 'truck_id')) {
    const parsed = parseInt(body.truck_id, 10);
    const truck = Number.isInteger(parsed)
      ? db.prepare("SELECT id FROM equipment WHERE id = ? AND type = 'truck'").get(parsed)
      : null;
    truckId = truck ? truck.id : null;
  }

  let projectId = existing ? existing.project_id : null;
  if (bodyHas(body, 'project_id')) {
    if (project) projectId = project.id;
    else if (!(existing && String(existing.project_id) === String(body.project_id))) projectId = null;
  }

  return {
    ticket_number: keptText(body, 'ticket_number', existing),
    load_date: keptText(body, 'load_date', existing),
    driver_id: driverId || null,
    truck_id: truckId,
    project_id: projectId,
    description: keptText(body, 'description', existing),
    origin: keptText(body, 'origin', existing),
    destination: keptText(body, 'destination', existing),
    notes: keptText(body, 'notes', existing),
    weight: weight == null || weight === '' ? null : weight,
    rate,
    hasFuel,
    hasDrive,
    driveAmount,
    hasSelf,
    selfAmount,
    payType,
    flatRate,
    status: body.action === 'draft' ? 'draft' : 'submitted'
  };
}

function backfillDocumentBlobs() {
  const rows = db.prepare('SELECT id, filename, file_blob FROM documents').all();
  const update = db.prepare('UPDATE documents SET file_blob = ? WHERE id = ?');
  rows.forEach((row) => {
    if (row.file_blob) return;
    const full = storedTicketPath(row);
    if (full && fs.existsSync(full)) update.run(fs.readFileSync(full), row.id);
  });
}

function saveTicketFiles(loadId, files, userId) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return;
  const insertDoc = db.prepare(`
    INSERT INTO documents (load_id, filename, original_name, category, uploaded_by, file_blob)
    VALUES (?, ?, ?, 'load_document', ?, ?)
  `);
  list.forEach((file) => {
    if (!file || !file.filename) return;
    const full = path.join(uploadDir, path.basename(file.filename));
    const bytes = fs.existsSync(full) ? fs.readFileSync(full) : null;
    insertDoc.run(loadId, file.filename, file.originalname, userId, bytes);
  });
}

function editableLoad(req, id) {
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
  if (!load) return null;
  if (req.session.user.role === 'admin') return load;
  if (load.status !== 'draft') return null;
  if (String(load.driver_id) !== String(req.session.user.id)) return null;
  return load;
}

function renderLoadForm(req, res, status, load, error) {
  const form = loadFormData(req.session.user, load);
  const tickets = load && load.id ? ticketRows(load.id) : [];
  return res.status(status).render('load-form', {
    user: req.session.user,
    load,
    tickets,
    error,
    ...form
  });
}

app.get('/loads/new', requireAuth, (req, res) => {
  const form = loadFormData(req.session.user);
  res.render('load-form', { user: req.session.user, load: {}, tickets: [], ...form });
});

app.get('/loads/:id/edit', requireAuth, (req, res) => {
  const existing = editableLoad(req, req.params.id);
  if (!existing) return res.redirect('/loads');
  const load = db.prepare(loadQuery + ' WHERE l.id = ?').get(existing.id);
  const form = loadFormData(req.session.user, load);
  res.render('load-form', { user: req.session.user, load, tickets: ticketRows(existing.id), ...form });
});

app.get('/loads/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.id);
  if (!canViewLoad(req, existing)) return res.redirect('/loads');
  const load = annotatePay(db.prepare(loadQuery + ' WHERE l.id = ?').get(existing.id));
  const form = loadFormData(req.session.user, load);
  if (load.project_id && !form.projects.some((project) => String(project.id) === String(load.project_id))) {
    const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(load.project_id);
    if (current) form.projects = [current].concat(form.projects);
  }
  res.render('load-review', {
    user: req.session.user,
    load,
    tickets: ticketRows(load.id),
    audit: loadAudit(load.id),
    saved: req.query.saved || '',
    ...form
  });
});

function loadFormErrorView(req, existing) {
  const action = req.body.action || 'submit';
  let entryMode = existing ? existing.entry_mode : '';
  if (action === 'draft' && req.session.user.role === 'admin') entryMode = 'assigned';
  else if (action === 'submit' || action === 'approve') entryMode = req.session.user.role === 'admin' ? 'entered' : (existing && existing.entry_mode ? existing.entry_mode : 'driver');
  return Object.assign({}, existing || {}, req.body, {
    id: existing ? existing.id : undefined,
    status: existing ? existing.status : undefined,
    entry_mode: entryMode
  });
}

function stampLoadApproval(loadId, req, entry) {
  if (!entry.approveNow) return;
  db.prepare(`
    UPDATE loads
    SET approved_by = ?, approved_by_name = ?, approved_at = CURRENT_TIMESTAMP, rejection_reason = NULL
    WHERE id = ?
  `).run(req.session.user.id, actorName(req), loadId);
}

app.post('/loads', requireAuth, upload.array('tickets', 10), (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const entry = resolveLoadEntry(req, null);
  const project = findActiveProject(req.body.project_id);
  const values = buildLoadValues(req, project);
  values.status = entry.status;
  if (isAdmin && !values.driver_id) {
    return renderLoadForm(req, res, 400, loadFormErrorView(req), 'Select a driver');
  }
  if (!project && req.body.action !== 'draft') {
    return renderLoadForm(req, res, 400, loadFormErrorView(req), 'Select an active project');
  }
  const result = db.prepare(`
    INSERT INTO loads (
      ticket_number, load_date, driver_id, truck_id, project_id, description, origin, destination, notes, weight_quantity,
      rate, has_fuel_surcharge, has_drive_time, drive_time_amount, has_self_load, self_load_amount,
      driver_pay_type, driver_flat_rate,
      status, submitted_by, created_by_role, entry_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.ticket_number,
    values.load_date,
    values.driver_id,
    values.truck_id,
    values.project_id,
    values.description,
    values.origin,
    values.destination,
    values.notes,
    values.weight,
    values.rate,
    values.hasFuel,
    values.hasDrive,
    values.driveAmount,
    values.hasSelf,
    values.selfAmount,
    values.payType,
    values.flatRate,
    entry.status,
    req.session.user.id,
    entry.createdByRole,
    entry.entryMode
  );
  stampLoadApproval(result.lastInsertRowid, req, entry);
  saveTicketFiles(result.lastInsertRowid, req.files, req.session.user.id);
  logAudit(req, entry.auditAction, 'load', result.lastInsertRowid, entry.auditDetail);
  res.redirect(isAdmin ? `/loads/${result.lastInsertRowid}` : '/loads');
});

app.post('/loads/:id', requireAuth, upload.array('tickets', 10), (req, res) => {
  const existing = editableLoad(req, req.params.id);
  if (!existing) return res.redirect('/loads');
  const isAdmin = req.session.user.role === 'admin';
  const entry = resolveLoadEntry(req, existing);
  const project = findActiveProject(req.body.project_id);
  if (isAdmin && req.body.action !== 'save' && !buildLoadValues(req, project, existing).driver_id) {
    return renderLoadForm(req, res, 400, loadFormErrorView(req, existing), 'Select a driver');
  }
  if (!project && req.body.action !== 'draft' && !(isAdmin && req.body.action === 'save')) {
    return renderLoadForm(req, res, 400, loadFormErrorView(req, existing), 'Select an active project');
  }
  const values = buildLoadValues(req, project, existing);
  const rejectionReason = entry.status === 'submitted' || entry.status === 'approved' ? null : (existing.rejection_reason || null);
  db.prepare(`
    UPDATE loads
    SET ticket_number = ?, load_date = ?, driver_id = ?, truck_id = ?, project_id = ?, description = ?,
        origin = ?, destination = ?, notes = ?,
        weight_quantity = ?, rate = ?, has_fuel_surcharge = ?, has_drive_time = ?, drive_time_amount = ?,
        has_self_load = ?, self_load_amount = ?, driver_pay_type = ?, driver_flat_rate = ?, status = ?, rejection_reason = ?,
        created_by_role = ?, entry_mode = ?,
        updated_by = ?, updated_by_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? ${isAdmin ? '' : "AND status = 'draft'"}
  `).run(
    values.ticket_number,
    values.load_date,
    values.driver_id,
    values.truck_id,
    values.project_id,
    values.description,
    values.origin,
    values.destination,
    values.notes,
    values.weight,
    values.rate,
    values.hasFuel,
    values.hasDrive,
    values.driveAmount,
    values.hasSelf,
    values.selfAmount,
    values.payType,
    values.flatRate,
    entry.status,
    rejectionReason,
    entry.createdByRole,
    entry.entryMode,
    req.session.user.id,
    actorName(req),
    existing.id
  );
  stampLoadApproval(existing.id, req, entry);
  removeSelectedTickets(existing.id, req.body);
  saveTicketFiles(existing.id, req.files, req.session.user.id);
  logAudit(req, entry.auditAction, 'load', existing.id, entry.auditDetail);
  res.redirect(isAdmin ? `/loads/${existing.id}?saved=edited` : '/loads');
});

app.post('/loads/:id/missing-info', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/loads');
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.id);
  if (!load) return res.redirect('/loads');
  const note = String(req.body.missing_info_note || '').trim();
  db.prepare(`
    UPDATE loads
    SET missing_info_note = ?, updated_by = ?, updated_by_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(note || null, req.session.user.id, actorName(req), load.id);
  logAudit(req, note ? 'Missing info flag' : 'Cleared missing info flag', 'load', load.id, note || 'Cleared');
  res.redirect(`/loads/${load.id}?saved=flag`);
});

// Admin: Drivers management
app.get('/drivers', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const drivers = db.prepare("SELECT id, name, first_name, last_name, email, phone, address, city, state, zip, pay_percentage, status, created_at FROM users WHERE role = 'driver' ORDER BY name").all();
  drivers.forEach((driver) => {
    const place = [driver.city, [driver.state, driver.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    driver.addressLine = [driver.address, place].filter(Boolean).join(', ');
    driver.levels = collectDriverLevels(driver.id, { docHref: `/drivers/${driver.id}`, loadHref: '/loads', equipHref: '/equipment' });
  });
  res.render('drivers', { user: req.session.user, drivers, notifications: notificationStatus() });
});

app.get('/drivers/new', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  res.render('driver-form', { user: req.session.user });
});

const APP_URL = 'https://dt1-tms.onrender.com';

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function buildWelcomeEmail({ name, email, tempPassword, phone }) {
  const subject = 'Welcome to DT1 Logistics';
  const text = [
    `Hi ${name},`,
    '',
    'Welcome to DT1 Logistics. Your driver account is ready.',
    '',
    `App: ${APP_URL}`,
    `Login email: ${email}`,
    `Temporary password: ${tempPassword}`,
    '',
    "You'll be prompted to set your own password the first time you sign in.",
    '',
    'Save the DT1 Logistics App to Your Phone (One-Tap Access)',
    '',
    'iPhone (Safari):',
    `1. Open ${APP_URL} in Safari.`,
    '2. Tap the Share icon (the square with an arrow pointing up at the bottom of the screen).',
    '3. Scroll down and tap Add to Home Screen, then tap Add.',
    '4. Now the DT1 Logistics app icon is on your phone screen—just tap the app anytime to open it!',
    '',
    'iPhone (Chrome):',
    `1. Open ${APP_URL} in Chrome.`,
    '2. Tap the Share icon (the square with an arrow pointing up in the top-right address bar).',
    '3. Scroll down and tap Add to Home Screen, then tap Add.',
    '4. Now the DT1 Logistics app icon is on your phone screen—just tap the app anytime to open it!',
    '',
    'Android (Chrome):',
    `1. Open ${APP_URL} in Chrome.`,
    '2. Tap the three-dot menu (⋮) in the top-right corner.',
    '3. Tap Add to Home screen (or Install app), then tap Add.',
    '4. Now the DT1 Logistics app icon is on your phone screen—just tap the app anytime to open it!',
    '',
    '— DT1 Logistics'
  ].join('\n');
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePassword = escapeHtml(tempPassword);
  const html = `
    <p>Hi ${safeName},</p>
    <p>Welcome to DT1 Logistics. Your driver account is ready.</p>
    <p><strong>App:</strong> <a href="${APP_URL}">${APP_URL}</a><br>
    <strong>Login email:</strong> ${safeEmail}<br>
    <strong>Temporary password:</strong> ${safePassword}</p>
    <p>You'll be prompted to set your own password the first time you sign in.</p>
    <h2>Save the DT1 Logistics App to Your Phone (One-Tap Access)</h2>
    <p><strong>iPhone (Safari):</strong></p>
    <ol>
      <li>Open <a href="${APP_URL}">${APP_URL}</a> in <strong>Safari</strong>.</li>
      <li>Tap the <strong>Share</strong> icon (the square with an arrow pointing up at the bottom of the screen).</li>
      <li>Scroll down and tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
      <li>Now the <strong>DT1 Logistics</strong> app icon is on your phone screen—just tap the app anytime to open it!</li>
    </ol>
    <p><strong>iPhone (Chrome):</strong></p>
    <ol>
      <li>Open <a href="${APP_URL}">${APP_URL}</a> in <strong>Chrome</strong>.</li>
      <li>Tap the <strong>Share</strong> icon (the square with an arrow pointing up in the top-right address bar).</li>
      <li>Scroll down and tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
      <li>Now the <strong>DT1 Logistics</strong> app icon is on your phone screen—just tap the app anytime to open it!</li>
    </ol>
    <p><strong>Android (Chrome):</strong></p>
    <ol>
      <li>Open <a href="${APP_URL}">${APP_URL}</a> in <strong>Chrome</strong>.</li>
      <li>Tap the <strong>three-dot menu (⋮)</strong> in the top-right corner.</li>
      <li>Tap <strong>Add to Home screen</strong> (or <strong>Install app</strong>), then tap <strong>Add</strong>.</li>
      <li>Now the <strong>DT1 Logistics</strong> app icon is on your phone screen—just tap the app anytime to open it!</li>
    </ol>
    <p>— DT1 Logistics</p>
  `;
  const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  const smsText = buildWelcomeSms({ name, email, tempPassword });
  return {
    subject,
    text,
    html,
    mailto,
    to: email,
    phone: phone || '',
    copyText: `Subject: ${subject}\n\n${text}`,
    smsText,
    smsHref: smsHref(phone, smsText)
  };
}

function buildWelcomeSms({ name, email, tempPassword }) {
  return [
    `Hi ${name}, welcome to DT1 Logistics.`,
    `App: ${APP_URL}`,
    `Login: ${email}`,
    `Temp password: ${tempPassword}`,
    `iPhone (Safari): Open ${APP_URL} in Safari -> tap the Share icon (square with arrow pointing up at the bottom) -> scroll down and tap Add to Home Screen -> tap Add.`,
    `iPhone (Chrome): Open ${APP_URL} in Chrome -> tap the Share icon (square with arrow pointing up in the top-right address bar) -> scroll down and tap Add to Home Screen -> tap Add.`,
    `Android (Chrome): Open ${APP_URL} in Chrome -> tap the three-dot menu (⋮) in the top-right corner -> tap Add to Home screen (or Install app) -> tap Add.`
  ].join('\n');
}

function smsAddress(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 8) return `+${digits}`;
  return '';
}

function smsHref(phone, body) {
  const address = smsAddress(phone);
  const encoded = encodeURIComponent(body || '');
  return address ? `sms:${address}?&body=${encoded}` : `sms:?&body=${encoded}`;
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function twilioConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

function smsGatewayDomain() {
  return String(process.env.SMS_GATEWAY_DOMAIN || '').trim().replace(/^@/, '');
}

function notificationStatus() {
  const gateway = smsGatewayDomain();
  return {
    email: smtpConfigured(),
    sms: twilioConfigured() || Boolean(gateway && smtpConfigured()),
    twilio: twilioConfigured(),
    gateway: Boolean(gateway && smtpConfigured())
  };
}

async function deliverWelcomeEmail(welcome) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return { sent: false, smtpConfigured: false, smtpError: false };
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: { user, pass }
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || user,
    to: welcome.to,
    subject: welcome.subject,
    text: welcome.text,
    html: welcome.html
  });
  return { sent: true, smtpConfigured: true, smtpError: false };
}

function gatewayPhone(phone) {
  const digits = smsAddress(phone).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

async function deliverSmsGateway(phone, body) {
  const domain = smsGatewayDomain();
  if (!domain || !smtpConfigured()) return { attempted: false, sent: false };
  const local = gatewayPhone(phone);
  if (!local) return { attempted: true, sent: false };
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: `${local}@${domain}`,
    subject: 'DT1 Logistics',
    text: body
  });
  return { attempted: true, sent: true };
}

async function deliverWelcomeSms(welcome, phone) {
  const body = welcome && welcome.smsText ? welcome.smsText : '';
  const target = phone || (welcome && welcome.phone) || '';
  const twilioOn = twilioConfigured();
  const gatewayOn = Boolean(smsGatewayDomain() && smtpConfigured());
  if (!twilioOn && !gatewayOn) {
    return { smsSent: false, smsConfigured: false, smsError: false, smsStatus: 'Not configured' };
  }
  const to = smsAddress(target);
  if (!to) {
    return { smsSent: false, smsConfigured: true, smsError: true, smsStatus: 'No phone number on file' };
  }
  let twilioSent = false;
  let gatewaySent = false;
  let failed = false;
  if (twilioOn) {
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const params = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER, Body: body });
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });
      if (!response.ok) {
        const text = await response.text();
        console.error('Welcome SMS failed:', response.status, text.slice(0, 300));
        failed = true;
      } else {
        twilioSent = true;
      }
    } catch (err) {
      console.error('Welcome SMS failed:', err.message);
      failed = true;
    }
  }
  if (gatewayOn) {
    try {
      const gateway = await deliverSmsGateway(target, body);
      gatewaySent = gateway.sent;
      if (gateway.attempted && !gateway.sent) failed = true;
    } catch (err) {
      console.error('Welcome SMS gateway failed:', err.message);
      failed = true;
    }
  }
  const smsSent = twilioSent || gatewaySent;
  let smsStatus = 'Not sent';
  if (twilioSent && gatewaySent) smsStatus = 'Sent via Twilio and email gateway';
  else if (twilioSent) smsStatus = 'Sent via Twilio';
  else if (gatewaySent) smsStatus = 'Sent via email gateway';
  else if (failed) smsStatus = 'Could not send';
  return { smsSent, smsConfigured: true, smsError: !smsSent, smsStatus };
}

async function deliverWelcome(welcome, phone, channel) {
  const mode = channel === 'email' || channel === 'sms' ? channel : 'both';
  const result = {
    sent: false,
    smtpConfigured: notificationStatus().email,
    smtpError: false,
    emailAttempted: mode !== 'sms',
    smsSent: false,
    smsConfigured: notificationStatus().sms,
    smsError: false,
    smsStatus: 'Not sent',
    smsAttempted: mode !== 'email'
  };
  if (result.emailAttempted) {
    try {
      Object.assign(result, await deliverWelcomeEmail(welcome), { emailAttempted: true });
    } catch (err) {
      console.error('Welcome email failed:', err.message);
      result.sent = false;
      result.smtpConfigured = true;
      result.smtpError = true;
    }
  }
  if (result.smsAttempted) {
    try {
      Object.assign(result, await deliverWelcomeSms(welcome, phone), { smsAttempted: true });
    } catch (err) {
      console.error('Welcome SMS failed:', err.message);
      result.smsSent = false;
      result.smsConfigured = true;
      result.smsError = true;
      result.smsAttempted = true;
    }
  }
  return result;
}

const COMM_PRESETS = [
  'DT1 Logistics — Dispatch / Schedule Update',
  'DT1 Logistics — Load Ticket / Paperwork Reminder',
  'DT1 Logistics — Weather / Site Update',
  'DT1 Logistics — Compliance / Document Reminder'
];

function personalizeMessage(template, driver) {
  const name = String(driver.name || '').trim() || [driver.first_name, driver.last_name].filter(Boolean).join(' ') || driver.email || 'Driver';
  const first = String(driver.first_name || '').trim() || name.split(/\s+/)[0] || name;
  return String(template || '')
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, name);
}

function messageHtml(body) {
  const html = escapeHtml(body).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
  return `<p>${html}</p><p>— DT1 Logistics</p>`;
}

function decorateComm(row) {
  const email = row.driver_email || '';
  const body = row.message_body || '';
  const subject = row.subject || '';
  return Object.assign({}, row, {
    mailto: `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    smsHref: smsHref(row.driver_phone, body),
    preview: body.length > 140 ? `${body.slice(0, 140)}…` : body
  });
}

function renderCommunications(req, res, extras) {
  const extra = extras || {};
  const drivers = db.prepare(`
    SELECT id, name, first_name, last_name, email, phone, status
    FROM users WHERE role = 'driver' ORDER BY name
  `).all();
  const activeDrivers = drivers.filter((driver) => (driver.status || 'active') !== 'inactive');
  const inactiveDrivers = drivers.filter((driver) => driver.status === 'inactive');
  const selectedIds = Array.isArray(extra.selectedIds) ? extra.selectedIds.map((id) => String(id)) : [];
  if (!extra.selectedIds && req.query.driver_id) selectedIds.push(String(req.query.driver_id));
  const selectedInactive = inactiveDrivers.some((driver) => selectedIds.includes(String(driver.id)));
  const log = db.prepare('SELECT * FROM communications_log ORDER BY id DESC LIMIT 40').all().map(decorateComm);
  const results = extra.results || req.session.commResults || [];
  if (req.session.commResults) delete req.session.commResults;
  res.status(extra.statusCode || 200).render('communications', {
    user: req.session.user,
    activeDrivers,
    inactiveDrivers,
    selectedIds,
    showInactive: Boolean(extra.showInactive || selectedInactive),
    notifications: notificationStatus(),
    presets: COMM_PRESETS,
    subject: extra.subject != null ? extra.subject : 'DT1 Logistics — Dispatch / Operations Update',
    message: extra.message || '',
    sendEmail: extra.sendEmail != null ? extra.sendEmail : true,
    sendSms: extra.sendSms != null ? extra.sendSms : true,
    error: extra.error || '',
    log,
    results
  });
}

app.get('/communications', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  renderCommunications(req, res);
});

app.post('/communications/send', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const sendEmail = req.body.send_email === '1' || req.body.send_email === 'on';
  const sendSms = req.body.send_sms === '1' || req.body.send_sms === 'on';
  const subject = String(req.body.subject || '').trim();
  const message = String(req.body.message || '').trim();
  const rawIds = Array.isArray(req.body.driver_ids) ? req.body.driver_ids : (req.body.driver_ids ? [req.body.driver_ids] : []);
  const selectedIds = rawIds.map((id) => parseInt(id, 10)).filter((id) => Number.isInteger(id));
  const showInactive = req.body.show_inactive === '1' || req.body.show_inactive === 'on';
  const formState = { selectedIds, subject, message, sendEmail, sendSms, showInactive };
  if (!sendEmail && !sendSms) {
    return renderCommunications(req, res, Object.assign({ statusCode: 400, error: 'Choose Email, Text, or both.' }, formState));
  }
  if (!message) {
    return renderCommunications(req, res, Object.assign({ statusCode: 400, error: 'Enter a message.' }, formState));
  }
  if (sendEmail && !subject) {
    return renderCommunications(req, res, Object.assign({ statusCode: 400, error: 'Enter a subject for the email.' }, formState));
  }
  if (!selectedIds.length) {
    return renderCommunications(req, res, Object.assign({ statusCode: 400, error: 'Select at least one driver.' }, formState));
  }
  const placeholders = selectedIds.map(() => '?').join(',');
  const found = db.prepare(`SELECT * FROM users WHERE role = 'driver' AND id IN (${placeholders})`).all(...selectedIds);
  const byId = new Map(found.map((driver) => [driver.id, driver]));
  const drivers = selectedIds.map((id) => byId.get(id)).filter(Boolean);
  if (!drivers.length) {
    return renderCommunications(req, res, Object.assign({ statusCode: 400, error: 'Select at least one driver.' }, formState));
  }
  const channels = sendEmail && sendSms ? 'Email + Text' : (sendEmail ? 'Email' : 'Text');
  const insert = db.prepare(`
    INSERT INTO communications_log (
      driver_id, driver_name, driver_email, driver_phone, channels, subject, message_body,
      email_status, sms_status, sent_by, sent_by_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const results = [];
  for (const driver of drivers) {
    const body = personalizeMessage(message, driver);
    const personalSubject = personalizeMessage(subject, driver);
    let emailStatus = 'Not sent';
    let smsStatus = 'Not sent';
    if (sendEmail) {
      const welcome = {
        to: driver.email,
        subject: personalSubject,
        text: `${body}\n\n— DT1 Logistics`,
        html: messageHtml(body)
      };
      try {
        const delivery = await deliverWelcomeEmail(welcome);
        if (delivery.sent) emailStatus = 'Sent';
        else if (delivery.smtpError) emailStatus = 'Could not send';
        else emailStatus = 'Not configured';
      } catch (err) {
        console.error('Driver email failed:', err.message);
        emailStatus = 'Could not send';
      }
    }
    if (sendSms) {
      try {
        const delivery = await deliverWelcomeSms({ smsText: body, phone: driver.phone }, driver.phone);
        smsStatus = delivery.smsStatus || (delivery.smsSent ? 'Sent' : 'Not configured');
      } catch (err) {
        console.error('Driver SMS failed:', err.message);
        smsStatus = 'Could not send';
      }
    }
    const saved = insert.run(
      driver.id,
      driver.name || driver.email,
      driver.email || '',
      driver.phone || '',
      channels,
      personalSubject,
      body,
      emailStatus,
      smsStatus,
      req.session.user.id,
      actorName(req)
    );
    logAudit(req, 'Sent message', 'communication', saved.lastInsertRowid, `${channels} to ${driver.name || driver.email}`);
    results.push(decorateComm({
      id: saved.lastInsertRowid,
      driver_id: driver.id,
      driver_name: driver.name || driver.email,
      driver_email: driver.email || '',
      driver_phone: driver.phone || '',
      channels,
      subject: personalSubject,
      message_body: body,
      email_status: emailStatus,
      sms_status: smsStatus,
      sent_by_name: actorName(req)
    }));
  }
  req.session.commResults = results;
  res.redirect('/communications?sent=1');
});

function ensureDriverTempPassword(driver) {
  const existing = String(driver.temp_password || '').trim();
  if (existing) return { tempPassword: existing, generatedNewPassword: false };
  const tempPassword = Math.random().toString(36).slice(-8);
  const hash = bcrypt.hashSync(tempPassword, 10);
  db.prepare('UPDATE users SET password = ?, temp_password = ?, must_change_password = 1 WHERE id = ?')
    .run(hash, tempPassword, driver.id);
  return { tempPassword, generatedNewPassword: true };
}

app.post('/drivers', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const firstName = String(req.body.first_name || '').trim();
  const middleInitial = String(req.body.middle_initial || '').trim().slice(0, 1);
  const lastName = String(req.body.last_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const place = readAddressParts(req.body);
  const fullName = composeName(firstName, middleInitial, lastName);
  const tempPassword = Math.random().toString(36).slice(-8);
  const hash = bcrypt.hashSync(tempPassword, 10);
  try {
    const result = db.prepare(`
      INSERT INTO users (email, password, role, name, first_name, middle_initial, last_name, phone, address, city, state, zip, pay_percentage, hire_date, dob, app_language, must_change_password, temp_password)
      VALUES (?, ?, 'driver', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'English', 1, ?)
    `).run(email, hash, fullName, firstName, middleInitial, lastName, phone, place.address, place.city, place.state, place.zip, req.body.pay_percentage || null, req.body.hire_date, req.body.dob, tempPassword);
    const welcome = buildWelcomeEmail({ name: fullName, email, tempPassword, phone });
    const delivery = await deliverWelcome(welcome, phone, 'both');
    res.render('driver-created', {
      user: req.session.user,
      email,
      tempPassword,
      name: fullName,
      driverId: result.lastInsertRowid,
      welcome: Object.assign({}, welcome, delivery, { generatedNewPassword: false })
    });
  } catch (e) {
    res.render('driver-form', { user: req.session.user, error: 'Email already exists or invalid data' });
  }
});

app.post('/drivers/:id/send-welcome', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const driver = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.id);
  if (!driver) return res.redirect('/drivers');
  const issued = ensureDriverTempPassword(driver);
  const welcome = buildWelcomeEmail({ name: driver.name, email: driver.email, tempPassword: issued.tempPassword, phone: driver.phone });
  const channel = req.body.channel === 'email' || req.body.channel === 'sms' ? req.body.channel : 'both';
  const delivery = await deliverWelcome(welcome, driver.phone, channel);
  res.render('welcome-sent', {
    user: req.session.user,
    driver,
    welcome: Object.assign({}, welcome, delivery, { generatedNewPassword: issued.generatedNewPassword })
  });
});

app.post('/drivers/:id/upload', requireAuth, upload.single('file'), (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const { doc_type, expiration_date } = req.body;
  if (req.file && doc_type) {
    db.prepare('DELETE FROM driver_documents WHERE driver_id = ? AND doc_type = ?').run(req.params.id, doc_type);
    db.prepare(`
      INSERT INTO driver_documents (driver_id, doc_type, filename, original_name, expiration_date)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.params.id, doc_type, req.file.filename, req.file.originalname, expiration_date || null);
  }
  res.redirect(`/drivers/${req.params.id}`);
});

function renderDriverEditor(req, res, driver, status, extras) {
  const docs = db.prepare('SELECT * FROM driver_documents WHERE driver_id = ?').all(driver.id);
  const levels = collectDriverLevels(driver.id, { docHref: '', loadHref: '/loads', equipHref: '/equipment' });
  res.status(status).render('driver-profile', Object.assign({
    user: req.session.user,
    driver,
    docs,
    levels,
    saved: false,
    error: ''
  }, extras));
}

app.get('/drivers/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const driver = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(req.params.id, 'driver');
  if (!driver) return res.redirect('/drivers');
  renderDriverEditor(req, res, driver, 200, { saved: req.query.saved === '1' });
});

app.post('/drivers/:id/status', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const driver = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'driver'").get(req.params.id);
  if (!driver) return res.redirect('/drivers');
  const status = req.body.status === 'inactive' ? 'inactive' : 'active';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, driver.id);
  res.redirect(req.body.return_to === 'profile' ? `/drivers/${driver.id}?saved=1` : '/drivers');
});

app.post('/drivers/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const driver = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(req.params.id, 'driver');
  if (!driver) return res.redirect('/drivers');
  const firstName = bodyHas(req.body, 'first_name') ? String(req.body.first_name || '').trim() : String(driver.first_name || '').trim();
  const middleInitial = bodyHas(req.body, 'middle_initial') ? String(req.body.middle_initial || '').trim().slice(0, 1) : String(driver.middle_initial || '').trim().slice(0, 1);
  const lastName = bodyHas(req.body, 'last_name') ? String(req.body.last_name || '').trim() : String(driver.last_name || '').trim();
  const email = bodyHas(req.body, 'email') ? String(req.body.email || '').trim().toLowerCase() : driver.email;
  const phone = bodyHas(req.body, 'phone') ? String(req.body.phone || '').trim() : String(driver.phone || '').trim();
  const place = readAddressParts(req.body, driver);
  const payPercentage = bodyHas(req.body, 'pay_percentage') && String(req.body.pay_percentage).trim() !== ''
    ? parseFloat(req.body.pay_percentage)
    : driver.pay_percentage;
  const draft = Object.assign({}, driver, {
    first_name: firstName,
    middle_initial: middleInitial,
    last_name: lastName,
    name: composeName(firstName, middleInitial, lastName),
    email,
    phone,
    address: place.address,
    city: place.city,
    state: place.state,
    zip: place.zip,
    pay_percentage: Number.isFinite(payPercentage) ? payPercentage : driver.pay_percentage,
    hire_date: bodyHas(req.body, 'hire_date') ? blankToNull(req.body.hire_date) : driver.hire_date,
    dob: bodyHas(req.body, 'dob') ? blankToNull(req.body.dob) : driver.dob,
    status: bodyHas(req.body, 'status') ? (req.body.status === 'inactive' ? 'inactive' : 'active') : (driver.status || 'active')
  });
  if (!firstName || !lastName || !email.includes('@')) {
    return renderDriverEditor(req, res, draft, 400, { error: 'Enter a first name, last name, and valid login email.' });
  }
  const duplicate = db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(email, driver.id);
  if (duplicate) return renderDriverEditor(req, res, draft, 400, { error: 'That email is already in use.' });
  db.prepare(`
    UPDATE users
    SET name = ?, first_name = ?, middle_initial = ?, last_name = ?, email = ?, phone = ?,
        address = ?, city = ?, state = ?, zip = ?,
        pay_percentage = ?, hire_date = ?, dob = ?, status = ?, app_language = 'English'
    WHERE id = ?
  `).run(
    draft.name,
    firstName,
    middleInitial,
    lastName,
    email,
    phone,
    place.address,
    place.city,
    place.state,
    place.zip,
    Number.isFinite(Number(payPercentage)) ? Number(payPercentage) : driver.pay_percentage,
    draft.hire_date,
    draft.dob,
    draft.status,
    driver.id
  );
  res.redirect(`/drivers/${driver.id}?saved=1`);
});

// Receipts
app.get('/receipts', requireAuth, (req, res) => {
  const receipts = db.prepare(`
    SELECT r.*, u.name as uploader_name
    FROM receipts r
    LEFT JOIN users u ON r.uploaded_by = u.id
    ORDER BY r.created_at DESC
  `).all();
  res.render('receipts', { user: req.session.user, receipts });
});

app.get('/receipts/new', requireAuth, (req, res) => {
  res.render('receipt-form', { user: req.session.user });
});

app.post('/receipts', requireAuth, upload.single('receipt_file'), (req, res) => {
  const { expense_date, lines } = req.body;
  const result = db.prepare(`
    INSERT INTO receipts (expense_date, uploaded_by, filename, original_name, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(expense_date, req.session.user.id, req.file ? req.file.filename : null, req.file ? req.file.originalname : null);
  const receiptId = result.lastInsertRowid;
  if (lines && Array.isArray(lines)) {
    const insertLine = db.prepare(`
      INSERT INTO receipt_lines (receipt_id, equipment_type, description, amount)
      VALUES (?, ?, ?, ?)
    `);
    lines.forEach(line => {
      if (line.description && line.amount) {
        insertLine.run(receiptId, line.equipment || '', line.description, parseFloat(line.amount) || 0);
      }
    });
  }
  res.redirect('/receipts');
});

app.post('/receipts/:id/approve', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/receipts');
  db.prepare(`UPDATE receipts SET status = 'approved' WHERE id = ? AND status = 'pending'`).run(req.params.id);
  // Placeholder: copy to SharePoint would happen here
  res.redirect('/receipts');
});

// Compliance
app.get('/compliance', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const items = db.prepare('SELECT * FROM compliance_items ORDER BY name').all();
  res.render('compliance', { user: req.session.user, items });
});

app.post('/compliance', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/compliance');
  db.prepare(`
    INSERT INTO compliance_items (name, expiration_date, notes)
    VALUES (?, ?, ?)
  `).run(name, blankToNull(req.body.expiration_date), blankToNull(req.body.notes));
  res.redirect('/compliance');
});

app.post('/compliance/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const existing = db.prepare('SELECT * FROM compliance_items WHERE id = ?').get(req.params.id);
  if (!existing) return res.redirect('/compliance');
  db.prepare(`
    UPDATE compliance_items
    SET name = ?, expiration_date = ?, notes = ?
    WHERE id = ?
  `).run(
    bodyHas(req.body, 'name') ? (String(req.body.name || '').trim() || existing.name) : existing.name,
    bodyHas(req.body, 'expiration_date') ? blankToNull(req.body.expiration_date) : existing.expiration_date,
    bodyHas(req.body, 'notes') ? blankToNull(req.body.notes) : existing.notes,
    req.params.id
  );
  res.redirect('/compliance');
});

function readEquipment(body, existing) {
  const maintenance = bodyHas(body, 'maintenance_status') && ['active', 'maintenance', 'out_of_service'].includes(body.maintenance_status)
    ? body.maintenance_status
    : (existing ? (existing.maintenance_status || 'active') : 'active');
  const type = bodyHas(body, 'type')
    ? (body.type === 'trailer' ? 'trailer' : 'truck')
    : (existing ? existing.type : 'truck');
  const kept = (key) => (bodyHas(body, key) ? String(body[key] || '').trim() : (existing ? (existing[key] || '') : ''));
  return {
    type,
    number: kept('number'),
    description: kept('description'),
    vin: kept('vin'),
    year: kept('year'),
    make: kept('make'),
    model: kept('model'),
    status: bodyHas(body, 'status') ? (body.status === 'inactive' ? 'inactive' : 'active') : (existing ? (existing.status || 'active') : 'active'),
    ownership: kept('ownership'),
    registration_expiration: bodyHas(body, 'registration_expiration') ? blankToNull(body.registration_expiration) : (existing ? existing.registration_expiration : null),
    inspection_expiration: bodyHas(body, 'inspection_expiration') ? blankToNull(body.inspection_expiration) : (existing ? existing.inspection_expiration : null),
    maintenance_status: maintenance
  };
}

// Equipment
app.get('/equipment', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const trucks = db.prepare("SELECT * FROM equipment WHERE type = 'truck' ORDER BY number").all();
  const trailers = db.prepare("SELECT * FROM equipment WHERE type = 'trailer' ORDER BY number").all();
  res.render('equipment', { user: req.session.user, trucks, trailers });
});

app.get('/equipment/new', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  res.render('equipment-form', { user: req.session.user, equipment: {} });
});

app.get('/equipment/:id/edit', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!equipment) return res.redirect('/equipment');
  res.render('equipment-form', { user: req.session.user, equipment });
});

app.post('/equipment', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const item = readEquipment(req.body);
  db.prepare(`
    INSERT INTO equipment (
      type, number, description, vin, year, make, model, status, ownership, registration_expiration, inspection_expiration, maintenance_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(item.type, item.number, item.description, item.vin, item.year, item.make, item.model, item.status, item.ownership, item.registration_expiration, item.inspection_expiration, item.maintenance_status);
  res.redirect('/equipment');
});

app.post('/equipment/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!existing) return res.redirect('/equipment');
  const item = readEquipment(req.body, existing);
  db.prepare(`
    UPDATE equipment
    SET type = ?, number = ?, description = ?, vin = ?, year = ?, make = ?, model = ?, status = ?,
        ownership = ?, registration_expiration = ?, inspection_expiration = ?, maintenance_status = ?
    WHERE id = ?
  `).run(item.type, item.number, item.description, item.vin, item.year, item.make, item.model, item.status, item.ownership, item.registration_expiration, item.inspection_expiration, item.maintenance_status, req.params.id);
  res.redirect('/equipment');
});

// Fuel rate
function calculateSurchargePercent(currentRate) {
  const percent = Math.max(0, ((Number(currentRate) - 4.00) / 0.10) * 0.1);
  return Math.round(percent * 1000) / 1000;
}

function fuelRateValue(body) {
  const raw = body && String(body.central_atlantic_rate || '').trim() !== ''
    ? body.central_atlantic_rate
    : (body ? body.rate : '');
  const rate = parseFloat(raw);
  return Number.isFinite(rate) ? rate : null;
}

function validFuelRates() {
  return db.prepare(`
    SELECT * FROM fuel_rates
    WHERE central_atlantic_rate IS NOT NULL AND surcharge_percent IS NOT NULL
    ORDER BY effective_date DESC, id DESC
  `).all();
}

app.get('/fuel-rate', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const history = validFuelRates();
  res.render('fuel-rate', {
    user: req.session.user,
    latest: history[0] || null,
    history,
    error: req.query.error === 'rate' ? 'Enter a valid Central Atlantic diesel rate.' : ''
  });
});

app.post('/fuel-rate', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const rate = fuelRateValue(req.body);
  if (rate == null) return res.redirect('/fuel-rate?error=rate');
  const percent = calculateSurchargePercent(rate);
  const effectiveDate = String(req.body.effective_date || '').trim() || new Date().toISOString().slice(0, 10);
  const name = actorName(req);
  const result = db.prepare(`
    INSERT INTO fuel_rates (
      effective_date, central_atlantic_rate, base_rate, surcharge_percent, updated_by, updated_by_id, updated_at
    ) VALUES (?, ?, 4.00, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(effectiveDate, rate, percent, name, req.session.user.id);
  logAudit(req, 'Updated fuel rate', 'fuel_rate', result.lastInsertRowid, `$${rate.toFixed(3)} effective ${effectiveDate}`);
  res.redirect('/fuel-rate');
});

// Fuel
app.get('/fuel', requireAuth, (req, res) => {
  const rates = db.prepare('SELECT * FROM fuel_rates ORDER BY effective_date DESC').all();
  const current = rates[0] || null;
  res.render('fuel', { user: req.session.user, current, rates });
});

// Profile
function profileLevels(profile) {
  if (!profile || profile.role !== 'driver') return [];
  return collectDriverLevels(profile.id, { docHref: '', loadHref: '/loads' });
}

app.get('/profile', requireAuth, (req, res) => {
  const profile = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', {
    user: req.session.user,
    profile,
    levels: profileLevels(profile),
    saved: req.query.saved === '1'
  });
});

app.post('/profile', requireAuth, (req, res) => {
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const isDriver = current.role === 'driver';
  const firstName = bodyHas(req.body, 'first_name') ? String(req.body.first_name || '').trim() : String(current.first_name || '').trim();
  const lastName = bodyHas(req.body, 'last_name') ? String(req.body.last_name || '').trim() : String(current.last_name || '').trim();
  const phone = bodyHas(req.body, 'phone') ? String(req.body.phone || '').trim() : String(current.phone || '').trim();
  const place = readAddressParts(req.body, current);
  const email = isDriver ? current.email : (bodyHas(req.body, 'email') ? String(req.body.email || '').trim().toLowerCase() : current.email);
  const name = composeName(firstName, current.middle_initial, lastName);
  const draft = Object.assign({}, current, {
    first_name: firstName,
    last_name: lastName,
    name,
    email,
    phone,
    address: place.address,
    city: place.city,
    state: place.state,
    zip: place.zip,
    app_language: 'English'
  });
  const renderForm = (status, error) => res.status(status).render('profile', {
    user: req.session.user,
    profile: draft,
    levels: profileLevels(current),
    saved: false,
    error
  });
  if (!firstName || !lastName) {
    return renderForm(400, 'Enter your first and last name.');
  }
  if (!isDriver && !email.includes('@')) {
    return renderForm(400, 'Enter a valid email.');
  }
  if (!isDriver) {
    const duplicate = db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(email, current.id);
    if (duplicate) return renderForm(400, 'That email is already in use.');
  }
  db.prepare(`
    UPDATE users
    SET name = ?, first_name = ?, last_name = ?, email = ?, phone = ?, address = ?, city = ?, state = ?, zip = ?, app_language = 'English'
    WHERE id = ?
  `).run(name, firstName, lastName, email, phone, place.address, place.city, place.state, place.zip, current.id);
  req.session.user.name = name;
  req.session.user.email = email;
  res.redirect('/profile?saved=1');
});

function pendingSettlementWeeks() {
  const loads = db.prepare(loadQuery + `
    WHERE l.status = 'approved' AND IFNULL(l.settlement_status, '') != 'approved'
    ORDER BY l.load_date, l.id
  `).all();
  const groups = new Map();
  loads.forEach((load) => {
    const week = weekBounds(load.load_date) || { start: '', end: '', range: 'Undated', title: 'Undated loads' };
    const key = `${load.driver_id || 0}:${week.start}`;
    if (!groups.has(key)) {
      groups.set(key, {
        driverId: load.driver_id,
        driver: load.driver_name || 'Unassigned',
        percentage: load.pay_percentage,
        week,
        loads: [],
        total: 0
      });
    }
    const group = groups.get(key);
    const payInfo = calcDriverPay(load);
    group.loads.push(Object.assign({}, load, { payInfo }));
    group.total += payInfo.pay;
  });
  return Array.from(groups.values()).map((group) => {
    group.qty = group.loads.reduce((sum, load) => sum + (Number(load.weight_quantity) || 0), 0);
    group.status = 'pending';
    return group;
  });
}

function approvedSettlementWeeks(driverId) {
  const rows = driverId
    ? db.prepare(`
        SELECT s.*, u.name AS driver_name, u.pay_percentage
        FROM driver_settlements s
        JOIN users u ON u.id = s.driver_id
        WHERE s.driver_id = ? AND s.status = 'approved'
        ORDER BY s.week_start DESC
      `).all(driverId)
    : db.prepare(`
        SELECT s.*, u.name AS driver_name, u.pay_percentage
        FROM driver_settlements s
        JOIN users u ON u.id = s.driver_id
        WHERE s.status = 'approved'
        ORDER BY s.week_start DESC, u.name
      `).all();
  return rows.map((row) => {
    const loads = db.prepare(loadQuery + `
      WHERE l.driver_id = ? AND l.settlement_status = 'approved'
        AND l.load_date >= ? AND l.load_date <= ?
      ORDER BY l.load_date, l.id
    `).all(row.driver_id, row.week_start, row.week_end).map((load) => Object.assign({}, load, { payInfo: calcDriverPay(load) }));
    const week = weekBounds(row.week_start);
    return {
      ...row,
      range: week ? week.range : `${row.week_start} - ${row.week_end}`,
      loads,
      qty: loads.reduce((sum, load) => sum + (Number(load.weight_quantity) || 0), 0),
      total: loads.reduce((sum, load) => sum + load.payInfo.pay, 0),
      base: loads.reduce((sum, load) => sum + load.payInfo.base, 0),
      drive: loads.reduce((sum, load) => sum + load.payInfo.drive, 0),
      self: loads.reduce((sum, load) => sum + load.payInfo.self, 0)
    };
  });
}

app.get('/settlements', requireAuth, (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const latestFuel = db.prepare('SELECT * FROM fuel_rates ORDER BY effective_date DESC, id DESC LIMIT 1').get();
  const surchargePercent = latestFuel && latestFuel.surcharge_percent != null ? Number(latestFuel.surcharge_percent) : 0;
  const approvedWeeks = approvedSettlementWeeks(isAdmin ? null : req.session.user.id);
  let customerInvoices = [];
  if (isAdmin) {
    const approvedLoads = db.prepare(loadQuery + ` WHERE l.status = 'approved' ORDER BY c.name, p.display_name, l.load_date`).all();
    const byProject = {};
  approvedLoads.forEach((load) => {
    const key = load.project_id ? String(load.project_id) : 'unassigned';
    if (!byProject[key]) {
      byProject[key] = {
        display_name: load.project_display || 'Unassigned',
        customer_name: load.customer_name || '',
        address_line1: load.address_line1 || '',
        address_line2: load.address_line2 || '',
        poc_name: load.poc_name || '',
        poc_phone: load.poc_phone || '',
        poc_email: load.poc_email || '',
        terms: load.terms || '',
        loads: [],
        hauling: 0,
        fscBase: 0,
        fuelSurcharge: 0,
        travelTime: 0,
        selfLoad: 0,
        total: 0
      };
    }
    const qty = Number(load.weight_quantity) || 0;
    const rate = Number(load.rate) || 0;
    const hauling = qty * rate;
    const travelTime = Number(load.has_drive_time) ? (Number(load.drive_time_amount) || 0) : 0;
    const selfLoad = Number(load.has_self_load) ? (Number(load.self_load_amount) || 0) : 0;
    const lineFsc = Number(load.has_fuel_surcharge) === 1 ? hauling * (surchargePercent / 100) : 0;
    byProject[key].loads.push({ ...load, hauling, travelTime, selfLoad, lineFsc });
    byProject[key].hauling += hauling;
    if (Number(load.has_fuel_surcharge) === 1) byProject[key].fscBase += hauling;
    byProject[key].travelTime += travelTime;
    byProject[key].selfLoad += selfLoad;
  });

    customerInvoices = Object.values(byProject).map((invoice) => {
      invoice.fuelSurcharge = invoice.fscBase * (surchargePercent / 100);
      invoice.total = invoice.hauling + invoice.fuelSurcharge + invoice.travelTime + invoice.selfLoad;
      return invoice;
    });
  }

  res.render('settlements', {
    user: req.session.user,
    pendingWeeks: isAdmin ? pendingSettlementWeeks() : [],
    approvedWeeks,
    customerInvoices,
    surchargePercent,
    fuelRate: latestFuel || null,
    saved: req.query.saved || ''
  });
});

app.post('/settlements/approve-week', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/settlements');
  const driverId = parseInt(req.body.driver_id, 10);
  const week = weekBounds(req.body.week_start);
  if (!Number.isInteger(driverId) || !week || week.start !== String(req.body.week_start || '')) {
    return res.redirect('/settlements');
  }
  const loads = db.prepare(`
    SELECT id, load_date FROM loads
    WHERE driver_id = ? AND status = 'approved' AND IFNULL(settlement_status, '') != 'approved'
  `).all(driverId).filter((load) => {
    const bounds = weekBounds(load.load_date);
    return bounds && bounds.start === week.start;
  });
  if (!loads.length) return res.redirect('/settlements');
  const mark = db.prepare(`UPDATE loads SET settlement_status = 'approved' WHERE id = ?`);
  const saveWeek = db.transaction(() => {
    loads.forEach((load) => mark.run(load.id));
    db.prepare(`
      INSERT INTO driver_settlements (driver_id, week_start, week_end, status, approved_by, approved_by_name, approved_at)
      VALUES (?, ?, ?, 'approved', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(driver_id, week_start) DO UPDATE SET
        week_end = excluded.week_end,
        status = 'approved',
        approved_by = excluded.approved_by,
        approved_by_name = excluded.approved_by_name,
        approved_at = CURRENT_TIMESTAMP
    `).run(driverId, week.start, week.end, req.session.user.id, actorName(req));
  });
  saveWeek();
  logAudit(req, 'Approved weekly settlement', 'driver_settlement', driverId, `Week of ${week.range}`);
  res.redirect('/settlements?saved=week');
});

function parseRedisUrl(raw) {
  const url = new URL(raw);
  const tlsOn = url.protocol === 'rediss:';
  return {
    host: url.hostname,
    port: Number(url.port) || (tlsOn ? 6380 : 6379),
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    tls: tlsOn
  };
}

function encodeRedisCommand(args) {
  const chunks = [Buffer.from(`*${args.length}\r\n`)];
  args.forEach((arg) => {
    const value = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg));
    chunks.push(Buffer.from(`$${value.length}\r\n`));
    chunks.push(value);
    chunks.push(Buffer.from('\r\n'));
  });
  return Buffer.concat(chunks);
}

function parseRedisReply(buffer) {
  if (!buffer.length) return null;
  const kind = String.fromCharCode(buffer[0]);
  const lineEnd = () => buffer.indexOf('\r\n');
  if (kind === '+' || kind === '-' || kind === ':') {
    const end = lineEnd();
    if (end === -1) return null;
    const text = buffer.subarray(1, end).toString();
    if (kind === '-') return { consumed: end + 2, error: new Error(text) };
    if (kind === ':') return { consumed: end + 2, value: Number(text) };
    return { consumed: end + 2, value: text };
  }
  if (kind === '$') {
    const end = lineEnd();
    if (end === -1) return null;
    const length = Number(buffer.subarray(1, end).toString());
    if (length === -1) return { consumed: end + 2, value: null };
    const start = end + 2;
    if (buffer.length < start + length + 2) return null;
    return { consumed: start + length + 2, value: buffer.subarray(start, start + length).toString('utf8') };
  }
  if (kind === '*') {
    const end = lineEnd();
    if (end === -1) return null;
    const count = Number(buffer.subarray(1, end).toString());
    if (count === -1) return { consumed: end + 2, value: null };
    let offset = end + 2;
    const values = [];
    for (let i = 0; i < count; i += 1) {
      const inner = parseRedisReply(buffer.subarray(offset));
      if (!inner) return null;
      if (inner.error) return { consumed: offset + inner.consumed, error: inner.error };
      values.push(inner.value);
      offset += inner.consumed;
    }
    return { consumed: offset, value: values };
  }
  return { consumed: buffer.length, error: new Error('Unknown Redis reply') };
}

class RedisClient {
  constructor(rawUrl) {
    this.config = parseRedisUrl(rawUrl);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.connectPromise = null;
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this);
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = this.config.tls
        ? tls.connect({ host: this.config.host, port: this.config.port, servername: this.config.host })
        : net.connect({ host: this.config.host, port: this.config.port });
      const fail = (err) => {
        this.connectPromise = null;
        reject(err);
      };
      socket.once('error', fail);
      const ready = () => {
        socket.removeListener('error', fail);
        this.socket = socket;
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (err) => this.drop(err));
        socket.on('close', () => this.drop(new Error('Redis connection closed')));
        resolve(this);
      };
      if (this.config.tls) socket.once('secureConnect', ready);
      else socket.once('connect', ready);
    }).then(async (client) => {
      if (this.config.password) {
        const args = this.config.username
          ? ['AUTH', this.config.username, this.config.password]
          : ['AUTH', this.config.password];
        await this.command(args);
      }
      return client;
    }).catch((err) => {
      this.connectPromise = null;
      if (this.socket) this.socket.destroy();
      this.socket = null;
      throw err;
    });
    return this.connectPromise;
  }

  drop(err) {
    this.socket = null;
    this.connectPromise = null;
    this.buffer = Buffer.alloc(0);
    const pending = this.queue.splice(0);
    pending.forEach((item) => item.reject(err));
  }

  command(args) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Redis is not connected'));
        return;
      }
      this.queue.push({ resolve, reject });
      this.socket.write(encodeRedisCommand(args));
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.queue.length) {
      const parsed = parseRedisReply(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.consumed);
      const item = this.queue.shift();
      if (parsed.error) item.reject(parsed.error);
      else item.resolve(parsed.value);
    }
  }
}

let redisClient = null;
let snapshotChain = Promise.resolve();

function redis() {
  if (!process.env.REDIS_URL) return Promise.reject(new Error('REDIS_URL is not set'));
  if (!redisClient) redisClient = new RedisClient(process.env.REDIS_URL);
  return redisClient.connect();
}

async function restoreDatabaseSnapshot() {
  if (!process.env.REDIS_URL) return false;
  const client = await redis();
  const payload = await client.command(['GET', SNAPSHOT_KEY]);
  if (!payload) return false;
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length < 16 || bytes.subarray(0, 15).toString() !== 'SQLite format 3') {
    throw new Error('Redis snapshot is not a SQLite database');
  }
  fs.writeFileSync(dbPath, bytes);
  ['-wal', '-shm'].forEach((suffix) => {
    const side = dbPath + suffix;
    if (fs.existsSync(side)) fs.unlinkSync(side);
  });
  return true;
}

async function writeDatabaseSnapshot() {
  if (!process.env.REDIS_URL || !db) return;
  const payload = db.serialize().toString('base64');
  const client = await redis();
  await client.command(['SET', SNAPSHOT_KEY, payload]);
}

function persistDatabaseSnapshot() {
  if (!process.env.REDIS_URL || !db) return Promise.resolve();
  const job = snapshotChain.then(writeDatabaseSnapshot, writeDatabaseSnapshot);
  snapshotChain = job.catch(() => {});
  return job;
}

async function boot() {
  if (process.env.REDIS_URL) {
    try {
      const restored = await restoreDatabaseSnapshot();
      console.log(restored ? 'Restored SQLite snapshot from Redis' : 'No Redis snapshot yet');
    } catch (err) {
      console.error('Redis restore skipped:', err.message);
    }
  }
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  initDB();
  if (process.env.REDIS_URL) {
    try {
      await persistDatabaseSnapshot();
      console.log('Saved SQLite snapshot to Redis');
    } catch (err) {
      console.error('Initial Redis snapshot skipped:', err.message);
    }
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DT1 TMS running on port ${PORT}`);
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const done = () => process.exit(0);
    const timer = setTimeout(done, 4000);
    timer.unref();
    persistDatabaseSnapshot()
      .catch((err) => console.error('Shutdown snapshot failed:', err.message))
      .finally(done);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

boot().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
