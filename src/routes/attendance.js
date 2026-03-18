const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

// Cycle hours map
const CYCLE_HOURS = { A:5, B:4, C:5, Beset:5, MR:4, FM:5 }
const MAX_HOURS_DDB1 = 10  // max without rescue

function calcHours(cycles, rescueHours) {
  let total = 0
  const hasCycles = cycles || []
  for (const c of hasCycles) {
    if (c === 'Rescue') {
      total += parseFloat(rescueHours || 0)
    } else {
      total += CYCLE_HOURS[c] || 0
    }
  }
  return total
}

// GET /api/attendance
router.get('/', auth, async (req, res) => {
  try {
    const { date, emp_id, station_code } = req.query
    const targetDate = date || new Date().toISOString().slice(0,10)
    let sql  = `SELECT a.*, e.name, e.role, e.avatar, e.station_code, e.hourly_rate AS emp_hourly_rate
                FROM attendance a JOIN employees e ON a.emp_id=e.id WHERE a.date=$1`
    const vals = [targetDate]
    if (req.user.role === 'driver') {
      vals.push(req.user.emp_id); sql += ` AND a.emp_id=$${vals.length}`
    } else if (req.user.role === 'poc') {
      vals.push(req.user.station_code); sql += ` AND e.station_code=$${vals.length}`
    } else {
      if (emp_id)       { vals.push(emp_id);       sql += ` AND a.emp_id=$${vals.length}` }
      if (station_code) { vals.push(station_code); sql += ` AND e.station_code=$${vals.length}` }
    }
    sql += ' ORDER BY e.name'
    const result = await query(sql, vals)
    res.json({ attendance: result.rows, date: targetDate })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/attendance
router.post('/', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { emp_id, date, check_in, check_out, status, note, cycles, rescue_hours, pay_type, worker_type } = req.body
    if (!emp_id || !status) return res.status(400).json({ error: 'emp_id and status required' })

    const empRes  = await query('SELECT hourly_rate, station_code FROM employees WHERE id=$1', [emp_id])
    const emp     = empRes.rows[0]
    const station = emp?.station_code || 'DDB1'

    let earnings      = null
    let finalPayType  = pay_type || 'hourly'
    let finalDailyRate= null
    let totalHours    = 0

    const cycleList = Array.isArray(cycles) ? cycles : (cycles ? [cycles] : [])

    if (status === 'present') {
      if (station === 'DXE6') {
        finalPayType   = 'daily'
        finalDailyRate = worker_type === 'helper' ? 90 : 115
        earnings       = finalDailyRate
      } else {
        const rate = parseFloat(emp?.hourly_rate || 3.85)
        totalHours = calcHours(cycleList, rescue_hours)

        // Enforce 10hr max for DDB1 unless rescue
        const hasRescue = cycleList.includes('Rescue')
        if (station === 'DDB1' && !hasRescue && totalHours > MAX_HOURS_DDB1) {
          return res.status(400).json({ error: `Max ${MAX_HOURS_DDB1} hours without Rescue cycle` })
        }

        earnings = Math.round(totalHours * rate * 100) / 100
      }
    }

    const result = await query(`
      INSERT INTO attendance (emp_id,date,check_in,check_out,status,note,logged_by,
        cycle,cycles,cycle_hours,total_hours,hourly_rate,earnings,is_rescue,rescue_hours,
        pay_type,daily_rate,worker_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (emp_id,date) DO UPDATE SET
        check_in=$3,check_out=$4,status=$5,note=$6,logged_by=$7,cycle=$8,cycles=$9,
        cycle_hours=$10,total_hours=$11,hourly_rate=$12,earnings=$13,is_rescue=$14,
        rescue_hours=$15,pay_type=$16,daily_rate=$17,worker_type=$18,updated_at=NOW()
      RETURNING *`,
      [emp_id, date||new Date().toISOString().slice(0,10),
       check_in||null, check_out||null, status, note||null, req.user.id,
       cycleList[0]||null, cycleList, totalHours||null, totalHours||null,
       emp?.hourly_rate||null, earnings, cycleList.includes('Rescue'), rescue_hours||null,
       finalPayType, finalDailyRate, worker_type||'driver'])

    req.io?.emit('attendance:updated', result.rows[0])
    res.json({ attendance: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || 'Server error' }) }
})

// PUT /api/attendance/:id — edit existing record
router.put('/:id', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { check_in, check_out, status, note, cycles, rescue_hours, worker_type } = req.body

    const existing = await query('SELECT a.*, e.hourly_rate, e.station_code FROM attendance a JOIN employees e ON a.emp_id=e.id WHERE a.id=$1', [req.params.id])
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' })
    const rec     = existing.rows[0]
    const station = rec.station_code

    const cycleList = Array.isArray(cycles) ? cycles : (cycles ? [cycles] : rec.cycles || [])
    let totalHours  = 0
    let earnings    = null

    if (station !== 'DXE6') {
      const rate = parseFloat(rec.hourly_rate || 3.85)
      totalHours = calcHours(cycleList, rescue_hours)
      earnings   = Math.round(totalHours * rate * 100) / 100
    } else {
      earnings = worker_type === 'helper' ? 90 : 115
    }

    const result = await query(`
      UPDATE attendance SET check_in=$1,check_out=$2,status=$3,note=$4,cycles=$5,
        cycle_hours=$6,total_hours=$6,earnings=$7,is_rescue=$8,rescue_hours=$9,
        worker_type=$10,updated_at=NOW()
      WHERE id=$11 RETURNING *`,
      [check_in||rec.check_in, check_out||rec.check_out, status||rec.status, note??rec.note,
       cycleList, totalHours, earnings, cycleList.includes('Rescue'), rescue_hours||null,
       worker_type||rec.worker_type, req.params.id])

    req.io?.emit('attendance:updated', result.rows[0])
    res.json({ attendance: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || 'Server error' }) }
})

// DELETE /api/attendance/:id
router.delete('/:id', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    await query('DELETE FROM attendance WHERE id=$1', [req.params.id])
    req.io?.emit('attendance:deleted', { id: req.params.id })
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// PATCH /:id/checkout
router.patch('/:id/checkout', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const time   = req.body.check_out || new Date().toTimeString().slice(0,5)
    const result = await query(`UPDATE attendance SET check_out=$1,updated_at=NOW() WHERE id=$2 RETURNING *`, [time, req.params.id])
    req.io?.emit('attendance:updated', result.rows[0])
    res.json({ attendance: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.get('/summary', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0,7)
    const result = await query(`
      SELECT e.id, e.name, e.station_code, e.hourly_rate,
        COUNT(*) FILTER (WHERE a.status='present') AS present_days,
        COUNT(*) FILTER (WHERE a.status='absent')  AS absent_days,
        COALESCE(SUM(a.earnings),0)                AS total_earnings,
        COALESCE(SUM(a.total_hours),0)             AS total_hours
      FROM employees e
      LEFT JOIN attendance a ON e.id=a.emp_id AND TO_CHAR(a.date,'YYYY-MM')=$1
      WHERE e.status!='inactive'
      GROUP BY e.id,e.name,e.station_code,e.hourly_rate ORDER BY e.name`, [month])
    res.json({ summary: result.rows, month })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
