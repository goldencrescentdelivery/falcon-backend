const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

router.get('/', auth, async (req, res) => {
  try {
    const { month, station, from, to } = req.query
    let sql  = `SELECT d.*, u.name AS logged_by_name FROM daily_deliveries d LEFT JOIN users u ON d.logged_by=u.id WHERE 1=1`
    const vals = []
    if (station) { vals.push(station); sql += ` AND d.station_code=$${vals.length}` }
    if (month)   { vals.push(`${month}%`); sql += ` AND d.date::TEXT LIKE $${vals.length}` }
    if (from)    { vals.push(from); sql += ` AND d.date >= $${vals.length}` }
    if (to)      { vals.push(to);   sql += ` AND d.date <= $${vals.length}` }
    if (req.user.role === 'poc') {
      const sc = req.user.station_code || 'DDB1'
      vals.push(sc); sql += ` AND d.station_code=$${vals.length}`
    }
    sql += ' ORDER BY d.date DESC'
    const result = await query(sql, vals)
    res.json({ deliveries: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

router.get('/monthly-summary', auth, requireRole('admin','manager','finance'), async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - months)
    const cutoffStr = cutoff.toISOString().slice(0,10)
    const result = await query(`
      SELECT
        TO_CHAR(date,'YYYY-MM') AS month,
        station_code,
        SUM(total)              AS total_deliveries,
        SUM(successful)         AS successful,
        SUM(returned)           AS returned,
        COUNT(*)                AS days_logged
      FROM daily_deliveries
      WHERE date >= $1
      GROUP BY TO_CHAR(date,'YYYY-MM'), station_code
      ORDER BY month ASC, station_code
    `, [cutoffStr])
    const byMonth = {}
    for (const row of result.rows) {
      if (!byMonth[row.month]) byMonth[row.month] = { month: row.month, total: 0 }
      byMonth[row.month][row.station_code] = parseInt(row.total_deliveries)
      byMonth[row.month].total += parseInt(row.total_deliveries)
    }
    res.json({ summary: Object.values(byMonth), raw: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

router.post('/', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { station_code, date, total, attempted, successful, returned, notes } = req.body
    if (!total && total !== 0) return res.status(400).json({ error: 'total required' })

    // Always resolve station_code — never allow null
    let sc = station_code
    if (req.user.role === 'poc') {
      sc = req.user.station_code || 'DDB1'
    }
    if (!sc) sc = 'DDB1'

    const result = await query(`
      INSERT INTO daily_deliveries (station_code, date, total, attempted, successful, returned, notes, logged_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (station_code, date) DO UPDATE SET
        total=$3, attempted=$4, successful=$5, returned=$6, notes=$7, logged_by=$8, updated_at=NOW()
      RETURNING *
    `, [sc, date || new Date().toISOString().slice(0,10), total, attempted||0, successful||0, returned||0, notes||null, req.user.id])

    req.io?.emit('deliveries:updated', result.rows[0])
    res.json({ delivery: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// PUT /api/deliveries/:id — edit a delivery record
router.put('/:id', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { total, attempted, successful, returned, notes } = req.body
    let sql = `UPDATE daily_deliveries SET total=$1,attempted=$2,successful=$3,returned=$4,notes=$5,updated_at=NOW()`
    const vals = [total, attempted||0, successful||0, returned||0, notes||null]
    // POC can only edit their own station's records
    if (req.user.role === 'poc') {
      vals.push(req.params.id, req.user.station_code || 'DDB1')
      sql += ` WHERE id=$6 AND station_code=$7 RETURNING *`
    } else {
      vals.push(req.params.id)
      sql += ` WHERE id=$6 RETURNING *`
    }
    const result = await query(sql, vals)
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    req.io?.emit('deliveries:updated', result.rows[0])
    res.json({ delivery: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/deliveries/:id
router.delete('/:id', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    let sql, vals
    if (req.user.role === 'poc') {
      // POC can only delete their own station's records
      sql  = `DELETE FROM daily_deliveries WHERE id=$1 AND station_code=$2 RETURNING id`
      vals = [req.params.id, req.user.station_code || 'DDB1']
    } else {
      sql  = `DELETE FROM daily_deliveries WHERE id=$1 RETURNING id`
      vals = [req.params.id]
    }
    const result = await query(sql, vals)
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    req.io?.emit('deliveries:deleted', { id: parseInt(req.params.id) })
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
