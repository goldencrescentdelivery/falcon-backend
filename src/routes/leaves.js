const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

router.get('/', auth, async (req, res) => {
  try {
    const { status, emp_id } = req.query
    let sql  = `SELECT l.*, e.name, e.avatar FROM leaves l JOIN employees e ON l.emp_id=e.id WHERE 1=1`
    const vals = []

    if (req.user.role === 'driver') {
      vals.push(req.user.emp_id); sql += ` AND l.emp_id=$${vals.length}`
    } else {
      if (emp_id) { vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}` }
      if (status) { vals.push(status); sql += ` AND l.status=$${vals.length}` }
    }

    sql += ' ORDER BY l.created_at DESC'
    const result = await query(sql, vals)
    res.json({ leaves: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
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
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.patch('/:id/status', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { status } = req.body
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
    const result = await query(
      `UPDATE leaves SET status=$1, approved_by=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [status, req.user.id, req.params.id]
    )
    req.io?.emit('leave:updated', result.rows[0])
    res.json({ leave: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    await query('DELETE FROM leaves WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
