/**
 * GCD — Secure Seed (development only)
 * All passwords read from environment variables — never hardcoded.
 * Run: ADMIN_PASSWORD=xxx POC_PASSWORD=xxx node src/db/seed_secure.js
 */
const { pool } = require('./pool')
const bcrypt = require('bcryptjs')
require('dotenv').config()

// ── Passwords MUST come from env — never hardcoded ────────────
const ADMIN_PWD = process.env.SEED_ADMIN_PASSWORD
const POC_PWD   = process.env.SEED_POC_PASSWORD

if (!ADMIN_PWD || !POC_PWD) {
  console.error('\n❌  SEED ABORTED')
  console.error('Set these env vars before running seed:')
  console.error('  SEED_ADMIN_PASSWORD=<strong password>')
  console.error('  SEED_POC_PASSWORD=<strong password>')
  process.exit(1)
}

if (ADMIN_PWD.length < 10 || POC_PWD.length < 10) {
  console.error('❌  Passwords must be at least 10 characters')
  process.exit(1)
}

async function seed() {
  const client = await pool.connect()
  try {
    console.log('🌱 Seeding minimal production data...')
    await client.query('BEGIN')

    const hash = (p) => bcrypt.hash(p, 12)

    // ── Create admin account only ─────────────────────────────
    // Do NOT create default driver/poc accounts in production seed
    const adminHash = await hash(ADMIN_PWD)
    await client.query(`
      INSERT INTO users (email, password_hash, name, role, status)
      VALUES ($1, $2, 'System Admin', 'admin', 'active')
      ON CONFLICT (email) DO UPDATE SET
        password_hash = $2,
        status = 'active',
        updated_at = NOW()
    `, ['admin@falconfastdelivery.com', adminHash])
    console.log('  ✓ Admin account: admin@falconfastdelivery.com')

    // ── Create POC accounts ───────────────────────────────────
    const pocHash = await hash(POC_PWD)
    const pocs = [
      { email:'poc.ddb6@falconfastdelivery.com', name:'POC DDB6', station:'DDB6' },
      { email:'poc.ddb7@falconfastdelivery.com', name:'POC DDB7', station:'DDB7' },
      { email:'poc.dsh6@falconfastdelivery.com', name:'POC DSH6', station:'DSH6' },
      { email:'poc.dxd3@falconfastdelivery.com', name:'POC DXD3', station:'DXD3' },
    ]
    for (const poc of pocs) {
      await client.query(`
        INSERT INTO users (email, password_hash, name, role, station_code, status)
        VALUES ($1, $2, $3, 'poc', $4, 'active')
        ON CONFLICT (email) DO UPDATE SET
          password_hash = $2, name = $3,
          station_code = $4, status = 'active', updated_at = NOW()
      `, [poc.email, pocHash, poc.name, poc.station])
      console.log(`  ✓ ${poc.name}: ${poc.email}`)
    }

    await client.query('COMMIT')
    console.log('\n✅ Seed complete')
    console.log('⚠️  Change all passwords immediately via User Accounts')
    console.log('⚠️  Never run this seed script in CI/CD pipelines')
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ Seed failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

seed()