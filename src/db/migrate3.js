const { pool } = require('./pool')
require('dotenv').config()

const MIGRATIONS = `
-- ── Users: add status + station_code for POC ─────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS station_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password TEXT; -- admin-visible, encrypted display only

-- ── Employees: rename amazon_id to transporter_id ────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS transporter_id TEXT;
UPDATE employees SET transporter_id = amazon_id WHERE transporter_id IS NULL AND amazon_id IS NOT NULL;

-- ── Attendance: add pay_type for DDB6 (daily rate) ───────────
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS pay_type   TEXT DEFAULT 'hourly' CHECK (pay_type IN ('hourly','daily'));
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS daily_rate NUMERIC(8,2);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS worker_type TEXT DEFAULT 'driver' CHECK (worker_type IN ('driver','helper'));

-- ── Leaves: track which POC approved ─────────────────────────
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS approved_by_poc UUID REFERENCES users(id);
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS poc_station     TEXT;

-- ── Fleet / Vehicles ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate         TEXT NOT NULL UNIQUE,
  make          TEXT,
  model         TEXT,
  year          INT,
  station_code  TEXT NOT NULL DEFAULT 'DDB7',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','grounded','maintenance','sold')),
  grounded_reason TEXT,
  grounded_since  DATE,
  grounded_until  DATE,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicle_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  emp_id      TEXT REFERENCES employees(id) ON DELETE SET NULL,
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  station_code TEXT,
  notes       TEXT,
  assigned_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vehicle_id, date)
);

CREATE INDEX IF NOT EXISTS idx_vehicles_station       ON vehicles(station_code);
CREATE INDEX IF NOT EXISTS idx_assignments_date       ON vehicle_assignments(date);
CREATE INDEX IF NOT EXISTS idx_assignments_vehicle    ON vehicle_assignments(vehicle_id);
`

async function migrate3() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v3 migrations...')
    await client.query(MIGRATIONS)
    console.log('✅ v3 migrations complete')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate3()
