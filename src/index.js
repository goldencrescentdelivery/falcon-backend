require('dotenv').config()
const express    = require('express')
const http       = require('http')
const { Server } = require('socket.io')
const cors       = require('cors')
const helmet     = require('helmet')
const morgan     = require('morgan')
const rateLimit  = require('express-rate-limit')

const app    = express()
const server = http.createServer(app)

// Allow multiple origins — handles both Vercel preview URLs and custom domain
const ALLOWED_ORIGINS = [
  'https://app.goldencrescent.ae',
  'https://goldencrescent.ae',
  process.env.FRONTEND_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
].filter(Boolean)

function corsOrigin(origin, callback) {
  // Allow requests with no origin (mobile apps, curl, Postman)
  if (!origin) return callback(null, true)
  // Allow any vercel.app preview URL for this project
  if (origin.includes('vercel.app') || origin.includes('goldencrescent.ae')) {
    return callback(null, true)
  }
  if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
  // In development allow localhost
  if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) {
    return callback(null, true)
  }
  return callback(new Error('Not allowed by CORS'))
}

// ── Socket.io ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET','POST','PUT','PATCH','DELETE'], credentials: true }
})
require('./socket')(io)

// ── Middleware ─────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({ origin: corsOrigin, credentials: true }))
app.use(express.json())
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))

// Rate limiting
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many requests' }))
app.use('/api',      rateLimit({ windowMs: 60 * 1000, max: 300 }))

// Attach io to every request so routes can emit events
app.use((req, _res, next) => { req.io = io; next() })

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'))
app.use('/api/employees',  require('./routes/employees'))
app.use('/api/attendance', require('./routes/attendance'))
app.use('/api/payroll',    require('./routes/payroll'))
app.use('/api/leaves',     require('./routes/leaves'))
app.use('/api/compliance', require('./routes/compliance'))
app.use('/api/expenses',   require('./routes/expenses'))
app.use('/api/poc',        require('./routes/poc'))
app.use('/api/analytics',  require('./routes/analytics'))
app.use('/api/deliveries', require('./routes/deliveries'))
app.use('/api/backup',     require('./routes/backup'))
app.use('/api/vehicles',   require('./routes/vehicles'))

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }))

// 404
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }))

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: err.message || 'Internal server error' })
})

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000
server.listen(PORT, () => {
  console.log(`🚀 GCD API running on port ${PORT}`)
  console.log(`🔗 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`)
})