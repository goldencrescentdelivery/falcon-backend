const { pool } = require('./pool')
require('dotenv').config()

const SQL = `
-- ── Expand user roles ─────────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check 
  CHECK (role IN ('admin','manager','general_manager','hr','accountant','poc','driver'));

-- ── Employee new fields ───────────────────────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_number   TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS project_type  TEXT DEFAULT 'pulser' CHECK (project_type IN ('pulser','cret'));
ALTER TABLE employees ADD COLUMN IF NOT EXISTS per_shipment_rate NUMERIC(6,3) DEFAULT 0.5;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS performance_bonus NUMERIC(8,2) DEFAULT 100;

-- ── Leave: 3-stage workflow (POC → HR/GM → Manager) ──────────
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS gm_status  TEXT DEFAULT 'waiting' CHECK (gm_status IN ('pending','approved','rejected','waiting'));
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS gm_id      UUID REFERENCES users(id);
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS gm_note    TEXT;
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS gm_actioned_at TIMESTAMPTZ;
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS mgr_status TEXT DEFAULT 'waiting' CHECK (mgr_status IN ('pending','approved','rejected','waiting'));
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS mgr_id     UUID REFERENCES users(id);
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS mgr_note   TEXT;
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS mgr_actioned_at TIMESTAMPTZ;

-- ── Payroll: store calculated net ────────────────────────────
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS project_type TEXT DEFAULT 'pulser';
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS total_hours  NUMERIC(8,2) DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS total_shipments INT DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS hourly_earnings NUMERIC(10,2) DEFAULT 0;
`

async function migrate6() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v6 migrations...')
    await client.query(SQL)
    console.log('✅ v6 migrations complete')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}
migrate6()
