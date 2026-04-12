/**
 * Migration 13 — Performance indexes
 *
 * Adds indexes on the most frequently queried columns to prevent
 * full-table scans as data grows.
 *
 * Run once: node src/db/migrate13.js
 */

require('dotenv').config()
const { query } = require('./pool')

async function migrate() {
  console.log('Running migration 13 — performance indexes...')

  const indexes = [
    // Attendance — most queried by (emp_id, date) and (date)
    `CREATE INDEX IF NOT EXISTS idx_attendance_emp_date   ON attendance(emp_id, date)`,
    `CREATE INDEX IF NOT EXISTS idx_attendance_date        ON attendance(date)`,
    `CREATE INDEX IF NOT EXISTS idx_attendance_month       ON attendance(TO_CHAR(date,'YYYY-MM'))`,

    // Leaves — frequently filtered by emp_id and status
    `CREATE INDEX IF NOT EXISTS idx_leaves_emp_id          ON leaves(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_status          ON leaves(status)`,
    `CREATE INDEX IF NOT EXISTS idx_leaves_poc_status      ON leaves(poc_status)`,

    // Salary deductions/bonuses — grouped by emp_id + month
    `CREATE INDEX IF NOT EXISTS idx_salary_ded_emp_month   ON salary_deductions(emp_id, month)`,
    `CREATE INDEX IF NOT EXISTS idx_salary_bon_emp_month   ON salary_bonuses(emp_id, month)`,

    // Payroll — grouped by emp_id + month
    `CREATE INDEX IF NOT EXISTS idx_payroll_emp_month      ON payroll(emp_id, month)`,

    // Vehicle assignments — queried by (vehicle_id, date) and (station_code, date)
    `CREATE INDEX IF NOT EXISTS idx_va_vehicle_date        ON vehicle_assignments(vehicle_id, date)`,
    `CREATE INDEX IF NOT EXISTS idx_va_station_date        ON vehicle_assignments(station_code, date)`,

    // Vehicle handovers — queried by emp_id and vehicle_id
    `CREATE INDEX IF NOT EXISTS idx_handovers_emp_id       ON vehicle_handovers(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_vehicle_id   ON vehicle_handovers(vehicle_id)`,
    `CREATE INDEX IF NOT EXISTS idx_handovers_type         ON vehicle_handovers(type)`,

    // Daily deliveries — queried by date and station
    `CREATE INDEX IF NOT EXISTS idx_deliveries_station_date ON daily_deliveries(station_code, date)`,
    `CREATE INDEX IF NOT EXISTS idx_deliveries_date         ON daily_deliveries(date)`,

    // DA performance — queried by emp_id + month
    `CREATE INDEX IF NOT EXISTS idx_da_perf_emp_month      ON da_performance(emp_id, month)`,

    // Employees — searched by name and station_code
    `CREATE INDEX IF NOT EXISTS idx_employees_station      ON employees(station_code)`,
    `CREATE INDEX IF NOT EXISTS idx_employees_status       ON employees(status)`,

    // SIM cards — filtered by station and status
    `CREATE INDEX IF NOT EXISTS idx_sims_station_status    ON sim_cards(station_code, status)`,

    // Salary advances — filtered by emp_id and status
    `CREATE INDEX IF NOT EXISTS idx_advances_emp_status    ON salary_advances(emp_id, status)`,

    // Shifts — queried by station + date range
    `CREATE INDEX IF NOT EXISTS idx_shifts_station_date    ON shifts(station_code, shift_date)`,
    `CREATE INDEX IF NOT EXISTS idx_shifts_emp_date        ON shifts(emp_id, shift_date)`,

    // Damage reports — filtered by status
    `CREATE INDEX IF NOT EXISTS idx_damage_status          ON damage_reports(status)`,
    `CREATE INDEX IF NOT EXISTS idx_damage_vehicle_id      ON damage_reports(vehicle_id)`,

    // Expenses — filtered by status
    `CREATE INDEX IF NOT EXISTS idx_expenses_status        ON expenses(status)`,
    `CREATE INDEX IF NOT EXISTS idx_expenses_emp_id        ON expenses(emp_id)`,

    // Compliance fines
    `CREATE INDEX IF NOT EXISTS idx_fines_status           ON compliance_fines(status)`,
    `CREATE INDEX IF NOT EXISTS idx_fines_emp_id           ON compliance_fines(emp_id)`,

    // Users — looked up by email
    `CREATE INDEX IF NOT EXISTS idx_users_email            ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_emp_id           ON users(emp_id)`,

    // Employee documents — filtered by emp_id and expires_at
    `CREATE INDEX IF NOT EXISTS idx_docs_emp_id            ON employee_documents(emp_id)`,
    `CREATE INDEX IF NOT EXISTS idx_docs_expires_at        ON employee_documents(expires_at)`,

    // Petty cash — filtered by user_id
    `CREATE INDEX IF NOT EXISTS idx_petty_cash_user_id     ON petty_cash(user_id, type)`,
  ]

  let created = 0
  let skipped = 0

  for (const sql of indexes) {
    try {
      await query(sql)
      created++
      console.log('  ✓', sql.match(/idx_\w+/)?.[0])
    } catch(e) {
      // Table may not exist yet on this instance — skip gracefully
      console.warn('  ⚠ Skipped:', sql.match(/idx_\w+/)?.[0], '—', e.message)
      skipped++
    }
  }

  console.log(`\nMigration 13 complete. ${created} indexes created, ${skipped} skipped.`)
  process.exit(0)
}

migrate().catch(e => { console.error(e); process.exit(1) })
