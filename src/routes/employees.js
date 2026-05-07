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
    if (req.user.role === 'poc' && req.user.station_code) { vals.push(req.user.station_code); sql += ` AND station_code=$${vals.length}` }
    sql += ' ORDER BY name'
    const result = await query(sql, vals)
    res.json({ employees: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/employees/for-handover — all active drivers, visible to any authenticated user
router.get('/for-handover', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, station_code
       FROM employees
       WHERE LOWER(COALESCE(status, '')) = 'active'
         AND (
           LOWER(COALESCE(role, '')) = 'driver'
           OR LOWER(COALESCE(dept, '')) = 'operations'
         )
       ORDER BY name`,
      []
    )
    res.json({ employees: result.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
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

router.post('/', auth, requireRole('admin','manager','general_manager','hr','accountant'), async (req, res) => {
  try {
    const { id,name,role,dept,status='active',salary=0,joined,phone,nationality,zone,
      visa_expiry,license_expiry,avatar='👤',station,station_code='DDB7',
      hourly_rate=3.85,iloe_expiry,annual_leave_start,amazon_id,emirates_id,annual_leave_balance=30,
      sub_group_name,beneficiary_first_name,beneficiary_middle_name,beneficiary_last_name,
      father_family_name,dob,gender,marital_status,uid_number,emirates_issuing_visa,
      residential_location,work_location,passport_no,email_id,visa_file_no,insurance_url,
      project_type='pulser',per_shipment_rate=0.5,performance_bonus=0,visa_type='company' } = req.body
    if (!id||!name||!role||!dept) return res.status(400).json({ error: 'id, name, role, dept required' })
    const result = await query(`
      INSERT INTO employees (id,name,role,dept,status,salary,joined,phone,nationality,zone,
        visa_expiry,license_expiry,avatar,station,station_code,hourly_rate,
        iloe_expiry,annual_leave_start,amazon_id,emirates_id,annual_leave_balance,
        sub_group_name,beneficiary_first_name,beneficiary_middle_name,beneficiary_last_name,
        father_family_name,dob,gender,marital_status,uid_number,emirates_issuing_visa,
        residential_location,work_location,passport_no,email_id,visa_file_no,insurance_url,
        project_type,per_shipment_rate,performance_bonus,visa_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
              $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,
              $38,$39,$40,$41) RETURNING *`,
      [id,name,role,dept,status,salary,joined||null,phone||null,nationality||null,zone||null,
       visa_expiry||null,license_expiry||null,avatar,station||null,station_code,hourly_rate,
       iloe_expiry||null,annual_leave_start||null,amazon_id||null,emirates_id||null,annual_leave_balance,
       sub_group_name||null,beneficiary_first_name||null,beneficiary_middle_name||null,beneficiary_last_name||null,
       father_family_name||null,dob||null,gender||null,marital_status||null,uid_number||null,emirates_issuing_visa||null,
       residential_location||null,work_location||null,passport_no||null,email_id||null,visa_file_no||null,insurance_url||null,
       project_type,Number(per_shipment_rate)||0.5,Number(performance_bonus)||0,visa_type||'company'])
    req.io?.emit('employee:created', result.rows[0])
    res.status(201).json({ employee: result.rows[0] })
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error: 'Employee ID already exists' })
    console.error(err); res.status(500).json({ error: 'Server error' })
  }
})

router.put('/:id', auth, requireRole('admin','manager','general_manager','poc','hr','accountant'), async (req, res) => {
  try {
    const { name,role,dept,status,salary,joined,phone,nationality,zone,visa_expiry,
      license_expiry,avatar,station,station_code,hourly_rate,iloe_expiry,
      annual_leave_start,amazon_id,emirates_id,annual_leave_balance,
      sub_group_name,beneficiary_first_name,beneficiary_middle_name,beneficiary_last_name,
      father_family_name,dob,gender,marital_status,uid_number,emirates_issuing_visa,
      residential_location,work_location,passport_no,email_id,visa_file_no,insurance_url,
      project_type,per_shipment_rate,performance_bonus,visa_type } = req.body

    // Sanitise date fields — only accept YYYY-MM-DD, reject phone-like junk
    const sd = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) ? v : null

    const result = await query(`
      UPDATE employees SET name=$1,role=$2,dept=$3,status=$4,salary=$5,joined=$6,phone=$7,
        nationality=$8,zone=$9,visa_expiry=$10,license_expiry=$11,avatar=$12,station=$13,
        station_code=$14,hourly_rate=$15,iloe_expiry=$16,annual_leave_start=$17,
        amazon_id=$18,emirates_id=$19,annual_leave_balance=$20,
        sub_group_name=$21,beneficiary_first_name=$22,beneficiary_middle_name=$23,
        beneficiary_last_name=$24,father_family_name=$25,dob=$26,gender=$27,
        marital_status=$28,uid_number=$29,emirates_issuing_visa=$30,
        residential_location=$31,work_location=$32,passport_no=$33,
        email_id=$34,visa_file_no=$35,insurance_url=$36,
        project_type=$37,per_shipment_rate=$38,performance_bonus=$39,visa_type=$40,updated_at=NOW()
      WHERE id=$41 RETURNING *`,
      [name,role,dept,status,Number(salary)||0,sd(joined),phone||null,nationality||null,zone||null,
       sd(visa_expiry),sd(license_expiry),avatar||'👤',station||null,station_code||'DDB1',
       Number(hourly_rate)||3.85,sd(iloe_expiry),sd(annual_leave_start),amazon_id||null,
       emirates_id||null,Number(annual_leave_balance)||30,
       sub_group_name||null,beneficiary_first_name||null,beneficiary_middle_name||null,
       beneficiary_last_name||null,father_family_name||null,sd(dob),gender||null,
       marital_status||null,uid_number||null,emirates_issuing_visa||null,
       residential_location||null,work_location||null,passport_no||null,
       email_id||null,visa_file_no||null,insurance_url||null,
       project_type||'pulser',Number(per_shipment_rate)||0.5,Number(performance_bonus)||0,
       visa_type||'company',req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })

    // Sync linked user account status with employee status
    const userStatus = status === 'inactive' ? 'inactive' : 'active'
    await query(
      `UPDATE users SET status=$1 WHERE emp_id=$2`,
      [userStatus, req.params.id]
    ).catch(() => {})

    req.io?.emit('employee:updated', result.rows[0])
    res.json({ employee: result.rows[0] })
  } catch (err) {
    console.error('PUT /employees/:id error:', err.message, err.detail||'')
    res.status(500).json({ error: err.detail || err.message || 'Server error' })
  }
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
      const prevCleared = await query(`UPDATE employees SET work_number=NULL WHERE id=$1 RETURNING *`, [sim.emp_id])
      const prev = prevCleared.rows[0]
      await query(
        `INSERT INTO work_number_history (emp_id,emp_name,phone_number,sim_id,action,prev_emp_id,prev_emp_name,performed_by)
         VALUES ($1,$2,$3,$4,'removed',$5,$6,$7)`,
        [prev?.id, prev?.name, phone_number, sim.id, emp.id, emp.name, req.user.id]
      )
      if (prev) req.io?.emit('employee:updated', prev)
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

    // 5. Assign — run all three writes in parallel
    const action = (sim.emp_id && sim.emp_id !== empId) ? 'reassigned' : 'assigned'
    const [empUpdated] = await Promise.all([
      query(`UPDATE employees SET work_number=$1 WHERE id=$2 RETURNING *`, [phone_number, empId]),
      query(`UPDATE sim_cards SET emp_id=$1, status='assigned', assigned_at=NOW(), assigned_by=$2 WHERE id=$3`,
        [empId, req.user.id, sim.id]),
      query(`INSERT INTO work_number_history (emp_id,emp_name,phone_number,sim_id,action,performed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [emp.id, emp.name, phone_number, sim.id, action, req.user.id]),
    ])
    req.io?.emit('employee:updated', empUpdated.rows[0])
    res.json({ ok: true, employee: empUpdated.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/employees/:id/work-number — unassign work number
router.delete('/:id/work-number', auth, requireRole('admin','manager','general_manager','poc','hr'), async (req, res) => {
  try {
    const empRes = await query(`SELECT * FROM employees WHERE id=$1`, [req.params.id])
    if (!empRes.rows[0]) return res.status(404).json({ error: 'Not found' })
    const emp = empRes.rows[0]
    if (!emp.work_number) return res.json({ ok: true })

    const [empCleared] = await Promise.all([
      query(`UPDATE employees SET work_number=NULL WHERE id=$1 RETURNING *`, [req.params.id]),
      query(`UPDATE sim_cards SET emp_id=NULL, status='available', assigned_at=NULL, assigned_by=NULL WHERE phone_number=$1`,
        [emp.work_number]),
      query(`INSERT INTO work_number_history (emp_id,emp_name,phone_number,action,performed_by) VALUES ($1,$2,$3,'removed',$4)`,
        [emp.id, emp.name, emp.work_number, req.user.id]),
    ])
    req.io?.emit('employee:updated', empCleared.rows[0])
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/employees/:id/create-user — create a login account linked to this employee
router.post('/:id/create-user', auth, requireRole('admin','manager','general_manager'), async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'email and password required' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

    const empRes = await query('SELECT * FROM employees WHERE id=$1', [req.params.id])
    if (!empRes.rows[0]) return res.status(404).json({ error: 'Employee not found' })
    const emp = empRes.rows[0]

    const bcrypt = require('bcryptjs')
    const hash   = await bcrypt.hash(password, 12)
    const r = await query(`
      INSERT INTO users (email, password_hash, name, role, emp_id, station_code, status)
      VALUES ($1,$2,$3,'driver',$4,$5,'active')
      RETURNING id, email, name, role, emp_id, station_code, status
    `, [email.trim().toLowerCase(), hash, emp.name, emp.id, emp.station_code])

    await query('UPDATE employees SET user_id=$1 WHERE id=$2', [r.rows[0].id, emp.id])

    res.status(201).json({ user: r.rows[0] })
  } catch(err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' })
    console.error(err); res.status(500).json({ error: 'Server error' })
  }
})

router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const eid = req.params.id
    // Null out FK references that have no ON DELETE rule (would otherwise RESTRICT)
    // receiver_emp_id has no ON DELETE clause; emp_id in handovers uses CASCADE (auto-deleted)
    await query('UPDATE vehicle_handovers SET receiver_emp_id=NULL WHERE receiver_emp_id=$1', [eid])
    // payslip_exports has no ON DELETE clause
    await query('UPDATE payslip_exports SET emp_id=NULL WHERE emp_id=$1', [eid])
    // employees.user_id FK must be cleared before deleting the linked user row
    await query('UPDATE employees SET user_id=NULL WHERE id=$1', [eid])
    await query('DELETE FROM users WHERE emp_id=$1', [eid])
    const result = await query('DELETE FROM employees WHERE id=$1 RETURNING id', [eid])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    req.io?.emit('employee:deleted', { id: eid })
    res.json({ message: 'Employee deleted' })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
