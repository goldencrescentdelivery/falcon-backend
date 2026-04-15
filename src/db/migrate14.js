/**
 * Migration 14 — Extended employee fields
 *
 * Adds personal/identity fields required for WPS/visa records:
 *   sub_group_name, beneficiary_first_name, beneficiary_middle_name,
 *   beneficiary_last_name, father_family_name, dob, gender,
 *   marital_status, uid_number, emirates_issuing_visa,
 *   residential_location, work_location, passport_no,
 *   email_id, visa_file_no
 *
 * Run once: node src/db/migrate14.js
 */

require('dotenv').config()
const { query } = require('./pool')

async function migrate() {
  console.log('Running migration 14 — extended employee fields...')

  const columns = [
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS sub_group_name       TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS beneficiary_first_name  TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS beneficiary_middle_name TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS beneficiary_last_name   TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS father_family_name      TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS dob                     DATE`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS gender                  TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS marital_status          TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS uid_number              TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS emirates_issuing_visa   TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS residential_location    TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_location           TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS passport_no             TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS email_id                TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS visa_file_no            TEXT`,
  ]

  for (const sql of columns) {
    await query(sql)
    const col = sql.match(/ADD COLUMN IF NOT EXISTS (\S+)/)?.[1]
    console.log('  ✓', col)
  }

  console.log('\nMigration 14 complete.')
  process.exit(0)
}

migrate().catch(e => { console.error(e); process.exit(1) })
