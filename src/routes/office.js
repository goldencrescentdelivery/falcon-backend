const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const ROLES = ['admin','manager','general_manager','hr','accountant']

/* ══ DOCUMENTS ══════════════════════════════════════════════════ */
router.get('/documents', auth, requireRole(...ROLES), async (req, res) => {
  try {
    const result = await query(`SELECT * FROM office_documents ORDER BY expiry_date ASC NULLS LAST, name ASC`)
    res.json({ documents: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

router.post('/documents', auth, requireRole('admin','general_manager','hr'), async (req, res) => {
  try {
    const { name, document_number, issued_by, issue_date, expiry_date, category, notes } = req.body
    if (!name) return res.status(400).json({ error: 'Document name required' })
    const sd = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null
    const { file_url } = req.body
    const r = await query(
      `INSERT INTO office_documents (name, document_number, issued_by, issue_date, expiry_date, category, notes, file_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, document_number||null, issued_by||null, sd(issue_date), sd(expiry_date), category||'other', notes||null, file_url||null]
    )
    res.status(201).json({ document: r.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

router.put('/documents/:id', auth, requireRole('admin','general_manager','hr'), async (req, res) => {
  try {
    const { name, document_number, issued_by, issue_date, expiry_date, category, notes } = req.body
    const sd = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null
    const r = await query(
      `UPDATE office_documents SET name=$1, document_number=$2, issued_by=$3, issue_date=$4,
       expiry_date=$5, category=$6, notes=$7, file_url=$8, updated_at=NOW() WHERE id=$9 RETURNING *`,
      [name, document_number||null, issued_by||null, sd(issue_date), sd(expiry_date), category||'other', notes||null, req.body.file_url||null, req.params.id]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ document: r.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

router.delete('/documents/:id', auth, requireRole('admin','general_manager','hr'), async (req, res) => {
  try {
    const r = await query(`DELETE FROM office_documents WHERE id=$1 RETURNING id`, [req.params.id])
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ message: 'Deleted' })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

/* ══ EVENTS ═════════════════════════════════════════════════════ */
router.get('/events', auth, requireRole(...ROLES), async (req, res) => {
  try {
    const result = await query(
      `SELECT e.*, u.name AS created_by_name FROM office_events e
       LEFT JOIN users u ON e.created_by = u.id
       ORDER BY e.event_date ASC`
    )
    res.json({ events: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

router.post('/events', auth, requireRole('admin','general_manager','hr','accountant'), async (req, res) => {
  try {
    const { title, description, event_date, event_type } = req.body
    if (!title || !event_date) return res.status(400).json({ error: 'Title and date required' })
    const sd = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null
    const r = await query(
      `INSERT INTO office_events (title, description, event_date, event_type, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [title, description||null, sd(event_date), event_type||'other', req.user.id]
    )
    res.status(201).json({ event: r.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

router.put('/events/:id', auth, requireRole('admin','general_manager','hr','accountant'), async (req, res) => {
  try {
    const { title, description, event_date, event_type } = req.body
    const sd = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null
    const r = await query(
      `UPDATE office_events SET title=$1, description=$2, event_date=$3, event_type=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [title, description||null, sd(event_date), event_type||'other', req.params.id]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ event: r.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

router.delete('/events/:id', auth, requireRole('admin','general_manager','hr','accountant'), async (req, res) => {
  try {
    const r = await query(`DELETE FROM office_events WHERE id=$1 RETURNING id`, [req.params.id])
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ message: 'Deleted' })
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }) }
})

module.exports = router
