const router = require('express').Router()
const { query } = require('../db/pool')
const { auth } = require('../middleware/auth')
const { getPublicKey, sendPush } = require('../lib/webpush')

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

// GET /api/notifications/vapid-public-key — expose VAPID public key to frontend
router.get('/vapid-public-key', async (_req, res) => {
  try {
    const key = await getPublicKey()
    res.json({ key })
  } catch(err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/notifications/subscribe — save a push subscription for this user
router.post('/subscribe', auth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body
    if (!endpoint || !keys?.p256dh || !keys?.auth)
      return res.status(400).json({ error: 'Invalid subscription object' })

    await query(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh=$3, auth=$4
    `, [req.user.id, endpoint, keys.p256dh, keys.auth])

    res.json({ ok: true })
  } catch(err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/notifications/unsubscribe — remove a push subscription
router.delete('/unsubscribe', auth, async (req, res) => {
  try {
    const { endpoint } = req.body
    if (endpoint) {
      await query(`DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2`, [req.user.id, endpoint])
    } else {
      await query(`DELETE FROM push_subscriptions WHERE user_id=$1`, [req.user.id])
    }
    res.json({ ok: true })
  } catch(err) { res.status(500).json({ error: 'Server error' }) }
})

// Internal helper used by other routes to fan-out push to a list of user_ids
async function sendPushToUsers(userIds, payload) {
  if (!userIds?.length) return
  const subs = await query(
    `SELECT * FROM push_subscriptions WHERE user_id = ANY($1::uuid[])`,
    [userIds]
  )
  const dead = []
  for (const sub of subs.rows) {
    try {
      await sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload)
    } catch(e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.id)
    }
  }
  if (dead.length) {
    await query(`DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])`, [dead])
  }
}

module.exports = router
module.exports.sendPushToUsers = sendPushToUsers
