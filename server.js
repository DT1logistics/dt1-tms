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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helper functions available in all EJS templates (e.g. driver-profile.ejs)
app.locals.getStatusClass = function(exp) {
  if (!exp) return 'red';
  const days = Math.ceil((new Date(exp) - new Date()) / (1000 * 60 * 60 * 24));
  if (days < 0 || days <= 14) return 'red';
  if (days <= 60) return 'yellow';
  return 'green';
};

app.locals.getStatusText = function(exp) {
  if (!exp) return 'Missing';
  const days = Math.ceil((new Date(exp) - new Date()) / (1000 * 60 * 60 * 24));
  if (days < 0) return 'Expired';
  if (days <= 14) return 'Expiring ≤14 days';
  if (days <= 60) return 'Expiring ≤60 days';
  return 'Active';
};

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

    CREATE TABLE IF NOT EXISTS loads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT,
      load_date DATE,
      driver_id INTEGER,
      truck_id INTEGER,
      project_id INTEGER,
      description TEXT,
      weight_quantity REAL,
      status TEXT DEFAULT 'draft',
      submitted_by INTEGER,
      approved_by INTEGER,
      approved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES users(id)
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed admin if not exists
  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@dt1logistics.com');
  if (!admin) {
    const hash = bcrypt.hashSync('changeme123', 10);
    db.prepare(`INSERT INTO users (email, password, role, name) VALUES (?, ?, 'admin', 'Administrator')`)
      .run('admin@dt1logistics.com', hash);
  }
}

initDB();

// Routes
app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.must_change_password) {
      return res.redirect('/change-password');
    }
    res.render('dashboard', { user: req.session.user });
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

app.get('/change-password', requireAuth, (req, res) => {
  res.render('change-password', { user: req.session.user });
});

app.post('/change-password', requireAuth, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.render('change-password', { user: req.session.user, error: 'Password must be at least 6 characters' });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?').run(hash, req.session.user.id);
  req.session.user.must_change_password = 0;
  res.redirect('/');
});

// Loads routes
app.get('/loads', requireAuth, (req, res) => {
  let loads;
  if (req.session.user.role === 'admin') {
    loads = db.prepare(`
      SELECT l.*, u.name as driver_name 
      FROM loads l 
      LEFT JOIN users u ON l.driver_id = u.id 
      ORDER BY l.created_at DESC
    `).all();
  } else {
    loads = db.prepare(`
      SELECT * FROM loads WHERE driver_id = ? ORDER BY created_at DESC
    `).all(req.session.user.id);
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
  const drivers = req.session.user.role === 'admin' 
    ? db.prepare("SELECT id, name FROM users WHERE role = 'driver' AND status = 'active'").all() 
    : [];
  res.render('load-form', { user: req.session.user, load: {}, drivers });
});

app.post('/loads', requireAuth, upload.array('documents', 10), (req, res) => {
  const { ticket_number, load_date, description, weight_quantity, driver_id } = req.body;
  const assignedDriver = req.session.user.role === 'driver' ? req.session.user.id : (driver_id || null);
  const result = db.prepare(`
    INSERT INTO loads (ticket_number, load_date, driver_id, description, weight_quantity, status, submitted_by)
    VALUES (?, ?, ?, ?, ?, 'submitted', ?)
  `).run(ticket_number, load_date, assignedDriver, description, weight_quantity, req.session.user.id);
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
  res.redirect('/receipts');
});

// Compliance
app.get('/compliance', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  res.render('compliance', { user: req.session.user });
});

// Equipment
app.get('/equipment', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const trucks = db.prepare("SELECT * FROM equipment WHERE type = 'truck' ORDER BY number").all();
  const trailers = db.prepare("SELECT * FROM equipment WHERE type = 'trailer' ORDER BY number").all();
  res.render('equipment', { user: req.session.user, trucks, trailers });
});

app.get('/equipment/new', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  res.render('equipment-form', { user: req.session.user });
});

app.post('/equipment', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const { type, number, description, ownership } = req.body;
  db.prepare(`
    INSERT INTO equipment (type, number, description, ownership)
    VALUES (?, ?, ?, ?)
  `).run(type, number, description, ownership);
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
  `).run(effective_date || new Date().toISOString().slice(0,10), rate, percent);
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

// Settlements (admin)
app.get('/settlements', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/');
  const approvedLoads = db.prepare(`
    SELECT l.*, u.name as driver_name, u.pay_percentage
    FROM loads l
    LEFT JOIN users u ON l.driver_id = u.id
    WHERE l.status = 'approved'
    ORDER BY l.load_date DESC
  `).all();
  res.render('settlements', { user: req.session.user, approvedLoads });
});

app.listen(PORT, () => {
  console.log(`DT1 TMS running on port ${PORT}`);
});
