const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

router.get('/', auth, async (req, res) => {
  try {
    const { status, emp_id, stage } = req.query
    let sql = `
      SELECT l.*, e.name, e.avatar, e.station_code,
             pu.name AS poc_name, hu.name AS hr_name,
             gu.name AS gm_name, mu.name AS mgr_name
      FROM leaves l
      JOIN employees e ON l.emp_id=e.id
      LEFT JOIN users pu ON l.poc_id=pu.id
      LEFT JOIN users hu ON l.hr_id=hu.id
      LEFT JOIN users gu ON l.gm_id=gu.id
      LEFT JOIN users mu ON l.mgr_id=mu.id
      WHERE 1=1`
    const vals = []

    if (req.user.role === 'driver') {
      vals.push(req.user.emp_id); sql += ` AND l.emp_id=$${vals.length}`
    } else if (req.user.role === 'poc') {
      vals.push(req.user.station_code); sql += ` AND e.station_code=$${vals.length}`
      if (!status) sql += ` AND l.poc_status='pending'`
    } else if (req.user.role === 'hr' || req.user.role === 'general_manager') {
      if (stage === 'pending') sql += ` AND l.poc_status='approved' AND (l.hr_status='pending' OR l.gm_status='pending')`
      else if (stage === 'all') {}
      else if (!status && !emp_id) sql += ` AND l.poc_status='approved' AND (l.hr_status='pending' OR l.gm_status='pending')`
      if (emp_id) { vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}` }
      if (status) { vals.push(status); sql += ` AND l.status=$${vals.length}` }
    } else if (req.user.role === 'manager' || req.user.role === 'admin') {
      if (stage === 'pending') sql += ` AND l.hr_status='approved' AND (l.mgr_status='pending' OR l.mgr_status IS NULL)`
      else if (stage === 'all') {}
      else if (!status && !emp_id) sql += ` AND l.hr_status='approved' AND (l.mgr_status='pending' OR l.mgr_status IS NULL)`
      if (emp_id) { vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}` }
      if (status) { vals.push(status); sql += ` AND l.status=$${vals.length}` }
    }

    sql += ' ORDER BY l.created_at DESC'
    const result = await query(sql, vals)
    res.json({ leaves: result.rows })
  } catch (err) { console.error('leaves GET error:', err.message); res.status(500).json({ error: 'Server error' }) }
})

router.post('/', auth, async (req, res) => {
  try {
    const { emp_id, type, from_date, to_date, days, reason } = req.body
    const actualEmpId = req.user.role === 'driver' ? req.user.emp_id : emp_id
    if (!actualEmpId) return res.status(400).json({ error: 'Employee ID required. Make sure your account is linked to an employee record.' })
    if (!from_date || !to_date) return res.status(400).json({ error: 'From and to dates required' })

    // Insert with only guaranteed columns — optional ones added if they exist
    const result = await query(`
      INSERT INTO leaves (emp_id, type, from_date, to_date, days, reason, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING *
    `, [actualEmpId, type||'Annual', from_date, to_date, days||1, reason||null])

    const leave = result.rows[0]

    // Try to set workflow columns if they exist (non-fatal if they don't)
    try {
      await query(`
        UPDATE leaves SET poc_status='pending', hr_status='waiting', gm_status='waiting', mgr_status='waiting'
        WHERE id=$1
      `, [leave.id])
    } catch(e) { /* columns may not exist yet, that's ok */ }

    req.io?.emit('leave:created', leave)
    res.status(201).json({ leave })
  } catch (err) {
    console.error('leaves POST error:', err.message)
    if (err.message.includes('violates foreign key')) {
      return res.status(400).json({ error: 'Your account is not linked to an employee record. Ask your admin to update your User Account with the correct Employee ID.' })
    }
    res.status(500).json({ error: err.message || 'Server error' })
  }
})

// Stage 1: POC
router.patch('/:id/poc', auth, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { status, note } = req.body
    if (req.user.role === 'poc') {
      const check = await query(`SELECT l.id FROM leaves l JOIN employees e ON l.emp_id=e.id WHERE l.id=$1 AND e.station_code=$2`, [req.params.id, req.user.station_code])
      if (!check.rows[0]) return res.status(403).json({ error: 'Not your station' })
    }
    const hrStatus    = status === 'rejected' ? 'waiting' : 'pending'
    const finalStatus = status === 'rejected' ? 'rejected' : 'pending'
    await query(`
      UPDATE leaves SET poc_status=$1, poc_id=$2, poc_note=$3, poc_actioned_at=NOW(),
        status=$4, hr_status=$5, gm_status=$5, updated_at=NOW()
      WHERE id=$6
    `, [status, req.user.id, note||null, finalStatus, hrStatus, req.params.id])
    const result = await query('SELECT * FROM leaves WHERE id=$1', [req.params.id])
    req.io?.emit('leave:updated', result.rows[0])
    res.json({ leave: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

// Stage 2: HR or GM
router.patch('/:id/hr', auth, requireRole('admin','manager','general_manager','hr'), async (req, res) => {
  try {
    const { status, note } = req.body
    const mgrStatus   = status === 'rejected' ? 'waiting' : 'pending'
    const finalStatus = status === 'rejected' ? 'rejected' : 'pending'
    await query(`
      UPDATE leaves SET hr_status=$1, gm_status=$1, hr_id=$2, gm_id=$2,
        hr_note=$3, gm_note=$3, hr_actioned_at=NOW(), gm_actioned_at=NOW(),
        status=$4, mgr_status=$5, updated_at=NOW()
      WHERE id=$6 AND poc_status='approved'
    `, [status, req.user.id, note||null, finalStatus, mgrStatus, req.params.id])
    const result = await query('SELECT * FROM leaves WHERE id=$1', [req.params.id])
    req.io?.emit('leave:updated', result.rows[0])
    res.json({ leave: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

// Stage 3: Manager final
router.patch('/:id/manager', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { status, note } = req.body
    await query(`
      UPDATE leaves SET mgr_status=$1, mgr_id=$2, mgr_note=$3, mgr_actioned_at=NOW(),
        status=$1, updated_at=NOW()
      WHERE id=$4
    `, [status, req.user.id, note||null, req.params.id])
    const result = await query('SELECT * FROM leaves WHERE id=$1', [req.params.id])
    req.io?.emit('leave:updated', result.rows[0])
    res.json({ leave: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

router.patch('/:id/status', auth, requireRole('admin','manager','poc','hr','general_manager'), async (req, res) => {
  try {
    const { status } = req.body
    const result = await query(`UPDATE leaves SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [status, req.params.id])
    req.io?.emit('leave:updated', result.rows[0])
    res.json({ leave: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.delete('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    await query('DELETE FROM leaves WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router