const { Pool } = require('pg')
require('dotenv').config()

// Parse DATABASE_URL manually to handle special characters in password
function createPool() {
  const dbUrl = process.env.DATABASE_URL

  if (!dbUrl) {
    console.error('❌ DATABASE_URL not set')
    process.exit(1)
  }

  // If separate vars are provided, use them directly
  if (process.env.DB_HOST) {
    return new Pool({
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT || '6543'),
      database: process.env.DB_NAME || 'postgres',
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl:      { rejectUnauthorized: false },
      max:      10,
      min:      2,
      idleTimeoutMillis:     10000,
      connectionTimeoutMillis: 15000,
    })
  }

  // Use connection string — encode any unencoded @ in password
  // Format: postgresql://user:password@host:port/db
  // Find the last @ which is the host separator
  const withoutProto = dbUrl.replace(/^postgresql:\/\//, '')
  const lastAt       = withoutProto.lastIndexOf('@')
  const userPass     = withoutProto.substring(0, lastAt)
  const hostPart     = withoutProto.substring(lastAt + 1)
  const colonIdx     = userPass.indexOf(':')
  const user         = userPass.substring(0, colonIdx)
  const password     = userPass.substring(colonIdx + 1)  // raw password, no encoding needed
  const [hostPort, dbName] = hostPart.split('/')
  const [host, port] = hostPort.split(':')

  console.log(`🔗 Connecting to ${host}:${port}/${dbName} as ${user}`)

  return new Pool({
    host,
    port:     parseInt(port || '6543'),
    database: dbName || 'postgres',
    user,
    password,  // passed as-is, no URL encoding issues
    ssl:       { rejectUnauthorized: false },
    max:       10,
    min:       0,
    idleTimeoutMillis:     10000,
    connectionTimeoutMillis: 15000,
  })
}

const pool = createPool()

pool.on('error', (err) => {
  console.error('DB pool error:', err.message)
})

// Test connection on startup
pool.query('SELECT 1').then(() => {
  console.log('✅ Database connected')
}).catch(err => {
  console.error('❌ Database connection failed:', err.message)
})

async function query(text, params) {
  const res = await pool.query(text, params)
  return res
}

module.exports = { query, pool }