const router = require('express').Router()
const { auth } = require('../middleware/auth')

const CT_BASE = 'https://fleetapi-me.cartrack.com/rest'
const CT_USER = process.env.CARTRACK_USER || 'FALC00005'
const CT_PASS = process.env.CARTRACK_PASS || '1d57e36d3711fe2ac38c11a996f756c9cfd29c79302d81cbe330df809268f43f'
const CT_AUTH = 'Basic ' + Buffer.from(`${CT_USER}:${CT_PASS}`).toString('base64')

async function ctFetch(path) {
  const res = await fetch(`${CT_BASE}${path}`, {
    headers: { Authorization: CT_AUTH, Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`Cartrack ${res.status}`)
  return res.json()
}

// GET /api/cartrack/status — live status for all vehicles
router.get('/status', auth, async (_req, res) => {
  try {
    const data = await ctFetch('/vehicles/status')
    res.json(data)
  } catch (err) {
    console.error('[cartrack] status error:', err.message)
    res.status(502).json({ error: 'Cartrack unavailable' })
  }
})

// GET /api/cartrack/vehicles — vehicle list (static info)
router.get('/vehicles', auth, async (_req, res) => {
  try {
    const data = await ctFetch('/vehicles')
    res.json(data)
  } catch (err) {
    console.error('[cartrack] vehicles error:', err.message)
    res.status(502).json({ error: 'Cartrack unavailable' })
  }
})

// GET /api/cartrack/events?registration=X&date=YYYY-MM-DD
// Returns today's events for a specific vehicle registration
router.get('/events', auth, async (req, res) => {
  try {
    const { registration, date } = req.query
    if (!registration) return res.status(400).json({ error: 'registration required' })

    const day = date || new Date().toISOString().slice(0, 10)
    const start = `${day} 00:00:00`
    const end   = `${day} 23:59:59`

    const path = `/vehicles/${encodeURIComponent(registration)}/events` +
      `?start_timestamp=${encodeURIComponent(start)}&end_timestamp=${encodeURIComponent(end)}`

    const data = await ctFetch(path)
    res.json(data)
  } catch (err) {
    console.error('[cartrack] events error:', err.message)
    res.status(502).json({ error: 'Cartrack unavailable' })
  }
})

module.exports = router
