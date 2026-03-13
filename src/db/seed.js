const { pool } = require('./pool')
const bcrypt = require('bcryptjs')
require('dotenv').config()

async function seed() {
  const client = await pool.connect()
  try {
    console.log('🌱 Seeding database...')
    await client.query('BEGIN')

    // ── Stations ──────────────────────────────────────────────
    await client.query(`
      INSERT INTO stations (name, location) VALUES
        ('Dubai Marina Station', 'Dubai Marina, JBR'),
        ('Deira Station',        'Deira City Centre Area'),
        ('Downtown Station',     'Downtown Dubai, Burj Area'),
        ('Business Bay Station', 'Business Bay, Executive Towers'),
        ('JVC Station',          'Jumeirah Village Circle'),
        ('Sharjah Station',      'Al Nahda, Sharjah')
      ON CONFLICT (name) DO NOTHING
    `)

    // ── Employees ─────────────────────────────────────────────
    await client.query(`
      INSERT INTO employees (id, name, role, dept, status, salary, joined, phone, nationality, zone, visa_expiry, license_expiry, avatar, station) VALUES
        ('E001','Mohammed Al Rashid','Driver','Operations','active',   3800,'2022-03-15','+971501234567','UAE',        'Dubai Marina', '2026-08-20','2025-11-30','👨‍💼','Dubai Marina Station'),
        ('E002','Rahul Sharma',      'Driver','Operations','active',   3200,'2022-07-01','+971502345678','India',      'Deira',        '2025-03-15','2026-03-12','👨‍💼','Deira Station'),
        ('E003','Carlos Mendez',     'Driver','Operations','on_leave', 3200,'2023-01-10','+971503456789','Philippines','JVC',          '2026-02-28','2025-09-05','👨‍💼','JVC Station'),
        ('E004','Ahmed Hassan',      'Driver','Operations','active',   3500,'2021-11-20','+971504567890','Egypt',      'Downtown',     '2025-06-10','2026-01-22','👨‍💼','Downtown Station'),
        ('E005','Priya Nair',        'HR Manager','HR','active',       7200,'2021-05-01','+971505678901','India',       NULL,          '2026-04-30', NULL,       '👩‍💼', NULL),
        ('E006','Omar Khalid',       'Dispatcher','Operations','active',4800,'2022-09-15','+971506789012','Jordan',     NULL,          '2025-10-08', NULL,       '👨‍💼', NULL),
        ('E007','Sarah Johnson',     'Finance Mgr','Finance','active', 8500,'2021-03-01','+971507890123','UK',          NULL,          '2026-01-15', NULL,       '👩‍💼', NULL),
        ('E008','Tariq Mehmood',     'Driver','Operations','inactive', 3200,'2023-04-01','+971508901234','Pakistan',  'Sharjah',      '2025-04-30','2025-07-14','👨‍💼','Sharjah Station'),
        ('E009','Liu Wei',           'Driver','Operations','active',   3200,'2023-06-01','+971509012345','China',     'Business Bay', '2025-12-20','2026-02-08','👨‍💼','Business Bay Station'),
        ('E010','Fatima Al Zahra',   'Admin','Admin','active',         5200,'2022-02-14','+971500123456','UAE',         NULL,          '2026-05-18', NULL,       '👩‍💼', NULL),
        ('E011','James Okafor',      'Driver','Operations','active',   3200,'2024-01-15','+971501112233','Nigeria',   'Deira',        '2026-01-15','2026-06-20','👨‍💼','Deira Station'),
        ('E012','Ana Reyes',         'POC','Operations','active',      4200,'2023-08-01','+971502223344','Philippines','Dubai Marina', '2025-11-01', NULL,       '👩‍💼','Dubai Marina Station')
      ON CONFLICT (id) DO NOTHING
    `)

    // ── Users (auth) ──────────────────────────────────────────
    const hash = async (p) => bcrypt.hash(p, 12)
    await client.query(`
      INSERT INTO users (email, password_hash, name, role, emp_id) VALUES
        ($1,$2,'Sarah Johnson','admin','E007'),
        ($3,$4,'Omar Khalid','manager','E006'),
        ($5,$6,'Sarah Johnson','finance','E007'),
        ($7,$8,'Ana Reyes','poc','E012'),
        ($9,$10,'Mohammed Al Rashid','driver','E001'),
        ($11,$12,'Rahul Sharma','driver','E002'),
        ($13,$14,'Ahmed Hassan','driver','E004'),
        ($15,$16,'Liu Wei','driver','E009')
      ON CONFLICT (email) DO NOTHING
    `, [
      'admin@goldencrescent.ae',   await hash('gcd2024'),
      'manager@goldencrescent.ae', await hash('gcd2024'),
      'finance@goldencrescent.ae', await hash('gcd2024'),
      'poc@goldencrescent.ae',     await hash('gcd2024'),
      'mohammed@goldencrescent.ae',await hash('gcd2024'),
      'rahul@goldencrescent.ae',   await hash('gcd2024'),
      'ahmed@goldencrescent.ae',   await hash('gcd2024'),
      'liu@goldencrescent.ae',     await hash('gcd2024'),
    ])

    // ── Attendance (last 3 days) ───────────────────────────────
    const drivers = ['E001','E002','E003','E004','E008','E009','E011']
    for (const empId of drivers) {
      for (let d = 0; d < 3; d++) {
        const dt = new Date(); dt.setDate(dt.getDate() - d)
        const dateStr = dt.toISOString().slice(0,10)
        const isLeave = empId === 'E003'
        const isInactive = empId === 'E008'
        await client.query(`
          INSERT INTO attendance (emp_id, date, check_in, check_out, status)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (emp_id, date) DO NOTHING
        `, [
          empId, dateStr,
          isLeave||isInactive ? null : `0${7+Math.floor(Math.random()*2)}:${String(Math.floor(Math.random()*60)).padStart(2,'0')}`,
          isLeave||isInactive ? null : d > 0 ? `1${8+Math.floor(Math.random()*2)}:${String(Math.floor(Math.random()*60)).padStart(2,'0')}` : null,
          isLeave ? 'leave' : isInactive ? 'absent' : 'present'
        ])
      }
    }

    // ── Salary Deductions ─────────────────────────────────────
    await client.query(`
      INSERT INTO salary_deductions (emp_id, month, type, amount, description, reference) VALUES
        ('E001','2024-12','traffic_fine',  400, 'RTA speeding fine — Dec 2',        'RTA-2024-88821'),
        ('E001','2024-12','iloe_fine',     200, 'Amazon SLA breach fine',            'AMZ-VL-20241207'),
        ('E002','2024-12','iloe_fee',       50, 'iMile monthly ILOE insurance fee',  'IM-FEE-DEC24'),
        ('E004','2024-12','cash_variance', 150, 'COD variance Dec — unaccounted',    NULL),
        ('E009','2024-12','iloe_fine',    1000, 'Customer complaint penalty',         'AMZ-VL-20241203'),
        ('E009','2024-12','iloe_fee',       50, 'iMile ILOE monthly fee',            'IM-FEE-DEC24'),
        ('E011','2024-12','iloe_fee',       50, 'iMile ILOE monthly fee',            'IM-FEE-DEC24'),
        ('E001','2024-11','traffic_fine',  200, 'RTA fine November',                 'RTA-2024-77710'),
        ('E004','2024-11','iloe_fine',     350, 'Noon damaged parcel',               'NN-VL-20241118')
      ON CONFLICT DO NOTHING
    `)

    // ── Salary Bonuses ────────────────────────────────────────
    await client.query(`
      INSERT INTO salary_bonuses (emp_id, month, type, amount, description) VALUES
        ('E001','2024-12','performance', 500, 'Top performer December'),
        ('E004','2024-12','performance', 300, 'Excellent delivery rate'),
        ('E009','2024-12','performance', 200, 'High volume bonus'),
        ('E001','2024-11','performance', 200, 'November performance bonus'),
        ('E002','2024-11','referral',    300, 'Referral bonus — new hire E011')
      ON CONFLICT DO NOTHING
    `)

    // ── Payroll records ───────────────────────────────────────
    const employees = await client.query('SELECT id, salary FROM employees')
    for (const emp of employees.rows) {
      for (const month of ['2024-11','2024-10']) {
        const bonusRes = await client.query(
          `SELECT COALESCE(SUM(amount),0) as total FROM salary_bonuses WHERE emp_id=$1 AND month=$2`,
          [emp.id, month]
        )
        const deductRes = await client.query(
          `SELECT COALESCE(SUM(amount),0) as total FROM salary_deductions WHERE emp_id=$1 AND month=$2`,
          [emp.id, month]
        )
        const bonus  = parseFloat(bonusRes.rows[0].total)
        const deduct = parseFloat(deductRes.rows[0].total)
        const net    = parseFloat(emp.salary) + bonus - deduct
        await client.query(`
          INSERT INTO payroll (emp_id, month, base_salary, total_bonuses, total_deductions, net_pay, status, paid_on)
          VALUES ($1,$2,$3,$4,$5,$6,'paid',NOW())
          ON CONFLICT (emp_id, month) DO NOTHING
        `, [emp.id, month, emp.salary, bonus, deduct, net])
      }
    }

    // ── Leaves ────────────────────────────────────────────────
    await client.query(`
      INSERT INTO leaves (emp_id, type, from_date, to_date, days, status, reason) VALUES
        ('E003','Annual',   '2024-12-01','2024-12-07',7,'approved','Family visit'),
        ('E002','Sick',     '2024-12-10','2024-12-11',2,'pending', 'Medical appointment'),
        ('E001','Emergency','2024-12-15','2024-12-15',1,'pending', 'Family emergency'),
        ('E009','Annual',   '2024-12-20','2024-12-26',7,'approved','Vacation'),
        ('E004','Sick',     '2024-11-28','2024-11-29',2,'rejected','Not feeling well')
      ON CONFLICT DO NOTHING
    `)

    // ── Compliance Fines ──────────────────────────────────────
    await client.query(`
      INSERT INTO compliance_fines (emp_id, date, violation, amount, status, paid_on, reference, source) VALUES
        ('E001','2024-11-05','Late delivery SLA breach',    500, 'paid',    '2024-11-12','AMZ-VL-20241105','Amazon'),
        ('E004','2024-11-18','Damaged parcel — noon order', 350, 'paid',    '2024-11-25','NN-VL-20241118', 'Noon'),
        ('E002','2024-12-01','Missed delivery window',      250, 'pending', NULL,         'IM-VL-20241201', 'iMile'),
        ('E009','2024-12-03','Customer complaint',         1000, 'pending', NULL,         'AMZ-VL-20241203','Amazon'),
        ('E001','2024-12-07','Unauthorized route deviation',200, 'disputed',NULL,         'AMZ-VL-20241207','Amazon'),
        ('E003','2024-10-22','Late return of vehicle',      300, 'paid',    '2024-10-29','INTL-20241022',  'Internal'),
        ('E004','2024-12-10','Failed to scan 12 parcels',   600, 'pending', NULL,         'NN-VL-20241210', 'Noon'),
        ('E006','2024-12-11','Incorrect manifest',          150, 'pending', NULL,         'IM-VL-20241211', 'iMile')
      ON CONFLICT DO NOTHING
    `)

    // ── Insurance ─────────────────────────────────────────────
    await client.query(`
      INSERT INTO insurance (emp_id, type, provider, policy_no, start_date, expiry, premium, coverage, status) VALUES
        ('E001','Health',  'Daman',    'DM-2024-001','2024-01-01','2025-12-31',2400,'Basic',    'active'),
        ('E002','Health',  'AXA Gulf', 'AX-2024-002','2024-01-01','2025-03-31',2400,'Basic',    'expiring'),
        ('E003','Health',  'Daman',    'DM-2024-003','2024-01-01','2025-12-31',2400,'Basic',    'active'),
        ('E004','Health',  'Daman',    'DM-2024-004','2024-01-01','2025-06-30',2400,'Basic',    'expiring'),
        ('E005','Health',  'Cigna',    'CG-2024-005','2024-01-01','2025-12-31',4800,'Enhanced', 'active'),
        ('E006','Health',  'Daman',    'DM-2024-006','2024-01-01','2025-12-31',2400,'Basic',    'active'),
        ('E007','Health',  'Cigna',    'CG-2024-007','2024-01-01','2025-12-31',4800,'Enhanced', 'active'),
        ('E008','Health',  'Daman',    'DM-2024-008','2024-01-01','2025-04-30',2400,'Basic',    'expiring'),
        ('E009','Health',  'AXA Gulf', 'AX-2024-009','2024-01-01','2025-12-31',2400,'Basic',    'active'),
        ('E010','Health',  'Cigna',    'CG-2024-010','2024-01-01','2025-12-31',3600,'Standard', 'active'),
        (NULL,  'Vehicle', 'RSA',      'RSA-VH-001', '2024-03-01','2025-03-01',12000,'Fleet 8 Vehicles','expiring'),
        (NULL,  'Liability','AIG',     'AIG-LB-001', '2024-01-01','2025-12-31',18000,'Public Liability 5M AED','active')
      ON CONFLICT (policy_no) DO NOTHING
    `)

    // ── Announcements ─────────────────────────────────────────
    await client.query(`
      INSERT INTO announcements (title, body, station) VALUES
        ('Route Update — Dec 15','Amazon routes updated. Check manifest before departure. New drop zones in JBR added.','Dubai Marina Station'),
        ('ILOE Compliance Reminder','Please ensure all parcels are scanned before handoff. Unscanned parcels incur fines.', NULL),
        ('Holiday Schedule','Operations will run at 70% capacity on Dec 25-26. Confirm availability with your POC.',NULL)
      ON CONFLICT DO NOTHING
    `)

    await client.query('COMMIT')
    console.log('✅ Seed complete')
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
