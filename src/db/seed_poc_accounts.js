// Run: node src/db/seed_poc_accounts.js
// Creates one POC account per station
const { pool } = require('./pool')
const bcrypt   = require('bcryptjs')
require('dotenv').config()

async function seed() {
  const client = await pool.connect()
  try {
    const hash = pwd => bcrypt.hash(pwd, 12)
    console.log('🌱 Creating POC accounts...')

    const pocs = [
      { email:'poc.ddb7@goldencrescent.ae', name:'POC DDB7', station:'DDB7', pwd:'ddb7poc2024' },
      { email:'poc.ddb6@goldencrescent.ae', name:'POC DDB6', station:'DDB6', pwd:'ddb6poc2024' },
      { email:'poc.dsh6@goldencrescent.ae', name:'POC DSH6', station:'DSH6', pwd:'dsh6poc2024' },
      { email:'poc.dxd3@goldencrescent.ae', name:'POC DXD3', station:'DXD3', pwd:'dxd3poc2024' },
    ]

    for (const poc of pocs) {
      const h = await hash(poc.pwd)
      await client.query(`
        INSERT INTO users (email, password_hash, plain_password, name, role, station_code)
        VALUES ($1,$2,$3,$4,'poc',$5)
        ON CONFLICT (email) DO UPDATE SET
          password_hash=$2, plain_password=$3, name=$4, station_code=$5, status='active'
      `, [poc.email, h, poc.pwd, poc.name, poc.station])
      console.log(`  ✓ ${poc.name} — ${poc.email} / ${poc.pwd}`)
    }

    console.log('\n✅ POC accounts ready. Update passwords via User Accounts page.')
  } catch (err) {
    console.error('❌', err.message)
  } finally {
    client.release()
    await pool.end()
  }
}

seed()
