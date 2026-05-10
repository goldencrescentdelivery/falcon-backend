const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const V = require('../middleware/validate')

// GET /api/vehicles/stats — aggregate counts only, used by overview (fast)
router.get('/stats', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT
        COUNT(*)                                         AS total,
        COUNT(*) FILTER (WHERE status='active')          AS active,
        COUNT(*) FILTER (WHERE status='grounded')        AS grounded,
        COUNT(*) FILTER (WHERE status='maintenance')     AS maintenance,
        COUNT(*) FILTER (WHERE station_code='DDB1')      AS ddb1,
        COUNT(*) FILTER (WHERE station_code='DXE6')      AS dxe6
      FROM vehicles
    `)
    res.set('Cache-Control', 'private, max-age=60')
    res.json({ stats: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// GET /api/vehicles
router.get('/', auth, async (req, res) => {
  try {
    // All roles see all vehicles — station_code param is optional for admin filtering only
    const sc = req.user.role !== 'poc' ? (req.query.station_code || null) : null

    let sql  = 'SELECT * FROM vehicles'
    const vals = []
    if (sc) { vals.push(sc); sql += ` WHERE station_code = $1` }
    sql += ' ORDER BY station_code, plate'

    const result = await query(sql, vals)
    res.set('Cache-Control', 'private, max-age=30')
    res.json({ vehicles: result.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/vehicles
router.post('/', auth, V.validateVehicle, requireRole('admin','manager','poc'), async (req, res) => {
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
router.put('/:id', auth, V.validateParams({ id: 'uuid' }), V.validateVehicle, requireRole('admin','manager','poc'), async (req, res) => {
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
router.delete('/:id', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    await query('DELETE FROM vehicles WHERE id=$1', [req.params.id])
    res.json({ message: 'Vehicle deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// GET /api/vehicles/assignments?date=&station_code=
router.get('/assignments', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0,10)
    const empId = req.user.role === 'driver' ? req.user.emp_id : (req.query.emp_id || null)
    // station_code is optional filter for admins only — POC sees all assignments
    const sc = req.user.role !== 'poc' ? (req.query.station_code || null) : null

    // Auto-carry forward: for each vehicle, copy its most recent assignment if none exists today
    await query(`
      INSERT INTO vehicle_assignments (vehicle_id, emp_id, date, station_code, notes, assigned_by)
      SELECT DISTINCT ON (va.vehicle_id) va.vehicle_id, va.emp_id, $1, va.station_code, va.notes, va.assigned_by
      FROM vehicle_assignments va
      WHERE va.date < $1
        AND NOT EXISTS (SELECT 1 FROM vehicle_assignments WHERE vehicle_id=va.vehicle_id AND date=$1)
      ORDER BY va.vehicle_id, va.date DESC
      ON CONFLICT (vehicle_id, date) DO NOTHING
    `, [date])

    let sql = `
      SELECT va.*, v.plate, v.make, v.model, v.status AS vehicle_status,
             e.name AS driver_name, e.avatar AS driver_avatar,
             u.name AS assigned_by_name
      FROM vehicle_assignments va
      JOIN vehicles v ON va.vehicle_id=v.id
      LEFT JOIN employees e ON va.emp_id=e.id
      LEFT JOIN users u ON va.assigned_by=u.id
      WHERE va.date=$1
    `
    const vals = [date]
    if (sc) {
      vals.push(sc)
      sql += ` AND va.station_code=$${vals.length}`
    }
    if (empId) {
      vals.push(empId)
      sql += ` AND va.emp_id=$${vals.length}`
    }
    sql += ' ORDER BY v.plate'
    const result = await query(sql, vals)
    res.json({ assignments: result.rows, date })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/vehicles/assignments/current?emp_id=&date=
// Current assignment is stateful: the latest assignment for a vehicle remains
// active until a newer unassignment/reassignment or a handover return.
router.get('/assignments/current', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0,10)
    const empId = req.user.role === 'driver' ? req.user.emp_id : (req.query.emp_id || null)
    if (!empId) return res.status(400).json({ error: 'emp_id required' })

    const result = await query(`
      WITH latest AS (
        SELECT DISTINCT ON (va.vehicle_id)
               va.*
        FROM vehicle_assignments va
        WHERE va.date <= $2
        ORDER BY va.vehicle_id, va.date DESC, va.created_at DESC
      )
      SELECT latest.*, v.plate, v.make, v.model, v.year, v.status AS vehicle_status,
             e.name AS driver_name, e.avatar AS driver_avatar,
             u.name AS assigned_by_name
      FROM latest
      JOIN vehicles v ON latest.vehicle_id=v.id
      LEFT JOIN employees e ON latest.emp_id=e.id
      LEFT JOIN users u ON latest.assigned_by=u.id
      WHERE latest.emp_id=$1
        AND NOT EXISTS (
          SELECT 1
          FROM vehicle_handovers h
          WHERE h.vehicle_id=latest.vehicle_id
            AND h.emp_id=latest.emp_id
            AND h.type='returned'
            AND h.status IN ('pending_acceptance','accepted','poc_pending','completed')
            AND h.submitted_at >= latest.created_at
        )
      ORDER BY latest.date DESC, v.plate
    `, [empId, date])

    res.json({ assignments: result.rows, date })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/vehicles/assignments/history?vehicle_id=&emp_id=&limit=
// Returns past assignments for a vehicle or a driver, newest first
router.get('/assignments/history', auth, async (req, res) => {
  try {
    const { vehicle_id, emp_id } = req.query
    const limit = Math.min(parseInt(req.query.limit)||60, 200)

    // Drivers can only see their own history
    const resolvedEmpId = req.user.role === 'driver' ? req.user.emp_id : (emp_id || null)

    let sql = `
      SELECT va.id, va.vehicle_id, va.emp_id, va.date, va.station_code, va.notes,
             v.plate, v.make, v.model, v.year,
             e.name  AS driver_name,
             u.email AS assigned_by_email
      FROM vehicle_assignments va
      JOIN vehicles v ON va.vehicle_id = v.id
      LEFT JOIN employees e  ON va.emp_id      = e.id
      LEFT JOIN users     u  ON va.assigned_by = u.id
      WHERE 1=1
    `
    const vals = []
    if (vehicle_id)    { vals.push(vehicle_id);    sql += ` AND va.vehicle_id=$${vals.length}` }
    if (resolvedEmpId) { vals.push(resolvedEmpId); sql += ` AND va.emp_id=$${vals.length}` }
    // For POC role, scope to their station
    if (req.user.role === 'poc') {
      vals.push(req.user.station_code); sql += ` AND va.station_code=$${vals.length}`
    }
    vals.push(limit)
    sql += ` ORDER BY va.date DESC LIMIT $${vals.length}`

    const result = await query(sql, vals)
    res.json({ history: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/vehicles/assignments
router.post('/assignments', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { vehicle_id, emp_id, date, station_code, notes } = req.body
    // Only DAs (Driver role) can be assigned to vehicles
    if (emp_id) {
      const empCheck = await query('SELECT role, name FROM employees WHERE id=$1', [emp_id])
      if (!empCheck.rows[0]) return res.status(400).json({ error: 'Employee not found' })
      if ((empCheck.rows[0].role||'').toLowerCase() !== 'driver') {
        return res.status(400).json({ error: 'Only Delivery Associates can be assigned to vehicles' })
      }
      // Block POC from overwriting another user's assignment
      const assignDate = date || new Date().toISOString().slice(0,10)
      const isAdmin = ['admin','manager','general_manager'].includes(req.user.role)
      if (!isAdmin) {
        const locked = await query(
          `SELECT va.assigned_by, u.name AS poc_name, e.name AS driver_name
           FROM vehicle_assignments va
           LEFT JOIN users u ON va.assigned_by=u.id
           LEFT JOIN employees e ON va.emp_id=e.id
           WHERE va.vehicle_id=$1 AND va.date=$2 AND va.emp_id IS NOT NULL AND va.assigned_by IS NOT NULL AND va.assigned_by != $3`,
          [vehicle_id, assignDate, req.user.id]
        )
        if (locked.rows.length > 0) {
          const poc    = locked.rows[0].poc_name    || 'Another POC'
          const driver = locked.rows[0].driver_name || 'a driver'
          return res.status(409).json({ error: `Vehicle is already assigned to ${driver} by ${poc}. Ask them to remove the assignment first.` })
        }
      }
      // Enforce one driver → one vehicle per day
      const conflict = await query(
        `SELECT va.vehicle_id, v.plate FROM vehicle_assignments va
         JOIN vehicles v ON va.vehicle_id = v.id
         WHERE va.emp_id = $1 AND va.date = $2 AND va.vehicle_id != $3 AND va.emp_id IS NOT NULL`,
        [emp_id, assignDate, vehicle_id]
      )
      if (conflict.rows.length > 0) {
        return res.status(409).json({ error: `${empCheck.rows[0].name} is already assigned to vehicle ${conflict.rows[0].plate} on this date. Remove that assignment first.` })
      }
    }
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
