const router = require('express').Router()
const { auth } = require('../middleware/auth')

const TT_BASE    = 'https://api.touchtracks.com'
const TT_USER    = process.env.TOUCHTRACKS_USER || 'GoldenCrescent'
const TT_PASS    = process.env.TOUCHTRACKS_PASS || 'GolesBxCX35J'
const COMPANY_ID = 473

// In-memory token cache
let _token  = null
let _expiry = 0

async function getToken() {
  if (_token && Date.now() < _expiry) return _token
  const res = await fetch(`${TT_BASE}/users/v1/users/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username: TT_USER, password: TT_PASS }),
  })
  const json = await res.json()
  if (!json.success || !json.data?.[0]?.token) throw new Error('TouchTracks login failed')
  _token  = json.data[0].token
  _expiry = Date.now() + 6 * 60 * 60 * 1000  // cache 6 hours
  return _token
}

async function ttFetch(path, opts = {}) {
  const doReq = async (tok) => fetch(`${TT_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })

  let res = await doReq(await getToken())
  if (res.status === 401) {
    // Token expired — clear cache and retry once
    _token = null; _expiry = 0
    res = await doReq(await getToken())
  }
  if (!res.ok) throw new Error(`TouchTracks ${res.status}`)
  return res.json()
}

// GET /api/touchtracks/live — live status for all company vehicles
router.get('/live', auth, async (_req, res) => {
  try {
    const data = await ttFetch('/vehicle/v1/tracking/live/company', {
      method: 'POST',
      body:   JSON.stringify({ companyId: COMPANY_ID }),
    })
    res.json(data)
  } catch (err) {
    console.error('[touchtracks] live error:', err.message)
    res.status(502).json({ error: 'TouchTracks unavailable' })
  }
})

// GET /api/touchtracks/vehicles — static vehicle list
router.get('/vehicles', auth, async (_req, res) => {
  try {
    const data = await ttFetch('/vehicle/v1/vehicle/getVehiclesByCompanyId', {
      method: 'POST',
      body:   JSON.stringify({ companyId: COMPANY_ID }),
    })
    res.json(data)
  } catch (err) {
    console.error('[touchtracks] vehicles error:', err.message)
    res.status(502).json({ error: 'TouchTracks unavailable' })
  }
})

// GET /api/touchtracks/history?vehicleId=X&date=YYYY-MM-DD — daily trip history
router.get('/history', auth, async (req, res) => {
  try {
    const { vehicleId, date } = req.query
    if (!vehicleId) return res.status(400).json({ error: 'vehicleId required' })
    const day   = date || new Date().toISOString().slice(0, 10)
    const start = `${day} 00:00:00`
    const end   = `${day} 23:59:59`
    const data  = await ttFetch(
      `/vehicle/v1/tracking/vehicle/history/Tracking?vehicleId=${encodeURIComponent(vehicleId)}&startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`
    )
    res.json(data)
  } catch (err) {
    console.error('[touchtracks] history error:', err.message)
    res.status(502).json({ error: 'TouchTracks unavailable' })
  }
})

module.exports = router
