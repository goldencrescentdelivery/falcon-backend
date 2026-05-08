const router  = require('express').Router()
const https   = require('https')
const { auth } = require('../middleware/auth')

const BASE     = 'https://iotmobility.etisalatdigital.ae'
const ET_USER  = process.env.ETISALAT_USER || 'GCDS'
const ET_PASS  = process.env.ETISALAT_PASS || 'NIkTtPQWwPLyUZ8Y6'
const ORG      = 'Amazon-Thrifty'

// ── Session cache ──────────────────────────────────────────────
let _cookie = null
let _expiry = 0

// Low-level HTTPS request helper
function httpsReq(method, urlStr, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: { ...headers },
      rejectUnauthorized: false,
    }
    if (body) {
      const buf = typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body))
      opts.headers['Content-Length'] = buf.length
      const req = https.request(opts, res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
      })
      req.on('error', reject)
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')) })
      req.write(buf)
      req.end()
    } else {
      const req = https.request(opts, res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
      })
      req.on('error', reject)
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    }
  })
}

// Parse Set-Cookie headers into a cookie string
function parseCookieHeader(setCookieArr = []) {
  return (Array.isArray(setCookieArr) ? setCookieArr : [setCookieArr])
    .map(c => c.split(';')[0].trim())
    .join('; ')
}

// Form-based login → returns session cookie string
async function login() {
  // Step 1: GET login page to get initial JSESSIONID + CSRFID
  const r1 = await httpsReq('GET', `${BASE}/Thingworx/FormLogin/${ORG}`)
  const cookie1 = parseCookieHeader(r1.headers['set-cookie'])
  const csrfMatch = cookie1.match(/CSRFID=([^;,\s]+)/)
  const csrfid = csrfMatch ? csrfMatch[1] : ''

  // Step 2: POST credentials
  const formBody = [
    `thingworx-form-userid=${encodeURIComponent(ET_USER)}`,
    `thingworx-form-password=${encodeURIComponent(ET_PASS)}`,
    `x-csrf-id=${encodeURIComponent(csrfid)}`,
    `x-thingworx-session=true`,
    `OrganizationName=${encodeURIComponent(ORG)}`,
  ].join('&')

  const r2 = await httpsReq('POST', `${BASE}/Thingworx/action-login`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookie1,
    },
    body: formBody,
  })

  const cookie2 = parseCookieHeader(r2.headers['set-cookie'])
  // Combine all cookies; action-login sets a fresh JSESSIONID
  const merged = {}
  for (const part of `${cookie1}; ${cookie2}`.split(';')) {
    const [k, v] = part.trim().split('=')
    if (k && v) merged[k.trim()] = v.trim()
  }
  const combined = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('; ')
  console.log('[etisalat] login status:', r2.status, '| cookie keys:', Object.keys(merged).join(','))
  if (r2.status >= 400) throw new Error(`Login failed HTTP ${r2.status}`)
  return combined
}

async function getSession() {
  if (_cookie && Date.now() < _expiry) return _cookie
  _cookie = await login()
  _expiry = Date.now() + 4 * 60 * 60 * 1000  // 4-hour cache
  return _cookie
}

// POST to a ThingWorx service with session cookie
async function twPost(path, body = {}) {
  const cookie = await getSession()
  const r = await httpsReq('POST', `${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Cookie':       cookie,
    },
    body,
  })
  if (r.status === 401 || r.status === 403) {
    // Session expired — clear and retry once
    _cookie = null; _expiry = 0
    const cookie2 = await getSession()
    const r2 = await httpsReq('POST', `${BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'Cookie':       cookie2,
      },
      body,
    })
    if (r2.status >= 400) throw new Error(`ThingWorx ${r2.status}: ${r2.body.slice(0, 200)}`)
    return JSON.parse(r2.body)
  }
  if (r.status >= 400) throw new Error(`ThingWorx ${r.status}: ${r.body.slice(0, 200)}`)
  return JSON.parse(r.body)
}

// GET /api/etisalat/live
router.get('/live', auth, async (_req, res) => {
  try {
    const data = await twPost(
      '/Thingworx/Things/PostgreSQL/Services/GetVehicleByClientNameAndFilter_APIByAppKey',
      { Username: ET_USER, PageNumber: '1', PlateFilter: '' }
    )
    const rows = data?.rows || []
    console.log('[etisalat] live OK — rows:', rows.length)
    res.json(data)
  } catch (err) {
    console.error('[etisalat] live error:', err.message)
    res.status(502).json({ error: 'Etisalat tracker unavailable', detail: err.message })
  }
})

// GET /api/etisalat/vehicle/:id
router.get('/vehicle/:id', auth, async (req, res) => {
  try {
    const data = await twPost(
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
