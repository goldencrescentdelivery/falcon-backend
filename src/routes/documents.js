const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const DOC_LABELS = {
  passport:    '🛂 Passport',
  emirates_id: '🪪 Emirates ID',
  visa:        '✈️ Visa Copy',
  license:     '🚗 Driving License',
  iloe:        '📋 ILOE Certificate',
  national_id: '🪪 National ID',
  other:       '📎 Other',
}

// GET /api/documents?emp_id=
router.get('/', auth, async (req, res) => {
  try {
    const { emp_id } = req.query
    let sql = `
      SELECT d.*, e.name AS emp_name, e.avatar AS emp_avatar, u.name AS uploaded_by_name
      FROM employee_documents d
      JOIN employees e ON d.emp_id=e.id
      LEFT JOIN users u ON d.uploaded_by=u.id
      WHERE 1=1
    `
    const vals = []
    if (emp_id) { vals.push(emp_id); sql += ` AND d.emp_id=$${vals.length}` }
    if (req.user.role === 'driver') { vals.push(req.user.emp_id); sql += ` AND d.emp_id=$${vals.length}` }
    sql += ' ORDER BY d.emp_id, d.doc_type, d.created_at DESC'
    const result = await query(sql, vals)
    res.json({ documents: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/documents/expiring?days=60
router.get('/expiring', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 60
    const result = await query(`
      SELECT d.*, e.name AS emp_name, e.avatar AS emp_avatar, e.station_code
      FROM employee_documents d
      JOIN employees e ON d.emp_id=e.id
      WHERE d.expires_at IS NOT NULL
        AND d.expires_at <= NOW() + ($1 || ' days')::INTERVAL
        AND e.status = 'active'
      ORDER BY d.expires_at ASC
    `, [days])
    res.json({ documents: result.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/documents — save document link
router.post('/', auth, requireRole('admin','manager','hr','poc'), async (req, res) => {
  try {
    const { emp_id, doc_type, file_name, drive_file_id, drive_link, notes, expires_at } = req.body
    if (!emp_id || !doc_type || !file_name) return res.status(400).json({ error: 'emp_id, doc_type, file_name required' })
    const result = await query(`
      INSERT INTO employee_documents (emp_id, doc_type, file_name, drive_file_id, drive_link, notes, expires_at, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [emp_id, doc_type, file_name, drive_file_id||null, drive_link||null, notes||null, expires_at||null, req.user.id])
    res.status(201).json({ document: result.rows[0] })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// PUT /api/documents/:id
router.put('/:id', auth, requireRole('admin','manager','hr'), async (req, res) => {
  try {
    const { file_name, drive_file_id, drive_link, notes, expires_at } = req.body
    const result = await query(`
      UPDATE employee_documents SET file_name=$1, drive_file_id=$2, drive_link=$3, notes=$4, expires_at=$5, updated_at=NOW()
      WHERE id=$6 RETURNING *
    `, [file_name, drive_file_id||null, drive_link||null, notes||null, expires_at||null, req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ document: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/documents/:id
router.delete('/:id', auth, requireRole('admin','manager','hr'), async (req, res) => {
  try {
    await query('DELETE FROM employee_documents WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
