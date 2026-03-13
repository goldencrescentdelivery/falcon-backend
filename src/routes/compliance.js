const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

// ── Insurance ──────────────────────────────────────────────────
router.get('/insurance', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT i.*, e.name AS emp_name, e.role AS emp_role
      FROM insurance i LEFT JOIN employees e ON i.emp_id=e.id
      ORDER BY i.expiry ASC
    `)
    res.json({ policies: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/insurance', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const { emp_id, type, provider, policy_no, start_date, expiry, premium, coverage } = req.body
    const result = await query(`
      INSERT INTO insurance (emp_id, type, provider, policy_no, start_date, expiry, premium, coverage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [emp_id||null, type, provider, policy_no, start_date, expiry, premium, coverage||null])
    res.status(201).json({ policy: result.rows[0] })
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error: 'Policy number already exists' })
    res.status(500).json({ error: 'Server error' })
  }
})

router.put('/insurance/:id', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const { type, provider, policy_no, start_date, expiry, premium, coverage, status } = req.body
    const result = await query(`
      UPDATE insurance SET type=$1,provider=$2,policy_no=$3,start_date=$4,expiry=$5,premium=$6,coverage=$7,status=$8
      WHERE id=$9 RETURNING *
    `, [type, provider, policy_no, start_date, expiry, premium, coverage||null, status, req.params.id])
    res.json({ policy: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── Fines ──────────────────────────────────────────────────────
router.get('/fines', auth, async (req, res) => {
  try {
    const { status, emp_id } = req.query
    let sql  = `SELECT f.*, e.name AS emp_name, e.avatar FROM compliance_fines f LEFT JOIN employees e ON f.emp_id=e.id WHERE 1=1`
    const vals = []
    if (status) { vals.push(status); sql += ` AND f.status=$${vals.length}` }
    if (emp_id) { vals.push(emp_id); sql += ` AND f.emp_id=$${vals.length}` }
    sql += ' ORDER BY f.date DESC'
    const result = await query(sql, vals)
    res.json({ fines: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/fines', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const { emp_id, date, violation, amount, source, reference, notes } = req.body
    const result = await query(`
      INSERT INTO compliance_fines (emp_id, date, violation, amount, source, reference, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [emp_id||null, date||new Date().toISOString().slice(0,10), violation, amount, source, reference||null, notes||null])
    req.io?.emit('fine:created', result.rows[0])
    res.status(201).json({ fine: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.patch('/fines/:id/status', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const { status, paid_on } = req.body
    const result = await query(`
      UPDATE compliance_fines SET status=$1, paid_on=$2, updated_at=NOW() WHERE id=$3 RETURNING *
    `, [status, paid_on||null, req.params.id])
    req.io?.emit('fine:updated', result.rows[0])
    res.json({ fine: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
