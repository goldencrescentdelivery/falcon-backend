const { pool } = require('./pool')
require('dotenv').config()

const SQL = `
ALTER TABLE vehicle_handovers
  ADD COLUMN IF NOT EXISTS receiver_emp_id TEXT REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS accepted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_handovers_receiver ON vehicle_handovers(receiver_emp_id);
`

async function migrate18() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v18 migrations...')
    await client.query(SQL)
    console.log('✅ vehicle_handovers: receiver_emp_id, accepted_at, completed_at added')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}
migrate18()
