const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

// GET /api/poc/drivers — POC sees their station's drivers
router.get('/drivers', auth, requireRole('poc','admin','manager'), async (req, res) => {
  try {
    let station = req.query.station
    if (req.user.role === 'poc' && !station) {
      const emp = await query('SELECT station FROM employees WHERE id=$1', [req.user.emp_id])
      station   = emp.rows[0]?.station
    }
    const sql  = station
      ? 'SELECT * FROM employees WHERE station=$1 AND dept=\'Operations\' ORDER BY name'
      : 'SELECT * FROM employees WHERE dept=\'Operations\' ORDER BY name'
    const result = await query(sql, station ? [station] : [])
    res.json({ drivers: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/poc/stations
router.get('/stations', auth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM stations WHERE active=TRUE ORDER BY name')
    res.json({ stations: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/poc/stations
router.post('/stations', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { name, location } = req.body
    const result = await query(
      `INSERT INTO stations (name, location) VALUES ($1,$2) RETURNING *`,
      [name, location||null]
    )
    res.status(201).json({ station: result.rows[0] })
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error: 'Station name already exists' })
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/poc/announcements
router.get('/announcements', auth, async (req, res) => {
  try {
    const { station } = req.query
    let empStation = station
    if (req.user.role === 'driver') {
      const emp   = await query('SELECT station FROM employees WHERE id=$1', [req.user.emp_id])
      empStation  = emp.rows[0]?.station
    }
    let sql = `SELECT a.*, u.name AS posted_by_name FROM announcements a LEFT JOIN users u ON a.posted_by=u.id WHERE 1=1`
    const vals = []
    if (empStation) {
      vals.push(empStation)
      sql += ` AND (a.station IS NULL OR a.station=$${vals.length})`
    }
    sql += ' ORDER BY a.created_at DESC LIMIT 20'
    const result = await query(sql, vals)
    res.json({ announcements: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/poc/announcements
router.post('/announcements', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { title, body, station } = req.body
    if (!title || !body) return res.status(400).json({ error: 'title and body required' })

    // If POC, auto-assign their station
    let resolvedStation = station
    if (req.user.role === 'poc' && !resolvedStation) {
      const emp = await query('SELECT station FROM employees WHERE id=$1', [req.user.emp_id])
      resolvedStation = emp.rows[0]?.station
    }

    const result = await query(
      `INSERT INTO announcements (title, body, station, posted_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [title, body, resolvedStation||null, req.user.id]
    )
    req.io?.emit('announcement:new', result.rows[0])
    res.status(201).json({ announcement: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
