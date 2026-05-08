const router = require('express').Router()
const { auth } = require('../middleware/auth')

// In-memory store — the UAE bridge script pushes data here every 60 s
let _liveData  = null
let _pushedAt  = 0
const BRIDGE_KEY = process.env.ETISALAT_BRIDGE_KEY || 'gcd-etisalat-bridge-2026'

// POST /api/etisalat/push — called by the UAE bridge script (not the browser)
router.post('/push', (req, res) => {
  if (req.headers['x-bridge-key'] !== BRIDGE_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  _liveData = req.body
  _pushedAt = Date.now()
  const rows = _liveData?.rows?.length ?? 0
  console.log(`[etisalat] push received — ${rows} vehicles at ${new Date().toISOString()}`)
  res.json({ ok: true, rows })
})

// GET /api/etisalat/live — returns the last pushed data
router.get('/live', auth, (req, res) => {
  if (!_liveData) {
    return res.status(503).json({ error: 'No data yet — bridge not running', rows: [] })
  }
  const ageSeconds = Math.round((Date.now() - _pushedAt) / 1000)
  res.json({ ..._liveData, _pushedAt, _ageSeconds: ageSeconds })
})

// GET /api/etisalat/vehicle/:id — kept for future use
router.get('/vehicle/:id', auth, (req, res) => {
  if (!_liveData?.rows) return res.status(503).json({ error: 'No data yet' })
  const v = _liveData.rows.find(r => String(r.id) === req.params.id)
  if (!v) return res.status(404).json({ error: 'Vehicle not found' })
  res.json({ rows: [v] })
})

module.exports = router
