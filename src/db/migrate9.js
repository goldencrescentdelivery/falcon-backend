const { pool } = require('./pool')
require('dotenv').config()

const SQL = `
CREATE TABLE IF NOT EXISTS vehicle_handovers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  emp_id          TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  station_code    TEXT,
  type            TEXT NOT NULL CHECK (type IN ('received','returned')),
  photo_1         TEXT,
  photo_2         TEXT,
  photo_3         TEXT,
  photo_4         TEXT,
  photos_expire_at TIMESTAMPTZ,
  photos_cleaned  BOOLEAN DEFAULT false,
  odometer        INTEGER,
  fuel_level      TEXT CHECK (fuel_level IN ('empty','quarter','half','three_quarter','full')),
  condition_note  TEXT,
  handover_to     TEXT,
  handover_from   TEXT,
  status          TEXT DEFAULT 'accepted',
  submitted_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handovers_vehicle  ON vehicle_handovers(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_handovers_emp      ON vehicle_handovers(emp_id);
CREATE INDEX IF NOT EXISTS idx_handovers_date     ON vehicle_handovers(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_handovers_expire   ON vehicle_handovers(photos_expire_at) WHERE photos_cleaned=false;
`

async function migrate9() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v9 migrations...')
    await client.query(SQL)
    console.log('✅ Vehicle handovers table created with photo expiry support')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}
migrate9()