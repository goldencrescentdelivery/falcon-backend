const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const V = require('../middleware/validate')

router.get('/', auth, async (req, res) => {
  try {
    let sql = `SELECT a.*, e.name, e.station_code FROM salary_advances a JOIN employees e ON a.emp_id=e.id WHERE 1=1`
    const vals = []
    if (req.user.role === 'driver') { vals.push(req.user.emp_id); sql += ` AND a.emp_id=$${vals.length}` }
    sql += ' ORDER BY a.created_at DESC'
    const result = await query(sql, vals)
    res.json({ advances: result.rows })
  } catch(err) { res.status(500).json({ error:'Server error' }) }
})

router.post('/', auth, V.validateAdvance, async (req, res) => {
  try {
    const { emp_id, amount, reason, month, deduct_month } = req.body
    const actualEmpId = req.user.role==='driver' ? req.user.emp_id : emp_id
    if (!actualEmpId||!amount||!month) return res.status(400).json({ error:'emp_id, amount, month required' })
    const result = await query(`
      INSERT INTO salary_advances (emp_id, amount, reason, month, deduct_month, status)
      VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *
    `, [actualEmpId, parseFloat(amount), reason||null, month, deduct_month||null])
    res.status(201).json({ advance: result.rows[0] })
  } catch(err) { res.status(500).json({ error:'Server error' }) }
})

router.patch('/:id', auth, V.validateParams({ id: 'uuid' }), V.validateAdvanceAction, requireRole('admin','manager','accountant'), async (req, res) => {
  try {
    const { status, review_note } = req.body
    const result = await query(`
      UPDATE salary_advances SET status=$1, review_note=$2, reviewed_by=$3, reviewed_at=NOW()
      WHERE id=$4 RETURNING *
    `, [status, review_note||null, req.user.id, req.params.id])
    // If approved, auto-create deduction for next month
    if (status==='approved' && result.rows[0]?.deduct_month) {
      const adv = result.rows[0]
      await query(`
        INSERT INTO salary_deductions (emp_id, month, type, amount, description)
        VALUES ($1,$3,'other',$2,'Salary Advance Recovery')
        ON CONFLICT DO NOTHING
      `, [adv.emp_id, adv.amount, adv.deduct_month]).catch(()=>{})
    }
    res.json({ advance: result.rows[0] })
  } catch(err) { res.status(500).json({ error:'Server error' }) }
})

module.exports = router