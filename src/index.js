// Prevent unhandled async errors from crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack)
})
process.on('SIGTERM', () => {
  console.log('[SIGTERM] Graceful shutdown')
  process.exit(0)
})

require('dotenv').config()
const express      = require('express')
const http         = require('http')
const { Server }   = require('socket.io')
const cors         = require('cors')
const helmet       = require('helmet')
const morgan       = require('morgan')
const compression  = require('compression')
const rateLimit    = require('express-rate-limit')
const cookieParser = require('cookie-parser')

const app    = express()
const server = http.createServer(app)

app.set('trust proxy', 1)

// ── CORS origins ───────────────────────────────────────────────
const CORS_ORIGINS = [
  'https://fms.falconfastdelivery.com',
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : []),
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
]

// ── Socket.io ──────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: CORS_ORIGINS, methods: ['GET','POST'], credentials: true }
})
require('./socket')(io)

// ── CORS — must be first so preflight OPTIONS never hits rate-limiter/helmet ──
const corsOptions = {
  origin: CORS_ORIGINS,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
  optionsSuccessStatus: 200,
}
app.use(cors(corsOptions))
app.options('*', cors(corsOptions))   // explicit preflight handler for all routes

// ── Security & other middleware ────────────────────────────────
app.use(compression())
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cookieParser())
app.use(express.json({ limit: '10mb' }))
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))

// Remove fingerprint header
app.disable('x-powered-by')

// ── Rate limiting ──────────────────────────────────────────────
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: JSON.stringify({ error: 'Too many login attempts. Try again in 15 minutes.' }),
  standardHeaders: true,
  legacyHeaders: false,
}))
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}))

app.use((req, _res, next) => { req.io = io; next() })
app.use(require('./middleware/audit'))

// ── Routes ─────────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'))
app.use('/api/employees',   require('./routes/employees'))
app.use('/api/attendance',  require('./routes/attendance'))
app.use('/api/payroll',     require('./routes/payroll'))
app.use('/api/leaves',      require('./routes/leaves'))
app.use('/api/compliance',  require('./routes/compliance'))
app.use('/api/expenses',    require('./routes/expenses'))
app.use('/api/poc',         require('./routes/poc'))
app.use('/api/analytics',   require('./routes/analytics'))
app.use('/api/deliveries',  require('./routes/deliveries'))
app.use('/api/backup',      require('./routes/backup'))
app.use('/api/vehicles',             require('./routes/vehicles'))
app.use('/api/vehicle-inspections',  require('./routes/vehicle-inspections'))
app.use('/api/documents',            require('./routes/documents'))
app.use('/api/sims',        require('./routes/sims'))
app.use('/api/handovers',   require('./routes/handovers'))
app.use('/api/performance', require('./routes/performance'))
app.use('/api/shifts',      require('./routes/shifts'))
app.use('/api/damage',      require('./routes/damage'))
app.use('/api/advances',    require('./routes/advances'))
app.use('/api/petty-cash',  require('./routes/petty-cash'))
app.use('/api/office',         require('./routes/office'))
app.use('/api/letters',        require('./routes/letters'))
app.use('/api/notifications',  require('./routes/notifications'))
app.use('/api/tasks',          require('./routes/tasks'))
app.use('/api/etisalat',            require('./routes/etisalat'))
app.use('/api/cartrack',            require('./routes/cartrack'))
app.use('/api/touchtraks',          require('./routes/touchtraks'))
app.use('/api/customers',          require('./routes/customers'))
app.use('/api/customer-invoices',  require('./routes/customer-invoices'))
app.use('/api/customer-receipts',  require('./routes/customer-receipts'))
app.use('/api/customer-ledger',    require('./routes/customer-ledger'))


// ── Health check ───────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status:'ok', ts:new Date().toISOString() }))

// ── 404 & error handler ────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Route not found' }))
app.use(require('./middleware/error'))

// ── Auto-migrate on startup ────────────────────────────────────
async function autoMigrate() {
  const { query } = require('./db/pool')
  const cols = [
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS sub_group_name        TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS beneficiary_first_name  TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS beneficiary_middle_name TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS beneficiary_last_name   TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS father_family_name      TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS dob                     DATE`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS gender                  TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS marital_status          TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS uid_number              TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS emirates_issuing_visa   TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS residential_location    TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_location           TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS passport_no             TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS email_id                TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS visa_file_no            TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS project_type            TEXT    DEFAULT 'pulser'`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS per_shipment_rate       NUMERIC DEFAULT 0.5`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS performance_bonus       NUMERIC DEFAULT 0`,
  ]
  for (const sql of cols) {
    try { await query(sql) } catch(e) { console.warn('migrate:', e.message) }
  }
  // office_documents & office_events (migrate15)
  const officeTables = [
    `CREATE TABLE IF NOT EXISTS office_documents (
      id             SERIAL PRIMARY KEY,
      name           TEXT NOT NULL,
      document_number TEXT,
      issued_by      TEXT,
      issue_date     DATE,
      expiry_date    DATE,
      category       TEXT DEFAULT 'other',
      notes          TEXT,
      file_url       TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE office_documents ADD COLUMN IF NOT EXISTS file_url TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS insurance_url TEXT`,
    `CREATE TABLE IF NOT EXISTS office_events (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT,
      event_date  DATE NOT NULL,
      event_type  TEXT DEFAULT 'other',
      created_by  INT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`,
  ]
  for (const sql of officeTables) {
    try { await query(sql) } catch(e) { console.warn('migrate office:', e.message) }
  }
  // vehicle_inspections (migrate15)
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS vehicle_inspections (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id       UUID REFERENCES vehicles(id) ON DELETE CASCADE,
        inspection_date  DATE NOT NULL,
        inspector_name   TEXT,
        approved_by_name TEXT,
        approved_by_date DATE,
        sections         JSONB DEFAULT '{}',
        additional_notes TEXT,
        status           TEXT DEFAULT 'completed',
        created_by       UUID REFERENCES users(id),
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_vi_vehicle_id ON vehicle_inspections(vehicle_id)`)
    await query(`CREATE INDEX IF NOT EXISTS idx_vi_date ON vehicle_inspections(inspection_date DESC)`)
  } catch(e) { console.warn('migrate vehicle_inspections:', e.message) }

  // notifications table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        body       TEXT,
        type       TEXT DEFAULT 'announcement',
        ref_id     UUID,
        read       BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at DESC)`)
  } catch(e) { console.warn('migrate notifications:', e.message) }

  // settings table (for VAPID keys etc.)
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
  } catch(e) { console.warn('migrate settings:', e.message) }

  // push_subscriptions table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
        endpoint   TEXT NOT NULL,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, endpoint)
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)`)
  } catch(e) { console.warn('migrate push_subscriptions:', e.message) }

  // petty_cash emp_id column for driver association
  try {
    await query(`ALTER TABLE petty_cash ADD COLUMN IF NOT EXISTS emp_id TEXT REFERENCES employees(id) ON DELETE SET NULL`)
  } catch(e) { console.warn('migrate petty_cash emp_id:', e.message) }

  // office_letters
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS office_letters (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ref_no           VARCHAR(30) UNIQUE NOT NULL,
        date             DATE NOT NULL DEFAULT CURRENT_DATE,
        to_name          TEXT,
        subject          TEXT,
        greeting         TEXT DEFAULT 'Dear Sir / Madam,',
        body             TEXT NOT NULL,
        created_by       TEXT,
        created_by_name  TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_letters_created ON office_letters(created_at DESC)`)
  } catch(e) { console.warn('migrate office_letters:', e.message) }

  // users — manager_type (migrate21)
  try {
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_type TEXT`)
  } catch(e) { console.warn('migrate users manager_type:', e.message) }

  // employees — amazon_transporter_id (migrate20)
  try {
    await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS amazon_transporter_id TEXT`)
  } catch(e) { console.warn('migrate amazon_transporter_id:', e.message) }

  // office_letters — signer fields (migrate19)
  try {
    await query(`ALTER TABLE office_letters ADD COLUMN IF NOT EXISTS signer_name     TEXT`)
    await query(`ALTER TABLE office_letters ADD COLUMN IF NOT EXISTS signer_title    TEXT`)
    await query(`ALTER TABLE office_letters ADD COLUMN IF NOT EXISTS signature_data  TEXT`)
    await query(`ALTER TABLE office_letters ADD COLUMN IF NOT EXISTS show_sign       BOOLEAN DEFAULT TRUE`)
    await query(`ALTER TABLE office_letters ADD COLUMN IF NOT EXISTS show_stamp      BOOLEAN DEFAULT TRUE`)
    await query(`ALTER TABLE office_letters ADD COLUMN IF NOT EXISTS show_qr         BOOLEAN DEFAULT TRUE`)
    await query(`ALTER TABLE office_letters ADD COLUMN IF NOT EXISTS status          TEXT DEFAULT 'approved'`)
  } catch(e) { console.warn('migrate office_letters signer:', e.message) }

  // tasks table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title                 TEXT NOT NULL,
        description           TEXT,
        assigned_to           UUID REFERENCES users(id) ON DELETE SET NULL,
        assigned_by           UUID REFERENCES users(id) ON DELETE SET NULL,
        deadline              DATE NOT NULL,
        due_at                TIMESTAMPTZ,
        priority              TEXT DEFAULT 'normal',
        status                TEXT DEFAULT 'pending',
        last_reminder_sent_at TIMESTAMPTZ,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)`)
    await query(`CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status)`)
    await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ`)
    await query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`)
  } catch(e) { console.warn('migrate tasks:', e.message) }

  // customers table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS customers (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name             TEXT NOT NULL,
        address          TEXT,
        trn_no           TEXT,
        opening_balance  NUMERIC DEFAULT 0,
        customer_type    TEXT DEFAULT 'sale_invoice',
        cost_center      TEXT,
        ncod_rate        NUMERIC,
        cod_rate         NUMERIC,
        rp_rate          NUMERIC,
        pickup_rate      NUMERIC,
        ncod_inv_rate    NUMERIC,
        cod_inv_rate     NUMERIC,
        rp_inv_rate      NUMERIC,
        pickup_inv_rate  NUMERIC,
        notes            TEXT,
        created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name)`)
  } catch(e) { console.warn('migrate customers:', e.message) }

  // customer_invoices table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS customer_invoices (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        invoice_date   DATE NOT NULL,
        invoice_no     TEXT,
        cost_center    TEXT,
        description    TEXT,
        invoice_amount NUMERIC NOT NULL DEFAULT 0,
        vat            NUMERIC NOT NULL DEFAULT 0,
        grand_total    NUMERIC NOT NULL DEFAULT 0,
        created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_cust_inv_customer ON customer_invoices(customer_id, invoice_date DESC)`)
  } catch(e) { console.warn('migrate customer_invoices:', e.message) }

  // customer_receipts table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS customer_receipts (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        receipt_date DATE NOT NULL,
        cost_center  TEXT,
        description  TEXT,
        credit       NUMERIC NOT NULL DEFAULT 0,
        created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_cust_rec_customer ON customer_receipts(customer_id, receipt_date DESC)`)
  } catch(e) { console.warn('migrate customer_receipts:', e.message) }

  // vehicle_handovers — two-actor flow columns (migrate18)
  try {
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS receiver_emp_id TEXT REFERENCES employees(id)`)
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS accepted_at     TIMESTAMPTZ`)
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ`)
    await query(`CREATE INDEX IF NOT EXISTS idx_handovers_receiver ON vehicle_handovers(receiver_emp_id)`)
  } catch(e) { console.warn('migrate vehicle_handovers two-actor cols:', e.message) }

  // vehicle_handovers — poc_pending status (no schema change needed, just status value)
  // vehicle_handovers photo columns + expiry
  try {
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photo_1 TEXT`)
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photo_2 TEXT`)
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photo_3 TEXT`)
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photo_4 TEXT`)
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photos_expire_at TIMESTAMPTZ`)
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photos_cleaned BOOLEAN DEFAULT FALSE`)
    await query(`CREATE INDEX IF NOT EXISTS idx_hv_photos_expire ON vehicle_handovers(photos_expire_at) WHERE photos_cleaned=false`)
  } catch(e) { console.warn('migrate vehicle_handovers photos:', e.message) }

  // Phase 9 — Workflow tables + seed
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS workflow_definitions (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        steps      JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`
      CREATE TABLE IF NOT EXISTS workflow_instances (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        definition_id TEXT REFERENCES workflow_definitions(id),
        entity_type   TEXT NOT NULL,
        entity_id     TEXT NOT NULL,
        current_step  INT  DEFAULT 1,
        status        TEXT DEFAULT 'active',
        history       JSONB DEFAULT '[]',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(entity_type, entity_id)
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_wi_entity ON workflow_instances(entity_type, entity_id)`)
    await query(`CREATE INDEX IF NOT EXISTS idx_wi_status ON workflow_instances(status)`)

    // Seed leave_approval definition (idempotent)
    await query(`
      INSERT INTO workflow_definitions (id, name, steps) VALUES (
        'leave_approval',
        'Leave Approval',
        $1::jsonb
      ) ON CONFLICT (id) DO NOTHING
    `, [JSON.stringify([
      { step: 1, role: 'poc',             label: 'POC Review'            },
      { step: 2, role: 'manager',         label: 'Manager Review'        },
      { step: 3, role: 'admin',           label: 'Admin Final Decision'  },
    ])])
  } catch(e) { console.warn('migrate workflow:', e.message) }

  // Phase 6 — Refresh tokens table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        family      UUID NOT NULL,
        revoked     BOOLEAN DEFAULT FALSE,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_rt_user    ON refresh_tokens(user_id)`)
    await query(`CREATE INDEX IF NOT EXISTS idx_rt_family  ON refresh_tokens(family)`)
    await query(`CREATE INDEX IF NOT EXISTS idx_rt_hash    ON refresh_tokens(token_hash)`)
  } catch(e) { console.warn('migrate refresh_tokens:', e.message) }

  // Phase 5 — RBAC permissions table + seed
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id         SERIAL PRIMARY KEY,
        role       TEXT NOT NULL,
        resource   TEXT NOT NULL,
        action     TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(role, resource, action)
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_perms_role ON permissions(role)`)

    // Seed core permissions — ON CONFLICT DO NOTHING makes re-runs safe
    const seeds = [
      // payroll
      ['admin',           'payroll', 'read'],
      ['admin',           'payroll', 'mark_paid'],
      ['admin',           'payroll', 'add_deduction'],
      ['admin',           'payroll', 'add_bonus'],
      ['accountant',      'payroll', 'read'],
      ['accountant',      'payroll', 'mark_paid'],
      ['accountant',      'payroll', 'add_deduction'],
      ['accountant',      'payroll', 'add_bonus'],
      ['general_manager', 'payroll', 'read'],
      ['general_manager', 'payroll', 'add_deduction'],
      ['general_manager', 'payroll', 'add_bonus'],
      ['manager',         'payroll', 'read'],
      ['manager',         'payroll', 'add_deduction'],
      ['manager',         'payroll', 'add_bonus'],
      // petty_cash
      ['admin',           'petty_cash', 'read'],
      ['admin',           'petty_cash', 'allocate'],
      ['admin',           'petty_cash', 'delete'],
      ['accountant',      'petty_cash', 'read'],
      ['accountant',      'petty_cash', 'allocate'],
      ['accountant',      'petty_cash', 'delete'],
      ['general_manager', 'petty_cash', 'read'],
      ['manager',         'petty_cash', 'read'],
      // leaves
      ['admin',           'leaves', 'read'],
      ['admin',           'leaves', 'approve'],
      ['admin',           'leaves', 'delete'],
      ['general_manager', 'leaves', 'read'],
      ['general_manager', 'leaves', 'approve'],
      ['general_manager', 'leaves', 'delete'],
      ['manager',         'leaves', 'read'],
      ['manager',         'leaves', 'approve'],
      ['poc',             'leaves', 'read'],
      ['poc',             'leaves', 'approve'],
      ['driver',          'leaves', 'read'],
      // employees
      ['admin',           'employees', 'read'],
      ['admin',           'employees', 'write'],
      ['admin',           'employees', 'delete'],
      ['general_manager', 'employees', 'read'],
      ['general_manager', 'employees', 'write'],
      ['manager',         'employees', 'read'],
      ['accountant',      'employees', 'read'],
      ['poc',             'employees', 'read'],
    ]
    for (const [role, resource, action] of seeds) {
      await query(
        `INSERT INTO permissions (role, resource, action) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [role, resource, action]
      )
    }
  } catch(e) { console.warn('migrate permissions:', e.message) }

  // Phase 2 — Audit log table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID,
        user_name   TEXT,
        user_role   TEXT,
        action      TEXT NOT NULL,
        entity      TEXT NOT NULL,
        entity_id   TEXT,
        old_value   JSONB,
        new_value   JSONB,
        ip_address  TEXT,
        user_agent  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_entity   ON audit_logs(entity, entity_id)`)
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_user     ON audit_logs(user_id)`)
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_logs(created_at DESC)`)
  } catch(e) { console.warn('migrate audit_logs:', e.message) }

  // Phase 1 — Performance indexes
  const indexes = [
    // attendance — list by employee+date, by date alone, by station+date
    `CREATE INDEX IF NOT EXISTS idx_att_emp_date      ON attendance(emp_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_att_date          ON attendance(date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_att_station_date  ON attendance(emp_id, date DESC)`,
    // leaves — lookup by employee, approval pipeline filter, status, recency
    `CREATE INDEX IF NOT EXISTS idx_leaves_emp        ON leaves(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_approval   ON leaves(poc_status, hr_status, mgr_status)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_status     ON leaves(status)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_created    ON leaves(created_at DESC)`,
    // payroll — lookup by employee, by period, by employee+period
    `CREATE INDEX IF NOT EXISTS idx_payroll_emp       ON payroll(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_payroll_period    ON payroll(month)`,
    `CREATE INDEX IF NOT EXISTS idx_payroll_emp_period ON payroll(emp_id, month)`,
    // petty_cash — balance queries, type filtering
    `CREATE INDEX IF NOT EXISTS idx_pc_user_date      ON petty_cash(user_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_pc_user_type      ON petty_cash(user_id, type)`,
    // employees — name search, station lookups
    `CREATE INDEX IF NOT EXISTS idx_emp_name          ON employees(name)`,
    `CREATE INDEX IF NOT EXISTS idx_emp_station       ON employees(station_code)`,
    `CREATE INDEX IF NOT EXISTS idx_emp_status        ON employees(status)`,
    // users — role lookups (used in notification fan-out, permission checks)
    `CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role)`,
    `CREATE INDEX IF NOT EXISTS idx_users_station     ON users(station_code)`,
    // vehicles — plate search, status filter
    `CREATE INDEX IF NOT EXISTS idx_vehicles_plate    ON vehicles(plate)`,
    `CREATE INDEX IF NOT EXISTS idx_vehicles_status   ON vehicles(status)`,
    // handovers — by emp, by submitted_at (actual sort column), by status, by station
    `CREATE INDEX IF NOT EXISTS idx_handovers_emp        ON vehicle_handovers(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_receiver   ON vehicle_handovers(receiver_emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_submitted  ON vehicle_handovers(submitted_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_status     ON vehicle_handovers(status)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_station    ON vehicle_handovers(station_code)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_vehicle    ON vehicle_handovers(vehicle_id, type, submitted_at DESC)`,
    // vehicle_assignments — carry-forward + date lookups
    `CREATE INDEX IF NOT EXISTS idx_va_vehicle_date      ON vehicle_assignments(vehicle_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_va_emp_date          ON vehicle_assignments(emp_id, date DESC)`,
    // advances — by employee
    `CREATE INDEX IF NOT EXISTS idx_advances_emp      ON salary_advances(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_advances_status   ON salary_advances(status)`,
    // expenses — by date
    `CREATE INDEX IF NOT EXISTS idx_expenses_date     ON expenses(date DESC)`,
    // damage — by vehicle, by date
    `CREATE INDEX IF NOT EXISTS idx_damage_vehicle    ON damage_reports(vehicle_id)`,
    `CREATE INDEX IF NOT EXISTS idx_damage_date       ON damage_reports(reported_at DESC)`,
    // sims — by employee
    `CREATE INDEX IF NOT EXISTS idx_sims_emp          ON sim_cards(emp_id)`,
  ]
  for (const sql of indexes) {
    try { await query(sql) } catch(e) { console.warn('index:', e.message) }
  }

  console.log('Auto-migration complete')
}

// ── Start ──────────────────────────────────────────────────────
// Listen immediately so Railway healthcheck passes, then migrate in background
const PORT = process.env.PORT || 3001
server.listen(PORT, '0.0.0.0', () => {
  console.log(`GCD API running on port ${PORT}`)

  // Run migrations and init tasks in background — don't block the healthcheck
  console.log('[startup] running autoMigrate...')
  autoMigrate().then(async () => {
    console.log('[startup] autoMigrate done, running VAPID init...')
    try { await require('./lib/webpush').initVapid() } catch(e) { console.warn('VAPID init:', e.message) }

    console.log('[startup] VAPID done, checking Redis...')
    try {
      const { pubClient, subClient, isAvailable } = require('./lib/redis')
      if (isAvailable && pubClient && subClient) {
        const { createAdapter } = require('@socket.io/redis-adapter')
        await Promise.all([pubClient.connect(), subClient.connect()])
        io.adapter(createAdapter(pubClient, subClient))
        console.log('[socket.io] Redis adapter attached')
      }
    } catch(e) { console.warn('[socket.io] Redis adapter failed:', e.message) }

    console.log('[startup] starting payroll worker...')
    try {
      const { startPayrollWorker } = require('./jobs/workers/payroll.worker')
      startPayrollWorker(io)
    } catch(e) { console.warn('[payroll-worker] startup failed:', e.message) }

    console.log('[startup] starting scheduler...')
    try { require('./jobs/scheduler').start() } catch(e) { console.warn('[scheduler] startup failed:', e.message) }

    console.log('[startup] ✅ SERVER FULLY READY')
  }).catch(e => { console.error('[startup] Migration failed:', e.message) })
})


