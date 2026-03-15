const { Pool } = require('pg')
require('dotenv').config()

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  min: 0,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true,
})

pool.on('error', (err) => {
  console.error('DB pool error:', err.message)
})

async function query(text, params) {
  const res = await pool.query(text, params)
  return res
}

module.exports = { query, pool }