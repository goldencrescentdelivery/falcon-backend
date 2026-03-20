const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

// GET /api/shifts?week=YYYY-MM-DD&station_code=
router.get('/', auth, async (req, res) => {
  try {
    const { week, station_code } = req.query
    const sc = req.user.role === 'poc' ? req.user.station_code : station_code
    const startDate = week || new Date().toISOString().slice(0,10)
    const endDate   = new Date(new Date(startDate).getTime() + 6*86400000).toISOString().slice(0,10)

    let sql = `
      SELECT s.*, e.name, e.avatar, e.station_code AS emp_station
      FROM shifts s JOIN employees e ON s.emp_id=e.id
      WHERE s.shift_date>=$1 AND s.shift_date<=$2`
    const vals = [startDate, endDate]
    if (sc) { vals.push(sc); sql += ` AND s.station_code=$${vals.length}` }
    sql += ` ORDER BY s.shift_date, e.name`

    const result = await query(sql, vals)
    res.json({ shifts: result.rows, week: startDate })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/shifts — assign/update shift
router.post('/', auth, requireRole('admin','manager','general_manager','poc'), async (req, res) => {
  try {
    const { emp_id, shift_date, shift_type, cycle, notes, station_code } = req.body
    const sc = req.user.role === 'poc' ? req.user.station_code : (station_code || 'DDB1')
    const result = await query(`
      INSERT INTO shifts (emp_id, station_code, shift_date, shift_type, cycle, notes, assigned_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (emp_id, shift_date) DO UPDATE SET
        shift_type=$4, cycle=$5, notes=$6, assigned_by=$7
      RETURNING *
    `, [emp_id, sc, shift_date, shift_type||'regular', cycle||null, notes||null, req.user.id])
    res.status(201).json({ shift: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/shifts/:id
router.delete('/:id', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    await query('DELETE FROM shifts WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
