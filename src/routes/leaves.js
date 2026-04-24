const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const V = require('../middleware/validate')
const { sendPushToUsers } = require('./notifications')

router.get('/', auth, async (req, res) => {
  try {
    const { status, emp_id, stage } = req.query
    let sql  = `
      SELECT l.*, e.name, e.avatar, e.station_code,
             u1.name AS poc_approver_name,
             u2.name AS mgr_approver_name,
             u3.name AS admin_approver_name
      FROM leaves l
      JOIN employees e ON l.emp_id=e.id
      LEFT JOIN users u1 ON l.poc_id=u1.id
      LEFT JOIN users u2 ON l.hr_id=u2.id
      LEFT JOIN users u3 ON l.mgr_id=u3.id
      WHERE 1=1`
    const vals = []

    if (req.user.role === 'driver') {
      vals.push(req.user.emp_id); sql += ` AND l.emp_id=$${vals.length}`
    } else if (req.user.role === 'poc') {
      vals.push(req.user.station_code); sql += ` AND e.station_code=$${vals.length}`
      if (stage === 'pending') {
        sql += ` AND l.poc_status='pending'`
      } else if (status) {
        vals.push(status); sql += ` AND l.status=$${vals.length}`
      }
    } else if (req.user.role === 'manager') {
      if (emp_id) { vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}` }
      if (stage === 'pending') {
        sql += ` AND l.poc_status='approved' AND l.hr_status NOT IN ('approved','rejected')`
      } else if (status) {
        vals.push(status); sql += ` AND l.status=$${vals.length}`
      }
    } else {
      // admin / general_manager / hr — sees all
      if (emp_id) { vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}` }
      if (stage === 'pending') {
        sql += ` AND l.hr_status='approved' AND l.mgr_status NOT IN ('approved','rejected')`
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

    // DA → POC → Manager → Admin — all three stages start pending
    const result = await query(`
      INSERT INTO leaves (emp_id, type, from_date, to_date, days, reason, poc_status, hr_status, mgr_status)
      VALUES ($1,$2,$3,$4,$5,$6,'pending','pending','pending') RETURNING *
    `, [actualEmpId, type, from_date, to_date, days, reason||null])
    req.io?.emit('leave:created', result.rows[0])
    res.status(201).json({ leave: result.rows[0] })
  } catch (err) { console.error('LEAVE CREATE ERR:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// PATCH /:id/status — Step 1: POC approves/rejects
router.patch('/:id/status', auth, requireRole('admin','general_manager','poc'), async (req, res) => {
  try {
    const { status } = req.body
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' })

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

// PATCH /:id/hr — Step 2: Manager approves/rejects (after POC)
router.patch('/:id/hr', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { status } = req.body
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' })

    const check = await query(`SELECT poc_status FROM leaves WHERE id=$1`, [req.params.id])
    if (!check.rows[0]) return res.status(404).json({ error: 'Leave not found' })
    if (!['approved'].includes(check.rows[0].poc_status))
      return res.status(400).json({ error: 'POC must approve before manager can act' })

    const result = await query(`
      UPDATE leaves SET
        hr_status  = $1,
        hr_id      = $2,
        mgr_status = CASE WHEN $1='approved' THEN 'pending' ELSE mgr_status END,
        status     = CASE WHEN $1='rejected' THEN 'rejected' ELSE status END,
        updated_at = NOW()
      WHERE id=$3 RETURNING *
    `, [status, req.user.id, req.params.id])

    req.io?.emit('leave:updated', result.rows[0])

    // Notify admins when manager approves — leave is now awaiting final admin decision
    if (status === 'approved') {
      const leave    = result.rows[0]
      const empRow   = await query(`SELECT name FROM employees WHERE id=$1`, [leave.emp_id])
      const empName  = empRow.rows[0]?.name || leave.emp_id
      const admins   = await query(`SELECT id FROM users WHERE role IN ('admin','general_manager') AND status='active'`)
      const adminIds = admins.rows.map(r => r.id)
      sendPushToUsers(adminIds, {
        title: '✅ Leave Awaiting Final Approval',
        body:  `${empName}'s leave request has been approved by POC & Manager — your approval required`,
        url:   '/dashboard/hr/leaves',
      }).catch(() => {})
    }

    res.json({ leave: result.rows[0] })
  } catch (err) { console.error('LEAVE MGR ERR:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// PATCH /:id/manager — Step 3: Admin final approval/rejection
router.patch('/:id/manager', auth, requireRole('admin','general_manager'), async (req, res) => {
  try {
    const { status } = req.body
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' })

    const check = await query(`SELECT hr_status FROM leaves WHERE id=$1`, [req.params.id])
    if (!check.rows[0]) return res.status(404).json({ error: 'Leave not found' })
    if (check.rows[0].hr_status !== 'approved')
      return res.status(400).json({ error: 'Manager must approve before admin can act' })

    const result = await query(`
      UPDATE leaves SET
        mgr_status = $1,
        mgr_id     = $2,
        status     = $1,
        updated_at = NOW()
      WHERE id=$3 RETURNING *
    `, [status, req.user.id, req.params.id])

    if (!result.rows[0]) return res.status(404).json({ error: 'Leave not found' })

    // Decrement annual leave balance when fully approved
    const leave = result.rows[0]
    if (status === 'approved' && leave.type === 'Annual' && leave.days > 0) {
      await query(
        `UPDATE employees SET annual_leave_balance = GREATEST(0, annual_leave_balance - $1) WHERE id = $2`,
        [leave.days, leave.emp_id]
      ).catch(e => console.error('Leave balance update error:', e.message))
    }

    req.audit('FINAL_DECISION', 'leave', req.params.id,
      { mgr_status: 'pending' }, { mgr_status: status, decided_by: req.user.id })

    req.io?.emit('leave:updated', result.rows[0])
    res.json({ leave: result.rows[0] })
  } catch (err) { console.error('LEAVE ADMIN ERR:', err.message); res.status(500).json({ error: 'Server error' }) }
})

router.delete('/:id', auth, requireRole('admin','general_manager'), async (req, res) => {
  try {
    await query('DELETE FROM leaves WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
