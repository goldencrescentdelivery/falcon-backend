const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt    = require('jsonwebtoken')
const { query } = require('../db/pool')
<<<<<<< HEAD
const { auth, requireRole } = require('../middleware/auth')
=======
const { auth }  = require('../middleware/auth')
>>>>>>> 990c42be8e5ed8214b91d3de93e4df84c6ab273b

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
<<<<<<< HEAD
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
=======

    const result = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()])
    const user   = result.rows[0]
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, emp_id: user.emp_id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, emp_id: user.emp_id }
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
>>>>>>> 990c42be8e5ed8214b91d3de93e4df84c6ab273b
})

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
<<<<<<< HEAD
    const result = await query('SELECT id,email,name,role,emp_id,station_code,status FROM users WHERE id=$1', [req.user.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ user: result.rows[0] })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/auth/change-password (driver changes own)
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    const result = await query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const valid  = await bcrypt.compare(currentPassword, result.rows[0].password_hash)
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' })
    const hash = await bcrypt.hash(newPassword, 12)
    await query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.user.id])
    res.json({ message: 'Password updated' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// GET /api/auth/users — admin sees all users with plain passwords
router.get('/users', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const result = await query(`
      SELECT u.id, u.email, u.name, u.role, u.emp_id, u.station_code, u.status, u.plain_password, u.created_at,
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
    const hash = await bcrypt.hash(password, 12)
    const result = await query(`
      INSERT INTO users (email, password_hash, plain_password, name, role, emp_id, station_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,email,name,role,emp_id,station_code,status
    `, [email.toLowerCase().trim(), hash, password, name, role, emp_id||null, station_code||null])
    res.status(201).json({ user: result.rows[0] })
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error: 'Email already exists' })
=======
    const result = await query('SELECT id,email,name,role,emp_id FROM users WHERE id=$1', [req.user.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ user: result.rows[0] })
  } catch (err) {
>>>>>>> 990c42be8e5ed8214b91d3de93e4df84c6ab273b
    res.status(500).json({ error: 'Server error' })
  }
})

<<<<<<< HEAD
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
        plain_password = CASE WHEN $3 IS NOT NULL THEN $3 ELSE plain_password END,
        name         = COALESCE($4, name),
        role         = COALESCE($5, role),
        emp_id       = COALESCE($6, emp_id),
        station_code = COALESCE($7, station_code),
        status       = COALESCE($8, status),
        updated_at   = NOW()
      WHERE id=$9 RETURNING id,email,name,role,emp_id,station_code,status,plain_password
    `, [email||null, hash, password||null, name||null, role||null, emp_id||null, station_code||null, status||null, req.params.id])
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
=======
// POST /api/auth/change-password
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    const result = await query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const user   = result.rows[0]
    const valid  = await bcrypt.compare(currentPassword, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' })
    const hash = await bcrypt.hash(newPassword, 12)
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id])
    res.json({ message: 'Password updated' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
>>>>>>> 990c42be8e5ed8214b91d3de93e4df84c6ab273b
})

module.exports = router
