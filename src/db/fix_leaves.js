const { pool } = require('./pool')
require('dotenv').config()

async function fix() {
  const client = await pool.connect()
  try {
    console.log('🔧 Fixing leaves table columns...')
    await client.query(`
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS poc_status TEXT DEFAULT 'pending' CHECK (poc_status IN ('pending','approved','rejected'));
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS hr_status  TEXT DEFAULT 'waiting' CHECK (hr_status  IN ('pending','approved','rejected','waiting'));
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS gm_status  TEXT DEFAULT 'waiting' CHECK (gm_status  IN ('pending','approved','rejected','waiting'));
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS mgr_status TEXT DEFAULT 'waiting' CHECK (mgr_status IN ('pending','approved','rejected','waiting'));
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS poc_id     UUID REFERENCES users(id);
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS hr_id      UUID REFERENCES users(id);
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS gm_id      UUID REFERENCES users(id);
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS mgr_id     UUID REFERENCES users(id);
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS poc_note   TEXT;
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS hr_note    TEXT;
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS gm_note    TEXT;
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS mgr_note   TEXT;
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS poc_actioned_at  TIMESTAMPTZ;
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS hr_actioned_at   TIMESTAMPTZ;
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS gm_actioned_at   TIMESTAMPTZ;
      ALTER TABLE leaves ADD COLUMN IF NOT EXISTS mgr_actioned_at  TIMESTAMPTZ;
    `)
    console.log('✅ Leaves table fixed')
  } catch (err) {
    console.error('❌', err.message)
  } finally {
    client.release()
    await pool.end()
  }
}
fix()