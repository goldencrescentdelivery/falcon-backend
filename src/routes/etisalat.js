/**
 * Etisalat IoT Mobility — ThingWorx fleet tracking proxy
 *
 * Platform : iotmobility.etisalatdigital.ae  (PTC ThingWorx)
 * Auth     : form-based login → session cookie (re-auths automatically)
 * Caching  : session cached 25 min · fleet data cached 2 min
 *
 * Design principles — MUST NOT affect website load speed:
 *  • This route is completely isolated from all other routes.
 *  • Fleet data is cached server-side for 2 min; concurrent users share
 *    one cache entry, never making duplicate outbound calls.
 *  • Every error path returns gracefully so the fleet page still renders
 *    from the database even when Etisalat is down.
 *  • The frontend calls this route lazily (Phase 3) — only after the main
 *    fleet cards have already rendered from the DB.
 *
 * Env vars (set in Railway — never hard-coded in production):
 *   ETISALAT_TW_USER   (default: GCDS)
 *   ETISALAT_TW_PASS   (default: NIkTtPQWwPLyUZ8Y6)
 *   ETISALAT_TW_BASE   (default: https://iotmobility.etisalatdigital.ae)
 */

const router = require('express').Router()
const { auth } = require('../middleware/auth')

// ── Config ────────────────────────────────────────────────────────
const TW_BASE = () => (process.env.ETISALAT_TW_BASE || 'https://iotmobility.etisalatdigital.ae').replace(/\/$/, '')
const TW_USER = () =>  process.env.ETISALAT_TW_USER || 'GCDS'
const TW_PASS = () =>  process.env.ETISALAT_TW_PASS || 'NIkTtPQWwPLyUZ8Y6'

// ── Session pool ──────────────────────────────────────────────────
// One session shared across all requests; auto-refreshes before expiry.
let _cookie    = null   // "COOKIENAME=value" string
let _cookieExp = 0      // epoch ms

// ── Fleet data cache ─────────────────────────────────────────────
const FLEET_TTL  = 2 * 60 * 1000   // 2 minutes — fresh enough for live tracking
let _cache       = null
let _cacheTs     = 0

// ── Helpers ───────────────────────────────────────────────────────

function timeoutFetch(url, opts, ms = 12000) {
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

// Strip all non-alphanumeric chars for plate matching
function normPlate(s) {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

// ── ThingWorx authentication ──────────────────────────────────────
async function login() {
  const params = new URLSearchParams({
    j_username: TW_USER(),
    j_password: TW_PASS(),
    appKey:     '',
  })

  const res = await timeoutFetch(
    `${TW_BASE()}/Thingworx/FormLogin`,
    {
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:     params.toString(),
      redirect: 'manual',   // grab the Set-Cookie without following the redirect
    },
    15000
  )

  // ThingWorx returns 302 with Set-Cookie on success
  const setCookie = res.headers.get('set-cookie') || ''

  // Try common ThingWorx session cookie names
  const match = setCookie.match(/(TWADMINFORMSSO|JSESSIONIDSSO|JSESSIONID|TW-SESSION)=[^;]+/)
  if (!match) {
    const body = await res.text().catch(() => '')
    throw new Error(`ThingWorx login failed (HTTP ${res.status}): ${body.slice(0, 300)}`)
  }

  _cookie    = match[0]
  _cookieExp = Date.now() + 25 * 60 * 1000   // sessions last ~30 min; refresh at 25
  console.log('[etisalat-tw] session established')
}

async function ensureSession() {
  if (_cookie && Date.now() < _cookieExp) return
  await login()
}

// ThingWorx GET with auto-session-refresh on 401/403
async function twGet(path) {
  await ensureSession()

  const doReq = () => timeoutFetch(
    `${TW_BASE()}${path}`,
    { headers: { Cookie: _cookie, Accept: 'application/json' } },
    10000
  )

  let res = await doReq()
  if (res.status === 401 || res.status === 403) {
    // Session expired mid-request — re-auth and retry once
    _cookie = null; _cookieExp = 0
    await login()
    res = await doReq()
  }
  if (!res.ok) throw new Error(`ThingWorx ${path} → HTTP ${res.status}`)
  return res.json()
}

// ThingWorx POST (for calling Services)
async function twPost(path, body = {}) {
  await ensureSession()

  const doReq = () => timeoutFetch(
    `${TW_BASE()}${path}`,
    {
      method:  'POST',
      headers: { Cookie: _cookie, Accept: 'application/json', 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    },
    10000
  )

  let res = await doReq()
  if (res.status === 401 || res.status === 403) {
    _cookie = null; _cookieExp = 0
    await login()
    res = await doReq()
  }
  if (!res.ok) throw new Error(`ThingWorx POST ${path} → HTTP ${res.status}`)
  return res.json()
}

// ── Normalise a raw ThingWorx row to our vehicle shape ────────────
function normalise(row, nameHint = '') {
  const lat = Number(row.latitude  ?? row.Latitude  ?? row.lat  ?? 0)
  const lng = Number(row.longitude ?? row.Longitude ?? row.lng  ?? row.lon ?? 0)
  const raw_name = row.name ?? row.vehicleName ?? row.vehicleId ?? nameHint ?? ''

  return {
    tw_name:     raw_name,
    plate:       normPlate(row.registrationNumber ?? row.plateNumber ?? row.vehicleReg ?? raw_name),
    lat,
    lng,
    speed:       Number(row.speed      ?? row.Speed      ?? row.currentSpeed ?? 0),
    heading:     Number(row.heading    ?? row.Heading    ?? row.direction     ?? 0),
    ignition:    row.ignition === true || row.ignition === 'true' || row.ignition === 1
                 || String(row.engineStatus ?? '').toLowerCase() === 'on',
    status:      String(row.vehicleStatus ?? row.status ?? row.deviceStatus ?? 'unknown').toLowerCase(),
    odometer:    Number(row.odometer   ?? row.totalDistance  ?? 0),
    last_update: row.timestamp ?? row.gpsTime ?? row.lastGPSUpdate ?? row.lastUpdate ?? null,
    has_gps:     lat !== 0 || lng !== 0,
  }
}

// ── Core fleet fetch — tries multiple ThingWorx patterns ──────────
async function fetchFleetData() {

  // ── Pattern A: well-known fleet-summary service endpoints ────────
  // These return all vehicles in one call — fastest when they exist.
  const servicePaths = [
    '/Thingworx/Things/FleetManager/Services/GetAllVehicleStatus',
    '/Thingworx/Things/FleetManager/Services/GetVehicleList',
    '/Thingworx/Things/GCDS/Services/GetAllVehicles',
    '/Thingworx/Things/GoldenCrescent/Services/GetVehicles',
    '/Thingworx/Things/AmazonThrifty/Services/GetVehicleStatus',
    '/Thingworx/Things/VehicleFleet/Services/GetAllVehicleLocations',
  ]

  for (const path of servicePaths) {
    try {
      const data = await twPost(path)
      const rows = data.rows ?? data.vehicles ?? data.result?.rows ?? data.data ?? []
      if (Array.isArray(rows) && rows.length > 0) {
        console.log(`[etisalat-tw] got ${rows.length} vehicles via ${path}`)
        return rows.map(r => normalise(r)).filter(v => v.has_gps)
      }
    } catch { /* not found — try next */ }
  }

  // ── Pattern B: enumerate Things, batch-fetch properties in parallel ─
  // Falls back to this when no known summary service exists.
  const thingsData = await twGet('/Thingworx/Things?maxItems=500')
  const things     = (thingsData.rows ?? []).filter(t => t.name)

  if (!things.length) return []

  // Fetch each thing's properties in batches of 20 (avoid hammering TW)
  const BATCH   = 20
  const results = []

  for (let i = 0; i < things.length; i += BATCH) {
    const slice   = things.slice(i, i + BATCH)
    const settled = await Promise.allSettled(
      slice.map(t =>
        twGet(`/Thingworx/Things/${encodeURIComponent(t.name)}/Properties/*`)
          .then(d => ({ name: t.name, ...(d.rows?.[0] ?? {}) }))
      )
    )
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value)
    }
  }

  console.log(`[etisalat-tw] got ${results.length} things via property enumeration`)
  return results.map(r => normalise(r, r.name)).filter(v => v.has_gps)
}

// ── Routes ────────────────────────────────────────────────────────

// GET /api/etisalat/fleet
// Returns all tracked vehicles with live GPS, speed and ignition.
// Called lazily from the fleet page (Phase 3) — never blocks the UI.
router.get('/fleet', auth, async (_req, res) => {
  // Serve from in-memory cache if still fresh
  if (_cache && Date.now() - _cacheTs < FLEET_TTL) {
    res.set('Cache-Control', 'private, max-age=60')
    return res.json({ ok: true, vehicles: _cache, count: _cache.length, cached: true })
  }

  try {
    const vehicles = await fetchFleetData()
    _cache   = vehicles
    _cacheTs = Date.now()
    res.set('Cache-Control', 'private, max-age=60')
    res.json({ ok: true, vehicles, count: vehicles.length, cached: false })
  } catch (err) {
    console.error('[etisalat-fleet]', err.message)
    // Serve stale cache over an error — fleet page must still work
    if (_cache) {
      return res.json({ ok: true, vehicles: _cache, count: _cache.length, stale: true })
    }
    // Graceful empty response — fleet page still renders from DB
    res.status(502).json({ ok: false, error: 'Etisalat fleet unavailable', vehicles: [] })
  }
})

// GET /api/etisalat/status — lightweight health-check (no external call)
router.get('/status', auth, (_req, res) => {
  res.json({
    session_active: !!_cookie && Date.now() < _cookieExp,
    cache_age_s:    _cacheTs ? Math.round((Date.now() - _cacheTs) / 1000) : null,
    cached_count:   _cache?.length ?? 0,
  })
})

module.exports = router
