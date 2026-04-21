/**
 * Migration 15 — Vehicle Inspections
 *
 * Creates the vehicle_inspections table for storing checklist-based
 * vehicle inspection records (7 sections, Yes/No/NA per item).
 *
 * Run once: node src/db/migrate15.js
 */

require('dotenv').config()
const { query } = require('./pool')

async function migrate() {
  console.log('Running migration 15 — vehicle inspections...')

  await query(`
    CREATE TABLE IF NOT EXISTS vehicle_inspections (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_id       UUID REFERENCES vehicles(id) ON DELETE CASCADE,
      inspection_date  DATE NOT NULL,
      inspector_name   TEXT,
      approved_by_name TEXT,
      approved_by_date DATE,
      sections         JSONB DEFAULT '{}',
      additional_notes TEXT,
      status           TEXT DEFAULT 'completed',
      created_by       UUID REFERENCES users(id),
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  console.log('  ✓ vehicle_inspections table created')

  await query(`CREATE INDEX IF NOT EXISTS idx_vi_vehicle_id ON vehicle_inspections(vehicle_id)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_vi_date      ON vehicle_inspections(inspection_date DESC)`)
  console.log('  ✓ indexes created')

  console.log('\nMigration 15 complete.')
  process.exit(0)
}

migrate().catch(e => { console.error(e); process.exit(1) })
