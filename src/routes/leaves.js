const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const V = require('../middleware/validate')

router.get('/', auth, async (req, res) => {
  try {
    const { status, emp_id, stage } = req.query
    let sql  = `SELECT l.*, e.name, e.avatar, e.station_code, u.name AS mgr_name FROM leaves l JOIN employees e ON l.emp_id=e.id LEFT JOIN users u ON l.mgr_id=u.id WHERE 1=1`
    const vals = []
    if (req.user.role === 'driver') {
      vals.push(req.user.emp_id); sql += ` AND l.emp_id=$${vals.length}`
    } else if (req.user.role === 'poc') {
      // POC sees all leaves for their station (read-only visibility)
      vals.push(req.user.station_code); sql += ` AND e.station_code=$${vals.length}`
      if (status) { vals.push(status); sql += ` AND l.status=$${vals.length}` }
    } else if (req.user.role === 'manager') {
      // Manager sees leaves pending their approval
      if (emp_id) { vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}` }
      if (stage === 'pending') {
        sql += ` AND l.mgr_status='pending'`
      } else if (status) {
        vals.push(status); sql += ` AND l.status=$${vals.length}`
      }
    } else {
      // admin / general_manager / hr — see all leaves
      if (emp_id) { vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}` }
      if (stage === 'pending') {
        sql += ` AND l.mgr_status='pending'`
      } else if (status) {
        vals.push(status); sql += ` AND l.status=$${vals.length}`
      }
    }
    sql += ' ORDER BY l.created_at DESC'
    const result = await query(sql, vals)
    res.json({ leaves: result.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.post('/', auth, V.validateLeave, async (req, res) => {
  try {
    const { emp_id, type, from_date, to_date, days, reason } = req.body
    const actualEmpId = req.user.role === 'driver' ? req.user.emp_id : emp_id

    // All leave requests go directly to manager — skip POC and HR steps
    const pocSt  = 'approved'
    const hrSt   = 'approved'
    const mgrSt  = 'pending'

    const result = await query(`
      INSERT INTO leaves (emp_id, type, from_date, to_date, days, reason, poc_status, hr_status, mgr_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [actualEmpId, type, from_date, to_date, days, reason||null, pocSt, hrSt, mgrSt])
    req.io?.emit('leave:created', result.rows[0])
    res.status(201).json({ leave: result.rows[0] })
  } catch (err) { console.error('LEAVE CREATE ERR:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// PATCH /:id/status — POC approves/rejects for their station
router.patch('/:id/status', auth, requireRole('admin','general_manager','poc','hr'), async (req, res) => {
  try {
    const { status } = req.body
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' })

    // POC can only action leaves for their station
    if (req.user.role === 'poc') {
      const check = await query(`
        SELECT l.id FROM leaves l JOIN employees e ON l.emp_id=e.id
        WHERE l.id=$1 AND e.station_code=$2
      `, [req.params.id, req.user.station_code])
      if (!check.rows[0]) return res.status(403).json({ error: 'Not your station' })
    }

    const result = await query(`
      UPDATE leaves SET
        poc_status      = $1,
        poc_id          = $2,
        poc_station     = $3,
        approved_by_poc = $2,
        hr_status       = CASE WHEN $1='approved' THEN 'pending' ELSE hr_status END,
        status          = CASE WHEN $1='rejected' THEN 'rejected' ELSE status END,
        updated_at      = NOW()
      WHERE id=$4 RETURNING *
    `, [status, req.user.id, req.user.station_code||null, req.params.id])

    if (!result.rows[0]) return res.status(404).json({ error: 'Leave not found' })
    req.io?.emit('leave:updated', result.rows[0])
    res.json({ leave: result.rows[0] })
  } catch (err) { console.error('LEAVE POC ERR:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// PATCH /:id/hr — HR or General Manager approves/rejects (step 2)
router.patch('/:id/hr', auth, requireRole('admin','general_manager','hr'), async (req, res) => {
  try {
    const { status } = req.body
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' })

    const result = await query(`
      UPDATE leaves SET
        hr_status     = $1,
        hr_id         = $2,
        mgr_status    = CASE WHEN $1='approved' THEN 'pending' ELSE mgr_status END,
        status        = CASE WHEN $1='rejected' THEN 'rejected' ELSE status END,
        updated_at    = NOW()
      WHERE id=$3 RETURNING *
    `, [status, req.user.id, req.params.id])

    if (!result.rows[0]) return res.status(404).json({ error: 'Leave not found' })
    req.io?.emit('leave:updated', result.rows[0])
    res.json({ leave: result.rows[0] })
  } catch (err) { console.error('LEAVE HR ERR:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// PATCH /:id/manager — Manager approves or rejects leave
router.patch('/:id/manager', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { status } = req.body
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' })

    const result = await query(`
      UPDATE leaves SET
        mgr_status  = $1,
        mgr_id      = $2,
        status      = $1,
        updated_at  = NOW()
      WHERE id=$3 RETURNING *
    `, [status, req.user.id, req.params.id])

    if (!result.rows[0]) return res.status(404).json({ error: 'Leave not found' })

    // Auto-decrement annual leave balance when Annual leave is fully approved
    const leave = result.rows[0]
    if (status === 'approved' && leave.type === 'Annual' && leave.days > 0) {
      await query(
        `UPDATE employees SET annual_leave_balance = GREATEST(0, annual_leave_balance - $1) WHERE id = $2`,
        [leave.days, leave.emp_id]
      ).catch(e => console.error('Leave balance update error:', e.message))
    }

    req.io?.emit('leave:updated', result.rows[0])
    res.json({ leave: result.rows[0] })
  } catch (err) { console.error('LEAVE MGR ERR:', err.message); res.status(500).json({ error: 'Server error' }) }
})

router.delete('/:id', auth, requireRole('admin','general_manager'), async (req, res) => {
  try {
    await query('DELETE FROM leaves WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
