const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const ALLOWED = requireRole('admin', 'accountant')

// GET /api/customer-ledger?customer_id=xxx&year=2026
router.get('/', auth, ALLOWED, async (req, res) => {
  try {
    const { customer_id, year } = req.query
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' })

    const yr    = parseInt(year) || new Date().getFullYear()
    const start = `${yr}-01-01`
    const end   = `${yr}-12-31`

    const custRes = await query('SELECT opening_balance FROM customers WHERE id=$1', [customer_id])
    if (!custRes.rows[0]) return res.status(404).json({ error: 'Customer not found' })
    const openingBalance = Number(custRes.rows[0].opening_balance || 0)

    // B/F: all invoices before this year
    const [bfInvRes, bfRecRes] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(grand_total),0) AS total
         FROM customer_invoices WHERE customer_id=$1 AND invoice_date < $2`,
        [customer_id, start]
      ),
      query(
        `SELECT COALESCE(SUM(credit),0) AS total
         FROM customer_receipts WHERE customer_id=$1 AND receipt_date < $2`,
        [customer_id, start]
      ),
    ])

    const bf_balance = openingBalance + Number(bfInvRes.rows[0].total) - Number(bfRecRes.rows[0].total)

    // Entries for the selected year
    const [invRes, recRes] = await Promise.all([
      query(
        `SELECT id, invoice_date AS date, description,
                COALESCE(invoice_no,'') AS ref,
                COALESCE(cost_center,'') AS cost_center,
                grand_total AS debit, NULL::numeric AS credit,
                'invoice' AS entry_type
         FROM customer_invoices
         WHERE customer_id=$1 AND invoice_date BETWEEN $2 AND $3
         ORDER BY invoice_date ASC, created_at ASC`,
        [customer_id, start, end]
      ),
      query(
        `SELECT id, receipt_date AS date, description,
                ''::text AS ref,
                COALESCE(cost_center,'') AS cost_center,
                NULL::numeric AS debit, credit,
                'receipt' AS entry_type
         FROM customer_receipts
         WHERE customer_id=$1 AND receipt_date BETWEEN $2 AND $3
         ORDER BY receipt_date ASC, created_at ASC`,
        [customer_id, start, end]
      ),
    ])

    // Merge and sort by date then by type (invoices before receipts same day)
    const entries = [...invRes.rows, ...recRes.rows].sort((a, b) => {
      if (a.date < b.date) return -1
      if (a.date > b.date) return 1
      if (a.entry_type === 'invoice' && b.entry_type === 'receipt') return -1
      if (a.entry_type === 'receipt' && b.entry_type === 'invoice') return 1
      return 0
    })

    let running = bf_balance
    const rows = entries.map(e => {
      const debit  = Number(e.debit  || 0)
      const credit = Number(e.credit || 0)
      running = running + debit - credit
      return {
        id:          e.id,
        date:        e.date,
        description: e.description || '',
        ref:         e.ref         || '',
        cost_center: e.cost_center || '',
        entry_type:  e.entry_type,
        debit:       debit  > 0 ? debit  : null,
        credit:      credit > 0 ? credit : null,
        balance:     Math.abs(running),
        balance_sign: running >= 0 ? 'Db' : 'Cr',
      }
    })

    const total_debit  = rows.reduce((s, r) => s + (r.debit  || 0), 0)
    const total_credit = rows.reduce((s, r) => s + (r.credit || 0), 0)
    const closing      = bf_balance + total_debit - total_credit

    res.json({
      year:          yr,
      bf_balance:    Math.abs(bf_balance),
      bf_sign:       bf_balance >= 0 ? 'Db' : 'Cr',
      entries:       rows,
      total_debit,
      total_credit,
      closing_balance: Math.abs(closing),
      closing_sign:  closing >= 0 ? 'Db' : 'Cr',
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router
