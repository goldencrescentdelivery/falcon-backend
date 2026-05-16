const router = require('express').Router()
const { auth } = require('../middleware/auth')

const CT_BASE = 'https://fleetapi-me.cartrack.com/rest'
const CT_USER = process.env.CARTRACK_USER || 'FALC00005'
const CT_PASS = process.env.CARTRACK_PASS || '1d57e36d3711fe2ac38c11a996f756c9cfd29c79302d81cbe330df809268f43f'
const CT_AUTH = 'Basic ' + Buffer.from(`${CT_USER}:${CT_PASS}`).toString('base64')

async function ctFetch(path) {
  const res = await fetch(`${CT_BASE}${path}`, {
    headers: { Authorization: CT_AUTH, Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`Cartrack ${res.status}`)
  return res.json()
}

// ── In-memory cache (shared across all requests, 60 s TTL) ──────
let _fleetCache = null
let _fleetCacheTs = 0
const FLEET_TTL = 60_000

// GET /api/cartrack/fleet — merged vehicle list + live status, 60 s cached
router.get('/fleet', auth, async (_req, res) => {
  const now = Date.now()
  if (_fleetCache && now - _fleetCacheTs < FLEET_TTL) {
    res.set('X-Cache', 'HIT')
    return res.json(_fleetCache)
  }
  try {
    const [vehs, status] = await Promise.all([
      ctFetch('/vehicles'),
      ctFetch('/vehicles/status'),
    ])

    const sm = {}
    for (const s of (status.data || [])) sm[s.vehicle_id] = s

    const vehicles = (vehs.data || []).map(v => {
      const s   = sm[v.vehicle_id] || {}
      const loc = s.location || {}
      const fuel = s.fuel || {}
      return {
        vehicle_id:       v.vehicle_id,
        registration:     v.registration,
        name:             v.vehicle_name,
        manufacturer:     v.manufacturer,
        model:            v.model,
        model_year:       v.model_year,
        colour:           v.colour,
        chassis:          v.chassis_number,
        in_maintenance:   !!(v.is_under_maintenance || v.terminal_in_repair),
        // Live telemetry
        has_gps:          !!s.event_ts,
        last_update:      s.event_ts    || null,
        ignition:         s.ignition    ?? null,
        idling:           s.idling      ?? null,
        speed:            s.speed       ?? 0,
        bearing:          s.bearing     ?? 0,
        odometer:         s.odometer    ? Math.round(s.odometer / 1000) : null,
        fuel_pct:         fuel.precentage_left ?? null,
        fuel_level:       fuel.level    ?? null,
        // Location
        lat:              loc.latitude  ?? null,
        lng:              loc.longitude ?? null,
        location_address: loc.position_description || null,
        location_updated: loc.updated  || null,
        // Cartrack assigned driver
        driver_name:  s.driver ? [s.driver.first_name, s.driver.last_name].filter(Boolean).join(' ') : null,
        driver_phone: s.driver?.phone_number || null,
      }
    })

    _fleetCache  = { ok: true, vehicles, count: vehicles.length, fetched_at: new Date().toISOString() }
    _fleetCacheTs = now
    res.set('X-Cache', 'MISS')
    res.json(_fleetCache)
  } catch (err) {
    console.error('[cartrack] fleet:', err.message)
    if (_fleetCache) return res.json({ ..._fleetCache, stale: true })
    res.status(502).json({ error: 'Cartrack unavailable' })
  }
})

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
