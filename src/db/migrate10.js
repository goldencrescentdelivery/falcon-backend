const { pool } = require('./pool')
require('dotenv').config()

const SQL = `
-- ── DA Performance Scores (monthly) ──────────────────────────
CREATE TABLE IF NOT EXISTS da_performance (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id        TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month         TEXT NOT NULL,  -- YYYY-MM
  attendance_score  NUMERIC(5,2) DEFAULT 0,
  delivery_score    NUMERIC(5,2) DEFAULT 0,
  compliance_score  NUMERIC(5,2) DEFAULT 0,
  deduction_score   NUMERIC(5,2) DEFAULT 0,
  leave_score       NUMERIC(5,2) DEFAULT 0,
  total_score       NUMERIC(5,2) DEFAULT 0,
  grade             TEXT DEFAULT 'C',
  computed_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(emp_id, month)
);

-- ── Shift Roster ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shifts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  station_code TEXT NOT NULL,
  shift_date   DATE NOT NULL,
  shift_type   TEXT DEFAULT 'regular' CHECK (shift_type IN ('regular','rescue','off','leave')),
  cycle        TEXT,
  notes        TEXT,
  assigned_by  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(emp_id, shift_date)
);
CREATE INDEX IF NOT EXISTS idx_shifts_date    ON shifts(shift_date);
CREATE INDEX IF NOT EXISTS idx_shifts_station ON shifts(station_code);

-- ── Vehicle Damage Reports ────────────────────────────────────
CREATE TABLE IF NOT EXISTS damage_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id    UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  emp_id        TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  station_code  TEXT,
  description   TEXT NOT NULL,
  severity      TEXT DEFAULT 'minor' CHECK (severity IN ('minor','moderate','major','totaled')),
  photo_1       TEXT,
  photo_2       TEXT,
  photo_3       TEXT,
  photo_4       TEXT,
  repair_cost   NUMERIC(10,2),
  deduct_from_da BOOLEAN DEFAULT false,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','reviewed','resolved')),
  reviewed_by   UUID REFERENCES users(id),
  review_note   TEXT,
  reported_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_damage_vehicle ON damage_reports(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_damage_emp     ON damage_reports(emp_id);

-- ── Advance Salary Requests ───────────────────────────────────
CREATE TABLE IF NOT EXISTS salary_advances (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id       TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  amount       NUMERIC(10,2) NOT NULL,
  reason       TEXT,
  month        TEXT NOT NULL,
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by  UUID REFERENCES users(id),
  review_note  TEXT,
  reviewed_at  TIMESTAMPTZ,
  deduct_month TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_advances_emp ON salary_advances(emp_id);
`

async function migrate10() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v10 migrations...')
    await client.query(SQL)
    console.log('✅ v10 complete — performance, shifts, damage, advances')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}
migrate10()
