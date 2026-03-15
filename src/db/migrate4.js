const { pool } = require('./pool')
require('dotenv').config()

const SQL = `
-- ── Leave two-stage approval workflow ────────────────────────
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS poc_status    TEXT DEFAULT 'pending' CHECK (poc_status IN ('pending','approved','rejected'));
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS hr_status     TEXT DEFAULT 'pending' CHECK (hr_status  IN ('pending','approved','rejected','waiting'));
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS poc_id        UUID REFERENCES users(id);
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS hr_id         UUID REFERENCES users(id);
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS poc_note      TEXT;
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS hr_note       TEXT;
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS poc_actioned_at  TIMESTAMPTZ;
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS hr_actioned_at   TIMESTAMPTZ;

-- ── Attendance: multi-cycle support ──────────────────────────
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS cycles    TEXT[];  -- e.g. ['A','FM','Rescue']
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS total_hours NUMERIC(5,2);

-- ── Employee-user link ────────────────────────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_id   UUID REFERENCES users(id);
`

async function migrate4() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v4 migrations...')
    await client.query(SQL)
    console.log('✅ v4 migrations complete')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}
migrate4()
