/**
 * Etisalat IoT Mobility — ThingWorx fleet tracking proxy
 *
 * Platform : iotmobility.etisalatdigital.ae  (PTC ThingWorx)
 * Auth     : form-based login → session cookie (re-auths automatically)
 * Caching  : session 25 min · fleet data 2 min · login-failure backoff 3 min
 *
 * Performance contract — MUST NOT affect website load speed:
 *  • Completely isolated route — no other route ever calls this file.
 *  • Fleet data cached server-side for 2 min: N concurrent users = 1 call.
 *  • Login-failure backoff: after one failed login attempt the next 3 min
 *    of /fleet requests return in < 1ms (no outbound call at all).
 *  • Every error path returns gracefully so fleet page renders from DB.
 *  • Frontend calls this lazily (Phase 3) after cards are already visible.
 *
 * Env vars (set in Railway):
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
let _cookie    = null
let _cookieExp = 0

// ── Login-failure backoff ─────────────────────────────────────────
// After one failed login we suppress all retries for 3 minutes.
// This is the critical fix: Pattern A tried 6 service paths, each
// re-attempted the login → 6 × ~12 s = 72-second hang.
// Now: fail once → instant rejection for the next 3 min.
const LOGIN_BACKOFF = 3 * 60 * 1000
let _loginFailedAt  = 0

// ── Fleet data cache ─────────────────────────────────────────────
const FLEET_TTL = 2 * 60 * 1000
let _cache      = null
let _cacheTs    = 0

// ── Timeout fetch — race against a hard timer ─────────────────────
// AbortController alone is not reliable for TCP-level hangs on some
// Node runtimes; Promise.race guarantees the outer promise resolves.
function timeoutFetch(url, opts, ms = 8000) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ])
}

function normPlate(s) {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

// ── ThingWorx login — one attempt, then backoff ───────────────────
async function login() {
  // Fast-reject during backoff window — no outbound call
  if (_loginFailedAt && Date.now() - _loginFailedAt < LOGIN_BACKOFF) {
    throw new Error('Etisalat login in backoff — skipping')
  }

  const params = new URLSearchParams({
    j_username: TW_USER(),
    j_password: TW_PASS(),
    appKey: '',
  })

  let res
  try {
    res = await timeoutFetch(
      `${TW_BASE()}/Thingworx/FormLogin`,
      {
        method:   'POST',
        headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:     params.toString(),
        redirect: 'manual',
      },
      8000   // 8 s — fail fast if unreachable
    )
  } catch (err) {
    _loginFailedAt = Date.now()
    const reason = err.cause?.code || err.message || String(err)
    console.error(`[etisalat-tw] login network error: ${reason}`)
    throw new Error(`ThingWorx unreachable: ${reason}`)
  }

  // ThingWorx sends 302 + Set-Cookie on success
  const setCookie = res.headers.get('set-cookie') || ''
  const match = setCookie.match(/(TWADMINFORMSSO|JSESSIONIDSSO|JSESSIONID|TW-SESSION)=[^;]+/)
  if (!match) {
    _loginFailedAt = Date.now()
    const body = await res.text().catch(() => '')
    throw new Error(`ThingWorx login failed (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }

  // Success — clear backoff, cache session 25 min
  _loginFailedAt = 0
  _cookie    = match[0]
  _cookieExp = Date.now() + 25 * 60 * 1000
  console.log('[etisalat-tw] session established')
}

async function ensureSession() {
  if (_cookie && Date.now() < _cookieExp) return
  await login()   // throws on failure (caller catches)
}

// ── ThingWorx GET / POST with auto-session-refresh ────────────────
async function twGet(path) {
  await ensureSession()
  const doReq = () => timeoutFetch(`${TW_BASE()}${path}`, {
    headers: { Cookie: _cookie, Accept: 'application/json' },
  }, 6000)

  let res = await doReq()
  if (res.status === 401 || res.status === 403) {
    _cookie = null; _cookieExp = 0
    await login()
    res = await doReq()
  }
  if (!res.ok) throw new Error(`ThingWorx GET ${path} → HTTP ${res.status}`)
  return res.json()
}

async function twPost(path, body = {}) {
  await ensureSession()
  const doReq = () => timeoutFetch(`${TW_BASE()}${path}`, {
    method:  'POST',
    headers: { Cookie: _cookie, Accept: 'application/json', 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }, 6000)

  let res = await doReq()
  if (res.status === 401 || res.status === 403) {
    _cookie = null; _cookieExp = 0
    await login()
    res = await doReq()
  }
  if (!res.ok) throw new Error(`ThingWorx POST ${path} → HTTP ${res.status}`)
  return res.json()
}

// ── Normalise ThingWorx row → our vehicle shape ───────────────────
function normalise(row, nameHint = '') {
  const lat     = Number(row.latitude  ?? row.Latitude  ?? row.lat ?? 0)
  const lng     = Number(row.longitude ?? row.Longitude ?? row.lng ?? row.lon ?? 0)
  const rawName = row.name ?? row.vehicleName ?? row.vehicleId ?? nameHint ?? ''
  return {
    tw_name:     rawName,
    plate:       normPlate(row.registrationNumber ?? row.plateNumber ?? row.vehicleReg ?? rawName),
    lat,
    lng,
    speed:       Number(row.speed    ?? row.Speed    ?? row.currentSpeed ?? 0),
    heading:     Number(row.heading  ?? row.Heading  ?? row.direction    ?? 0),
    ignition:    row.ignition === true || row.ignition === 'true' || row.ignition === 1
                 || String(row.engineStatus ?? '').toLowerCase() === 'on',
    status:      String(row.vehicleStatus ?? row.status ?? row.deviceStatus ?? 'unknown').toLowerCase(),
    odometer:    Number(row.odometer ?? row.totalDistance ?? 0),
    last_update: row.timestamp ?? row.gpsTime ?? row.lastGPSUpdate ?? row.lastUpdate ?? null,
    has_gps:     lat !== 0 || lng !== 0,
  }
}

// ── Fleet fetch — login once, then try discovery strategies ───────
async function fetchFleetData() {
  // Ensure we can log in BEFORE trying any service paths.
  // If this throws (network unreachable / backoff), we bail immediately —
  // no inner loop retries that would pile up timeout latency.
  await ensureSession()

  // ── Strategy A: known fleet-summary service endpoints ────────────
  // Each is one POST that returns all vehicles in a single call.
  const servicePaths = [
    '/Thingworx/Things/FleetManager/Services/GetAllVehicleStatus',
    '/Thingworx/Things/GCDS/Services/GetAllVehicles',
    '/Thingworx/Things/VehicleFleet/Services/GetAllVehicleLocations',
  ]

  for (const path of servicePaths) {
    try {
      const data = await twPost(path)
      const rows = data.rows ?? data.vehicles ?? data.result?.rows ?? data.data ?? []
      if (Array.isArray(rows) && rows.length > 0) {
        console.log(`[etisalat-tw] ${rows.length} vehicles via ${path}`)
        return rows.map(r => normalise(r)).filter(v => v.has_gps)
      }
    } catch { /* try next strategy */ }
  }

  // ── Strategy B: enumerate Things, batch-fetch properties ─────────
  const thingsData = await twGet('/Thingworx/Things?maxItems=500')
  const things     = (thingsData.rows ?? []).filter(t => t.name)
  if (!things.length) return []

  const BATCH   = 20
  const results = []
  for (let i = 0; i < things.length; i += BATCH) {
    const settled = await Promise.allSettled(
      things.slice(i, i + BATCH).map(t =>
        twGet(`/Thingworx/Things/${encodeURIComponent(t.name)}/Properties/*`)
          .then(d => ({ name: t.name, ...(d.rows?.[0] ?? {}) }))
      )
    )
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value)
    }
  }

  console.log(`[etisalat-tw] ${results.length} vehicles via property enumeration`)
  return results.map(r => normalise(r, r.name)).filter(v => v.has_gps)
}

// ── Routes ────────────────────────────────────────────────────────

// GET /api/etisalat/fleet
router.get('/fleet', auth, async (_req, res) => {
  // Serve from cache if still fresh (< 2 min old)
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
    // Stale cache is better than an error
    if (_cache) {
      return res.json({ ok: true, vehicles: _cache, count: _cache.length, stale: true })
    }
    // Graceful empty — fleet page still renders from DB
    res.status(502).json({ ok: false, error: err.message, vehicles: [] })
  }
})

// GET /api/etisalat/status — lightweight health check (no outbound call)
router.get('/status', auth, (_req, res) => {
  const inBackoff = _loginFailedAt > 0 && Date.now() - _loginFailedAt < LOGIN_BACKOFF
  res.json({
    session_active:   !!_cookie && Date.now() < _cookieExp,
    login_backoff:    inBackoff,
    backoff_remaining_s: inBackoff ? Math.round((LOGIN_BACKOFF - (Date.now() - _loginFailedAt)) / 1000) : 0,
    cache_age_s:      _cacheTs ? Math.round((Date.now() - _cacheTs) / 1000) : null,
    cached_count:     _cache?.length ?? 0,
  })
})

// GET /api/etisalat/ping — one-shot connectivity probe (clears backoff, makes real request)
// Useful for diagnosing Railway → ThingWorx network reachability
router.get('/ping', auth, async (_req, res) => {
  const start = Date.now()
  // Clear backoff so this is always a live attempt
  _loginFailedAt = 0
  try {
    const r = await timeoutFetch(`${TW_BASE()}/Thingworx/FormLogin`, { method: 'HEAD' }, 5000)
    res.json({
      reachable: true,
      http_status: r.status,
      ms: Date.now() - start,
      base: TW_BASE(),
    })
  } catch (err) {
    res.json({
      reachable: false,
      error:     err.message,
      code:      err.cause?.code || null,
      ms:        Date.now() - start,
      base:      TW_BASE(),
    })
  }
})

module.exports = router
