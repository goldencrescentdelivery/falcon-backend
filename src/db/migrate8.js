const { pool } = require('./pool')
require('dotenv').config()

const SQL = `
-- Fix users table — add missing columns safely
ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- Fix role constraint to include all 7 roles
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','manager','general_manager','hr','accountant','poc','driver'));

-- Fix employees station constraint
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_station_code_check;
ALTER TABLE employees ADD CONSTRAINT employees_station_code_check
  CHECK (station_code IN ('DDB1','DXE6'));

-- Update old station codes in all tables
UPDATE employees SET station_code = 'DDB1' WHERE station_code IN ('DDB7','DSH6');
UPDATE employees SET station_code = 'DXE6' WHERE station_code IN ('DDB6','DXD3');
UPDATE users     SET station_code = 'DDB1' WHERE station_code IN ('DDB7','DSH6');
UPDATE users     SET station_code = 'DXE6' WHERE station_code IN ('DDB6','DXD3');
UPDATE vehicles  SET station_code = 'DDB1' WHERE station_code IN ('DDB7','DSH6') AND station_code IS NOT NULL;
UPDATE vehicles  SET station_code = 'DXE6' WHERE station_code IN ('DDB6','DXD3') AND station_code IS NOT NULL;
UPDATE sim_cards SET station_code = 'DDB1' WHERE station_code IN ('DDB7','DSH6') AND station_code IS NOT NULL;
UPDATE sim_cards SET station_code = 'DXE6' WHERE station_code IN ('DDB6','DXD3') AND station_code IS NOT NULL;

-- Update old role values
UPDATE users SET role = 'accountant'      WHERE role = 'finance';
UPDATE users SET role = 'general_manager' WHERE role = 'dispatcher';
`

async function migrate8() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running v8 migrations...')
    await client.query(SQL)
    console.log('✅ v8 complete — all constraints and station codes fixed')
  } catch (err) {
    console.error('❌', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}
migrate8()
