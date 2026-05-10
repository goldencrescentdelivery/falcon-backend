const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const ALLOWED = requireRole('admin', 'accountant')

// GET /api/customers
router.get('/', auth, ALLOWED, async (req, res) => {
  try {
    const { search, type } = req.query
    const vals = []
    let sql = `SELECT * FROM customers WHERE 1=1`
    if (search) {
      vals.push(`%${search}%`)
      sql += ` AND (name ILIKE $${vals.length} OR trn_no ILIKE $${vals.length} OR cost_center ILIKE $${vals.length} OR address ILIKE $${vals.length})`
    }
    if (type) { vals.push(type); sql += ` AND customer_type = $${vals.length}` }
    sql += ' ORDER BY name ASC'
    const result = await query(sql, vals)
    res.json({ customers: result.rows })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/customers/:id
router.get('/:id', auth, ALLOWED, async (req, res) => {
  try {
    const result = await query('SELECT * FROM customers WHERE id=$1', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ customer: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/customers
router.post('/', auth, ALLOWED, async (req, res) => {
  try {
    const {
      name, address, trn_no, opening_balance, customer_type, cost_center,
      ncod_rate, cod_rate, rp_rate, pickup_rate,
      ncod_inv_rate, cod_inv_rate, rp_inv_rate, pickup_inv_rate, notes,
    } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Customer name is required' })

    const result = await query(`
      INSERT INTO customers
        (name, address, trn_no, opening_balance, customer_type, cost_center,
         ncod_rate, cod_rate, rp_rate, pickup_rate,
         ncod_inv_rate, cod_inv_rate, rp_inv_rate, pickup_inv_rate,
         notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [
      name.trim(),
      address        || null,
      trn_no         || null,
      opening_balance != null ? parseFloat(opening_balance) : 0,
      customer_type  || 'sale_invoice',
      cost_center    || null,
      ncod_rate      != null ? parseFloat(ncod_rate)      : null,
      cod_rate       != null ? parseFloat(cod_rate)       : null,
      rp_rate        != null ? parseFloat(rp_rate)        : null,
      pickup_rate    != null ? parseFloat(pickup_rate)    : null,
      ncod_inv_rate  != null ? parseFloat(ncod_inv_rate)  : null,
      cod_inv_rate   != null ? parseFloat(cod_inv_rate)   : null,
      rp_inv_rate    != null ? parseFloat(rp_inv_rate)    : null,
      pickup_inv_rate!= null ? parseFloat(pickup_inv_rate): null,
      notes          || null,
      req.user.id,
    ])
    res.status(201).json({ customer: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/customers/:id
router.put('/:id', auth, ALLOWED, async (req, res) => {
  try {
    const {
      name, address, trn_no, opening_balance, customer_type, cost_center,
      ncod_rate, cod_rate, rp_rate, pickup_rate,
      ncod_inv_rate, cod_inv_rate, rp_inv_rate, pickup_inv_rate, notes,
    } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Customer name is required' })

    const result = await query(`
      UPDATE customers SET
        name=$1, address=$2, trn_no=$3, opening_balance=$4, customer_type=$5,
        cost_center=$6, ncod_rate=$7, cod_rate=$8, rp_rate=$9, pickup_rate=$10,
        ncod_inv_rate=$11, cod_inv_rate=$12, rp_inv_rate=$13, pickup_inv_rate=$14,
        notes=$15, updated_at=NOW()
      WHERE id=$16 RETURNING *
    `, [
      name.trim(),
      address        || null,
      trn_no         || null,
      opening_balance != null ? parseFloat(opening_balance) : 0,
      customer_type  || 'sale_invoice',
      cost_center    || null,
      ncod_rate      != null ? parseFloat(ncod_rate)      : null,
      cod_rate       != null ? parseFloat(cod_rate)       : null,
      rp_rate        != null ? parseFloat(rp_rate)        : null,
      pickup_rate    != null ? parseFloat(pickup_rate)    : null,
      ncod_inv_rate  != null ? parseFloat(ncod_inv_rate)  : null,
      cod_inv_rate   != null ? parseFloat(cod_inv_rate)   : null,
      rp_inv_rate    != null ? parseFloat(rp_inv_rate)    : null,
      pickup_inv_rate!= null ? parseFloat(pickup_inv_rate): null,
      notes          || null,
      req.params.id,
    ])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ customer: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// DELETE /api/customers/:id  (admin only)
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const result = await query('DELETE FROM customers WHERE id=$1 RETURNING id', [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router
