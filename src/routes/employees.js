const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const V = require('../middleware/validate')

router.get('/', auth, async (req, res) => {
  try {
    const { dept, status, search, station_code } = req.query
    let sql    = 'SELECT * FROM employees WHERE 1=1'
    const vals = []
    if (dept)         { vals.push(dept);        sql += ` AND dept=$${vals.length}` }
    if (status)       { vals.push(status);       sql += ` AND status=$${vals.length}` }
    if (station_code) { vals.push(station_code); sql += ` AND station_code=$${vals.length}` }
    if (search) {
      vals.push(`%${search.toLowerCase()}%`)
      sql += ` AND (LOWER(name) LIKE $${vals.length} OR LOWER(id) LIKE $${vals.length} OR LOWER(COALESCE(amazon_id,'')) LIKE $${vals.length})`
    }
    if (req.user.role === 'driver') { vals.push(req.user.emp_id); sql += ` AND id=$${vals.length}` }
    sql += ' ORDER BY name'
    const result = await query(sql, vals)
    res.json({ employees: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/employees/work-number/history — full assignment log (must be before /:id)
router.get('/work-number/history', auth, requireRole('admin','manager','general_manager','hr'), async (req, res) => {
  try {
    const { emp_id } = req.query
    let sql = `SELECT * FROM work_number_history`
    const vals = []
    if (emp_id) { vals.push(emp_id); sql += ` WHERE emp_id=$1` }
    sql += ' ORDER BY performed_at DESC LIMIT 200'
    const result = await query(sql, vals)
    res.json({ history: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

router.get('/:id', auth, V.validateParams({ id: 'id' }), async (req, res) => {
  try {
    if (req.user.role === 'driver' && req.user.emp_id !== req.params.id)
      return res.status(403).json({ error: 'Forbidden' })
    const result = await query('SELECT * FROM employees WHERE id=$1', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ employee: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { id,name,role,dept,status='active',salary=0,joined,phone,nationality,zone,
      visa_expiry,license_expiry,avatar='👤',station,station_code='DDB7',
      hourly_rate=3.85,iloe_expiry,annual_leave_start,amazon_id,emirates_id,annual_leave_balance=30 } = req.body
    if (!id||!name||!role||!dept) return res.status(400).json({ error: 'id, name, role, dept required' })
    const result = await query(`
      INSERT INTO employees (id,name,role,dept,status,salary,joined,phone,nationality,zone,
        visa_expiry,license_expiry,avatar,station,station_code,hourly_rate,
        iloe_expiry,annual_leave_start,amazon_id,emirates_id,annual_leave_balance)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [id,name,role,dept,status,salary,joined||null,phone||null,nationality||null,zone||null,
       visa_expiry||null,license_expiry||null,avatar,station||null,station_code,hourly_rate,
       iloe_expiry||null,annual_leave_start||null,amazon_id||null,emirates_id||null,annual_leave_balance])
    req.io?.emit('employee:created', result.rows[0])
    res.status(201).json({ employee: result.rows[0] })
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error: 'Employee ID already exists' })
    console.error(err); res.status(500).json({ error: 'Server error' })
  }
})

router.put('/:id', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { name,role,dept,status,salary,joined,phone,nationality,zone,visa_expiry,
      license_expiry,avatar,station,station_code,hourly_rate,iloe_expiry,
      annual_leave_start,amazon_id,emirates_id,annual_leave_balance } = req.body
    const result = await query(`
      UPDATE employees SET name=$1,role=$2,dept=$3,status=$4,salary=$5,joined=$6,phone=$7,
        nationality=$8,zone=$9,visa_expiry=$10,license_expiry=$11,avatar=$12,station=$13,
        station_code=$14,hourly_rate=$15,iloe_expiry=$16,annual_leave_start=$17,
        amazon_id=$18,emirates_id=$19,annual_leave_balance=$20,updated_at=NOW()
      WHERE id=$21 RETURNING *`,
      [name,role,dept,status,salary,joined||null,phone||null,nationality||null,zone||null,
       visa_expiry||null,license_expiry||null,avatar||'👤',station||null,station_code||'DDB7',
       hourly_rate||3.85,iloe_expiry||null,annual_leave_start||null,amazon_id||null,
       emirates_id||null,annual_leave_balance||30,req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    req.io?.emit('employee:updated', result.rows[0])
    res.json({ employee: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/employees/:id/assign-work-number
router.post('/:id/assign-work-number', auth, requireRole('admin','manager','general_manager','poc','hr'), async (req, res) => {
  const { phone_number, force = false } = req.body
  const empId = req.params.id
  try {
    // 1. SIM must exist with this phone number
    const simRes = await query(`SELECT * FROM sim_cards WHERE phone_number=$1`, [phone_number])
    if (!simRes.rows[0]) return res.status(400).json({ error: 'Number not found in SIM cards' })
    const sim = simRes.rows[0]

    // 2. Target employee must exist
    const empRes = await query(`SELECT * FROM employees WHERE id=$1`, [empId])
    if (!empRes.rows[0]) return res.status(404).json({ error: 'Employee not found' })
    const emp = empRes.rows[0]

    // 3. Conflict check — SIM already assigned to someone else
    if (sim.emp_id && sim.emp_id !== empId) {
      if (!force) {
        const prevRes = await query(`SELECT id, name FROM employees WHERE id=$1`, [sim.emp_id])
        const prev = prevRes.rows[0]
        return res.json({ conflict: true, conflictEmpId: prev?.id, conflictEmpName: prev?.name })
      }
      // Forced: strip number from previous employee & log removal
      const prevRes = await query(`SELECT id, name FROM employees WHERE id=$1`, [sim.emp_id])
      const prev = prevRes.rows[0]
      await query(`UPDATE employees SET work_number=NULL WHERE id=$1`, [sim.emp_id])
      await query(
        `INSERT INTO work_number_history (emp_id,emp_name,phone_number,sim_id,action,prev_emp_id,prev_emp_name,performed_by)
         VALUES ($1,$2,$3,$4,'removed',$5,$6,$7)`,
        [prev?.id, prev?.name, phone_number, sim.id, emp.id, emp.name, req.user.id]
      )
      const prevUpdated = await query(`SELECT * FROM employees WHERE id=$1`, [sim.emp_id])
      if (prevUpdated.rows[0]) req.io?.emit('employee:updated', prevUpdated.rows[0])
    }

    // 4. Release this employee's old SIM if different
    if (emp.work_number && emp.work_number !== phone_number) {
      await query(
        `UPDATE sim_cards SET emp_id=NULL, status='available', assigned_at=NULL, assigned_by=NULL WHERE phone_number=$1`,
        [emp.work_number]
      )
      await query(
        `INSERT INTO work_number_history (emp_id,emp_name,phone_number,action,performed_by) VALUES ($1,$2,$3,'removed',$4)`,
        [emp.id, emp.name, emp.work_number, req.user.id]
      )
    }

    // 5. Assign
    const action = (sim.emp_id && sim.emp_id !== empId) ? 'reassigned' : 'assigned'
    await query(`UPDATE employees SET work_number=$1 WHERE id=$2`, [phone_number, empId])
    await query(
      `UPDATE sim_cards SET emp_id=$1, status='assigned', assigned_at=NOW(), assigned_by=$2 WHERE id=$3`,
      [empId, req.user.id, sim.id]
    )
    await query(
      `INSERT INTO work_number_history (emp_id,emp_name,phone_number,sim_id,action,performed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [emp.id, emp.name, phone_number, sim.id, action, req.user.id]
    )

    const updated = await query(`SELECT * FROM employees WHERE id=$1`, [empId])
    req.io?.emit('employee:updated', updated.rows[0])
    res.json({ ok: true, employee: updated.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/employees/:id/work-number — unassign work number
router.delete('/:id/work-number', auth, requireRole('admin','manager','general_manager','poc','hr'), async (req, res) => {
  try {
    const empRes = await query(`SELECT * FROM employees WHERE id=$1`, [req.params.id])
    if (!empRes.rows[0]) return res.status(404).json({ error: 'Not found' })
    const emp = empRes.rows[0]
    if (!emp.work_number) return res.json({ ok: true })

    await query(
      `UPDATE sim_cards SET emp_id=NULL, status='available', assigned_at=NULL, assigned_by=NULL WHERE phone_number=$1`,
      [emp.work_number]
    )
    await query(
      `INSERT INTO work_number_history (emp_id,emp_name,phone_number,action,performed_by) VALUES ($1,$2,$3,'removed',$4)`,
      [emp.id, emp.name, emp.work_number, req.user.id]
    )
    await query(`UPDATE employees SET work_number=NULL WHERE id=$1`, [req.params.id])

    const updated = await query(`SELECT * FROM employees WHERE id=$1`, [req.params.id])
    req.io?.emit('employee:updated', updated.rows[0])
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const result = await query('DELETE FROM employees WHERE id=$1 RETURNING id', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    req.io?.emit('employee:deleted', { id: req.params.id })
    res.json({ message: 'Employee deleted' })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

module.exports = router