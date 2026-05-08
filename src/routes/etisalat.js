const router = require('express').Router()
const { auth } = require('../middleware/auth')
const https = require('https')

const BASE     = 'https://iotmobility.etisalatdigital.ae'
const APP_KEY  = process.env.ETISALAT_APP_KEY || '8a3745a8-f755-417d-8049-e57d13041789'
const USERNAME = process.env.ETISALAT_USER    || 'GCDS'

// Use https.request to support self-signed / enterprise certs and get full error detail
function etFetch(path, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const url = new URL(`${BASE}${path}`)
    const options = {
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        'appKey':         APP_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
      // Allow self-signed / enterprise CA certs
      rejectUnauthorized: false,
    }

    const req = https.request(options, resp => {
      let data = ''
      resp.on('data', chunk => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          return reject(new Error(`Etisalat HTTP ${resp.statusCode}: ${data.slice(0, 300)}`))
        }
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)) }
      })
    })

    req.on('error', err => reject(new Error(`Network error: ${err.message}`)))
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')) })
    req.write(payload)
    req.end()
  })
}

// GET /api/etisalat/live — all vehicles with live status
router.get('/live', auth, async (_req, res) => {
  try {
    const data = await etFetch(
      '/Thingworx/Things/PostgreSQL/Services/GetVehicleByClientNameAndFilter_APIByAppKey',
      { Username: USERNAME, PageNumber: '1', PlateFilter: '' }
    )
    const rows = data?.rows || data?.result?.rows || []
    console.log('[etisalat] live OK — rows:', rows.length, '| keys:', Object.keys(data || {}))
    res.json(data)
  } catch (err) {
    console.error('[etisalat] live error:', err.message)
    res.status(502).json({ error: 'Etisalat tracker unavailable', detail: err.message })
  }
})

// GET /api/etisalat/vehicle/:id — individual vehicle detail
router.get('/vehicle/:id', auth, async (req, res) => {
  try {
    const data = await etFetch(
      '/Thingworx/Things/PostgreSQL/Services/GetFullDetailsOnVehicleNewV2',
      { VehicleId: Number(req.params.id) }
    )
    res.json(data)
  } catch (err) {
    console.error('[etisalat] vehicle error:', err.message)
    res.status(502).json({ error: 'Etisalat tracker unavailable', detail: err.message })
  }
})

module.exports = router
