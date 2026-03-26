const { pool } = require('./pool')
require('dotenv').config()

const SQL = `
-- ── Work Number Assignment History ─────────────────────────────
CREATE TABLE IF NOT EXISTS work_number_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emp_id        TEXT,
  emp_name      TEXT,
  phone_number  TEXT NOT NULL,
  sim_id        UUID,
  action        TEXT NOT NULL CHECK (action IN ('assigned','reassigned','removed')),
  prev_emp_id   TEXT,
  prev_emp_name TEXT,
  performed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  performed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wnh_emp   ON work_number_history(emp_id);
CREATE INDEX IF NOT EXISTS idx_wnh_phone ON work_number_history(phone_number);
CREATE INDEX IF NOT EXISTS idx_wnh_at    ON work_number_history(performed_at DESC);
`

async function migrate11() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v11 migrations...')
    await client.query(SQL)
    console.log('✅ v11 complete — work_number_history table created')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}
migrate11()
