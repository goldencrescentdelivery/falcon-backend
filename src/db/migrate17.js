/**
 * Migration 17 — office_letters: status + show_sign + show_stamp
 * Run once: node src/db/migrate17.js
 */

require('dotenv').config()
const { query } = require('./pool')

async function migrate() {
  console.log('Running migration 17 — office_letters approval + sign/stamp...')

  await query(`ALTER TABLE office_letters ADD COLUMN IF NOT EXISTS status     TEXT    DEFAULT 'approved'`)
  await query(`ALTER TABLE office_letters ADD COLUMN IF NOT EXISTS show_sign  BOOLEAN DEFAULT true`)
  await query(`ALTER TABLE office_letters ADD COLUMN IF NOT EXISTS show_stamp BOOLEAN DEFAULT true`)

  console.log('  ✓ status, show_sign, show_stamp columns added')
  console.log('\nMigration 17 complete.')
  process.exit(0)
}

migrate().catch(e => { console.error(e); process.exit(1) })
