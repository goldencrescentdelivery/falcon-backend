const { pool } = require('./pool')
require('dotenv').config()

const SQL = `
-- ── Petty Cash ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS petty_cash (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('allocation','expense')),
  amount       NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  expense_type TEXT,
  note         TEXT,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  date         DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pc_user ON petty_cash(user_id);
CREATE INDEX IF NOT EXISTS idx_pc_date ON petty_cash(date DESC);
CREATE INDEX IF NOT EXISTS idx_pc_type ON petty_cash(type);
`

async function migrate12() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v12 migrations...')
    await client.query(SQL)
    console.log('✅ v12 complete — petty_cash table created')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}
migrate12()
