const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

// Auto-compute score for a DA for a given month
async function computeScore(empId, month) {
  const [start, end] = [`${month}-01`, `${month}-31`]

  const [att, lv, ded, workdays] = await Promise.all([
    query(`SELECT COUNT(*) FILTER (WHERE status='present') AS present,
                  COUNT(*) AS total FROM attendance
           WHERE emp_id=$1 AND date>=$2 AND date<=$3`, [empId, start, end]),
    query(`SELECT COUNT(*) AS leaves FROM leaves WHERE emp_id=$1 AND status='approved'
           AND from_date>=$2 AND from_date<=$3`, [empId, start, end]),
    query(`SELECT COALESCE(SUM(amount),0) AS total FROM payroll_deductions
           WHERE emp_id=$1 AND month=$2`, [empId, month]),
    query(`SELECT COUNT(DISTINCT date) AS days FROM attendance WHERE emp_id=$1
           AND date>=$2 AND date<=$3`, [empId, start, end]),
  ])

  const presentDays = parseInt(att.rows[0].present || 0)
  const totalLogged  = parseInt(workdays.rows[0].days || 1)
  const leaveCount   = parseInt(lv.rows[0].leaves || 0)
  const dedTotal     = parseFloat(ded.rows[0].total || 0)

  // Score components (each max 20)
  const attendanceScore  = Math.min(20, Math.round((presentDays / Math.max(totalLogged,1)) * 20))
  const deliveryScore    = 15 // placeholder until delivery targets implemented
  const complianceScore  = 20 // placeholder
  const leaveScore       = Math.max(0, 20 - (leaveCount * 5))
  const deductionScore   = dedTotal === 0 ? 20 : dedTotal < 100 ? 15 : dedTotal < 300 ? 10 : 5

  const total = attendanceScore + deliveryScore + complianceScore + leaveScore + deductionScore
  const grade = total >= 90 ? 'A+' : total >= 80 ? 'A' : total >= 70 ? 'B' : total >= 60 ? 'C' : 'D'

  await query(`
    INSERT INTO da_performance (emp_id, month, attendance_score, delivery_score, compliance_score, deduction_score, leave_score, total_score, grade)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (emp_id, month) DO UPDATE SET
      attendance_score=$3, delivery_score=$4, compliance_score=$5,
      deduction_score=$6, leave_score=$7, total_score=$8, grade=$9, computed_at=NOW()
  `, [empId, month, attendanceScore, deliveryScore, complianceScore, deductionScore, leaveScore, total, grade])

  return { attendanceScore, deliveryScore, complianceScore, leaveScore, deductionScore, total, grade }
}

// GET /api/performance?month=YYYY-MM
router.get('/', auth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0,7)
    const sc    = req.user.role === 'poc' ? req.user.station_code : req.query.station_code

    // Compute scores for all relevant employees
    let empQ = `SELECT id FROM employees WHERE status='active'`
    const vals = []
    if (sc) { vals.push(sc); empQ += ` AND station_code=$${vals.length}` }
    const emps = await query(empQ, vals)

    await Promise.all(emps.rows.map(e => computeScore(e.id, month)))

    // Return leaderboard
    let sql = `
      SELECT p.*, e.name, e.station_code, e.avatar
      FROM da_performance p JOIN employees e ON p.emp_id=e.id
      WHERE p.month=$1`
    const rvals = [month]
    if (sc) { rvals.push(sc); sql += ` AND e.station_code=$${rvals.length}` }
    sql += ` ORDER BY p.total_score DESC`

    const result = await query(sql, rvals)
    res.json({ scores: result.rows, month })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/performance/:empId — individual history
router.get('/:empId', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT p.*, e.name FROM da_performance p JOIN employees e ON p.emp_id=e.id
       WHERE p.emp_id=$1 ORDER BY p.month DESC LIMIT 12`,
      [req.params.empId]
    )
    res.json({ history: result.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
