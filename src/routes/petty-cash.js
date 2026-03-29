const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

// GET /api/petty-cash/summary — accountant/admin/manager: all users with balances
router.get('/summary', auth, requireRole('admin','accountant','general_manager','manager'), async (req, res) => {
  try {
    const result = await query(`
      SELECT
        u.id, u.name, u.role,
        COALESCE(SUM(CASE WHEN pc.type='allocation' THEN pc.amount ELSE 0 END), 0) AS total_allocated,
        COALESCE(SUM(CASE WHEN pc.type='expense'    THEN pc.amount ELSE 0 END), 0) AS total_spent,
        COALESCE(SUM(CASE WHEN pc.type='expense'    THEN pc.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN pc.type='allocation' THEN pc.amount ELSE 0 END), 0) AS balance,
        COUNT(pc.id) AS transaction_count
      FROM users u
      LEFT JOIN petty_cash pc ON pc.user_id = u.id
      WHERE u.role NOT IN ('driver','admin')
      GROUP BY u.id, u.name, u.role
      ORDER BY u.name
    `)
    res.json({ summary: result.rows })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/petty-cash/my — current user's records + balance
router.get('/my', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT pc.*, cb.name AS created_by_name
      FROM petty_cash pc
      LEFT JOIN users cb ON pc.created_by = cb.id
      WHERE pc.user_id = $1
      ORDER BY pc.date DESC, pc.created_at DESC
    `, [req.user.id])

    const rows = result.rows
    const total_allocated = rows.filter(r => r.type === 'allocation').reduce((s, r) => s + Number(r.amount), 0)
    const total_spent     = rows.filter(r => r.type === 'expense').reduce((s, r) => s + Number(r.amount), 0)
    const balance         = total_spent - total_allocated

    res.json({ records: rows, balance, total_allocated, total_spent })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/petty-cash/user/:userId — detail for a specific user (accountant/admin view)
router.get('/user/:userId', auth, requireRole('admin','accountant','general_manager','manager'), async (req, res) => {
  try {
    const result = await query(`
      SELECT pc.*, u.name AS user_name, u.role AS user_role, cb.name AS created_by_name
      FROM petty_cash pc
      JOIN users u ON pc.user_id = u.id
      LEFT JOIN users cb ON pc.created_by = cb.id
      WHERE pc.user_id = $1
      ORDER BY pc.date DESC, pc.created_at DESC
    `, [req.params.userId])

    const rows = result.rows
    const total_allocated = rows.filter(r => r.type === 'allocation').reduce((s, r) => s + Number(r.amount), 0)
    const total_spent     = rows.filter(r => r.type === 'expense').reduce((s, r) => s + Number(r.amount), 0)
    const balance         = total_spent - total_allocated

    res.json({ records: rows, balance, total_allocated, total_spent })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/petty-cash/allocate — give cash to someone
router.post('/allocate', auth, requireRole('admin','accountant','general_manager','manager'), async (req, res) => {
  try {
    const { user_id, amount, note, date } = req.body
    if (!user_id || !amount) return res.status(400).json({ error: 'user_id and amount required' })
    const amt = parseFloat(amount)
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be positive' })

    const result = await query(`
      INSERT INTO petty_cash (user_id, type, amount, note, created_by, date)
      VALUES ($1, 'allocation', $2, $3, $4, $5) RETURNING *
    `, [user_id, amt, note || null, req.user.id, date || new Date().toISOString().slice(0, 10)])

    req.io?.emit('petty_cash:updated', { user_id })
    res.status(201).json({ record: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/petty-cash/expense — user records an expense
router.post('/expense', auth, async (req, res) => {
  try {
    const { amount, expense_type, note, date } = req.body
    if (!amount || !expense_type) return res.status(400).json({ error: 'amount and expense_type required' })
    const amt = parseFloat(amount)
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be positive' })

    const result = await query(`
      INSERT INTO petty_cash (user_id, type, amount, expense_type, note, created_by, date)
      VALUES ($1, 'expense', $2, $3, $4, $5, $6) RETURNING *
    `, [req.user.id, amt, expense_type, note || null, req.user.id, date || new Date().toISOString().slice(0, 10)])

    req.io?.emit('petty_cash:updated', { user_id: req.user.id })
    res.status(201).json({ record: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// DELETE /api/petty-cash/:id — admin/accountant only
router.delete('/:id', auth, requireRole('admin','accountant'), async (req, res) => {
  try {
    await query('DELETE FROM petty_cash WHERE id=$1', [req.params.id])
    req.io?.emit('petty_cash:updated', {})
    res.json({ message: 'Deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router
