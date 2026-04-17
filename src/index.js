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

app.set('trust proxy', 1)

// ── Socket.io ──────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE'] }
})
require('./socket')(io)

// ── Security & Middleware ──────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}))
app.use(express.json({ limit: '10mb' }))
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))

// Remove fingerprint header
app.disable('x-powered-by')

// ── Rate limiting ──────────────────────────────────────────────
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: JSON.stringify({ error: 'Too many login attempts. Try again in 15 minutes.' }),
  standardHeaders: true,
  legacyHeaders: false,
}))
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}))

app.use((req, _res, next) => { req.io = io; next() })

// ── Routes ─────────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'))
app.use('/api/employees',   require('./routes/employees'))
app.use('/api/attendance',  require('./routes/attendance'))
app.use('/api/payroll',     require('./routes/payroll'))
app.use('/api/leaves',      require('./routes/leaves'))
app.use('/api/compliance',  require('./routes/compliance'))
app.use('/api/expenses',    require('./routes/expenses'))
app.use('/api/poc',         require('./routes/poc'))
app.use('/api/analytics',   require('./routes/analytics'))
app.use('/api/deliveries',  require('./routes/deliveries'))
app.use('/api/backup',      require('./routes/backup'))
app.use('/api/vehicles',    require('./routes/vehicles'))
app.use('/api/documents',   require('./routes/documents'))
app.use('/api/sims',        require('./routes/sims'))
app.use('/api/handovers',   require('./routes/handovers'))
app.use('/api/performance', require('./routes/performance'))
app.use('/api/shifts',      require('./routes/shifts'))
app.use('/api/damage',      require('./routes/damage'))
app.use('/api/advances',    require('./routes/advances'))
app.use('/api/petty-cash',  require('./routes/petty-cash'))

// ── Health check ───────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status:'ok', ts:new Date().toISOString() }))

// ── 404 & error handler ────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error:'Route not found' }))
app.use((err, _req, res, _next) => {
  console.error('Global error:', err.message)
  res.status(500).json({ error: err.message || 'Internal server error' })
})

// ── Auto-migrate on startup ────────────────────────────────────
async function autoMigrate() {
  const { query } = require('./db/pool')
  const cols = [
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS sub_group_name        TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS beneficiary_first_name  TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS beneficiary_middle_name TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS beneficiary_last_name   TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS father_family_name      TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS dob                     DATE`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS gender                  TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS marital_status          TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS uid_number              TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS emirates_issuing_visa   TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS residential_location    TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_location           TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS passport_no             TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS email_id                TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS visa_file_no            TEXT`,
  ]
  for (const sql of cols) {
    try { await query(sql) } catch(e) { console.warn('migrate:', e.message) }
  }
  console.log('Auto-migration complete')
}

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
autoMigrate().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`GCD API running on port ${PORT}`)
  })
}).catch(e => {
  console.error('Migration failed, starting anyway:', e.message)
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`GCD API running on port ${PORT}`)
  })
})

// ── Daily photo cleanup ────────────────────────────────────────
async function runPhotoCleanup() {
  try {
    const { query } = require('./db/pool')
    let createClient
    try { createClient = require('@supabase/supabase-js').createClient } catch(e) { return }
    const expired = await query(`
      SELECT id, photo_1, photo_2, photo_3, photo_4
      FROM vehicle_handovers
      WHERE photos_expire_at < NOW() AND photos_cleaned = false
      AND (photo_1 IS NOT NULL OR photo_2 IS NOT NULL OR photo_3 IS NOT NULL OR photo_4 IS NOT NULL)
    `)
    if (!expired.rows.length) return
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY
    if (!supabaseUrl || !supabaseKey) return
    const supabase = createClient(supabaseUrl, supabaseKey)
    for (const row of expired.rows) {
      const paths = [row.photo_1,row.photo_2,row.photo_3,row.photo_4]
        .filter(Boolean)
        .map(url => { const m=url.match(/vehicle-photos\/(.+)/); return m?m[1]:null })
        .filter(Boolean)
      if (paths.length) await supabase.storage.from('vehicle-photos').remove(paths)
      await query(`UPDATE vehicle_handovers SET photo_1=NULL,photo_2=NULL,photo_3=NULL,photo_4=NULL,photos_cleaned=true,updated_at=NOW() WHERE id=$1`,[row.id])
    }
    console.log(`Cleanup: removed photos from ${expired.rows.length} handovers`)
  } catch(e) { console.error('Cleanup error:', e.message) }
}

runPhotoCleanup()
setInterval(runPhotoCleanup, 24*60*60*1000)