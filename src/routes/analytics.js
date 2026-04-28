const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

router.get('/summary', auth, requireRole('admin','manager','general_manager','hr','accountant','finance'), async (req, res) => {
  try {
    const [empCount, attToday, pendingLeaves, pendingFines, todayDeliveries] = await Promise.all([
      query(`SELECT COUNT(*) c, COUNT(*) FILTER (WHERE status='active') active FROM employees WHERE LOWER(role)='driver'`),
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
      if (!map[r.mon]) map[r.mon] = { month: r.mon, total: 0, DDB1: 0, DXE6: 0 }
      map[r.mon][r.station_code] = parseInt(r.total_deliveries)
      map[r.mon].total += parseInt(r.total_deliveries)
    }
    res.json({ chart: Object.values(map) })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/analytics/alerts — single DB round-trip for all sidebar badge counts
router.get('/alerts', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT
        (SELECT COUNT(*) FROM employees WHERE status != 'inactive'
          AND (
            (visa_expiry    IS NOT NULL AND visa_expiry    <= CURRENT_DATE + INTERVAL '30 days') OR
            (license_expiry IS NOT NULL AND license_expiry <= CURRENT_DATE + INTERVAL '30 days') OR
            (iloe_expiry    IS NOT NULL AND iloe_expiry    <= CURRENT_DATE + INTERVAL '30 days')
          )
        )::int AS expiring_docs,
        (SELECT COUNT(*) FROM leaves    WHERE poc_status = 'pending')::int  AS pending_leaves,
        (SELECT COUNT(*) FROM sim_cards WHERE status IN ('damaged','inactive'))::int AS sim_issues,
        (SELECT COUNT(*) FROM vehicles  WHERE status IN ('grounded','maintenance'))::int AS fleet_issues
    `)
    const { expiring_docs, pending_leaves, sim_issues, fleet_issues } = result.rows[0]

    // Pending tasks for current user (or all tasks if admin)
    let pending_tasks = 0
    try {
      const taskRes = await query(
        `SELECT COUNT(*)::int AS c FROM tasks
         WHERE ($1 = 'admin' OR assigned_to::text = $2::text)
           AND status != 'completed'`,
        [req.user.role, String(req.user.id)]
      )
      pending_tasks = taskRes.rows[0].c || 0
    } catch { /* tasks table may not exist yet */ }

    res.json({
      employees: expiring_docs,
      leaves:    pending_leaves,
      sims:      sim_issues,
      fleet:     fleet_issues,
      hr:        expiring_docs + pending_leaves,
      poc:       fleet_issues + sim_issues + pending_leaves,
      tasks:     pending_tasks,
    })
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
