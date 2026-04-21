const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const ALLOWED = ['admin', 'general_manager', 'hr']

// GET /api/vehicle-inspections
router.get('/', auth, requireRole(...ALLOWED), async (req, res) => {
  try {
    const { vehicle_id } = req.query
    const vals = []
    let where = ''
    if (vehicle_id) { vals.push(vehicle_id); where = 'WHERE vi.vehicle_id=$1' }

    const result = await query(`
      SELECT vi.*,
             v.plate, v.make, v.model, v.year, v.station_code
      FROM vehicle_inspections vi
      JOIN vehicles v ON vi.vehicle_id = v.id
      ${where}
      ORDER BY vi.inspection_date DESC, vi.created_at DESC
    `, vals)
    res.json({ inspections: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/vehicle-inspections/:id
router.get('/:id', auth, requireRole(...ALLOWED), async (req, res) => {
  try {
    const result = await query(`
      SELECT vi.*,
             v.plate, v.make, v.model, v.year, v.station_code
      FROM vehicle_inspections vi
      JOIN vehicles v ON vi.vehicle_id = v.id
      WHERE vi.id = $1
    `, [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ inspection: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/vehicle-inspections
router.post('/', auth, requireRole(...ALLOWED), async (req, res) => {
  try {
    const { vehicle_id, inspection_date, inspector_name,
            approved_by_name, approved_by_date,
            sections, additional_notes, status } = req.body

    if (!vehicle_id)      return res.status(400).json({ error: 'Vehicle is required' })
    if (!inspection_date) return res.status(400).json({ error: 'Inspection date is required' })

    const result = await query(`
      INSERT INTO vehicle_inspections
        (vehicle_id, inspection_date, inspector_name,
         approved_by_name, approved_by_date,
         sections, additional_notes, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      vehicle_id,
      inspection_date,
      inspector_name   || null,
      approved_by_name || null,
      approved_by_date || null,
      JSON.stringify(sections || {}),
      additional_notes || null,
      status           || 'completed',
      req.user.id,
    ])
    res.status(201).json({ inspection: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// PUT /api/vehicle-inspections/:id
router.put('/:id', auth, requireRole(...ALLOWED), async (req, res) => {
  try {
    const { vehicle_id, inspection_date, inspector_name,
            approved_by_name, approved_by_date,
            sections, additional_notes, status } = req.body

    const result = await query(`
      UPDATE vehicle_inspections SET
        vehicle_id=$1, inspection_date=$2, inspector_name=$3,
        approved_by_name=$4, approved_by_date=$5,
        sections=$6, additional_notes=$7, status=$8,
        updated_at=NOW()
      WHERE id=$9
      RETURNING *
    `, [
      vehicle_id,
      inspection_date,
      inspector_name   || null,
      approved_by_name || null,
      approved_by_date || null,
      JSON.stringify(sections || {}),
      additional_notes || null,
      status           || 'completed',
      req.params.id,
    ])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ inspection: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/vehicle-inspections/:id
router.delete('/:id', auth, requireRole(...ALLOWED), async (req, res) => {
  try {
    await query('DELETE FROM vehicle_inspections WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
