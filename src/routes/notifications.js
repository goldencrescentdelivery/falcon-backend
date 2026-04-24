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

// GET /api/notifications/alerts — expired/expiring documents for all employees
router.get('/alerts', auth, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    const result = await query(`
      SELECT id, name, role, station_code,
        visa_expiry, license_expiry, iloe_expiry
      FROM employees
      WHERE status = 'active'
        AND (
          (visa_expiry     IS NOT NULL AND visa_expiry     <= $1) OR
          (license_expiry  IS NOT NULL AND license_expiry  <= $1) OR
          (iloe_expiry     IS NOT NULL AND iloe_expiry     <= $1)
        )
      ORDER BY name
    `, [cutoff])

    const today  = new Date()
    const alerts = []

    for (const emp of result.rows) {
      for (const [field, label] of [['visa_expiry','Visa'],['license_expiry','License'],['iloe_expiry','ILOE']]) {
        const d = emp[field]
        if (!d) continue
        const days = Math.ceil((new Date(d) - today) / 86400000)
        if (days <= 30) {
          alerts.push({
            emp_id: emp.id, name: emp.name, role: emp.role,
            station_code: emp.station_code,
            type: field, label, date: d, days,
            severity: days < 0 ? 'expired' : days <= 7 ? 'critical' : 'warning'
          })
        }
      }
    }

    alerts.sort((a, b) => a.days - b.days)
    const staff   = alerts.filter(a => a.role !== 'driver')
    const drivers = alerts.filter(a => a.role === 'driver')

    res.json({ alerts, staff, drivers, total: alerts.length })
  } catch(err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// POST /api/notifications/push-critical — push expired-doc alert to all admin subscribers
router.post('/push-critical', auth, async (req, res) => {
  try {
    const { expiredCount, criticalCount } = req.body
    const admins = await query(
      `SELECT id FROM users WHERE role IN ('admin','general_manager') AND status='active'`
    )
    const adminIds = admins.rows.map(r => r.id)
    const body = [
      expiredCount  > 0 ? `${expiredCount} expired`   : '',
      criticalCount > 0 ? `${criticalCount} expiring`  : '',
    ].filter(Boolean).join(', ')
    await sendPushToUsers(adminIds, {
      title: '⚠️ Document Alert',
      body:  `${body} — action required`,
      url:   '/dashboard/hr/employees',
    })
    res.json({ ok: true })
  } catch(err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
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
