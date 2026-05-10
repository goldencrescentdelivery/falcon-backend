const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const V = require('../middleware/validate')

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

router.post('/', auth, requireRole('admin','manager','general_manager','poc','accountant'), async (req, res) => {
  try {
    const { emp_id, date, check_in, check_out, status, note, hours_worked, shipments_returned } = req.body
    if (!emp_id || !status) return res.status(400).json({ error: 'emp_id and status required' })

    const empRes  = await query('SELECT hourly_rate, station_code FROM employees WHERE id=$1', [emp_id])
    const emp     = empRes.rows[0]
    const station = emp?.station_code || 'DDB1'

    let earnings = null
    let finalPayType = 'hourly'
    let storedUnits = null

    if (status === 'present') {
      if (station === 'DXE6') {
        finalPayType = 'shipment'
        storedUnits = shipments_returned != null ? parseInt(shipments_returned) : null
        earnings = storedUnits != null ? Math.round(storedUnits * 0.5 * 100) / 100 : null
      } else {
        finalPayType = 'hourly'
        storedUnits = hours_worked != null ? parseFloat(hours_worked) : null
        earnings = storedUnits != null ? Math.round(storedUnits * 3.85 * 100) / 100 : null
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
       status, note||null, req.user.id, null, storedUnits,
       emp?.hourly_rate||null, earnings, false, null,
       finalPayType, null, null])

    req.io?.emit('attendance:updated', result.rows[0])
    res.json({ attendance: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

router.patch('/:id/checkout', auth, requireRole('admin','manager','general_manager','poc','accountant'), async (req, res) => {
  try {
    const time   = req.body.check_out || new Date().toTimeString().slice(0,5)
    const result = await query(`UPDATE attendance SET check_out=$1,updated_at=NOW() WHERE id=$2 RETURNING *`, [time, req.params.id])
    req.io?.emit('attendance:updated', result.rows[0])
    res.json({ attendance: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/attendance/bulk — log attendance for multiple employees at once
router.post('/bulk', auth, requireRole('admin','manager','general_manager','poc','accountant'), async (req, res) => {
  try {
    const { records } = req.body
    if (!Array.isArray(records) || records.length === 0)
      return res.status(400).json({ error: 'records array required' })
    if (records.length > 100)
      return res.status(400).json({ error: 'Maximum 100 records per bulk request' })

    const results = []
    // Batch-fetch all employee data in one query instead of one per record
    const validEmpIds = [...new Set(records.filter(r => r.emp_id && r.status).map(r => r.emp_id))]
    const empRows = validEmpIds.length
      ? await query('SELECT id, hourly_rate, station_code FROM employees WHERE id = ANY($1::text[])', [validEmpIds])
      : { rows: [] }
    const empMap = {}
    for (const e of empRows.rows) empMap[e.id] = e

    for (const rec of records) {
      const { emp_id, date, status, note, hours_worked, shipments_returned } = rec
      if (!emp_id || !status) continue

      const emp     = empMap[emp_id]
      const station = emp?.station_code || 'DDB1'

      let earnings = null
      let finalPayType = 'hourly'
      let storedUnits = null

      if (status === 'present') {
        if (station === 'DXE6') {
          finalPayType = 'shipment'
          storedUnits = shipments_returned != null ? parseInt(shipments_returned) : null
          earnings = storedUnits != null ? Math.round(storedUnits * 0.5 * 100) / 100 : null
        } else {
          finalPayType = 'hourly'
          storedUnits = hours_worked != null ? parseFloat(hours_worked) : null
          earnings = storedUnits != null ? Math.round(storedUnits * 3.85 * 100) / 100 : null
        }
      }

      const r = await query(`
        INSERT INTO attendance (emp_id,date,status,note,logged_by,cycle,cycle_hours,hourly_rate,earnings,is_rescue,rescue_hours,pay_type,daily_rate,worker_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (emp_id,date) DO UPDATE SET
          status=$3,note=$4,logged_by=$5,cycle=$6,cycle_hours=$7,
          hourly_rate=$8,earnings=$9,is_rescue=$10,rescue_hours=$11,pay_type=$12,daily_rate=$13,
          worker_type=$14,updated_at=NOW()
        RETURNING *`,
        [emp_id, date||new Date().toISOString().slice(0,10), status, note||null, req.user.id,
         null, storedUnits, emp?.hourly_rate||null, earnings, false, null,
         finalPayType, null, null])

      results.push(r.rows[0])
      req.io?.emit('attendance:updated', r.rows[0])
    }

    res.json({ attendance: results, count: results.length })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// PUT /api/attendance/:id — edit an existing record (recomputes earnings)
router.put('/:id', auth, requireRole('admin','manager','general_manager','poc','accountant'), async (req, res) => {
  try {
    const { status, note, hours_worked, shipments_returned } = req.body
    const existing = await query('SELECT * FROM attendance WHERE id=$1', [req.params.id])
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' })
    const rec = existing.rows[0]
    const empRes = await query('SELECT hourly_rate, station_code FROM employees WHERE id=$1', [rec.emp_id])
    const emp = empRes.rows[0]
    const station = emp?.station_code || 'DDB1'
    const newStatus = status ?? rec.status
    let earnings = null, finalPayType = 'hourly', storedUnits = null
    if (newStatus === 'present') {
      if (station === 'DXE6') {
        finalPayType = 'shipment'
        storedUnits = shipments_returned != null ? parseInt(shipments_returned) : (rec.cycle_hours != null ? parseFloat(rec.cycle_hours) : null)
        earnings = storedUnits != null ? Math.round(storedUnits * 0.5 * 100) / 100 : null
      } else {
        finalPayType = 'hourly'
        storedUnits = hours_worked != null ? parseFloat(hours_worked) : (rec.cycle_hours != null ? parseFloat(rec.cycle_hours) : null)
        earnings = storedUnits != null ? Math.round(storedUnits * 3.85 * 100) / 100 : null
      }
    }
    const result = await query(`
      UPDATE attendance SET
        status=$1, note=$2, cycle=$3, cycle_hours=$4,
        earnings=$5, is_rescue=$6, rescue_hours=$7,
        pay_type=$8, daily_rate=$9, worker_type=$10, updated_at=NOW()
      WHERE id=$11 RETURNING *`,
      [newStatus, note ?? rec.note, null, storedUnits,
       earnings, false, null,
       finalPayType, null, null,
       req.params.id])
    req.io?.emit('attendance:updated', result.rows[0])
    res.json({ attendance: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/attendance/:id
router.delete('/:id', auth, requireRole('admin','manager','general_manager','poc','accountant'), async (req, res) => {
  try {
    await query('DELETE FROM attendance WHERE id=$1', [req.params.id])
    req.io?.emit('attendance:deleted', { id: req.params.id })
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.get('/summary', auth, requireRole('admin','manager','general_manager','accountant'), async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0,7)
    const [y, mo] = month.split('-').map(Number)
    const monthStart = `${month}-01`
    const monthEnd   = new Date(y, mo, 1).toISOString().slice(0, 10)
    const result = await query(`
      SELECT e.id, e.name, e.station_code, e.hourly_rate,
        COUNT(*) FILTER (WHERE a.status='present') AS present_days,
        COUNT(*) FILTER (WHERE a.status='absent')  AS absent_days,
        COUNT(*) FILTER (WHERE a.status='leave')   AS leave_days,
        COALESCE(SUM(a.earnings),0)                AS total_earnings,
        COALESCE(SUM(a.cycle_hours),0)             AS total_hours
      FROM employees e
      LEFT JOIN attendance a ON e.id=a.emp_id AND a.date >= $1 AND a.date < $2
      WHERE e.status!='inactive'
      GROUP BY e.id,e.name,e.station_code,e.hourly_rate ORDER BY e.name`, [monthStart, monthEnd])
    res.json({ summary: result.rows, month })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.get('/earnings', auth, async (req, res) => {
  try {
    const empId = req.user.role==='driver' ? req.user.emp_id : req.query.emp_id
    const month = req.query.month || new Date().toISOString().slice(0,7)
    const [y, mo] = month.split('-').map(Number)
    const monthStart = `${month}-01`
    const monthEnd   = new Date(y, mo, 1).toISOString().slice(0, 10)
    const result = await query(`SELECT a.* FROM attendance a WHERE a.emp_id=$1 AND a.date >= $2 AND a.date < $3 ORDER BY a.date`, [empId, monthStart, monthEnd])
    const totEarnings = result.rows.reduce((s,r)=>s+parseFloat(r.earnings||0),0)
    const totHours    = result.rows.reduce((s,r)=>s+parseFloat(r.cycle_hours||0),0)
    res.json({ records: result.rows, total_hours: totHours, total_earnings: totEarnings, month })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router