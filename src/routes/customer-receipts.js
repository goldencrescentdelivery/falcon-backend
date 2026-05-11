const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const ALLOWED = requireRole('admin', 'accountant')

// GET /api/customer-receipts?customer_id=xxx
router.get('/', auth, ALLOWED, async (req, res) => {
  try {
    const { customer_id } = req.query
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' })

    const result = await query(`
      SELECT cr.*, u.name AS created_by_name
      FROM customer_receipts cr
      LEFT JOIN users u ON u.id = cr.created_by
      WHERE cr.customer_id = $1
      ORDER BY cr.receipt_date DESC, cr.created_at DESC
    `, [customer_id])

    const rows = result.rows
    const total_credit = rows.reduce((s, r) => s + Number(r.credit || 0), 0)

    res.json({ receipts: rows, count: rows.length, total_credit })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/customer-receipts
router.post('/', auth, ALLOWED, async (req, res) => {
  try {
    const { customer_id, receipt_date, cost_center, description, credit } = req.body
    if (!customer_id || !receipt_date || credit == null)
      return res.status(400).json({ error: 'customer_id, receipt_date, and credit are required' })

    const amt = parseFloat(credit)
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Credit must be a positive number' })

    const result = await query(`
      INSERT INTO customer_receipts (customer_id, receipt_date, cost_center, description, credit, created_by)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [customer_id, receipt_date, cost_center || null, description || null, amt, req.user.id])

    res.status(201).json({ receipt: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/customer-receipts/:id
router.put('/:id', auth, ALLOWED, async (req, res) => {
  try {
    const { receipt_date, cost_center, description, credit } = req.body
    if (!receipt_date || credit == null)
      return res.status(400).json({ error: 'receipt_date and credit are required' })

    const amt = parseFloat(credit)
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Credit must be a positive number' })

    const result = await query(`
      UPDATE customer_receipts SET
        receipt_date=$1, cost_center=$2, description=$3, credit=$4, updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [receipt_date, cost_center || null, description || null, amt, req.params.id])

    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ receipt: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// DELETE /api/customer-receipts/:id (admin only)
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const result = await query('DELETE FROM customer_receipts WHERE id=$1 RETURNING id', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router
