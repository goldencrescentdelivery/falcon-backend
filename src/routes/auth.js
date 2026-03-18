const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt    = require('jsonwebtoken')
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format' })
    const result = await query('SELECT * FROM users WHERE email=$1', [email.toLowerCase().trim()])
    const user   = result.rows[0]
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })
    // Block inactive users
    if (user.status === 'inactive') return res.status(403).json({ error: 'Account disabled. Contact your administrator.' })
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, emp_id: user.emp_id, station_code: user.station_code },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, emp_id: user.emp_id, station_code: user.station_code } })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const result = await query('SELECT id,email,name,role,emp_id,station_code,status FROM users WHERE id=$1', [req.user.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ user: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/auth/change-password (driver changes own)
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' })
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' })
    const result = await query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const valid  = await bcrypt.compare(currentPassword, result.rows[0].password_hash)
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' })
    const hash = await bcrypt.hash(newPassword, 12)
    await query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.user.id])
    res.json({ message: 'Password updated' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// GET /api/auth/users — admin sees all users
router.get('/users', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const result = await query(`
      SELECT u.id, u.email, u.name, u.role, u.emp_id, u.station_code, u.status, u.created_at,
             e.name AS emp_name, e.station_code AS emp_station
      FROM users u LEFT JOIN employees e ON u.emp_id=e.id
      ORDER BY u.role, u.name
    `)
    res.json({ users: result.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/auth/users — admin creates user with email+password
router.post('/users', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { email, password, name, role, emp_id, station_code } = req.body
    if (!email||!password||!name||!role) return res.status(400).json({ error: 'email, password, name, role required' })
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })
    const VALID_ROLES = ['admin','manager','general_manager','hr','accountant','poc','driver']
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` })
    const hash = await bcrypt.hash(password, 12)
    const result = await query(`
      INSERT INTO users (email, password_hash, name, role, emp_id, station_code)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,email,name,role,emp_id,station_code,status
    `, [email.toLowerCase().trim(), hash, name, role, emp_id||null, station_code||null])
    res.status(201).json({ user: result.rows[0] })
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error: 'Email already exists' })
    res.status(500).json({ error: 'Server error' })
  }
})

// PUT /api/auth/users/:id — admin updates user (password, status, etc)
router.put('/users/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { email, password, name, role, emp_id, station_code, status } = req.body
    let hash = null
    if (password) hash = await bcrypt.hash(password, 12)
    const result = await query(`
      UPDATE users SET
        email        = COALESCE($1, email),
        password_hash= CASE WHEN $2 IS NOT NULL THEN $2 ELSE password_hash END,
        name         = COALESCE($3, name),
        role         = COALESCE($4, role),
        emp_id       = COALESCE($5, emp_id),
        station_code = COALESCE($6, station_code),
        status       = COALESCE($7, status),
        updated_at   = NOW()
      WHERE id=$8 RETURNING id,email,name,role,emp_id,station_code,status
    `, [email||null, hash, name||null, role||null, emp_id||null, station_code||null, status||null, req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ user: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// DELETE /api/auth/users/:id
router.delete('/users/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await query('DELETE FROM users WHERE id=$1', [req.params.id])
    res.json({ message: 'User deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
