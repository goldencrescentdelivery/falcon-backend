const router = require('express').Router()
const { auth } = require('../middleware/auth')

// In-memory store — the UAE bridge script pushes data here every 60 s
let _liveData  = null
let _pushedAt  = 0
const BRIDGE_KEY = process.env.ETISALAT_BRIDGE_KEY || 'gcd-etisalat-bridge-2026'

// Fields the frontend actually uses — everything else is discarded on push
const KEEP = ['name','status','gpsspeed','speed','virtualodometer','address','drivername','lastcommunication','duration']

// POST /api/etisalat/push — called by the UAE bridge script (not the browser)
router.post('/push', (req, res) => {
  if (req.headers['x-bridge-key'] !== BRIDGE_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const raw  = req.body
  const rows = (raw?.rows || raw?.result?.rows || []).map(v => {
    const slim = {}
    for (const k of KEEP) if (v[k] !== undefined) slim[k] = v[k]
    return slim
  })
  _liveData = { rows }
  _pushedAt = Date.now()
  console.log(`[etisalat] push received — ${rows.length} vehicles at ${new Date().toISOString()}`)
  res.json({ ok: true, rows: rows.length })
})

// GET /api/etisalat/live — returns the last pushed data
router.get('/live', auth, (req, res) => {
  if (!_liveData) {
    return res.status(503).json({ error: 'No data yet — bridge not running', rows: [] })
  }
  const ageSeconds = Math.round((Date.now() - _pushedAt) / 1000)
  res.set('Cache-Control', 'private, max-age=55')
  res.json({ rows: _liveData.rows, _pushedAt, _ageSeconds: ageSeconds })
})

// GET /api/etisalat/vehicle/:id — kept for future use
router.get('/vehicle/:id', auth, (req, res) => {
  if (!_liveData?.rows) return res.status(503).json({ error: 'No data yet' })
  const v = _liveData.rows.find(r => String(r.id) === req.params.id)
  if (!v) return res.status(404).json({ error: 'Vehicle not found' })
  res.json({ rows: [v] })
})

module.exports = router
