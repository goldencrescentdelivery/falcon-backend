const { pool } = require('./pool')
require('dotenv').config()

const SQL = `
-- ── SIM Cards table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sim_cards (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sim_number   TEXT NOT NULL UNIQUE,
  phone_number TEXT,
  carrier      TEXT DEFAULT 'Du',
  status       TEXT DEFAULT 'available' CHECK (status IN ('available','assigned','inactive','damaged')),
  emp_id       TEXT REFERENCES employees(id) ON DELETE SET NULL,
  station_code TEXT,
  assigned_at  TIMESTAMPTZ,
  assigned_by  UUID REFERENCES users(id),
  notes        TEXT,
  monthly_cost NUMERIC(8,2) DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sims_emp    ON sim_cards(emp_id);
CREATE INDEX IF NOT EXISTS idx_sims_status ON sim_cards(status);
CREATE INDEX IF NOT EXISTS idx_sims_station ON sim_cards(station_code);
`

async function migrate7() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v7 migrations...')
    await client.query(SQL)
    console.log('✅ v7 migrations complete')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}
migrate7()
