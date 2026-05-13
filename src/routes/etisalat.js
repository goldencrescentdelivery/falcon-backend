/**
 * Etisalat SIM Management API proxy
 *
 * - All Etisalat calls are made server-side so the API key is never exposed to the browser.
 * - In-memory cache (10 min TTL) means one outbound call per SIM per 10 minutes regardless
 *   of how many users hit the page simultaneously.
 * - Every error path is swallowed and returns { ok: false } — the fleet/SIM pages still
 *   render instantly from the database; Etisalat enrichment is purely additive.
 *
 * Required env vars (set in Railway):
 *   ETISALAT_API_KEY   — API key issued by Etisalat Business / e& Enterprise portal
 *   ETISALAT_API_BASE  — optional override (default: https://api.etisalat.ae)
 */

const router = require('express').Router()
const { auth, requireRole } = require('../middleware/auth')
const { query }             = require('../db/pool')

// ── In-memory cache ──────────────────────────────────────────────
const CACHE_TTL = 10 * 60 * 1000   // 10 minutes
const CACHE     = new Map()         // msisdn → { v, ts }

function getCached(key) {
  const hit = CACHE.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > CACHE_TTL) { CACHE.delete(key); return null }
  return hit.v
}
function putCache(key, v) { CACHE.set(key, { v, ts: Date.now() }) }

// Auto-evict stale entries every 15 minutes so the Map stays lean
setInterval(() => {
  const now = Date.now()
  for (const [k, e] of CACHE) {
    if (now - e.ts > CACHE_TTL) CACHE.delete(k)
  }
}, 15 * 60 * 1000).unref()   // .unref() so the timer doesn't keep the process alive

// ── Etisalat config (read at call-time so hot-reloads pick up new env) ──
function cfg() {
  return {
    key:  process.env.ETISALAT_API_KEY  || '',
    base: (process.env.ETISALAT_API_BASE || 'https://api.etisalat.ae').replace(/\/$/, ''),
  }
}

// ── Normalise raw Etisalat JSON to our internal shape ────────────
function normalise(raw, msisdn) {
  return {
    msisdn,
    ok:            true,
    sim_status:    raw.status              || raw.simStatus           || 'unknown',
    data_used_mb:  Number(raw.dataUsage?.used    || raw.usedData     || 0),
    data_limit_mb: Number(raw.dataUsage?.limit   || raw.dataLimit    || 0),
    sms_used:      Number(raw.smsUsage?.sent     || raw.smsSent      || 0),
    balance_aed:   Number(raw.balance            || 0).toFixed(2),
    expiry_date:   raw.expiryDate          || raw.subscriptionEndDate || null,
    plan_name:     raw.planName            || raw.productName         || null,
    last_fetched:  new Date().toISOString(),
  }
}

// ── Fetch one SIM with caching — never throws ────────────────────
async function fetchOne(msisdn) {
  const cached = getCached(msisdn)
  if (cached) return cached

  const { key, base } = cfg()
  if (!key) return { msisdn, ok: false, reason: 'not_configured' }

  // Manual timeout so we work on Node 16+ (AbortSignal.timeout needs Node 17.3)
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)

  try {
    const res = await fetch(
      `${base}/business/sim-management/v1/subscribers/${encodeURIComponent(msisdn)}`,
      {
        headers: {
          'x-apikey':     key,
          Authorization: `Bearer ${key}`,
          Accept:        'application/json',
        },
        signal: ctrl.signal,
      }
    )
    clearTimeout(timer)

    if (!res.ok) {
      const out = { msisdn, ok: false, reason: `http_${res.status}` }
      putCache(msisdn, out)   // cache HTTP errors briefly to avoid hammering
      return out
    }

    const raw = await res.json()
    const out = normalise(raw, msisdn)
    putCache(msisdn, out)
    return out

  } catch (err) {
    clearTimeout(timer)
    const reason = err.name === 'AbortError' ? 'timeout' : 'fetch_error'
    const out    = { msisdn, ok: false, reason }
    putCache(msisdn, out)
    return out
  }
}

// ── Routes ────────────────────────────────────────────────────────

// GET /api/etisalat/status — quick health check (no external call)
router.get('/status', auth, (_req, res) => {
  const { key } = cfg()
  res.json({ configured: !!key, cached_entries: CACHE.size })
})

// GET /api/etisalat/sims — bulk enrichment for every Etisalat SIM in the DB
// Called lazily from the SIMs page after the DB list has already rendered.
router.get('/sims', auth, async (_req, res) => {
  const { key } = cfg()
  if (!key) return res.json({ available: false, reason: 'not_configured', sims: {} })

  try {
    // Only pull SIMs whose carrier is Etisalat / e&
    const { rows } = await query(`
      SELECT sim_number, phone_number
      FROM   sim_cards
      WHERE  LOWER(carrier) LIKE '%etisalat%'
          OR LOWER(carrier) = 'e&'
          OR LOWER(carrier) LIKE '%e &%'
      ORDER  BY sim_number
    `)

    if (!rows.length) {
      return res.json({ available: true, sims: {}, count: 0 })
    }

    // Fetch all in parallel — cache absorbs concurrent/repeat calls
    const settled = await Promise.allSettled(
      rows.map(r => fetchOne(r.phone_number || r.sim_number))
    )

    const sims = {}
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value?.msisdn) {
        sims[r.value.msisdn] = r.value
      }
    }

    // Allow browser to cache for 60s so rapid tab-switches don't re-fetch
    res.set('Cache-Control', 'private, max-age=60')
    res.json({ available: true, sims, count: Object.keys(sims).length })

  } catch (err) {
    console.error('[etisalat] /sims error:', err.message)
    res.status(500).json({ available: false, reason: 'server_error', sims: {} })
  }
})

// GET /api/etisalat/sim/:msisdn — on-demand single-SIM refresh
router.get('/sim/:msisdn', auth, async (req, res) => {
  const data = await fetchOne(req.params.msisdn)
  res.json(data)
})

// POST /api/etisalat/cache/clear — admin only, force full refresh
router.post('/cache/clear', auth, requireRole('admin'), (_req, res) => {
  const count = CACHE.size
  CACHE.clear()
  res.json({ cleared: count, message: `Cleared ${count} cached entries` })
})

module.exports = router
