const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

router.get('/', auth, async (req, res) => {
  try {
    const { status, emp_id } = req.query
    let sql  = `SELECT l.*, e.name, e.avatar, e.station_code FROM leaves l JOIN employees e ON l.emp_id=e.id WHERE 1=1`
    const vals = []
    if (req.user.role === 'driver') {
      vals.push(req.user.emp_id); sql += ` AND l.emp_id=$${vals.length}`
    } else if (req.user.role === 'poc') {
      // POC only sees their station's DAs
      vals.push(req.user.station_code); sql += ` AND e.station_code=$${vals.length}`
    } else {
      if (emp_id) { vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}` }
      if (status) { vals.push(status); sql += ` AND l.status=$${vals.length}` }
    }
    sql += ' ORDER BY l.created_at DESC'
    const result = await query(sql, vals)
    res.json({ leaves: result.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.post('/', auth, async (req, res) => {
  try {
    const { emp_id, type, from_date, to_date, days, reason } = req.body
    const actualEmpId = req.user.role === 'driver' ? req.user.emp_id : emp_id
    const result = await query(`
      INSERT INTO leaves (emp_id, type, from_date, to_date, days, reason)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [actualEmpId, type, from_date, to_date, days, reason||null])
    req.io?.emit('leave:created', result.rows[0])
    res.status(201).json({ leave: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// PATCH /:id/status — POC approves for their station; admin/manager approve all
router.patch('/:id/status', auth, requireRole('admin','manager','poc','hr'), async (req, res) => {
  try {
    const { status, reason } = req.body
    // POC can only approve leaves for their station
    if (req.user.role === 'poc') {
      const check = await query(`
        SELECT l.id FROM leaves l JOIN employees e ON l.emp_id=e.id
        WHERE l.id=$1 AND e.station_code=$2
      `, [req.params.id, req.user.station_code])
      if (!check.rows[0]) return res.status(403).json({ error: 'Not your station' })
    }
    const result = await query(`
      UPDATE leaves SET status=$1, approved_by_poc=$2, poc_station=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [status, req.user.id, req.user.station_code||null, req.params.id])
    req.io?.emit('leave:updated', result.rows[0])
    res.json({ leave: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.delete('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    await query('DELETE FROM leaves WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
