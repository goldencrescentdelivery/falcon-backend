const { query, pool } = require('./pool')
require('dotenv').config()

// Tables to back up in order (respects foreign keys on restore)
const TABLES = [
  'stations', 'employees', 'users',
  'attendance', 'leaves',
  'salary_deductions', 'salary_bonuses', 'payroll',
  'expenses', 'documents', 'insurance', 'compliance_fines',
  'daily_deliveries', 'announcements', 'backup_log'
]

async function createBackup(triggeredBy = null) {
  const backup = {
    version: 2,
    created_at: new Date().toISOString(),
    database: 'golden_crescent_operations',
    tables: {}
  }

  let totalRows = 0
  for (const table of TABLES) {
    try {
      const res = await query(`SELECT * FROM ${table} ORDER BY created_at ASC NULLS LAST`)
      backup.tables[table] = res.rows
      totalRows += res.rows.length
      console.log(`  ✓ ${table}: ${res.rows.length} rows`)
    } catch (err) {
      console.warn(`  ⚠ ${table}: skipped (${err.message})`)
      backup.tables[table] = []
    }
  }

  const json      = JSON.stringify(backup, null, 2)
  const sizeBytes = Buffer.byteLength(json, 'utf8')

  // Log the backup
  try {
    await query(
      `INSERT INTO backup_log (size_bytes, tables, rows, triggered_by) VALUES ($1,$2,$3,$4)`,
      [sizeBytes, TABLES.length, totalRows, triggeredBy]
    )
  } catch {}

  console.log(`\n✅ Backup complete: ${totalRows} rows, ${(sizeBytes/1024).toFixed(1)} KB`)
  return { json, sizeBytes, totalRows, tables: TABLES.length }
}

// When run directly: node src/db/backup.js
if (require.main === module) {
  const fs   = require('fs')
  const path = require('path')
  createBackup().then(({ json, totalRows }) => {
    const filename = `gcd_backup_${new Date().toISOString().slice(0,10)}.json`
    const filepath = path.join(__dirname, '../../../../', filename)
    fs.writeFileSync(filepath, json)
    console.log(`📁 Saved to: ${filename}`)
    pool.end()
  }).catch(err => {
    console.error('❌ Backup failed:', err.message)
    process.exit(1)
  })
}

module.exports = { createBackup }
