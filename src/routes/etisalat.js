const router = require('express').Router()
const { auth } = require('../middleware/auth')

const BASE     = 'https://iotmobility.etisalatdigital.ae'
const APP_KEY  = process.env.ETISALAT_APP_KEY || '8a3745a8-f755-417d-8049-e57d13041789'
const USERNAME = process.env.ETISALAT_USER    || 'GCDS'

async function etFetch(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'appKey':       APP_KEY,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Etisalat API ${res.status}`)
  return res.json()
}

// GET /api/etisalat/live — all vehicles with live status
// Returns rows with: name (plate), id, latitude, longitude, ignitiondin4 (0/1),
//   gpsspeed, speed, address, drivername, lastcommunication, status (0-4),
//   virtualodometer, clientorg, duration, geoname
router.get('/live', auth, async (_req, res) => {
  try {
    const data = await etFetch(
      '/Thingworx/Things/PostgreSQL/Services/GetVehicleByClientNameAndFilter_APIByAppKey',
      { Username: USERNAME, PageNumber: '1', PlateFilter: '' }
    )
    res.json(data)
  } catch (err) {
    console.error('[etisalat] live error:', err.message)
    res.status(502).json({ error: 'Etisalat tracker unavailable' })
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
    res.status(502).json({ error: 'Etisalat tracker unavailable' })
  }
})

module.exports = router
