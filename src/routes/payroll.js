const router  = require('express').Router()
const { query } = require('../db/pool')
const { withTransaction } = require('../lib/transaction')
const { auth, requireRole } = require('../middleware/auth')
const V = require('../middleware/validate')
const { payrollQueue } = require('../lib/queue')

// GET /api/payroll?month=2024-12&emp_id=
router.get('/', auth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7)

    // Drivers are scoped to their own emp_id. If emp_id is null they have no
    // payroll record — return empty rather than leaking the entire list.
    if (req.user.role === 'driver') {
      if (!req.user.emp_id) return res.json({ payroll: [], month })
    }
    const empId = req.user.role === 'driver' ? req.user.emp_id : req.query.emp_id

    let sql = `
      SELECT
        e.id, e.name, e.role, e.dept, e.avatar, e.salary AS base_salary,
        e.hourly_rate, e.station_code, e.project_type, e.per_shipment_rate, e.performance_bonus,
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
    sql += ' GROUP BY e.id, e.name, e.role, e.dept, e.avatar, e.salary, e.hourly_rate, e.station_code, e.project_type, e.per_shipment_rate, e.performance_bonus, p.status, p.paid_on, p.net_pay, p.id ORDER BY e.name'

    const result = await query(sql, vals)
    if (!result.rows.length) return res.json({ payroll: [], month })

    // Batch-fetch deductions and bonuses in 2 queries instead of 2N
    const empIds = result.rows.map(r => r.id)
    const [deductionRows, bonusRows] = await Promise.all([
      query(
        `SELECT * FROM salary_deductions WHERE emp_id = ANY($1::uuid[]) AND month=$2 ORDER BY created_at`,
        [empIds, month]
      ),
      query(
        `SELECT * FROM salary_bonuses WHERE emp_id = ANY($1::uuid[]) AND month=$2 ORDER BY created_at`,
        [empIds, month]
      ),
    ])

    const deductionMap = {}
    const bonusMap     = {}
    for (const d of deductionRows.rows) {
      ;(deductionMap[d.emp_id] ||= []).push(d)
    }
    for (const b of bonusRows.rows) {
      ;(bonusMap[b.emp_id] ||= []).push(b)
    }

    const rows = result.rows.map(emp => ({
      ...emp,
      deductions: deductionMap[emp.id] || [],
      bonuses:    bonusMap[emp.id]     || [],
    }))

    res.json({ payroll: rows, month })
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/payroll/deductions – add a deduction
router.post('/deductions', auth, V.validatePayrollDeduction, requireRole('admin','manager','general_manager','accountant'), async (req, res) => {
  try {
    const { emp_id, month, type, amount, description, reference } = req.body
    const VALID_TYPES = ['traffic_fine','iloe_fee','iloe_fine','cash_variance','other']
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid deduction type' })
    if (!emp_id || !month || !amount) return res.status(400).json({ error: 'emp_id, month, amount required' })

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
router.delete('/deductions/:id', auth, requireRole('admin','accountant'), async (req, res) => {
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
router.post('/bonuses', auth, V.validatePayrollBonus, requireRole('admin','manager','general_manager','accountant'), async (req, res) => {
  try {
    const { emp_id, month, type='bonus', amount, description } = req.body
    if (!emp_id || !month || !amount) return res.status(400).json({ error: 'emp_id, month, amount required' })

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
router.post('/mark-paid', auth, requireRole('admin','accountant'), async (req, res) => {
  try {
    const { emp_id, month } = req.body
    if (!emp_id || !month) return res.status(400).json({ error: 'emp_id and month required' })
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' })

    // If Redis/BullMQ is available, enqueue and return immediately
    if (payrollQueue) {
      const job = await payrollQueue.add('mark-paid', { emp_id, month, paid_by: req.user.id })
      return res.json({ queued: true, job_id: job.id })
    }

    // Fallback: synchronous transaction (Redis unavailable)
    const payrollRecord = await withTransaction(async (client) => {
      const emp = await client.query('SELECT salary FROM employees WHERE id=$1 FOR UPDATE', [emp_id])
      const bon = await client.query(`SELECT COALESCE(SUM(amount),0) t FROM salary_bonuses    WHERE emp_id=$1 AND month=$2`, [emp_id, month])
      const ded = await client.query(`SELECT COALESCE(SUM(amount),0) t FROM salary_deductions WHERE emp_id=$1 AND month=$2`, [emp_id, month])

      const base   = parseFloat(emp.rows[0]?.salary || 0)
      const bonus  = parseFloat(bon.rows[0].t)
      const deduct = parseFloat(ded.rows[0].t)
      const net    = base + bonus - deduct

      const result = await client.query(`
        INSERT INTO payroll (emp_id, month, base_salary, total_bonuses, total_deductions, net_pay, status, paid_on, paid_by)
        VALUES ($1,$2,$3,$4,$5,$6,'paid',NOW(),$7)
        ON CONFLICT (emp_id, month) DO UPDATE SET status='paid', paid_on=NOW(), net_pay=$6, paid_by=$7, total_bonuses=$4, total_deductions=$5
        RETURNING *
      `, [emp_id, month, base, bonus, deduct, net, req.user.id])

      return result.rows[0]
    })

    req.audit('MARK_PAID', 'payroll', payrollRecord.id,
      null, { emp_id, month, net_pay: payrollRecord.net_pay, paid_by: req.user.id })

    req.io?.emit('payroll:paid', payrollRecord)
    res.json({ payroll: payrollRecord })
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router