const { pool } = require('./pool')
require('dotenv').config()

// Syncs roles CHECK constraint and drops plain_password column if it still exists
const SQL = `
-- Update users role constraint to include all 7 roles used in the application
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','manager','general_manager','hr','accountant','poc','driver'));

-- Drop plain_password column if it exists (security: passwords must not be stored in plain text)
ALTER TABLE users DROP COLUMN IF EXISTS plain_password;
`

async function migrate8() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running migrate8 (role sync + plain_password removal)...')
    await client.query(SQL)
    console.log('✅ migrate8 complete')
  } catch (err) {
    console.error('❌ migrate8 failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate8()
