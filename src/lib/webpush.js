const webpush = require('web-push')
const { query } = require('../db/pool')

let _ready = false

async function initVapid() {
  if (_ready) return

  let pub  = process.env.VAPID_PUBLIC_KEY
  let priv = process.env.VAPID_PRIVATE_KEY

  if (!pub || !priv) {
    // Auto-generate and store in DB settings table (persists across restarts)
    const existing = await query(`SELECT key, value FROM settings WHERE key IN ('vapid_public_key','vapid_private_key')`)
    const map = {}
    existing.rows.forEach(r => { map[r.key] = r.value })

    if (map.vapid_public_key && map.vapid_private_key) {
      pub  = map.vapid_public_key
      priv = map.vapid_private_key
    } else {
      const keys = webpush.generateVAPIDKeys()
      pub  = keys.publicKey
      priv = keys.privateKey
      await query(`
        INSERT INTO settings (key, value) VALUES ('vapid_public_key',$1),('vapid_private_key',$2)
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value
      `, [pub, priv])
      console.log('╔══════════════════════════════════════════════════════════╗')
      console.log('║  VAPID keys generated. Add to Railway env vars:          ║')
      console.log(`║  VAPID_PUBLIC_KEY=${pub.slice(0,20)}…  ║`)
      console.log('╚══════════════════════════════════════════════════════════╝')
    }
  }

  webpush.setVapidDetails('mailto:admin@goldencrescent.ae', pub, priv)
  _ready = true
  return pub
}

async function getPublicKey() {
  await initVapid()
  return process.env.VAPID_PUBLIC_KEY ||
    (await query(`SELECT value FROM settings WHERE key='vapid_public_key'`)).rows[0]?.value
}

async function sendPush(subscription, payload) {
  await initVapid()
  return webpush.sendNotification(subscription, JSON.stringify(payload))
}

module.exports = { initVapid, getPublicKey, sendPush }
