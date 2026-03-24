/**
 * Security Migration — Run once to harden the database
 * 1. Add password_changed_at column
 * 2. Add last_login_at column
 * 3. Add login_attempts table for persistent rate limiting
 * 4. DROP plain_password column (CRITICAL — removes stored plaintext passwords)
 * 5. Add indexes
 */

const { pool } = require('./pool')
require('dotenv').config({ path: '../../.env' })

const SQL = `
-- Add security columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at       TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts     INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until        TIMESTAMPTZ;

-- !! CRITICAL: Drop the plaintext password column !!
-- This permanently removes all stored plaintext passwords.
-- Make sure all users know their password before running this.
ALTER TABLE users DROP COLUMN IF EXISTS plain_password;

-- Index on email for fast login lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Index on status for active-user queries
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Audit log table for security events
CREATE TABLE IF NOT EXISTS security_audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  event      TEXT NOT NULL,  -- 'login_success', 'login_failed', 'password_changed', 'account_locked'
  ip_address TEXT,
  user_agent TEXT,
  metadata   JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_user    ON security_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_event   ON security_audit_log(event);
CREATE INDEX IF NOT EXISTS idx_audit_created ON security_audit_log(created_at);
`

async function migrate() {
  const client = await pool.connect()
  try {
    console.log('🔐 Running security migration...')
    await client.query(SQL)
    console.log('✅ Security migration complete')
    console.log('⚠️  plain_password column has been dropped')
    console.log('✅ password_changed_at, last_login_at columns added')
    console.log('✅ security_audit_log table created')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate()