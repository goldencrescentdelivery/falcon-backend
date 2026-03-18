const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
function validAmount(v) { const n = Number(v); return !isNaN(n) && n > 0 }

// GET /api/payroll?month=2024-12&emp_id=
router.get('/', auth, async (req, res) => {
  try {
    const month  = req.query.month || new Date().toISOString().slice(0, 7)
    const empId  = req.user.role === 'driver' ? req.user.emp_id : req.query.emp_id

    let sql = `
      SELECT
        e.id, e.name, e.role, e.dept, e.avatar, e.salary AS base_salary,
        COALESCE(SUM(DISTINCT sb.amount) FILTER (WHERE sb.month=$1), 0) AS bonus_total,
        COALESCE(SUM(DISTINCT sd.amount) FILTER (WHERE sd.month=$1), 0) AS deduction_total,
        p.status AS payroll_status, p.paid_on, p.net_pay, p.id AS payroll_id
      FROM employees e
      LEFT JOIN salary_bonuses sb    ON e.id=sb.emp_id    AND sb.month=$1
      LEFT JOIN salary_deductions sd ON e.id=sd.emp_id    AND sd.month=$1
      LEFT JOIN payroll p            ON e.id=p.emp_id     AND p.month=$1
      WHERE e.status != 'inactive'
    `
    const vals = [month]
    if (empId) { vals.push(empId); sql += ` AND e.id=$${vals.length}` }
    sql += ' GROUP BY e.id, e.name, e.role, e.dept, e.avatar, e.salary, p.status, p.paid_on, p.net_pay, p.id ORDER BY e.name'

    const result = await query(sql, vals)

    // Attach deduction line-items for each employee
    const rows = await Promise.all(result.rows.map(async (emp) => {
      const deductions = await query(
        `SELECT * FROM salary_deductions WHERE emp_id=$1 AND month=$2 ORDER BY created_at`,
        [emp.id, month]
      )
      const bonuses = await query(
        `SELECT * FROM salary_bonuses WHERE emp_id=$1 AND month=$2 ORDER BY created_at`,
        [emp.id, month]
      )
      return { ...emp, deductions: deductions.rows, bonuses: bonuses.rows }
    }))

    res.json({ payroll: rows, month })
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/payroll/deductions – add a deduction
router.post('/deductions', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const { emp_id, month, type, amount, description, reference } = req.body
    const VALID_TYPES = ['traffic_fine','iloe_fee','iloe_fine','cash_variance','other']
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid deduction type' })
    if (!emp_id || !month || !amount) return res.status(400).json({ error: 'emp_id, month, amount required' })
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' })
    if (!validAmount(amount)) return res.status(400).json({ error: 'amount must be a positive number' })

    const result = await query(`
      INSERT INTO salary_deductions (emp_id, month, type, amount, description, reference, added_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [emp_id, month, type, amount, description||null, reference||null, req.user.id])

    req.io?.emit('payroll:deduction_added', { deduction: result.rows[0], emp_id, month })
    res.status(201).json({ deduction: result.rows[0] })
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Server error' })
  }
})

// DELETE /api/payroll/deductions/:id
router.delete('/deductions/:id', auth, requireRole('admin','finance'), async (req, res) => {
  try {
    const result = await query('DELETE FROM salary_deductions WHERE id=$1 RETURNING *', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    req.io?.emit('payroll:deduction_removed', result.rows[0])
    res.json({ message: 'Deduction removed' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/payroll/bonuses
router.post('/bonuses', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const { emp_id, month, type='bonus', amount, description } = req.body
    if (!emp_id || !month || !amount) return res.status(400).json({ error: 'emp_id, month, amount required' })
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' })
    if (!validAmount(amount)) return res.status(400).json({ error: 'amount must be a positive number' })

    const result = await query(`
      INSERT INTO salary_bonuses (emp_id, month, type, amount, description, added_by)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [emp_id, month, type, amount, description||null, req.user.id])

    req.io?.emit('payroll:bonus_added', { bonus: result.rows[0], emp_id, month })
    res.status(201).json({ bonus: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/payroll/mark-paid
router.post('/mark-paid', auth, requireRole('admin','finance'), async (req, res) => {
  try {
    const { emp_id, month } = req.body
    if (!emp_id || !month) return res.status(400).json({ error: 'emp_id and month required' })
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' })
    // Recalculate totals on the fly
    const emp = await query('SELECT salary FROM employees WHERE id=$1', [emp_id])
    const bon = await query(`SELECT COALESCE(SUM(amount),0) t FROM salary_bonuses WHERE emp_id=$1 AND month=$2`, [emp_id, month])
    const ded = await query(`SELECT COALESCE(SUM(amount),0) t FROM salary_deductions WHERE emp_id=$1 AND month=$2`, [emp_id, month])

    const base   = parseFloat(emp.rows[0]?.salary || 0)
    const bonus  = parseFloat(bon.rows[0].t)
    const deduct = parseFloat(ded.rows[0].t)
    const net    = base + bonus - deduct

    const result = await query(`
      INSERT INTO payroll (emp_id, month, base_salary, total_bonuses, total_deductions, net_pay, status, paid_on, paid_by)
      VALUES ($1,$2,$3,$4,$5,$6,'paid',NOW(),$7)
      ON CONFLICT (emp_id, month) DO UPDATE SET status='paid', paid_on=NOW(), net_pay=$6, paid_by=$7, total_bonuses=$4, total_deductions=$5
      RETURNING *
    `, [emp_id, month, base, bonus, deduct, net, req.user.id])

    req.io?.emit('payroll:paid', result.rows[0])
    res.json({ payroll: result.rows[0] })
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router

// DELETE /api/payroll/bonuses/:id
router.delete('/bonuses/:id', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const result = await query('DELETE FROM salary_bonuses WHERE id=$1 RETURNING *', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    req.io?.emit('payroll:bonus_removed', result.rows[0])
    res.json({ message: 'Bonus removed' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})
