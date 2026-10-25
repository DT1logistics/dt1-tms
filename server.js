const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const db = new Database(path.join(__dirname, 'dt1.db'));
db.pragma('foreign_keys = ON');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.money = (n) => (Number(n) || 0).toFixed(2);

function getStatusClass(exp) {
  if (!exp) return 'red';
  const days = Math.ceil((new Date(exp) - new Date()) / (1000 * 60 * 60 * 24));
  if (days < 0 || days <= 14) return 'red';
  if (days <= 60) return 'yellow';
  return 'green';
}

function getStatusText(exp) {
  if (!exp) return 'Missing';
  const days = Math.ceil((new Date(exp) - new Date()) / (1000 * 60 * 60 * 24));
  if (days < 0) return 'Expired';
  if (days <= 14) return 'Expiring ≤14 days';
  if (days <= 60) return 'Expiring ≤60 days';
  return 'Active';
}

app.locals.getStatusClass = getStatusClass;
app.locals.getStatusText = getStatusText;

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
      pay_percentage REAL,
      hire_date DATE,
      dob DATE,
      profile_pic TEXT,
      status TEXT DEFAULT 'active',
      must_change_password INTEGER DEFAULT 0,
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
      weight_quantity REAL,
      rate REAL DEFAULT 0,
      has_fuel_surcharge INTEGER DEFAULT 0,
      has_drive_time INTEGER DEFAULT 0,
      drive_time_amount REAL DEFAULT 0,
      has_self_load INTEGER DEFAULT 0,
      self_load_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft',
      submitted_by INTEGER,
      approved_by INTEGER,
      approved_at DATETIME,
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('truck', 'trailer')),
      number TEXT,
      description TEXT,
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

    CREATE TABLE IF NOT EXISTS receipt_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER,
      equipment_type TEXT,
      description TEXT,
      amount REAL,
      FOREIGN KEY (receipt_id) REFERENCES receipts(id)
    );
  `);

  // Safe upgrades for databases created before these columns existed.
  ensureColumn('users', 'first_name', 'TEXT');
  ensureColumn('users', 'middle_initial', 'TEXT');
  ensureColumn('users', 'last_name', 'TEXT');
  ensureColumn('users', 'hire_date', 'DATE');
  ensureColumn('users', 'dob', 'DATE');
  ensureColumn('users', 'profile_pic', 'TEXT');

  ensureColumn('loads', 'project_id', 'INTEGER');
  ensureColumn('loads', 'rate', 'REAL DEFAULT 0');
  ensureColumn('loads', 'has_fuel_surcharge', 'INTEGER DEFAULT 0');
  ensureColumn('loads', 'has_drive_time', 'INTEGER DEFAULT 0');
  ensureColumn('loads', 'drive_time_amount', 'REAL DEFAULT 0');
  ensureColumn('loads', 'has_self_load', 'INTEGER DEFAULT 0');
  ensureColumn('loads', 'self_load_amount', 'REAL DEFAULT 0');
  ensureColumn('equipment', 'registration_expiration', 'DATE');
  ensureColumn('equipment', 'inspection_expiration', 'DATE');
  ensureColumn('equipment', 'maintenance_status', "TEXT DEFAULT 'active'");

  const complianceCount = db.prepare('SELECT COUNT(*) AS n FROM compliance_items').get().n;
  if (!complianceCount) {
    const insertCompliance = db.prepare('INSERT INTO compliance_items (name) VALUES (?)');
    ['FMCSA', 'HVUT', 'UCR', 'IFTA', 'Insurance'].forEach((name) => insertCompliance.run(name));
  }

  // Seed admin if not exists
  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@dt1logistics.com');
  if (!admin) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('changeme123', 10);
    db.prepare(`INSERT INTO users (email, password, role, name) VALUES (?, ?, 'admin', 'Administrator')`)
      .run('admin@dt1logistics.com', hash);
  }
}

initDB();

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

function readCustomer(body) {
  return {
    name: String(body.name || '').trim(),
    address_line1: String(body.address_line1 || '').trim(),
    address_line2: String(body.address_line2 || '').trim(),
    poc_name: String(body.poc_name || '').trim(),
    poc_phone: String(body.poc_phone || '').trim(),
    poc_email: String(body.poc_email || '').trim(),
    terms: String(body.terms || '').trim() || 'Net 30',
    status: body.status === 'inactive' ? 'inactive' : 'active'
  };
}

function readProject(body, customer) {
  const naming = projectNaming(customer.name, body.project_name);
  const defaultRate = parseFloat(body.default_rate);
  const hasFuel = flagValue(body.has_fuel_surcharge) ? 1 : 0;
  const hasDrive = flagValue(body.has_drive_time) ? 1 : 0;
  let driveAmount = parseFloat(body.default_drive_time_amount);
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
    status: body.status === 'inactive' ? 'inactive' : 'active',
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

function loadFormData(user) {
  const drivers = user.role === 'admin'
    ? db.prepare("SELECT id, name FROM users WHERE role = 'driver' AND status = 'active' ORDER BY name").all()
    : [];
  return { drivers, projects: activeProjects() };
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
    const title = load.ticket_number || `Load #${load.id}`;
    if (load.status === 'submitted') {
      pushAlert(alerts, 'yellow', 'Load', title, 'Pending review', '/loads');
    }
    const hasFile = (docMap[load.id] || 0) > 0;
    if (!hasFile && !load.ticket_number) {
      pushAlert(alerts, 'red', 'Load', title, 'Missing ticket number and ticket file', '/loads');
    } else if (!hasFile) {
      pushAlert(alerts, 'yellow', 'Load', title, 'Missing ticket file', '/loads');
    } else if (!load.ticket_number) {
      pushAlert(alerts, 'yellow', 'Load', title, 'Missing ticket number', '/loads');
    }
    const rateMissing = load.rate == null || Number(load.rate) === 0;
    if (rateMissing && load.status !== 'draft') {
      pushAlert(alerts, load.status === 'approved' ? 'red' : 'yellow', 'Load', title, 'Rate not set', '/loads');
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

app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.must_change_password) {
      return res.redirect('/change-password');
    }
    const attention = collectAlerts(req.session.user);
    res.render('dashboard', { user: req.session.user, ...attention });
  } else {
    res.render('login');
  }
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim());
  if (user && bcrypt.compareSync(password || '', user.password)) {
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
  db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?').run(hash, req.session.user.id);
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
  const customer = { ...readCustomer(req.body), id: existing.id };
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
      has_drive_time, default_drive_time_amount, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customer.id, parsed.projectName, parsed.displayName, parsed.defaultRate, parsed.hasFuel, parsed.hasDrive, parsed.driveAmount, parsed.status);
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
      has_drive_time, default_drive_time_amount, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customer.id, parsed.projectName, parsed.displayName, parsed.defaultRate, parsed.hasFuel, parsed.hasDrive, parsed.driveAmount, parsed.status);
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
  const parsed = readProject(req.body, customer);
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
        has_fuel_surcharge = ?, has_drive_time = ?, default_drive_time_amount = ?, status = ?
    WHERE id = ?
  `).run(customer.id, parsed.projectName, parsed.displayName, parsed.defaultRate, parsed.hasFuel, parsed.hasDrive, parsed.driveAmount, parsed.status, existing.id);
  res.redirect('/customers/' + customer.id);
});

// Loads routes
app.get('/loads', requireAuth, (req, res) => {
  let loads;
  if (req.session.user.role === 'admin') {
    loads = db.prepare(loadQuery + ' ORDER BY l.created_at DESC').all();
  } else {
    loads = db.prepare(loadQuery + ' WHERE l.driver_id = ? ORDER BY l.created_at DESC').all(req.session.user.id);
  }
  res.render('loads', { user: req.session.user, loads });
});

app.post('/loads/:id/approve', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/loads');
  db.prepare(`
    UPDATE loads SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'submitted'
  `).run(req.session.user.id, req.params.id);
  res.redirect('/loads');
});

app.get('/loads/new', requireAuth, (req, res) => {
  const form = loadFormData(req.session.user);
  res.render('load-form', { user: req.session.user, load: {}, ...form });
});

app.post('/loads', requireAuth, upload.array('documents', 10), (req, res) => {
  const projectId = parseInt(req.body.project_id, 10);
  const project = Number.isInteger(projectId)
    ? db.prepare(`
        SELECT p.*
        FROM projects p
        JOIN customers c ON c.id = p.customer_id
        WHERE p.id = ? AND p.status = 'active' AND c.status = 'active'
      `).get(projectId)
    : null;
  if (!project) {
    const form = loadFormData(req.session.user);
    return res.status(400).render('load-form', {
      user: req.session.user,
      load: req.body,
      error: 'Select an active project',
      ...form
    });
  }

  const rateMissing = req.body.rate === undefined || req.body.rate === null || String(req.body.rate).trim() === '';
  let rate = parseFloat(req.body.rate);
  let hasFuel = flagValue(req.body.has_fuel_surcharge) ? 1 : 0;
  let hasDrive = flagValue(req.body.has_drive_time) ? 1 : 0;
  let hasSelf = flagValue(req.body.has_self_load) ? 1 : 0;
  let driveAmount = parseFloat(req.body.drive_time_amount);
  let selfAmount = parseFloat(req.body.self_load_amount);

  if (rateMissing || !Number.isFinite(rate)) {
    rate = Number(project.default_rate) || 0;
    hasFuel = project.has_fuel_surcharge ? 1 : 0;
    hasDrive = project.has_drive_time ? 1 : 0;
    driveAmount = hasDrive ? (Number(project.default_drive_time_amount) || 0) : 0;
  } else if (!hasDrive) {
    driveAmount = 0;
  } else if (!Number.isFinite(driveAmount)) {
    driveAmount = Number(project.default_drive_time_amount) || 0;
  }

  if (!hasSelf) {
    selfAmount = 0;
  } else if (!Number.isFinite(selfAmount) || selfAmount === 0) {
    selfAmount = 20;
  }

  const weight = parseFloat(req.body.weight_quantity);
  const assignedDriver = req.session.user.role === 'driver' ? req.session.user.id : (req.body.driver_id || null);
  const result = db.prepare(`
    INSERT INTO loads (
      ticket_number, load_date, driver_id, project_id, description, weight_quantity,
      rate, has_fuel_surcharge, has_drive_time, drive_time_amount, has_self_load, self_load_amount,
      status, submitted_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?)
  `).run(
    req.body.ticket_number || null,
    req.body.load_date || null,
    assignedDriver,
    project.id,
    req.body.description || null,
    Number.isFinite(weight) ? weight : null,
    rate,
    hasFuel,
    hasDrive,
    driveAmount,
    hasSelf,
    selfAmount,
    req.session.user.id
  );
  const loadId = result.lastInsertRowid;
  if (req.files) {
    const insertDoc = db.prepare(`
      INSERT INTO documents (load_id, filename, original_name, category, uploaded_by)
      VALUES (?, ?, ?, 'load_document', ?)
    `);
    req.files.forEach(file => {
      insertDoc.run(loadId, file.filename, file.originalname, req.session.user.id);
    });
  }
  res.redirect('/loads');
});

// Admin: Drivers management
app.get('/drivers', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const drivers = db.prepare("SELECT id, name, email, phone, pay_percentage, status, created_at FROM users WHERE role = 'driver' ORDER BY name").all();
  res.render('drivers', { user: req.session.user, drivers });
});

app.get('/drivers/new', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  res.render('driver-form', { user: req.session.user });
});

app.post('/drivers', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const bcrypt = require('bcryptjs');
  const { first_name, middle_initial, last_name, email, phone, address, pay_percentage, hire_date, dob } = req.body;
  const fullName = [first_name, middle_initial, last_name].filter(Boolean).join(' ');
  const tempPassword = Math.random().toString(36).slice(-8);
  const hash = bcrypt.hashSync(tempPassword, 10);
  try {
    const result = db.prepare(`
      INSERT INTO users (email, password, role, name, first_name, middle_initial, last_name, phone, address, pay_percentage, hire_date, dob, must_change_password)
      VALUES (?, ?, 'driver', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(email, hash, fullName, first_name, middle_initial, last_name, phone, address, pay_percentage || null, hire_date, dob);
    res.render('driver-created', { user: req.session.user, email, tempPassword, name: fullName, driverId: result.lastInsertRowid });
  } catch (e) {
    res.render('driver-form', { user: req.session.user, error: 'Email already exists or invalid data' });
  }
});

app.post('/drivers/:id/send-welcome', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const driver = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!driver) return res.redirect('/drivers');
  // Placeholder: in production this will send email via configured service (e.g. from Logan)
  // For now, record the action and show confirmation
  console.log(`Welcome email would be sent to ${driver.email} with temporary password`);
  res.render('welcome-sent', { user: req.session.user, driver });
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

app.get('/drivers/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const driver = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(req.params.id, 'driver');
  if (!driver) return res.redirect('/drivers');
  const docs = db.prepare('SELECT * FROM driver_documents WHERE driver_id = ?').all(req.params.id);
  res.render('driver-profile', { user: req.session.user, driver, docs });
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
  db.prepare(`
    UPDATE compliance_items
    SET name = ?, expiration_date = ?, notes = ?
    WHERE id = ?
  `).run(
    String(req.body.name || '').trim(),
    blankToNull(req.body.expiration_date),
    blankToNull(req.body.notes),
    req.params.id
  );
  res.redirect('/compliance');
});

function readEquipment(body) {
  const maintenance = ['active', 'maintenance', 'out_of_service'].includes(body.maintenance_status)
    ? body.maintenance_status
    : 'active';
  return {
    type: body.type === 'trailer' ? 'trailer' : 'truck',
    number: String(body.number || '').trim(),
    description: String(body.description || '').trim(),
    ownership: String(body.ownership || '').trim(),
    registration_expiration: blankToNull(body.registration_expiration),
    inspection_expiration: blankToNull(body.inspection_expiration),
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
      type, number, description, ownership, registration_expiration, inspection_expiration, maintenance_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(item.type, item.number, item.description, item.ownership, item.registration_expiration, item.inspection_expiration, item.maintenance_status);
  res.redirect('/equipment');
});

app.post('/equipment/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const item = readEquipment(req.body);
  db.prepare(`
    UPDATE equipment
    SET type = ?, number = ?, description = ?, ownership = ?, registration_expiration = ?, inspection_expiration = ?, maintenance_status = ?
    WHERE id = ?
  `).run(item.type, item.number, item.description, item.ownership, item.registration_expiration, item.inspection_expiration, item.maintenance_status, req.params.id);
  res.redirect('/equipment');
});

// Fuel rate
function calculateSurchargePercent(currentRate) {
  const base = 4.00;
  const diff = Math.max(0, currentRate - base);
  return (diff / 0.10) * 0.1;
}

app.get('/fuel-rate', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const latest = db.prepare('SELECT * FROM fuel_rates ORDER BY effective_date DESC LIMIT 1').get();
  res.render('fuel-rate', { user: req.session.user, latest });
});

app.post('/fuel-rate', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const { central_atlantic_rate, effective_date } = req.body;
  const rate = parseFloat(central_atlantic_rate);
  const percent = calculateSurchargePercent(rate);
  db.prepare(`
    INSERT INTO fuel_rates (effective_date, central_atlantic_rate, surcharge_percent)
    VALUES (?, ?, ?)
  `).run(effective_date || new Date().toISOString().slice(0, 10), rate, percent);
  res.redirect('/fuel-rate');
});

// Fuel
app.get('/fuel', requireAuth, (req, res) => {
  const rates = db.prepare('SELECT * FROM fuel_rates ORDER BY effective_date DESC').all();
  const current = rates[0] || null;
  res.render('fuel', { user: req.session.user, current, rates });
});

// Profile
app.get('/profile', requireAuth, (req, res) => {
  const profile = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', { user: req.session.user, profile });
});

// Settlements and customer invoices (admin)
app.get('/settlements', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const approvedLoads = db.prepare(loadQuery + ` WHERE l.status = 'approved' ORDER BY c.name, p.display_name, l.load_date`).all();
  const latestFuel = db.prepare('SELECT * FROM fuel_rates ORDER BY effective_date DESC, id DESC LIMIT 1').get();
  const surchargePercent = latestFuel && latestFuel.surcharge_percent != null ? Number(latestFuel.surcharge_percent) : 0;

  const byDriver = {};
  approvedLoads.forEach((load) => {
    const key = load.driver_name || 'Unassigned';
    if (!byDriver[key]) {
      byDriver[key] = {
        driver: key,
        percentage: load.pay_percentage,
        loads: [],
        linehaul: 0,
        driveTime: 0,
        selfLoad: 0,
        total: 0
      };
    }
    const qty = Number(load.weight_quantity) || 0;
    const rate = Number(load.rate) || 0;
    const pct = Number(load.pay_percentage) || 0;
    // Driver pay is base linehaul plus drive time and self load. Fuel surcharge is never included.
    const linehaul = qty * rate * (pct / 100);
    const driveTime = Number(load.drive_time_amount) || 0;
    const selfLoad = Number(load.self_load_amount) || 0;
    const pay = linehaul + driveTime + selfLoad;
    byDriver[key].loads.push({ ...load, linehaul, driveTime, selfLoad, pay });
    byDriver[key].linehaul += linehaul;
    byDriver[key].driveTime += driveTime;
    byDriver[key].selfLoad += selfLoad;
    byDriver[key].total += pay;
  });

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
    const travelTime = Number(load.drive_time_amount) || 0;
    const selfLoad = Number(load.self_load_amount) || 0;
    const lineFsc = Number(load.has_fuel_surcharge) === 1 ? hauling * (surchargePercent / 100) : 0;
    byProject[key].loads.push({ ...load, hauling, travelTime, selfLoad, lineFsc });
    byProject[key].hauling += hauling;
    if (Number(load.has_fuel_surcharge) === 1) byProject[key].fscBase += hauling;
    byProject[key].travelTime += travelTime;
    byProject[key].selfLoad += selfLoad;
  });

  const customerInvoices = Object.values(byProject).map((invoice) => {
    invoice.fuelSurcharge = invoice.fscBase * (surchargePercent / 100);
    invoice.total = invoice.hauling + invoice.fuelSurcharge + invoice.travelTime + invoice.selfLoad;
    return invoice;
  });

  res.render('settlements', {
    user: req.session.user,
    approvedLoads,
    driverSettlements: Object.values(byDriver),
    customerInvoices,
    surchargePercent,
    fuelRate: latestFuel || null
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DT1 TMS running on port ${PORT}`);
});
