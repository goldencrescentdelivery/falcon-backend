const router = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const { sendPushToUsers } = require('./notifications')

const ALLOWED = requireRole('admin', 'general_manager', 'hr', 'accountant')

async function notifyAdminsLetterPending(letter, submitterName) {
  try {
    const admins = await query(
      `SELECT id FROM users WHERE role = 'admin' AND status = 'active'`
    )
    const adminIds = admins.rows.map(r => r.id)
    if (!adminIds.length) return

    // In-app notifications
    for (const uid of adminIds) {
      await query(
        `INSERT INTO notifications (user_id, title, body, type, ref_id)
         VALUES ($1, $2, $3, 'letter_approval', $4)`,
        [uid,
         '📄 Letter Awaiting Approval',
         `${submitterName} submitted "${letter.ref_no}" for approval.`,
         letter.id]
      )
    }

    // Push notifications
    await sendPushToUsers(adminIds, {
      title: '📄 Letter Awaiting Approval',
      body:  `${submitterName} submitted "${letter.ref_no}" for approval.`,
      url:   '/dashboard/office/letters',
    })
  } catch (e) { console.error('notifyAdmins error:', e.message) }
}

// GET /api/letters/verify/:id
// Public endpoint used by the QR code printed on official letters.
router.get('/verify/:id', async (req, res) => {
  try {
    const result = await query(`
      SELECT id, ref_no, date, to_name, subject, status, created_by_name, created_at
      FROM office_letters
      WHERE id=$1
    `, [req.params.id])

    const letter = result.rows[0]
    if (!letter) {
      return res.status(404).json({
        valid: false,
        status: 'not_found',
        message: 'Document not found',
      })
    }

    const valid = letter.status === 'approved'
    res.json({
      valid,
      status: letter.status,
      message: valid ? 'Document is valid' : 'Document is not approved',
      letter,
    })
  } catch (err) { res.status(500).json({ valid: false, error: err.message }) }
})

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
    const { date, to_name, subject, greeting, body, show_sign = true, show_stamp = true, show_qr = true, signer_name, signer_title, signature_data } = req.body
    if (!body?.trim()) return res.status(400).json({ error: 'body is required' })

    const isAdmin = req.user.role === 'admin'
    const status  = isAdmin ? 'approved' : 'pending'

    const year = new Date().getFullYear()
    const seqRes = await query(
      `SELECT ref_no FROM office_letters WHERE ref_no LIKE $1 ORDER BY ref_no DESC LIMIT 1`,
      [`GCD/LTR/${year}/%`]
    )
    const lastSeq = seqRes.rows[0]
      ? parseInt(seqRes.rows[0].ref_no.split('/').pop()) || 0
      : 0
    const ref_no = `GCD/LTR/${year}/${String(lastSeq + 1).padStart(4, '0')}`

    const result = await query(`
      INSERT INTO office_letters
        (ref_no, date, to_name, subject, greeting, body, created_by, created_by_name, status, show_sign, show_stamp, show_qr, signer_name, signer_title, signature_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
      show_qr,
      signer_name || null,
      signer_title || null,
      signature_data || null,
    ])
    const saved = result.rows[0]
    if (saved.status === 'pending') {
      notifyAdminsLetterPending(saved, req.user.name || req.user.email || 'A team member')
    }
    res.status(201).json({ letter: saved })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/letters/:id
router.put('/:id', auth, ALLOWED, async (req, res) => {
  try {
    const { date, to_name, subject, greeting, body, show_sign = true, show_stamp = true, show_qr = true, signer_name, signer_title, signature_data } = req.body
    if (!body?.trim()) return res.status(400).json({ error: 'body is required' })

    const existing = await query(`SELECT created_by FROM office_letters WHERE id=$1`, [req.params.id])
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' })
    if (req.user.role !== 'admin' && String(existing.rows[0].created_by) !== String(req.user.id))
      return res.status(403).json({ error: 'You can only edit your own letters' })

    const isAdmin  = req.user.role === 'admin'
    const status   = isAdmin ? 'approved' : 'pending'

    const result = await query(`
      UPDATE office_letters
      SET date=$1, to_name=$2, subject=$3, greeting=$4, body=$5, show_sign=$6, show_stamp=$7, show_qr=$8, status=$9,
          signer_name=$10, signer_title=$11, signature_data=$12
      WHERE id=$13 RETURNING *
    `, [
      date || new Date().toISOString().split('T')[0],
      to_name  || null,
      subject  || null,
      greeting || 'Dear Sir / Madam,',
      body.trim(),
      show_sign,
      show_stamp,
      show_qr,
      status,
      signer_name || null,
      signer_title || null,
      signature_data || null,
      req.params.id,
    ])
    const saved = result.rows[0]
    if (saved.status === 'pending') {
      notifyAdminsLetterPending(saved, req.user.name || req.user.email || 'A team member')
    }
    res.json({ letter: saved })
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
