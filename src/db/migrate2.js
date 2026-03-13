const { pool } = require('./pool')
require('dotenv').config()

// Run this AFTER the original migrate.js
// Adds new columns to existing tables without destroying data
const MIGRATIONS = `
-- ── Employee new fields ───────────────────────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS station_code   TEXT DEFAULT 'DDB7' CHECK (station_code IN ('DDB7','DDB6','DSH6','DXD3'));
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_rate    NUMERIC(6,2) DEFAULT 3.85;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS iloe_expiry    DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS annual_leave_start DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS amazon_id      TEXT;      -- Amazon DA ID
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emirates_id    TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS annual_leave_balance INT DEFAULT 30;

-- ── Attendance new fields (cycles + hours) ────────────────────
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS cycle         TEXT CHECK (cycle IN ('A','B','C','Beset','MR','FM','Rescue'));
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS cycle_hours   NUMERIC(4,2);  -- hours worked this session
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS hourly_rate   NUMERIC(6,2);  -- rate at time of log
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS earnings      NUMERIC(8,2);  -- computed: hours * rate
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS is_rescue     BOOLEAN DEFAULT FALSE;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS rescue_hours  NUMERIC(4,2);

-- ── Daily Deliveries (POC enters, admin sees on analytics) ────
CREATE TABLE IF NOT EXISTS daily_deliveries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_code TEXT NOT NULL DEFAULT 'DDB7',
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  total       INT NOT NULL DEFAULT 0,
  attempted   INT DEFAULT 0,
  successful  INT DEFAULT 0,
  returned    INT DEFAULT 0,
  notes       TEXT,
  logged_by   UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(station_code, date)
);

-- ── Payslip export log ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payslip_exports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id      TEXT REFERENCES employees(id),
  month       TEXT NOT NULL,
  exported_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Backup log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backup_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  size_bytes  BIGINT,
  tables      INT,
  rows        BIGINT,
  triggered_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_deliveries_station_date ON daily_deliveries(station_code, date);
CREATE INDEX IF NOT EXISTS idx_deliveries_date         ON daily_deliveries(date);
CREATE INDEX IF NOT EXISTS idx_attendance_cycle        ON attendance(cycle);
`

async function migrate2() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v2 migrations...')
    await client.query(MIGRATIONS)
    console.log('✅ v2 migrations complete')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate2()
