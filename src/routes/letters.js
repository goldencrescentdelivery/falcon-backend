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
    const { date, to_name, subject, greeting, body, show_sign = true, show_stamp = true } = req.body
    if (!body?.trim()) return res.status(400).json({ error: 'body is required' })

    const isAdmin = req.user.role === 'admin'
    const status  = isAdmin ? 'approved' : 'pending'

    const year = new Date().getFullYear()
    const countRes = await query(
      `SELECT COUNT(*) FROM office_letters WHERE EXTRACT(YEAR FROM created_at) = $1`, [year]
    )
    const seq    = parseInt(countRes.rows[0].count) + 1
    const ref_no = `GCD/LTR/${year}/${String(seq).padStart(4, '0')}`

    const result = await query(`
      INSERT INTO office_letters
        (ref_no, date, to_name, subject, greeting, body, created_by, created_by_name, status, show_sign, show_stamp)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
      status,
      show_sign,
      show_stamp,
    ])
    res.status(201).json({ letter: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/letters/:id
router.put('/:id', auth, ALLOWED, async (req, res) => {
  try {
    const { date, to_name, subject, greeting, body, show_sign = true, show_stamp = true } = req.body
    if (!body?.trim()) return res.status(400).json({ error: 'body is required' })

    const existing = await query(`SELECT created_by FROM office_letters WHERE id=$1`, [req.params.id])
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' })
    if (req.user.role !== 'admin' && String(existing.rows[0].created_by) !== String(req.user.id))
      return res.status(403).json({ error: 'You can only edit your own letters' })

    const isAdmin  = req.user.role === 'admin'
    const status   = isAdmin ? 'approved' : 'pending'

    const result = await query(`
      UPDATE office_letters
      SET date=$1, to_name=$2, subject=$3, greeting=$4, body=$5, show_sign=$6, show_stamp=$7, status=$8
      WHERE id=$9 RETURNING *
    `, [
      date || new Date().toISOString().split('T')[0],
      to_name  || null,
      subject  || null,
      greeting || 'Dear Sir / Madam,',
      body.trim(),
      show_sign,
      show_stamp,
      status,
      req.params.id,
    ])
    res.json({ letter: result.rows[0] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PATCH /api/letters/:id/approve  (admin only)
router.patch('/:id/approve', auth, requireRole('admin'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE office_letters SET status='approved' WHERE id=$1 RETURNING *`,
      [req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ letter: result.rows[0] })
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
