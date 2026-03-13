const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

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

router.get('/:id', auth, async (req, res) => {
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

router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const result = await query('DELETE FROM employees WHERE id=$1 RETURNING id', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    req.io?.emit('employee:deleted', { id: req.params.id })
    res.json({ message: 'Employee deleted' })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
