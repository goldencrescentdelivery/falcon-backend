const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

router.get('/summary', auth, requireRole('admin','manager','general_manager','hr','accountant','finance'), async (req, res) => {
  try {
    const [empCount, attToday, pendingLeaves, pendingFines, todayDeliveries] = await Promise.all([
      query(`SELECT COUNT(*) c, COUNT(*) FILTER (WHERE status='active') active FROM employees`),
      query(`SELECT COUNT(*) FILTER (WHERE status='present') present, COUNT(*) FILTER (WHERE status='absent') absent FROM attendance WHERE date=CURRENT_DATE`),
      query(`SELECT COUNT(*) c FROM leaves WHERE status='pending'`),
      query(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) total FROM compliance_fines WHERE status='pending'`),
      query(`SELECT COALESCE(SUM(total),0) total FROM daily_deliveries WHERE date=CURRENT_DATE`).catch(()=>({rows:[{total:0}]})),
    ])
    const payrollMonth = new Date().toISOString().slice(0,7)
    const payroll = await query(`
      SELECT COALESCE(SUM(e.salary),0) base_total,
        COALESCE(SUM(sb.total),0) bonus_total, COALESCE(SUM(sd.total),0) ded_total
      FROM employees e
      LEFT JOIN (SELECT emp_id,SUM(amount) total FROM salary_bonuses WHERE month=$1 GROUP BY emp_id) sb ON e.id=sb.emp_id
      LEFT JOIN (SELECT emp_id,SUM(amount) total FROM salary_deductions WHERE month=$1 GROUP BY emp_id) sd ON e.id=sd.emp_id
      WHERE e.status!='inactive'`, [payrollMonth])
    res.json({
      employees:        empCount.rows[0],
      attendance:       attToday.rows[0],
      pending_leaves:   pendingLeaves.rows[0].c,
      today_deliveries: parseInt(todayDeliveries.rows[0].total||0),
      compliance: { pending_fines: pendingFines.rows[0].c, pending_amount: pendingFines.rows[0].total },
      payroll: payroll.rows[0],
    })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/analytics/deliveries-chart?months=6
router.get('/deliveries-chart', auth, requireRole('admin','manager','general_manager','hr','accountant','finance'), async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6
    // Calculate cutoff in JS to avoid PostgreSQL INTERVAL syntax issues
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - months)
    const cutoffStr = cutoff.toISOString().slice(0, 10)

    const result = await query(`
      SELECT
        TO_CHAR(date, 'YYYY-MM') AS mon,
        station_code,
        SUM(total)               AS total_deliveries,
        SUM(successful)          AS successful,
        SUM(returned)            AS returned
      FROM daily_deliveries
      WHERE date >= $1
      GROUP BY TO_CHAR(date, 'YYYY-MM'), station_code
      ORDER BY mon ASC
    `, [cutoffStr])

    const map = {}
    for (const r of result.rows) {
      if (!map[r.mon]) map[r.mon] = { month: r.mon, total: 0, DDB1: 0, DXE6: 0, DDB1: 0, DXE6: 0 }
      map[r.mon][r.station_code] = parseInt(r.total_deliveries)
      map[r.mon].total += parseInt(r.total_deliveries)
    }
    res.json({ chart: Object.values(map) })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

router.get('/station-stats', auth, requireRole('admin','manager','general_manager'), async (req, res) => {
  try {
    const result = await query(`
      SELECT station_code,
        COUNT(*) FILTER (WHERE status='active') active,
        COUNT(*) total
      FROM employees GROUP BY station_code ORDER BY station_code`)
    res.json({ stations: result.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
