const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const ALLOWED = requireRole('admin', 'general_manager', 'hr', 'accountant')

// GET /api/letters
router.get('/', auth, ALLOWED, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM office_letters ORDER BY created_at DESC`)
    res.json({ letters: result.rows })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/letters/:id
router.get('/:id', auth, ALLOWED, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM office_letters WHERE id=$1`, [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ letter: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/letters
router.post('/', auth, ALLOWED, async (req, res) => {
  try {
    const { date, to_name, subject, greeting, body } = req.body
    if (!body?.trim()) return res.status(400).json({ error: 'body is required' })

    const year = new Date().getFullYear()
    const countRes = await query(
      `SELECT COUNT(*) FROM office_letters WHERE EXTRACT(YEAR FROM created_at) = $1`, [year]
    )
    const seq    = parseInt(countRes.rows[0].count) + 1
    const ref_no = `GCD/LTR/${year}/${String(seq).padStart(4, '0')}`

    const result = await query(`
      INSERT INTO office_letters
        (ref_no, date, to_name, subject, greeting, body, created_by, created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [
      ref_no,
      date || new Date().toISOString().split('T')[0],
      to_name   || null,
      subject   || null,
      greeting  || 'Dear Sir / Madam,',
      body.trim(),
      req.user.id,
      req.user.name || req.user.email || null,
    ])
    res.status(201).json({ letter: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// DELETE /api/letters/:id  (admin only)
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await query(`DELETE FROM office_letters WHERE id=$1`, [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router
