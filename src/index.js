require('dotenv').config()
const express    = require('express')
const http       = require('http')
const { Server } = require('socket.io')
const cors       = require('cors')
const helmet     = require('helmet')
const morgan     = require('morgan')
const rateLimit    = require('express-rate-limit')
const cookieParser = require('cookie-parser')

const app    = express()
const server = http.createServer(app)

app.set('trust proxy', 1)

// ── Socket.io ──────────────────────────────────────────────────
const SOCKET_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : (process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000'])

const io = new Server(server, {
  cors: {
    origin:      SOCKET_ORIGINS,
    methods:     ['GET', 'POST'],
    credentials: true,
  }
})
require('./socket')(io)

// ── Security & Middleware ──────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}))
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
app.use('/api/notifications',  require('./routes/notifications'))

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

  // vehicle_handovers photo expiry columns
  try {
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photos_expire_at TIMESTAMPTZ`)
    await query(`ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photos_cleaned BOOLEAN DEFAULT FALSE`)
    await query(`CREATE INDEX IF NOT EXISTS idx_hv_photos_expire ON vehicle_handovers(photos_expire_at) WHERE photos_cleaned=false`)
  } catch(e) { console.warn('migrate vehicle_handovers photo expiry:', e.message) }

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
    `CREATE INDEX IF NOT EXISTS idx_att_station_date  ON attendance(station_code, date DESC)`,
    // leaves — lookup by employee, approval pipeline filter, status, recency
    `CREATE INDEX IF NOT EXISTS idx_leaves_emp        ON leaves(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_approval   ON leaves(poc_status, hr_status, mgr_status)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_status     ON leaves(status)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_created    ON leaves(created_at DESC)`,
    // payroll — lookup by employee, by period, by employee+period
    `CREATE INDEX IF NOT EXISTS idx_payroll_emp       ON payroll(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_payroll_period    ON payroll(month, year)`,
    `CREATE INDEX IF NOT EXISTS idx_payroll_emp_period ON payroll(emp_id, month, year)`,
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
    `CREATE INDEX IF NOT EXISTS idx_vehicles_plate    ON vehicles(plate_number)`,
    `CREATE INDEX IF NOT EXISTS idx_vehicles_status   ON vehicles(status)`,
    // handovers — by driver, by date
    `CREATE INDEX IF NOT EXISTS idx_handovers_driver  ON vehicle_handovers(driver_id)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_date    ON vehicle_handovers(handover_date DESC)`,
    // advances — by employee
    `CREATE INDEX IF NOT EXISTS idx_advances_emp      ON advances(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_advances_status   ON advances(status)`,
    // expenses — by date
    `CREATE INDEX IF NOT EXISTS idx_expenses_date     ON expenses(date DESC)`,
    // damage — by vehicle, by date
    `CREATE INDEX IF NOT EXISTS idx_damage_vehicle    ON damage_reports(vehicle_id)`,
    `CREATE INDEX IF NOT EXISTS idx_damage_date       ON damage_reports(date DESC)`,
    // sims — by employee
    `CREATE INDEX IF NOT EXISTS idx_sims_emp          ON sims(emp_id)`,
  ]
  for (const sql of indexes) {
    try { await query(sql) } catch(e) { console.warn('index:', e.message) }
  }

  console.log('Auto-migration complete')
}

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
autoMigrate().then(async () => {
  // Init VAPID keys after tables exist
  try { await require('./lib/webpush').initVapid() } catch(e) { console.warn('VAPID init:', e.message) }

  // Phase 8 — Redis adapter + payroll worker (no-op if REDIS_URL not set)
  try {
    const { pubClient, subClient, isAvailable } = require('./lib/redis')
    if (isAvailable && pubClient && subClient) {
      const { createAdapter } = require('@socket.io/redis-adapter')
      await Promise.all([pubClient.connect(), subClient.connect()])
      io.adapter(createAdapter(pubClient, subClient))
      console.log('[socket.io] Redis adapter attached')
    }
  } catch(e) { console.warn('[socket.io] Redis adapter failed:', e.message) }

  try {
    const { startPayrollWorker } = require('./jobs/workers/payroll.worker')
    startPayrollWorker(io)
  } catch(e) { console.warn('[payroll-worker] startup failed:', e.message) }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`GCD API running on port ${PORT}`)
  })
}).catch(e => {
  console.error('Migration failed, starting anyway:', e.message)
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`GCD API running on port ${PORT}`)
  })
})

// ── Daily photo cleanup ────────────────────────────────────────
async function runPhotoCleanup() {
  try {
    const { query } = require('./db/pool')
    let createClient
    try { createClient = require('@supabase/supabase-js').createClient } catch(e) { return }
    const expired = await query(`
      SELECT id, photo_1, photo_2, photo_3, photo_4
      FROM vehicle_handovers
      WHERE photos_expire_at < NOW() AND photos_cleaned = false
      AND (photo_1 IS NOT NULL OR photo_2 IS NOT NULL OR photo_3 IS NOT NULL OR photo_4 IS NOT NULL)
    `)
    if (!expired.rows.length) return
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY
    if (!supabaseUrl || !supabaseKey) return
    const supabase = createClient(supabaseUrl, supabaseKey)
    for (const row of expired.rows) {
      const paths = [row.photo_1,row.photo_2,row.photo_3,row.photo_4]
        .filter(Boolean)
        .map(url => { const m=url.match(/vehicle-photos\/(.+)/); return m?m[1]:null })
        .filter(Boolean)
      if (paths.length) await supabase.storage.from('vehicle-photos').remove(paths)
      await query(`UPDATE vehicle_handovers SET photo_1=NULL,photo_2=NULL,photo_3=NULL,photo_4=NULL,photos_cleaned=true,updated_at=NOW() WHERE id=$1`,[row.id])
    }
    console.log(`Cleanup: removed photos from ${expired.rows.length} handovers`)
  } catch(e) { console.error('Cleanup error:', e.message) }
}

runPhotoCleanup()
setInterval(runPhotoCleanup, 24*60*60*1000)