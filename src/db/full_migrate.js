/**
 * full_migrate.js — run once to bring Falcon DB fully up to date.
 * Applies every table + column that autoMigrate() in index.js creates.
 * Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.
 *
 *   node src/db/full_migrate.js
 */
require('dotenv').config()
const { query, pool } = require('./pool')

async function run() {
  console.log('Running full migration…\n')
  let ok = 0, skip = 0

  async function q(sql, params) {
    try { await query(sql, params); process.stdout.write('.'); ok++ }
    catch(e) { process.stdout.write('x'); skip++; }
  }

  // ── Fix users role constraint (base migrate.js is too restrictive) ──
  await q(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`)
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'active'`)
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS station_code TEXT`)

  // ── Employee extra columns ──────────────────────────────────────────
  for (const col of [
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
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS project_type            TEXT    DEFAULT 'pulser'`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS per_shipment_rate       NUMERIC DEFAULT 0.5`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS performance_bonus       NUMERIC DEFAULT 0`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS insurance_url           TEXT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS station_code            TEXT DEFAULT 'DDB1'`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS pay_type                TEXT DEFAULT 'monthly'`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_rate             NUMERIC DEFAULT 0`,
  ]) { await q(col) }

  // ── Office documents & events ───────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS office_documents (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    document_number TEXT,
    issued_by       TEXT,
    issue_date      DATE,
    expiry_date     DATE,
    category        TEXT DEFAULT 'other',
    notes           TEXT,
    file_url        TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )`)
  await q(`CREATE TABLE IF NOT EXISTS office_events (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    event_date  DATE NOT NULL,
    event_type  TEXT DEFAULT 'other',
    created_by  UUID,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  )`)

  // ── Vehicle inspections ─────────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS vehicle_inspections (
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
  )`)

  // ── Notifications ───────────────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS notifications (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT,
    type       TEXT DEFAULT 'announcement',
    ref_id     UUID,
    read       BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`)
  await q(`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at DESC)`)

  // ── Settings ────────────────────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`)

  // ── Push subscriptions ──────────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, endpoint)
  )`)
  await q(`CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)`)

  // ── Office letters ──────────────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS office_letters (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref_no           VARCHAR(30) UNIQUE NOT NULL,
    date             DATE NOT NULL DEFAULT CURRENT_DATE,
    to_name          TEXT,
    subject          TEXT,
    greeting         TEXT DEFAULT 'Dear Sir / Madam,',
    body             TEXT NOT NULL,
    created_by       TEXT,
    created_by_name  TEXT,
    signer_name      TEXT,
    signer_title     TEXT,
    signature_data   TEXT,
    show_sign        BOOLEAN DEFAULT TRUE,
    show_stamp       BOOLEAN DEFAULT TRUE,
    show_qr          BOOLEAN DEFAULT TRUE,
    status           TEXT DEFAULT 'approved',
    created_at       TIMESTAMPTZ DEFAULT NOW()
  )`)
  await q(`CREATE INDEX IF NOT EXISTS idx_letters_created ON office_letters(created_at DESC)`)

  // ── Tasks ───────────────────────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS tasks (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title                 TEXT NOT NULL,
    description           TEXT,
    assigned_to           UUID REFERENCES users(id) ON DELETE SET NULL,
    assigned_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    deadline              DATE NOT NULL,
    due_at                TIMESTAMPTZ,
    priority              TEXT DEFAULT 'normal',
    status                TEXT DEFAULT 'pending',
    last_reminder_sent_at TIMESTAMPTZ,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
  )`)
  await q(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)`)
  await q(`CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status)`)

  // ── Customers + invoices + receipts ────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS customers (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL,
    address          TEXT,
    trn_no           TEXT,
    opening_balance  NUMERIC DEFAULT 0,
    customer_type    TEXT DEFAULT 'sale_invoice',
    cost_center      TEXT,
    ncod_rate        NUMERIC, cod_rate NUMERIC, rp_rate NUMERIC,
    pickup_rate      NUMERIC, ncod_inv_rate NUMERIC, cod_inv_rate NUMERIC,
    rp_inv_rate      NUMERIC, pickup_inv_rate NUMERIC,
    notes            TEXT,
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
  )`)
  await q(`CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name)`)
  await q(`CREATE TABLE IF NOT EXISTS customer_invoices (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    invoice_date   DATE NOT NULL,
    invoice_no     TEXT,
    cost_center    TEXT,
    description    TEXT,
    invoice_amount NUMERIC NOT NULL DEFAULT 0,
    vat            NUMERIC NOT NULL DEFAULT 0,
    grand_total    NUMERIC NOT NULL DEFAULT 0,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
  )`)
  await q(`CREATE TABLE IF NOT EXISTS customer_receipts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    receipt_date DATE NOT NULL,
    cost_center  TEXT,
    description  TEXT,
    credit       NUMERIC NOT NULL DEFAULT 0,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  )`)

  // ── Petty cash emp_id ───────────────────────────────────────────────
  await q(`ALTER TABLE petty_cash ADD COLUMN IF NOT EXISTS emp_id TEXT REFERENCES employees(id) ON DELETE SET NULL`)

  // ── Vehicle handovers extra columns ────────────────────────────────
  for (const col of [
    `ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS receiver_emp_id   TEXT REFERENCES employees(id)`,
    `ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS accepted_at        TIMESTAMPTZ`,
    `ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS completed_at       TIMESTAMPTZ`,
    `ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photo_1            TEXT`,
    `ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photo_2            TEXT`,
    `ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photo_3            TEXT`,
    `ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photo_4            TEXT`,
    `ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photos_expire_at   TIMESTAMPTZ`,
    `ALTER TABLE vehicle_handovers ADD COLUMN IF NOT EXISTS photos_cleaned     BOOLEAN DEFAULT FALSE`,
  ]) { await q(col) }

  // ── Workflow tables ─────────────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS workflow_definitions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, steps JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`)
  await q(`CREATE TABLE IF NOT EXISTS workflow_instances (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    definition_id TEXT REFERENCES workflow_definitions(id),
    entity_type   TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    current_step  INT DEFAULT 1,
    status        TEXT DEFAULT 'active',
    history       JSONB DEFAULT '[]',
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(entity_type, entity_id)
  )`)
  await q(`INSERT INTO workflow_definitions (id, name, steps) VALUES ('leave_approval','Leave Approval',$1::jsonb) ON CONFLICT DO NOTHING`,
    [JSON.stringify([
      { step:1, role:'poc',     label:'POC Review'           },
      { step:2, role:'manager', label:'Manager Review'       },
      { step:3, role:'admin',   label:'Admin Final Decision' },
    ])])

  // ── Refresh tokens ──────────────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    family     UUID NOT NULL,
    revoked    BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`)

  // ── RBAC permissions ────────────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY, role TEXT NOT NULL, resource TEXT NOT NULL, action TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(role, resource, action)
  )`)
  const perms = [
    ['admin','payroll','read'],['admin','payroll','mark_paid'],['admin','payroll','add_deduction'],['admin','payroll','add_bonus'],
    ['accountant','payroll','read'],['accountant','payroll','mark_paid'],['accountant','payroll','add_deduction'],['accountant','payroll','add_bonus'],
    ['general_manager','payroll','read'],['general_manager','payroll','add_deduction'],['general_manager','payroll','add_bonus'],
    ['admin','petty_cash','read'],['admin','petty_cash','allocate'],['admin','petty_cash','delete'],
    ['accountant','petty_cash','read'],['accountant','petty_cash','allocate'],['accountant','petty_cash','delete'],
    ['admin','leaves','read'],['admin','leaves','approve'],['admin','leaves','delete'],
    ['general_manager','leaves','read'],['general_manager','leaves','approve'],['general_manager','leaves','delete'],
    ['poc','leaves','read'],['poc','leaves','approve'],['driver','leaves','read'],
    ['admin','employees','read'],['admin','employees','write'],['admin','employees','delete'],
    ['general_manager','employees','read'],['general_manager','employees','write'],
    ['accountant','employees','read'],['poc','employees','read'],
  ]
  for (const [role,resource,action] of perms) {
    await q(`INSERT INTO permissions(role,resource,action) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[role,resource,action])
  }

  // ── Audit logs ──────────────────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID, user_name TEXT, user_role TEXT,
    action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT,
    old_value JSONB, new_value JSONB, ip_address TEXT, user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`)

  // ── Performance indexes ─────────────────────────────────────────────
  for (const idx of [
    `CREATE INDEX IF NOT EXISTS idx_att_emp_date       ON attendance(emp_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_att_date           ON attendance(date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_emp         ON leaves(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_status      ON leaves(status)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_created     ON leaves(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_payroll_emp        ON payroll(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_payroll_period     ON payroll(month)`,
    `CREATE INDEX IF NOT EXISTS idx_payroll_emp_period ON payroll(emp_id, month)`,
    `CREATE INDEX IF NOT EXISTS idx_emp_name           ON employees(name)`,
    `CREATE INDEX IF NOT EXISTS idx_emp_station        ON employees(station_code)`,
    `CREATE INDEX IF NOT EXISTS idx_emp_status         ON employees(status)`,
    `CREATE INDEX IF NOT EXISTS idx_users_role         ON users(role)`,
    `CREATE INDEX IF NOT EXISTS idx_users_station      ON users(station_code)`,
    `CREATE INDEX IF NOT EXISTS idx_vehicles_plate     ON vehicles(plate)`,
    `CREATE INDEX IF NOT EXISTS idx_vehicles_status    ON vehicles(status)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_emp      ON vehicle_handovers(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_submitted ON vehicle_handovers(submitted_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_status   ON vehicle_handovers(status)`,
    `CREATE INDEX IF NOT EXISTS idx_expenses_date      ON expenses(date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sims_emp           ON sim_cards(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_advances_emp       ON salary_advances(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_advances_status    ON salary_advances(status)`,
    `CREATE INDEX IF NOT EXISTS idx_vi_vehicle_id      ON vehicle_inspections(vehicle_id)`,
    `CREATE INDEX IF NOT EXISTS idx_vi_date            ON vehicle_inspections(inspection_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_created      ON audit_logs(created_at DESC)`,
  ]) { await q(idx) }

  console.log(`\n\nDone — ${ok} OK, ${skip} skipped`)
  await pool.end()
}

run().catch(e => { console.error('\nFATAL:', e.message); process.exit(1) })
