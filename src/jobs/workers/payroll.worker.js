const { Worker } = require('bullmq')
const { bullConnection, isAvailable } = require('../../lib/redis')
const { withTransaction } = require('../../lib/transaction')

function startPayrollWorker(io) {
  if (!isAvailable || !bullConnection) {
    console.log('[payroll-worker] Redis unavailable — worker not started')
    return null
  }

  const worker = new Worker('payroll', async (job) => {
    const { emp_id, month, paid_by } = job.data

    const payrollRecord = await withTransaction(async (client) => {
      const emp = await client.query(
        `SELECT salary FROM employees WHERE id=$1 FOR UPDATE`, [emp_id]
      )
      const bon = await client.query(
        `SELECT COALESCE(SUM(amount),0) t FROM salary_bonuses    WHERE emp_id=$1 AND month=$2`, [emp_id, month]
      )
      const ded = await client.query(
        `SELECT COALESCE(SUM(amount),0) t FROM salary_deductions WHERE emp_id=$1 AND month=$2`, [emp_id, month]
      )

      const base   = parseFloat(emp.rows[0]?.salary || 0)
      const bonus  = parseFloat(bon.rows[0].t)
      const deduct = parseFloat(ded.rows[0].t)
      const net    = base + bonus - deduct

      const result = await client.query(`
        INSERT INTO payroll (emp_id, month, base_salary, total_bonuses, total_deductions, net_pay, status, paid_on, paid_by)
        VALUES ($1,$2,$3,$4,$5,$6,'paid',NOW(),$7)
        ON CONFLICT (emp_id, month) DO UPDATE
          SET status='paid', paid_on=NOW(), net_pay=$6, paid_by=$7,
              total_bonuses=$4, total_deductions=$5
        RETURNING *
      `, [emp_id, month, base, bonus, deduct, net, paid_by])

      return result.rows[0]
    })

    // Broadcast to the /payroll namespace so finance dashboards update live
    io?.of('/payroll').to('payroll:updates').emit('payroll:updated', {
      job_id:   job.id,
      emp_id,
      month,
      net_pay:  payrollRecord.net_pay,
      status:   payrollRecord.status,
      paid_on:  payrollRecord.paid_on,
    })

    return payrollRecord

  }, { connection: bullConnection, concurrency: 3 })

  worker.on('completed', (job) => {
    console.log(`[payroll-worker] job ${job.id} completed — emp:${job.data.emp_id} ${job.data.month}`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[payroll-worker] job ${job?.id} failed:`, err.message)
  })
  worker.on('error', (err) => {
    console.error('[payroll-worker] worker error:', err.message)
  })

  console.log('[payroll-worker] started (concurrency: 3)')
  return worker
}

module.exports = { startPayrollWorker }
