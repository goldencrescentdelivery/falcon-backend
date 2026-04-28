const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const { sendPushToUsers } = require('./notifications')

// GET /api/tasks/users — assignable users list (admin only)
router.get('/users', auth, requireRole('admin'), async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, role FROM users
       WHERE role IN ('general_manager','hr','accountant','poc') AND status='active'
       ORDER BY name ASC`
    )
    res.json({ users: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

// GET /api/tasks — admin sees all; others see tasks assigned to them
router.get('/', auth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin'
    const sql = `
      SELECT t.*,
        u.name AS assigned_to_name, u.role AS assigned_to_role,
        a.name AS assigned_by_name
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to::text = u.id::text
      LEFT JOIN users a ON t.assigned_by::text = a.id::text
      ${isAdmin ? '' : 'WHERE t.assigned_to::text = $1'}
      ORDER BY
        CASE t.status WHEN 'completed' THEN 2 ELSE 1 END,
        t.deadline ASC NULLS LAST,
        t.created_at DESC
    `
    const result = isAdmin ? await query(sql) : await query(sql, [req.user.id])
    res.json({ tasks: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

// POST /api/tasks — admin only, creates task + sends push notification
router.post('/', auth, requireRole('admin'), async (req, res) => {
  try {
    const { title, description, assigned_to, deadline, priority } = req.body
    if (!title || !assigned_to || !deadline)
      return res.status(400).json({ error: 'Title, assignee, and deadline are required' })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline))
      return res.status(400).json({ error: 'Deadline must be YYYY-MM-DD' })

    const r = await query(
      `INSERT INTO tasks (title, description, assigned_to, assigned_by, deadline, priority, last_reminder_sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *`,
      [title, description || null, assigned_to, req.user.id, deadline, priority || 'normal']
    )
    const task = r.rows[0]

    // In-app notification
    await query(
      `INSERT INTO notifications (user_id, title, body, type, ref_id)
       VALUES ($1::uuid,$2,$3,'task',$4::uuid)`,
      [assigned_to, `📋 New Task: ${title}`,
       `Deadline: ${deadline}${description ? ' — ' + description.slice(0, 80) : ''}`,
       task.id]
    ).catch(e => console.warn('task notif insert:', e.message))

    // Push notification
    await sendPushToUsers([assigned_to], {
      title: '📋 New Task Assigned',
      body:  `${title} — Due ${deadline}`,
      url:   '/dashboard/tasks',
    }).catch(e => console.warn('task push:', e.message))

    res.status(201).json({ task })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

// PUT /api/tasks/:id — admin can edit task details
router.put('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const { title, description, assigned_to, deadline, priority } = req.body
    if (!title || !assigned_to || !deadline)
      return res.status(400).json({ error: 'Title, assignee, and deadline are required' })

    const r = await query(
      `UPDATE tasks SET title=$1, description=$2, assigned_to=$3, deadline=$4, priority=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [title, description || null, assigned_to,
       /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null,
       priority || 'normal', req.params.id]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ task: r.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

// PATCH /api/tasks/:id/status — assignee or admin can update status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body
    if (!['pending', 'in_progress', 'completed'].includes(status))
      return res.status(400).json({ error: 'Invalid status' })

    const existing = await query(`SELECT * FROM tasks WHERE id=$1`, [req.params.id])
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' })

    const task = existing.rows[0]
    if (req.user.role !== 'admin' && String(task.assigned_to) !== String(req.user.id))
      return res.status(403).json({ error: 'Forbidden' })

    const r = await query(
      `UPDATE tasks SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    )
    res.json({ task: r.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

// DELETE /api/tasks/:id — admin only
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const r = await query(`DELETE FROM tasks WHERE id=$1 RETURNING id`, [req.params.id])
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ message: 'Deleted' })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

module.exports = router
