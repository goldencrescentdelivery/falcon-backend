const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

// GET /api/sims — list all SIMs
router.get('/', auth, async (req, res) => {
  try {
    const { station_code, status } = req.query
    let sql = `
      SELECT s.*, e.name AS emp_name, e.avatar AS emp_avatar, e.station_code AS emp_station
      FROM sim_cards s
      LEFT JOIN employees e ON s.emp_id = e.id
      WHERE 1=1`
    const vals = []
    if (req.user.role === 'poc') {
      vals.push(req.user.station_code); sql += ` AND s.station_code=$${vals.length}`
    } else {
      if (station_code) { vals.push(station_code); sql += ` AND s.station_code=$${vals.length}` }
    }
    if (status) { vals.push(status); sql += ` AND s.status=$${vals.length}` }
    sql += ' ORDER BY s.status, s.sim_number'
    const result = await query(sql, vals)
    res.json({ sims: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/sims/stats — summary for manager dashboard
router.get('/stats', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='available') AS available,
        COUNT(*) FILTER (WHERE status='assigned')  AS assigned,
        COUNT(*) FILTER (WHERE status='inactive')  AS inactive,
        COUNT(*) FILTER (WHERE status='damaged')   AS damaged,
        COALESCE(SUM(monthly_cost),0)              AS monthly_cost,
        json_agg(DISTINCT carrier) FILTER (WHERE carrier IS NOT NULL) AS carriers
      FROM sim_cards
    `)
    const byStation = await query(`
      SELECT station_code, COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='assigned') AS assigned
      FROM sim_cards WHERE station_code IS NOT NULL
      GROUP BY station_code ORDER BY station_code
    `)
    res.json({ stats: result.rows[0], by_station: byStation.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/sims — add SIM
router.post('/', auth, requireRole('admin','manager','general_manager','poc'), async (req, res) => {
  try {
    const { sim_number, phone_number, carrier, status, emp_id, station_code, notes, monthly_cost } = req.body
    if (!sim_number) return res.status(400).json({ error: 'sim_number required' })
    const result = await query(`
      INSERT INTO sim_cards (sim_number, phone_number, carrier, status, emp_id, station_code, notes, monthly_cost, assigned_by, assigned_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [sim_number, phone_number||null, carrier||'Du', status||'available',
        emp_id||null, station_code||req.user.station_code||null, notes||null,
        monthly_cost||0, emp_id?req.user.id:null, emp_id?new Date():null])
    if (emp_id && phone_number) {
      await query(`UPDATE employees SET work_number=$1 WHERE id=$2`, [phone_number, emp_id])
    }
    res.status(201).json({ sim: result.rows[0] })
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error: 'SIM number already exists' })
    res.status(500).json({ error: 'Server error' })
  }
})

// PUT /api/sims/:id — update / assign SIM
router.put('/:id', auth, requireRole('admin','manager','general_manager','poc'), async (req, res) => {
  try {
    const { sim_number, phone_number, carrier, status, emp_id, station_code, notes, monthly_cost } = req.body

    // Fetch current SIM to detect assignment changes
    const prev = await query(`SELECT * FROM sim_cards WHERE id=$1`, [req.params.id])
    if (!prev.rows[0]) return res.status(404).json({ error: 'Not found' })
    const prevSim = prev.rows[0]

    const assigned_at = emp_id ? new Date() : null
    const assigned_by = emp_id ? req.user.id : null
    const result = await query(`
      UPDATE sim_cards SET
        sim_number=$1, phone_number=$2, carrier=$3, status=$4,
        emp_id=$5, station_code=$6, notes=$7, monthly_cost=$8,
        assigned_at=$9, assigned_by=$10, updated_at=NOW()
      WHERE id=$11 RETURNING *
    `, [sim_number, phone_number||null, carrier||'Du', status||'available',
        emp_id||null, station_code||null, notes||null, monthly_cost||0,
        assigned_at, assigned_by, req.params.id])

    const sim = result.rows[0]

    // Sync employees.work_number whenever assignment changes
    const ph = sim.phone_number
    if (emp_id && ph) {
      // Release old SIM from this employee if they had a different one
      const empRow = await query(`SELECT work_number FROM employees WHERE id=$1`, [emp_id])
      const oldWN  = empRow.rows[0]?.work_number
      if (oldWN && oldWN !== ph) {
        await query(`UPDATE sim_cards SET emp_id=NULL, status='available', assigned_at=NULL, assigned_by=NULL WHERE phone_number=$1`, [oldWN])
      }
      await query(`UPDATE employees SET work_number=$1 WHERE id=$2`, [ph, emp_id])
    }
    // If SIM was previously assigned to someone and is now unassigned or reassigned, clear old employee's work_number
    if (prevSim.emp_id && prevSim.emp_id !== (emp_id || null)) {
      await query(`UPDATE employees SET work_number=NULL WHERE id=$1 AND work_number=$2`, [prevSim.emp_id, prevSim.phone_number])
    }

    res.json({ sim })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/sims/:id
router.delete('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    await query('DELETE FROM sim_cards WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/sims/bulk — bulk insert SIM cards from CSV upload
router.post('/bulk', auth, requireRole('admin','manager','general_manager','poc'), async (req, res) => {
  try {
    const { sims } = req.body
    if (!Array.isArray(sims) || sims.length === 0)
      return res.status(400).json({ error: 'sims array required' })
    if (sims.length > 500)
      return res.status(400).json({ error: 'Max 500 SIMs per upload' })

    let inserted = 0, skipped = 0
    const errors = []

    for (let i = 0; i < sims.length; i++) {
      const row = sims[i]
      const sim_number = (row.sim_number || '').trim()
      if (!sim_number) { errors.push({ row: i+1, error: 'sim_number required' }); continue }

      const sc = req.user.role === 'poc' ? req.user.station_code : (row.station_code || null)

      // Resolve employee by ID or name if provided
      let resolvedEmpId = null
      const empIdentifier = (row.emp_id || '').trim()
      if (empIdentifier) {
        const empRes = await query(
          `SELECT id FROM employees WHERE LOWER(id)=LOWER($1) OR LOWER(name)=LOWER($1) LIMIT 1`,
          [empIdentifier]
        )
        if (empRes.rows[0]) {
          resolvedEmpId = empRes.rows[0].id
        } else {
          errors.push({ row: i+1, sim_number, error: `Employee not found: ${empIdentifier}` })
          continue
        }
      }

      const status   = resolvedEmpId ? 'assigned' : (['available','assigned','inactive','damaged'].includes(row.status) ? row.status : 'available')
      const assignedAt = resolvedEmpId ? new Date() : null
      const assignedBy = resolvedEmpId ? req.user.id : null

      const ph = (row.phone_number||'').trim() || null
      try {
        await query(`
          INSERT INTO sim_cards (sim_number, phone_number, carrier, status, emp_id, station_code, notes, monthly_cost, assigned_at, assigned_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [
          sim_number,
          ph,
          (row.carrier||'Du').trim(),
          status,
          resolvedEmpId,
          sc,
          (row.notes||'').trim() || null,
          parseFloat(row.monthly_cost) || 0,
          assignedAt,
          assignedBy,
        ])
        // Sync employees.work_number when bulk-assigning
        if (resolvedEmpId && ph) {
          await query(`UPDATE employees SET work_number=$1 WHERE id=$2`, [ph, resolvedEmpId])
        }
        inserted++
      } catch (e) {
        if (e.code === '23505') skipped++
        else errors.push({ row: i+1, sim_number, error: e.message })
      }
    }

    res.json({ inserted, skipped, errors })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
