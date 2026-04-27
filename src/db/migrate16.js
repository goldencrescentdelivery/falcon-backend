/**
 * Migration 16 — Add visa_type to employees
 * Run once: node src/db/migrate16.js
 */

require('dotenv').config()
const { query } = require('./pool')

async function migrate() {
  console.log('Running migration 16 — add visa_type to employees...')

  await query(`
    ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS visa_type TEXT DEFAULT 'company'
  `)
  console.log('  ✓ visa_type column added')

  await query(`
    UPDATE employees SET visa_type = 'company' WHERE visa_type IS NULL
  `)
  console.log('  ✓ existing rows defaulted to company')

  console.log('\nMigration 16 complete.')
  process.exit(0)
}

migrate().catch(e => { console.error(e); process.exit(1) })
