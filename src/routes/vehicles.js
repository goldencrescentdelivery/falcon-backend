const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

// GET /api/vehicles
router.get('/', auth, async (req, res) => {
  try {
    let sc = req.query.station_code
    if (req.user.role === 'poc') sc = req.user.station_code
    const sql = sc
      ? `SELECT * FROM vehicles WHERE station_code=$1 ORDER BY plate`
      : `SELECT * FROM vehicles ORDER BY station_code, plate`
    const result = await query(sql, sc ? [sc] : [])
    res.json({ vehicles: result.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/vehicles
router.post('/', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { plate, make, model, year, station_code, status, grounded_reason, grounded_since, grounded_until, notes } = req.body
    if (!plate) return res.status(400).json({ error: 'Plate number required' })
    const sc = req.user.role === 'poc' ? req.user.station_code : (station_code || 'DDB7')
    const result = await query(`
      INSERT INTO vehicles (plate,make,model,year,station_code,status,grounded_reason,grounded_since,grounded_until,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [plate.toUpperCase(), make||null, model||null, year||null, sc, status||'active', grounded_reason||null, grounded_since||null, grounded_until||null, notes||null])
    req.io?.emit('vehicle:created', result.rows[0])
    res.status(201).json({ vehicle: result.rows[0] })
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error: 'Plate already exists' })
    res.status(500).json({ error: 'Server error' })
  }
})

// PUT /api/vehicles/:id
router.put('/:id', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { plate, make, model, year, station_code, status, grounded_reason, grounded_since, grounded_until, notes } = req.body
    const result = await query(`
      UPDATE vehicles SET plate=$1,make=$2,model=$3,year=$4,station_code=$5,status=$6,
        grounded_reason=$7,grounded_since=$8,grounded_until=$9,notes=$10,updated_at=NOW()
      WHERE id=$11 RETURNING *
    `, [plate?.toUpperCase(), make||null, model||null, year||null, station_code, status, grounded_reason||null, grounded_since||null, grounded_until||null, notes||null, req.params.id])
    req.io?.emit('vehicle:updated', result.rows[0])
    res.json({ vehicle: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/vehicles/:id
router.delete('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    await query('DELETE FROM vehicles WHERE id=$1', [req.params.id])
    res.json({ message: 'Vehicle deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// GET /api/vehicles/assignments?date=&station_code=
router.get('/assignments', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0,10)
    let sc     = req.query.station_code
    if (req.user.role === 'poc') sc = req.user.station_code

    // Auto-carry forward previous day assignments for vehicles with no assignment today
    if (sc) {
      await query(`
        INSERT INTO vehicle_assignments (vehicle_id, emp_id, date, station_code, notes, assigned_by)
        SELECT va.vehicle_id, va.emp_id, $1, va.station_code, va.notes, va.assigned_by
        FROM vehicle_assignments va
        JOIN vehicles v ON va.vehicle_id = v.id
        WHERE va.date = (SELECT MAX(date) FROM vehicle_assignments WHERE date < $1 AND station_code=$2)
          AND va.station_code = $2
          AND NOT EXISTS (SELECT 1 FROM vehicle_assignments WHERE vehicle_id=va.vehicle_id AND date=$1)
        ON CONFLICT (vehicle_id, date) DO NOTHING
      `, [date, sc])
    }

    const sql = `
      SELECT va.*, v.plate, v.make, v.model, v.status AS vehicle_status,
             e.name AS driver_name, e.avatar AS driver_avatar
      FROM vehicle_assignments va
      JOIN vehicles v ON va.vehicle_id=v.id
      LEFT JOIN employees e ON va.emp_id=e.id
      WHERE va.date=$1 ${sc ? 'AND va.station_code=$2' : ''}
      ORDER BY v.plate
    `
    const result = await query(sql, sc ? [date, sc] : [date])
    res.json({ assignments: result.rows, date })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/vehicles/assignments
router.post('/assignments', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { vehicle_id, emp_id, date, station_code, notes } = req.body
    const sc = req.user.role === 'poc' ? req.user.station_code : station_code
    const result = await query(`
      INSERT INTO vehicle_assignments (vehicle_id, emp_id, date, station_code, notes, assigned_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (vehicle_id, date) DO UPDATE SET emp_id=$2, notes=$5, assigned_by=$6, station_code=$4
      RETURNING *
    `, [vehicle_id, emp_id||null, date||new Date().toISOString().slice(0,10), sc, notes||null, req.user.id])
    req.io?.emit('vehicle:assigned', result.rows[0])
    res.json({ assignment: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
