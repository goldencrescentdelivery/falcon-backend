const router  = require('express').Router()
const multer  = require('multer')
const { query } = require('../db/pool')
const { createBackup, restoreBackup } = require('../db/backup')
const { auth, requireRole } = require('../middleware/auth')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
      cb(null, true)
    } else {
      cb(new Error('Only .json backup files are accepted'))
    }
  },
})

// GET /api/backup/download — download full JSON backup
router.get('/download', auth, requireRole('admin'), async (req, res) => {
  try {
    console.log(`🔒 Backup requested by ${req.user.name}`)
    const { json, totalRows, sizeBytes } = await createBackup(req.user.id)
    const filename = `gcd_backup_${new Date().toISOString().slice(0,10)}.json`
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', sizeBytes)
    res.send(json)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Backup failed: ' + err.message })
  }
})

// GET /api/backup/history — last 20 backups
router.get('/history', auth, requireRole('admin'), async (req, res) => {
  try {
    const result = await query(`
      SELECT b.*, u.name AS triggered_by_name
      FROM backup_log b LEFT JOIN users u ON b.triggered_by=u.id
      ORDER BY b.created_at DESC LIMIT 20
    `)
    res.json({ backups: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/backup/stats — database size stats
router.get('/stats', auth, requireRole('admin'), async (req, res) => {
  try {
    const tables = ['employees','attendance','leaves','salary_deductions','payroll','daily_deliveries','compliance_fines']
    const counts = await Promise.all(tables.map(t =>
      query(`SELECT COUNT(*) c FROM ${t}`).then(r => ({ table: t, rows: parseInt(r.rows[0].c) }))
    ))
    const lastBackup = await query(`SELECT * FROM backup_log ORDER BY created_at DESC LIMIT 1`)
    res.json({
      tables: counts,
      total_rows: counts.reduce((s,t)=>s+t.rows,0),
      last_backup: lastBackup.rows[0] || null
    })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/backup/restore — upload a backup JSON file and restore all tables
router.post('/restore', auth, requireRole('admin'), upload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No backup file uploaded' })

  let backupData
  try {
    backupData = JSON.parse(req.file.buffer.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'Invalid JSON — file could not be parsed' })
  }

  if (!backupData.tables) {
    return res.status(400).json({ error: 'Invalid backup format: missing tables field' })
  }

  try {
    console.log(`🔄 Restore started by ${req.user.name}`)
    const result = await restoreBackup(backupData, req.user.id)
    console.log(`✅ Restore complete — ${result.totalRows} rows restored`)
    res.json({
      message: 'Restore completed successfully',
      totalRows: result.totalRows,
      tablesRestored: result.tablesRestored,
      summary: result.summary,
    })
  } catch (err) {
    console.error('Restore failed:', err)
    res.status(500).json({ error: 'Restore failed: ' + err.message })
  }
})

module.exports = router
