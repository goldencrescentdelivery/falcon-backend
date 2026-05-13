/**
 * fetch-etisalat-fleet.js
 *
 * Run this on any machine that CAN reach iotmobility.etisalatdigital.ae
 * (your office PC, laptop, etc.) — Railway servers cannot reach it directly.
 *
 * Usage:
 *   node scripts/fetch-etisalat-fleet.js
 *
 * What it does:
 *   1. Logs in to ThingWorx with form-based auth
 *   2. Fetches all vehicle GPS positions
 *   3. Saves the result to frontend/public/etisalat-fleet.json
 *
 * After running, commit + push the JSON file:
 *   git add ../frontend/public/etisalat-fleet.json
 *   git commit -m "chore: update Etisalat fleet data"
 *   git push origin main
 *
 * Vercel deploys it as a static file — the fleet page reads it in < 100 ms
 * from the CDN with zero backend roundtrip.
 */

const fs   = require('fs')
const path = require('path')

const TW_BASE = (process.env.ETISALAT_TW_BASE || 'https://iotmobility.etisalatdigital.ae').replace(/\/$/, '')
const TW_USER = process.env.ETISALAT_TW_USER || 'GCDS'
const TW_PASS = process.env.ETISALAT_TW_PASS || 'NIkTtPQWwPLyUZ8Y6'

const OUT = path.resolve(__dirname, '../../frontend/public/etisalat-fleet.json')

function normPlate(s) {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function normalise(row, nameHint = '') {
  const lat     = Number(row.latitude  ?? row.Latitude  ?? row.lat ?? 0)
  const lng     = Number(row.longitude ?? row.Longitude ?? row.lng ?? row.lon ?? 0)
  const rawName = row.name ?? row.vehicleName ?? row.vehicleId ?? nameHint ?? ''
  return {
    tw_name:     rawName,
    plate:       normPlate(row.registrationNumber ?? row.plateNumber ?? row.vehicleReg ?? rawName),
    lat, lng,
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

async function login() {
  const params = new URLSearchParams({ j_username: TW_USER, j_password: TW_PASS, appKey: '' })
  const res = await fetch(`${TW_BASE}/Thingworx/FormLogin`, {
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:     params.toString(),
    redirect: 'manual',
  })
  const setCookie = res.headers.get('set-cookie') || ''
  const match = setCookie.match(/(TWADMINFORMSSO|JSESSIONIDSSO|JSESSIONID|TW-SESSION)=[^;]+/)
  if (!match) {
    const body = await res.text().catch(() => '')
    throw new Error(`Login failed (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }
  return match[0]
}

async function fetchVehicles(cookie) {
  const authHeaders = { Cookie: cookie, Accept: 'application/json' }

  // Strategy A: known fleet-summary services
  const servicePaths = [
    '/Thingworx/Things/FleetManager/Services/GetAllVehicleStatus',
    '/Thingworx/Things/GCDS/Services/GetAllVehicles',
    '/Thingworx/Things/VehicleFleet/Services/GetAllVehicleLocations',
  ]
  for (const p of servicePaths) {
    try {
      const r = await fetch(`${TW_BASE}${p}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (r.ok) {
        const data = await r.json()
        const rows = data.rows ?? data.vehicles ?? data.result?.rows ?? data.data ?? []
        if (Array.isArray(rows) && rows.length > 0) {
          console.log(`  Got ${rows.length} vehicles via ${p}`)
          return rows.map(r => normalise(r)).filter(v => v.has_gps)
        }
      }
    } catch { /* try next */ }
  }

  // Strategy B: enumerate Things + batch-fetch properties
  console.log('  Enumerating Things...')
  const r     = await fetch(`${TW_BASE}/Thingworx/Things?maxItems=500`, { headers: authHeaders })
  const things = (await r.json()).rows ?? []
  if (!things.length) return []

  const results = []
  const BATCH   = 20
  for (let i = 0; i < things.length; i += BATCH) {
    process.stdout.write(`  Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(things.length / BATCH)}…\r`)
    await Promise.allSettled(
      things.slice(i, i + BATCH).map(t =>
        fetch(`${TW_BASE}/Thingworx/Things/${encodeURIComponent(t.name)}/Properties/*`, { headers: authHeaders })
          .then(x => x.json())
          .then(d => results.push({ name: t.name, ...(d.rows?.[0] ?? {}) }))
          .catch(() => {})
      )
    )
  }
  console.log()
  return results.map(r => normalise(r, r.name)).filter(v => v.has_gps)
}

async function main() {
  console.log(`ThingWorx: ${TW_BASE}`)
  console.log(`User     : ${TW_USER}`)
  console.log()

  console.log('1/3  Logging in...')
  const cookie = await login()
  console.log('     Login OK')

  console.log('2/3  Fetching fleet data...')
  const vehicles = await fetchVehicles(cookie)

  const payload = {
    ok:         true,
    vehicles,
    count:      vehicles.length,
    fetched_at: new Date().toISOString(),
  }

  console.log(`3/3  Saving ${vehicles.length} vehicles to:`)
  console.log(`     ${OUT}`)
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2))

  console.log()
  console.log('Done! Next steps:')
  console.log('  cd ../frontend')
  console.log('  git add public/etisalat-fleet.json')
  console.log('  git commit -m "chore: update Etisalat fleet data"')
  console.log('  git push origin main')
  console.log()
  console.log('Vercel will deploy the static file in ~30 seconds.')
  console.log('The fleet page will read it from the CDN in < 100 ms.')
}

main().catch(e => {
  console.error('\nError:', e.message)
  process.exit(1)
})
