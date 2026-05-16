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

// ── Socket.io ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE'] }
})
require('./socket')(io)

// ── Middleware ─────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors())   // allow ALL origins — simplest possible, no env var needed
app.use(express.json())
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))

// Rate limiting
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many requests' }))
app.use('/api',      rateLimit({ windowMs: 60 * 1000, max: 300 }))

// Attach io to every request
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
app.use('/api/vehicles',             require('./routes/vehicles'))
app.use('/api/vehicle-inspections',  require('./routes/vehicle-inspections'))
app.use('/api/petty-cash',           require('./routes/petty-cash'))
app.use('/api/cartrack',             require('./routes/cartrack'))

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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 GCD API running on port ${PORT}`)
})
