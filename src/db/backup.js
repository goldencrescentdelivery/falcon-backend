const { query, pool } = require('./pool')
require('dotenv').config()

// Restore order must respect FK dependencies:
//   stations → employees → users → everything else
const RESTORE_ORDER = [
  'stations', 'employees', 'users',
  'attendance', 'leaves',
  'salary_deductions', 'salary_bonuses', 'payroll',
  'expenses', 'documents', 'insurance', 'compliance_fines',
  'daily_deliveries', 'announcements', 'backup_log',
]

async function restoreBackup(backupData, restoredBy = null) {
  if (!backupData || typeof backupData.tables !== 'object') {
    throw new Error('Invalid backup format: missing tables object')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Disable FK + trigger checks for the duration of the restore so we can
    // delete/insert without worrying about dependency order.
    // Works on Supabase (postgres superuser) and standard PG.
    await client.query(`SET session_replication_role = 'replica'`)

    // Fetch current schema columns for every table so we can safely ignore
    // columns that were added/removed since the backup was taken.
    const colRes = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position
    `, [RESTORE_ORDER])

    const tableColumns = {}
    for (const row of colRes.rows) {
      ;(tableColumns[row.table_name] ||= []).push(row.column_name)
    }

    // DELETE backed-up tables in REVERSE order (safe even with FK disabled,
    // but the ordering makes intent clear). We only delete what we back up —
    // other tables (vehicles, SIMs, …) are left untouched.
    for (const tbl of [...RESTORE_ORDER].reverse()) {
      if (tableColumns[tbl]?.length) {
        await client.query(`DELETE FROM "${tbl}"`)
      }
    }

    const summary = {}

    // INSERT in FORWARD order, batched to stay well under PG's 65535 param limit.
    for (const tbl of RESTORE_ORDER) {
      const rows   = backupData.tables[tbl] || []
      const dbCols = tableColumns[tbl] || []

      if (!rows.length || !dbCols.length) { summary[tbl] = 0; continue }

      // Only columns that exist in current schema
      const backupKeys = Object.keys(rows[0])
      const cols       = backupKeys.filter(c => dbCols.includes(c))
      if (!cols.length) { summary[tbl] = 0; continue }

      // Max rows per batch: floor(65535 / cols.length), capped at 500
      const batchSize = Math.min(500, Math.floor(65535 / cols.length))
      const colList   = cols.map(c => `"${c}"`).join(',')
      let inserted    = 0

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch  = rows.slice(i, i + batchSize)
        const params = []
        const clauses = batch.map(row => {
          const rowParams = cols.map(c => {
            params.push(row[c] !== undefined ? row[c] : null)
            return `$${params.length}`
          })
          return `(${rowParams.join(',')})`
        })
        await client.query(
          `INSERT INTO "${tbl}" (${colList}) VALUES ${clauses.join(',')} ON CONFLICT DO NOTHING`,
          params
        )
        inserted += batch.length
      }

      summary[tbl] = inserted
      console.log(`  ✓ Restored ${tbl}: ${inserted} rows`)
    }

    // Re-enable FK + trigger checks
    await client.query(`SET session_replication_role = 'DEFAULT'`)
    await client.query('COMMIT')

    const totalRows = Object.values(summary).reduce((s, n) => s + n, 0)

    // Log the restore event (outside the transaction so it persists)
    try {
      await query(
        `INSERT INTO backup_log (size_bytes, tables, rows, triggered_by)
         VALUES ($1, $2, $3, $4)`,
        [0, RESTORE_ORDER.length, totalRows, restoredBy]
      )
    } catch {}

    console.log(`✅ Restore complete: ${totalRows} rows across ${RESTORE_ORDER.length} tables`)
    return { summary, totalRows, tablesRestored: RESTORE_ORDER.length }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

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

module.exports = { createBackup, restoreBackup }
