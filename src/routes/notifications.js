const router = require('express').Router()
const { query } = require('../db/pool')
const { auth } = require('../middleware/auth')

// GET /api/notifications — current user's latest 30 notifications
router.get('/', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`,
      [req.user.id]
    )
    res.json({ notifications: result.rows })
  } catch(err) { res.status(500).json({ error: 'Server error' }) }
})

// PATCH /api/notifications/read-all — mark all unread as read
router.patch('/read-all', auth, async (req, res) => {
  try {
    await query(
      `UPDATE notifications SET read=TRUE WHERE user_id=$1 AND read=FALSE`,
      [req.user.id]
    )
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
