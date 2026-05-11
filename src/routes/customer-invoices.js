const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const ALLOWED = requireRole('admin', 'accountant')

// GET /api/customer-invoices?customer_id=xxx
router.get('/', auth, ALLOWED, async (req, res) => {
  try {
    const { customer_id } = req.query
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' })

    const result = await query(`
      SELECT ci.*, u.name AS created_by_name
      FROM customer_invoices ci
      LEFT JOIN users u ON u.id = ci.created_by
      WHERE ci.customer_id = $1
      ORDER BY ci.invoice_date DESC, ci.created_at DESC
    `, [customer_id])

    const rows = result.rows
    const total_amount = rows.reduce((s, r) => s + Number(r.invoice_amount || 0), 0)
    const total_vat    = rows.reduce((s, r) => s + Number(r.vat           || 0), 0)
    const total_grand  = rows.reduce((s, r) => s + Number(r.grand_total   || 0), 0)

    res.json({ invoices: rows, count: rows.length, total_amount, total_vat, total_grand })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/customer-invoices
router.post('/', auth, ALLOWED, async (req, res) => {
  try {
    const { customer_id, invoice_date, invoice_no, cost_center, description, invoice_amount, vat, grand_total } = req.body
    if (!customer_id || !invoice_date || invoice_amount == null)
      return res.status(400).json({ error: 'customer_id, invoice_date, and invoice_amount are required' })

    const amt   = parseFloat(invoice_amount)
    const custResult = await query('SELECT trn_no FROM customers WHERE id=$1', [customer_id])
    const hasTrn = !!custResult.rows[0]?.trn_no
    const vatAmt = vat != null ? parseFloat(vat) : (hasTrn ? Math.round(amt * 5) / 100 : 0)
    const grand  = grand_total != null ? parseFloat(grand_total) : amt + vatAmt

    const result = await query(`
      INSERT INTO customer_invoices
        (customer_id, invoice_date, invoice_no, cost_center, description, invoice_amount, vat, grand_total, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [customer_id, invoice_date, invoice_no || null, cost_center || null, description || null, amt, vatAmt, grand, req.user.id])

    res.status(201).json({ invoice: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/customer-invoices/:id
router.put('/:id', auth, ALLOWED, async (req, res) => {
  try {
    const { invoice_date, invoice_no, cost_center, description, invoice_amount, vat, grand_total } = req.body
    if (!invoice_date || invoice_amount == null)
      return res.status(400).json({ error: 'invoice_date and invoice_amount are required' })

    const amt    = parseFloat(invoice_amount)
    const custLookup = await query('SELECT c.trn_no FROM customers c JOIN customer_invoices ci ON ci.customer_id=c.id WHERE ci.id=$1', [req.params.id])
    const hasTrn2 = !!custLookup.rows[0]?.trn_no
    const vatAmt = vat != null ? parseFloat(vat) : (hasTrn2 ? Math.round(amt * 5) / 100 : 0)
    const grand  = grand_total != null ? parseFloat(grand_total) : amt + vatAmt

    const result = await query(`
      UPDATE customer_invoices SET
        invoice_date=$1, invoice_no=$2, cost_center=$3, description=$4,
        invoice_amount=$5, vat=$6, grand_total=$7, updated_at=NOW()
      WHERE id=$8
      RETURNING *
    `, [invoice_date, invoice_no || null, cost_center || null, description || null, amt, vatAmt, grand, req.params.id])

    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ invoice: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// DELETE /api/customer-invoices/:id (admin only)
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const result = await query('DELETE FROM customer_invoices WHERE id=$1 RETURNING id', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router
