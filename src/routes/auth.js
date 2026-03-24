const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

const JWT_SECRET  = process.env.JWT_SECRET || 'fallback-dev-secret-change-in-production'
const VALID_ROLES = ['admin','manager','general_manager','hr','accountant','poc','driver']
const BCRYPT_COST = 12

// In-memory rate limiter: 5 failed attempts -> 15 min lockout
const loginAttempts = new Map()

function getRateLimit(email) {
  const key = email.toLowerCase()
  const rec = loginAttempts.get(key)
  if (!rec) return { blocked: false }
  if (Date.now() < rec.lockedUntil) {
    return { blocked: true, minutesLeft: Math.ceil((rec.lockedUntil - Date.now()) / 60000) }
  }
  if (Date.now() - rec.firstAt > 15 * 60 * 1000) {
    loginAttempts.delete(key)
    return { blocked: false }
  }
  return { blocked: false, count: rec.count }
}

function recordFail(email) {
  const key = email.toLowerCase()
  const now = Date.now()
  const rec = loginAttempts.get(key) || { count: 0, firstAt: now, lockedUntil: 0 }
  if (now - rec.firstAt > 15 * 60 * 1000) { loginAttempts.set(key, { count:1, firstAt:now, lockedUntil:0 }); return }
  rec.count++
  if (rec.count >= 5) rec.lockedUntil = now + 15 * 60 * 1000
  loginAttempts.set(key, rec)
}

function clearFail(email) { loginAttempts.delete(email.toLowerCase()) }

// Only safe fields - never expose password_hash
function safeUser(u) {
  return { id:u.id, email:u.email, name:u.name, role:u.role, emp_id:u.emp_id, station_code:u.station_code, status:u.status }
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const email    = (req.body.email    || '').trim().toLowerCase()
    const password = (req.body.password || '').trim()
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

    const limit = getRateLimit(email)
    if (limit.blocked) return res.status(429).json({ error: `Too many attempts. Try again in ${limit.minutesLeft} minute(s).` })

    const result = await query(
      'SELECT id, email, name, role, emp_id, station_code, status, password_hash FROM users WHERE email = $1',
      [email]
    )
    const user = result.rows[0]

    // Timing-safe: always run bcrypt even if user not found
    const hash = user?.password_hash || '$2a$12$KIXfakeHashToPreventTimingAttack0000000000000'
    const valid = await bcrypt.compare(password, hash)

    if (!user || !valid) {
      recordFail(email)
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    if (user.status === 'inactive')
      return res.status(403).json({ error: 'Account disabled. Contact your administrator.' })

    clearFail(email)

    const token = jwt.sign(
      { id:user.id, email:user.email, name:user.name, role:user.role, emp_id:user.emp_id, station_code:user.station_code },
      JWT_SECRET,
      { expiresIn: '8h' }
    )

    res.json({ token, user: safeUser(user) })
  } catch (err) {
    console.error('Login error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, email, name, role, emp_id, station_code, status FROM users WHERE id = $1',
      [req.user.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ user: safeUser(result.rows[0]) })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/auth/change-password
router.post('/change-password', auth, async (req, res) => {
  try {
    const current = (req.body.currentPassword || '').trim()
    const next    = (req.body.newPassword     || '').trim()
    if (!current || !next) return res.status(400).json({ error: 'Both passwords required' })
    if (next.length < 8)   return res.status(400).json({ error: 'Password must be at least 8 characters' })

    const result = await query('SELECT id, password_hash FROM users WHERE id = $1', [req.user.id])
    const user   = result.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })

    const valid = await bcrypt.compare(current, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' })

    const same = await bcrypt.compare(next, user.password_hash)
    if (same) return res.status(400).json({ error: 'New password must differ from current' })

    const hash = await bcrypt.hash(next, BCRYPT_COST)
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id])
    res.json({ message: 'Password updated successfully' })
  } catch (err) {
    console.error('Change password error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/auth/users
router.get('/users', auth, requireRole('admin','manager','general_manager'), async (req, res) => {
  try {
    const result = await query(`
      SELECT u.id, u.email, u.name, u.role, u.emp_id, u.station_code, u.status, u.created_at,
             e.name AS emp_name, e.station_code AS emp_station
      FROM users u
      LEFT JOIN employees e ON u.emp_id = e.id
      ORDER BY u.role, u.name
    `)
    res.json({ users: result.rows })
  } catch (err) {
    console.error('List users error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/auth/users
router.post('/users', auth, requireRole('admin','manager','general_manager'), async (req, res) => {
  try {
    const email        = (req.body.email || '').trim().toLowerCase()
    const password     = (req.body.password || '').trim()
    const name         = (req.body.name || '').trim()
    const role         = (req.body.role || '').trim()
    const emp_id       = req.body.emp_id       || null
    const station_code = req.body.station_code || null
    const status       = req.body.status       || 'active'

    if (!email || !password || !name || !role)
      return res.status(400).json({ error: 'email, password, name, role required' })

    if (!VALID_ROLES.includes(role))
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` })

    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' })

    const hash = await bcrypt.hash(password, BCRYPT_COST)

    const result = await query(`
      INSERT INTO users (email, password_hash, name, role, emp_id, station_code, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, email, name, role, emp_id, station_code, status
    `, [email, hash, name, role, emp_id, station_code, status])

    res.status(201).json({ user: result.rows[0] })
  } catch (err) {
    console.error('Create user error:', err.message)
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' })
    if (err.code === '23514') return res.status(400).json({ error: 'Invalid role — run database migration first' })
    res.status(500).json({ error: err.message || 'Server error' })
  }
})

// PUT /api/auth/users/:id
router.put('/users/:id', auth, requireRole('admin','manager','general_manager'), async (req, res) => {
  try {
    const { email, password, name, role, emp_id, station_code, status } = req.body

    if (role && !VALID_ROLES.includes(role))
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` })

    let hash = null
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })
      hash = await bcrypt.hash(password.trim(), BCRYPT_COST)
    }

    const result = await query(`
      UPDATE users SET
        email         = COALESCE($1, email),
        password_hash = CASE WHEN $2 IS NOT NULL THEN $2 ELSE password_hash END,
        name          = COALESCE($3, name),
        role          = COALESCE($4, role),
        emp_id        = COALESCE($5, emp_id),
        station_code  = COALESCE($6, station_code),
        status        = COALESCE($7, status),
        updated_at    = NOW()
      WHERE id = $8
      RETURNING id, email, name, role, emp_id, station_code, status
    `, [
      email ? email.toLowerCase().trim() : null,
      hash,
      name         || null,
      role         || null,
      emp_id       || null,
      station_code || null,
      status       || null,
      req.params.id
    ])

    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ user: result.rows[0] })
  } catch (err) {
    console.error('Update user error:', err.message)
    if (err.code === '23514') return res.status(400).json({ error: 'Invalid role — run database migration' })
    res.status(500).json({ error: err.message || 'Server error' })
  }
})

// DELETE /api/auth/users/:id
router.delete('/users/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'Cannot delete your own account' })
    await query('DELETE FROM users WHERE id = $1', [req.params.id])
    res.json({ message: 'User deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router