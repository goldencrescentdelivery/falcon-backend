const { pool } = require('./pool')
require('dotenv').config()

const SCHEMA = `
-- ── Users (auth) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','manager','finance','poc','driver')),
  emp_id        TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Employees ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id              TEXT PRIMARY KEY,          -- e.g. E001
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,
  dept            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_leave','inactive')),
  salary          NUMERIC(10,2) NOT NULL DEFAULT 0,
  joined          DATE,
  phone           TEXT,
  nationality     TEXT,
  zone            TEXT,
  visa_expiry     DATE,
  license_expiry  DATE,
  avatar          TEXT DEFAULT '👤',
  station         TEXT,                      -- POC station assignment
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Attendance ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id      TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  check_in    TIME,
  check_out   TIME,
  status      TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','absent','leave','half_day')),
  note        TEXT,
  logged_by   UUID REFERENCES users(id),    -- POC who logged it
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(emp_id, date)
);

-- ── Leave Requests ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leaves (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('Annual','Sick','Emergency','Unpaid','Other')),
  from_date    DATE NOT NULL,
  to_date      DATE NOT NULL,
  days         INT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason       TEXT,
  approved_by  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Salary Deductions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS salary_deductions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month        TEXT NOT NULL,               -- e.g. '2024-12'
  type         TEXT NOT NULL CHECK (type IN ('traffic_fine','iloe_fee','iloe_fine','cash_variance','other')),
  amount       NUMERIC(10,2) NOT NULL,
  description  TEXT,
  reference    TEXT,
  added_by     UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Salary Bonuses ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS salary_bonuses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month        TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'bonus',
  amount       NUMERIC(10,2) NOT NULL,
  description  TEXT,
  added_by     UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Payroll Records ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month          TEXT NOT NULL,
  base_salary    NUMERIC(10,2) NOT NULL,
  total_bonuses  NUMERIC(10,2) DEFAULT 0,
  total_deductions NUMERIC(10,2) DEFAULT 0,
  net_pay        NUMERIC(10,2) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  paid_on        DATE,
  paid_by        UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(emp_id, month)
);

-- ── Expenses ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id      TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  amount      NUMERIC(10,2) NOT NULL,
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  description TEXT,
  approved_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Documents (visa, license etc.) ───────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id      TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,               -- 'visa','license','emirates_id','contract' etc.
  expiry      DATE,
  file_url    TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Insurance Policies ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insurance (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id      TEXT REFERENCES employees(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,               -- 'Health','Vehicle','Liability'
  provider    TEXT NOT NULL,
  policy_no   TEXT UNIQUE NOT NULL,
  start_date  DATE NOT NULL,
  expiry      DATE NOT NULL,
  premium     NUMERIC(10,2) NOT NULL,
  coverage    TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expiring','expired','cancelled')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── ILOE / Compliance Fines ───────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_fines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id      TEXT REFERENCES employees(id) ON DELETE SET NULL,
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  violation   TEXT NOT NULL,
  amount      NUMERIC(10,2) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','disputed')),
  paid_on     DATE,
  reference   TEXT,
  source      TEXT NOT NULL,              -- 'Amazon','iMile','Noon','Internal','Traffic'
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── POC Stations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  location    TEXT,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Announcements (POC → Drivers) ─────────────────────────────
CREATE TABLE IF NOT EXISTS announcements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  station     TEXT,
  posted_by   UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_attendance_emp_date   ON attendance(emp_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_date       ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_deductions_emp_month  ON salary_deductions(emp_id, month);
CREATE INDEX IF NOT EXISTS idx_bonuses_emp_month     ON salary_bonuses(emp_id, month);
CREATE INDEX IF NOT EXISTS idx_leaves_emp            ON leaves(emp_id);
CREATE INDEX IF NOT EXISTS idx_fines_emp             ON compliance_fines(emp_id);
CREATE INDEX IF NOT EXISTS idx_payroll_emp_month     ON payroll(emp_id, month);
`

async function migrate() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running migrations...')
    await client.query(SCHEMA)
    console.log('✅ Migrations complete')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate()
