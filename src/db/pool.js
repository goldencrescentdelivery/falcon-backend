const { Pool } = require('pg')
require('dotenv').config()

// Supabase requires SSL — always enabled when DATABASE_URL is set
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },   // required for Supabase + Railway
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on('error', (err) => {
  console.error('DB pool error:', err.message)
})

async function query(text, params) {
  const res = await pool.query(text, params)
  return res
}

module.exports = { query, pool }
