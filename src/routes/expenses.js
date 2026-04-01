const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const V = require('../middleware/validate')

router.get('/', auth, async (req, res) => {
  try {
    const { status, emp_id } = req.query
    let sql  = `SELECT ex.*, e.name, e.avatar, e.station_code AS emp_station FROM expenses ex JOIN employees e ON ex.emp_id=e.id WHERE 1=1`
    const vals = []
    if (req.user.role === 'driver') {
      vals.push(req.user.emp_id); sql += ` AND ex.emp_id=$${vals.length}`
    } else {
      if (emp_id) { vals.push(emp_id); sql += ` AND ex.emp_id=$${vals.length}` }
      if (status) { vals.push(status); sql += ` AND ex.status=$${vals.length}` }
    }
    sql += ' ORDER BY ex.date DESC'
    const result = await query(sql, vals)
    res.json({ expenses: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/', auth, V.validateExpense, async (req, res) => {
  try {
    const { emp_id, category, amount, date, description } = req.body
    const actualEmpId = req.user.role === 'driver' ? req.user.emp_id : emp_id
    const result = await query(`
      INSERT INTO expenses (emp_id, category, amount, date, description)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [actualEmpId, category, amount, date||new Date().toISOString().slice(0,10), description||null])
    req.io?.emit('expense:created', result.rows[0])
    res.status(201).json({ expense: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.patch('/:id/status', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const { status } = req.body
    const result = await query(
      `UPDATE expenses SET status=$1, approved_by=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [status, req.user.id, req.params.id]
    )
    req.io?.emit('expense:updated', result.rows[0])
    res.json({ expense: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.put('/:id', auth, requireRole('admin','accountant'), async (req, res) => {
  try {
    const { category, amount, date, description, status, emp_id } = req.body
    const result = await query(
      `UPDATE expenses SET category=COALESCE($1,category), amount=COALESCE($2,amount), date=COALESCE($3,date), description=COALESCE($4,description), status=COALESCE($5,status), emp_id=COALESCE($6,emp_id), updated_at=NOW() WHERE id=$7 RETURNING *`,
      [category||null, amount||null, date||null, description||null, status||null, emp_id||null, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Expense not found' })
    req.io?.emit('expense:updated', result.rows[0])
    res.json({ expense: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/:id', auth, requireRole('admin','accountant'), async (req, res) => {
  try {
    await query('DELETE FROM expenses WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router