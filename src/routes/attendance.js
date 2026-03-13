const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const CYCLE_HOURS = { A:5, B:4, C:5, Beset:5, MR:4, FM:5, Rescue:null }

router.get('/', auth, async (req, res) => {
  try {
    const { date, emp_id, station_code } = req.query
    const targetDate = date || new Date().toISOString().slice(0,10)
    let sql  = `SELECT a.*, e.name, e.role, e.avatar, e.station_code, e.hourly_rate AS emp_hourly_rate
                FROM attendance a JOIN employees e ON a.emp_id=e.id WHERE a.date=$1`
    const vals = [targetDate]
<<<<<<< HEAD
    if (req.user.role === 'driver') {
      vals.push(req.user.emp_id); sql += ` AND a.emp_id=$${vals.length}`
    } else if (req.user.role === 'poc') {
      vals.push(req.user.station_code); sql += ` AND e.station_code=$${vals.length}`
    } else {
      if (emp_id)       { vals.push(emp_id);       sql += ` AND a.emp_id=$${vals.length}` }
      if (station_code) { vals.push(station_code); sql += ` AND e.station_code=$${vals.length}` }
=======
    if (req.user.role === 'driver') { vals.push(req.user.emp_id); sql += ` AND a.emp_id=$${vals.length}` }
    else if (req.user.role === 'poc') {
      const poc = await query('SELECT station_code FROM employees WHERE id=$1', [req.user.emp_id])
      const sc  = poc.rows[0]?.station_code
      if (sc) { vals.push(sc); sql += ` AND e.station_code=$${vals.length}` }
    } else {
      if (emp_id)      { vals.push(emp_id);      sql += ` AND a.emp_id=$${vals.length}` }
      if (station_code){ vals.push(station_code); sql += ` AND e.station_code=$${vals.length}` }
>>>>>>> 990c42be8e5ed8214b91d3de93e4df84c6ab273b
    }
    sql += ' ORDER BY e.name'
    const result = await query(sql, vals)
    res.json({ attendance: result.rows, date: targetDate })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

router.post('/', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
<<<<<<< HEAD
    const { emp_id, date, check_in, check_out, status, note, cycle, cycle_hours, is_rescue, rescue_hours, pay_type, daily_rate, worker_type } = req.body
    if (!emp_id || !status) return res.status(400).json({ error: 'emp_id and status required' })

    const empRes  = await query('SELECT hourly_rate, station_code FROM employees WHERE id=$1', [emp_id])
    const emp     = empRes.rows[0]
    const station = emp?.station_code || 'DDB7'

    let earnings = null
    let finalPayType = pay_type || 'hourly'
    let finalDailyRate = null
    let hours = null

    if (status === 'present') {
      if (station === 'DDB6') {
        // DDB6: daily rate — driver AED 115, helper AED 90
        finalPayType   = 'daily'
        finalDailyRate = daily_rate || (worker_type === 'helper' ? 90 : 115)
        earnings       = finalDailyRate
      } else {
        // DDB7/DSH6/DXD3: hourly
        const rate = emp?.hourly_rate || 3.85
        hours = cycle_hours != null ? parseFloat(cycle_hours) : (cycle ? CYCLE_HOURS[cycle] : null)
        if (is_rescue && rescue_hours) hours = parseFloat(rescue_hours)
        earnings = hours != null ? Math.round(hours * rate * 100) / 100 : null
      }
    }

    const result = await query(`
      INSERT INTO attendance (emp_id,date,check_in,check_out,status,note,logged_by,cycle,cycle_hours,hourly_rate,earnings,is_rescue,rescue_hours,pay_type,daily_rate,worker_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (emp_id,date) DO UPDATE SET
        check_in=$3,check_out=$4,status=$5,note=$6,logged_by=$7,cycle=$8,cycle_hours=$9,
        hourly_rate=$10,earnings=$11,is_rescue=$12,rescue_hours=$13,pay_type=$14,daily_rate=$15,
        worker_type=$16,updated_at=NOW()
      RETURNING *`,
      [emp_id, date||new Date().toISOString().slice(0,10), check_in||null, check_out||null,
       status, note||null, req.user.id, cycle||null, hours,
       emp?.hourly_rate||null, earnings, is_rescue||false, rescue_hours||null,
       finalPayType, finalDailyRate, worker_type||'driver'])
=======
    const { emp_id, date, check_in, check_out, status, note, cycle, cycle_hours, is_rescue, rescue_hours } = req.body
    if (!emp_id || !status) return res.status(400).json({ error: 'emp_id and status required' })

    // Get employee hourly rate
    const empRes = await query('SELECT hourly_rate FROM employees WHERE id=$1', [emp_id])
    const rate   = empRes.rows[0]?.hourly_rate || 3.85

    // Calculate hours and earnings
    let hours = cycle_hours != null ? parseFloat(cycle_hours) : (cycle ? CYCLE_HOURS[cycle] : null)
    if (is_rescue && rescue_hours) hours = parseFloat(rescue_hours)
    const earnings = hours != null ? Math.round(hours * rate * 100) / 100 : null

    const result = await query(`
      INSERT INTO attendance (emp_id,date,check_in,check_out,status,note,logged_by,cycle,cycle_hours,hourly_rate,earnings,is_rescue,rescue_hours)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (emp_id,date) DO UPDATE SET
        check_in=$3,check_out=$4,status=$5,note=$6,logged_by=$7,cycle=$8,
        cycle_hours=$9,hourly_rate=$10,earnings=$11,is_rescue=$12,rescue_hours=$13,updated_at=NOW()
      RETURNING *`,
      [emp_id, date||new Date().toISOString().slice(0,10), check_in||null, check_out||null,
       status, note||null, req.user.id, cycle||null, hours, rate, earnings, is_rescue||false, rescue_hours||null])
>>>>>>> 990c42be8e5ed8214b91d3de93e4df84c6ab273b

    req.io?.emit('attendance:updated', result.rows[0])
    res.json({ attendance: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

router.patch('/:id/checkout', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const time   = req.body.check_out || new Date().toTimeString().slice(0,5)
    const result = await query(`UPDATE attendance SET check_out=$1,updated_at=NOW() WHERE id=$2 RETURNING *`, [time, req.params.id])
    req.io?.emit('attendance:updated', result.rows[0])
    res.json({ attendance: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

<<<<<<< HEAD
=======
// GET /api/attendance/summary?month=2024-12
>>>>>>> 990c42be8e5ed8214b91d3de93e4df84c6ab273b
router.get('/summary', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0,7)
    const result = await query(`
      SELECT e.id, e.name, e.station_code, e.hourly_rate,
        COUNT(*) FILTER (WHERE a.status='present') AS present_days,
        COUNT(*) FILTER (WHERE a.status='absent')  AS absent_days,
        COUNT(*) FILTER (WHERE a.status='leave')   AS leave_days,
        COALESCE(SUM(a.earnings),0)                AS total_earnings,
<<<<<<< HEAD
        COALESCE(SUM(a.cycle_hours),0)             AS total_hours
=======
        COALESCE(SUM(a.cycle_hours),0)             AS total_hours,
        COUNT(*) FILTER (WHERE a.is_rescue=true)   AS rescue_days
>>>>>>> 990c42be8e5ed8214b91d3de93e4df84c6ab273b
      FROM employees e
      LEFT JOIN attendance a ON e.id=a.emp_id AND TO_CHAR(a.date,'YYYY-MM')=$1
      WHERE e.status!='inactive'
      GROUP BY e.id,e.name,e.station_code,e.hourly_rate ORDER BY e.name`, [month])
    res.json({ summary: result.rows, month })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

<<<<<<< HEAD
=======
// GET /api/attendance/earnings?emp_id=&month=
>>>>>>> 990c42be8e5ed8214b91d3de93e4df84c6ab273b
router.get('/earnings', auth, async (req, res) => {
  try {
    const empId = req.user.role==='driver' ? req.user.emp_id : req.query.emp_id
    const month = req.query.month || new Date().toISOString().slice(0,7)
<<<<<<< HEAD
    const result = await query(`SELECT a.* FROM attendance a WHERE a.emp_id=$1 AND TO_CHAR(a.date,'YYYY-MM')=$2 ORDER BY a.date`, [empId, month])
    const totEarnings = result.rows.reduce((s,r)=>s+parseFloat(r.earnings||0),0)
    const totHours    = result.rows.reduce((s,r)=>s+parseFloat(r.cycle_hours||0),0)
=======
    const result = await query(`
      SELECT a.*, TO_CHAR(a.date,'YYYY-MM-DD') AS date_str
      FROM attendance a
      WHERE a.emp_id=$1 AND TO_CHAR(a.date,'YYYY-MM')=$2
      ORDER BY a.date`, [empId, month])
    const totHours    = result.rows.reduce((s,r)=>s+parseFloat(r.cycle_hours||0),0)
    const totEarnings = result.rows.reduce((s,r)=>s+parseFloat(r.earnings||0),0)
>>>>>>> 990c42be8e5ed8214b91d3de93e4df84c6ab273b
    res.json({ records: result.rows, total_hours: totHours, total_earnings: totEarnings, month })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
