const router = require('express').Router()
const { auth } = require('../middleware/auth')
const { query } = require('../db/pool')

const TT_BASE     = 'https://www.touchtraks.com/app/index.php'
const TT_USER     = process.env.TOUCHTRAKS_USER     || 'falcon_fast'
const TT_PASS     = process.env.TOUCHTRAKS_PASS     || 'falcon@2025'
const TT_COMPANY  = process.env.TOUCHTRAKS_COMPANY  || '7451'

// Plate normalisation helpers
const normPlate  = s => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
const normSuffix = s => normPlate(s).replace(/^(DXB|AUH|AJM|SHJ|RAK|UAQ|FUJ)/, '')

// Strip the fleet code suffix Touchtraks appends: "B 48099 - FD" → "B 48099"
const stripTTSuffix = s => String(s || '').split(/\s*[-–]\s*[A-Z]+\s*$/).shift().trim()

function ttEncode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

async function ttFetch(c, a, payload = {}) {
  const postData = ttEncode({ tokenId: -1, companyId: TT_COMPANY, ...payload })
  const body     = new URLSearchParams({ postData }).toString()
  const res = await fetch(`${TT_BASE}?c=${c}&a=${a}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Touchtraks ${res.status}`)
  const text = await res.text()
  // Response sometimes prefixes SQL warnings before JSON — find the JSON
  const jsonStart = text.indexOf('{')
  if (jsonStart < 0) throw new Error('Touchtraks: no JSON in response')
  return JSON.parse(text.slice(jsonStart))
}

// ── In-memory cache (60 s TTL) ──────────────────────────────────
let _cache   = null
let _cacheTs = 0
const TTL    = 60_000

// GET /api/touchtraks/fleet — live positions matched to DB vehicles, 60 s cached
router.get('/fleet', auth, async (_req, res) => {
  const now = Date.now()
  if (_cache && now - _cacheTs < TTL) {
    res.set('X-Cache', 'HIT')
    return res.json(_cache)
  }
  try {
    const [ttResp, dbRows] = await Promise.all([
      ttFetch('vehicletracking', 'searchvehicle', { start: 0, limit: 500 }),
      query('SELECT id, plate, vin FROM vehicles'),
    ])

    const rawVehicles = ttResp.data?.detailtrack || []

    // Build normalised plate → touchtraks vehicle map
    const byPlate  = {}
    const bySuffix = {}
    for (const veh of rawVehicles) {
      // Strip fleet suffix before normalising
      const cleanPlate = stripTTSuffix(veh.vehicleNo)
      const np = normPlate(cleanPlate)
      const ns = normSuffix(cleanPlate)
      if (np) {
        byPlate[np]  = veh
        if (ns && ns !== np) bySuffix[ns] = veh
      }
    }

    // Match each DB vehicle to a Touchtraks vehicle
    const matched = {}
    for (const row of dbRows.rows) {
      const tt =
        byPlate[normPlate(row.plate)] ||
        bySuffix[normSuffix(row.plate)] ||
        (row.vin ? byPlate[normPlate(row.vin)] : null)

      if (!tt) continue

      const lat = parseFloat(tt.latitude)
      const lng = parseFloat(tt.longitude)
      const spd = parseFloat(tt.speed) || 0
      const ign = String(tt.acc) === '1'

      matched[row.id] = {
        source:           'touchtraks',
        registration:     stripTTSuffix(tt.vehicleNo),
        has_gps:          !!(tt.latitude && tt.longitude),
        ignition:         ign,
        speed:            spd,
        lat:              isNaN(lat) ? null : lat,
        lng:              isNaN(lng) ? null : lng,
        location_address: tt.formatted_address || null,
        last_update:      tt.updatedate || null,
        driver_name:      tt.name       || null,
        driver_phone:     tt.mobileno   || null,
        odometer:         null,
        fuel_pct:         null,
      }
    }

    console.log(`[touchtraks] ${rawVehicles.length} TT vehicles, ${Object.keys(matched).length}/${dbRows.rows.length} DB matched`)

    _cache   = { ok: true, matched, count: rawVehicles.length, fetched_at: new Date().toISOString() }
    _cacheTs = now
    res.set('X-Cache', 'MISS')
    res.json(_cache)
  } catch (err) {
    console.error('[touchtraks] fleet:', err.message)
    if (_cache) return res.json({ ..._cache, stale: true })
    res.status(502).json({ error: 'Touchtraks unavailable' })
  }
})

module.exports = router
