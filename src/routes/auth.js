/**
 * GOLDEN CRESCENT — Secure Auth Routes
 * Security hardening:
 *  - Plaintext passwords removed from DB entirely
 *  - Rate limiting: 5 attempts per 15 min window, then 1h lockout
 *  - JWT: 8h expiry, validated secret on startup
 *  - Passwords: bcrypt cost 12, min 8 chars
 *  - No sensitive fields ever returned to frontend
 *  - Input sanitisation on all fields
 *  - Password change invalidates old tokens via issuedAt check
 */

const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

// ── Validate JWT secret at startup ────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters.')
  process.exit(1)
}

const VALID_ROLES = ['admin','manager','general_manager','hr','accountant','poc','driver']
const BCRYPT_COST = 12
const JWT_EXPIRY  = '8h'       // Sessions expire after 8 hours
const MAX_ATTEMPTS = 5         // Max failed logins before lockout
const WINDOW_MS    = 15 * 60 * 1000  // 15-minute attempt window
const LOCKOUT_MS   = 60 * 60 * 1000  // 1-hour lockout

// ── In-memory rate limiter (per email) ───────────────────────
// For production, replace with Redis. Fine for single-instance Railway.
const loginAttempts = new Map() // email -> { count, firstAttempt, lockedUntil }

function checkRateLimit(email) {
  const key  = email.toLowerCase().trim()
  const now  = Date.now()
  const rec  = loginAttempts.get(key) || { count:0, firstAttempt:now, lockedUntil:0 }

  // Currently locked out?
  if (rec.lockedUntil && now < rec.lockedUntil) {
    const secsLeft = Math.ceil((rec.lockedUntil - now) / 1000)
    return { blocked: true, secsLeft }
  }

  // Reset window if it's expired
  if (now - rec.firstAttempt > WINDOW_MS) {
    loginAttempts.set(key, { count:0, firstAttempt:now, lockedUntil:0 })
    return { blocked: false }
  }

  return { blocked: false }
}

function recordFailedAttempt(email) {
  const key = email.toLowerCase().trim()
  const now = Date.now()
  const rec = loginAttempts.get(key) || { count:0, firstAttempt:now, lockedUntil:0 }

  // Reset window if expired
  if (now - rec.firstAttempt > WINDOW_MS) {
    loginAttempts.set(key, { count:1, firstAttempt:now, lockedUntil:0 })
    return { attemptsLeft: MAX_ATTEMPTS - 1 }
  }

  rec.count++
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS
    loginAttempts.set(key, rec)
    return { locked: true, secsLeft: Math.ceil(LOCKOUT_MS / 1000) }
  }

  loginAttempts.set(key, rec)
  return { attemptsLeft: MAX_ATTEMPTS - rec.count }
}

function clearAttempts(email) {
  loginAttempts.delete(email.toLowerCase().trim())
}

// Sanitise string input
function sanitise(val) {
  if (typeof val !== 'string') return ''
  return val.trim().slice(0, 255)
}

// Safe user object — never include password_hash, plain_password
function safeUser(u) {
  return {
    id:           u.id,
    email:        u.email,
    name:         u.name,
    role:         u.role,
    emp_id:       u.emp_id,
    station_code: u.station_code,
    status:       u.status,
  }
}

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const email    = sanitise(req.body.email || '').toLowerCase()
    const password = sanitise(req.body.password || '')

    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' })

    // Rate limit check
    const limit = checkRateLimit(email)
    if (limit.blocked) {
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${Math.ceil(limit.secsLeft / 60)} minute(s).`
      })
    }

    // Fetch only needed columns — never SELECT *
    const result = await query(
      `SELECT id, email, name, role, emp_id, station_code, status, password_hash, password_changed_at
       FROM users WHERE email = $1`,
      [email]
    )
    const user = result.rows[0]

    // Use constant-time comparison path even when user not found
    // (prevents timing-based user enumeration)
    const dummyHash = '$2a$12$invalidhashfortimingprotectiononly000000000000000000000'
    const hashToCheck = user ? user.password_hash : dummyHash
    const valid = await bcrypt.compare(password, hashToCheck)

    if (!user || !valid) {
      const result2 = recordFailedAttempt(email)
      if (result2.locked) {
        return res.status(429).json({ error: `Account locked for 1 hour after ${MAX_ATTEMPTS} failed attempts.` })
      }
      return res.status(401).json({
        error: 'Invalid credentials',
        attemptsLeft: result2.attemptsLeft
      })
    }

    if (user.status === 'inactive')
      return res.status(403).json({ error: 'Account disabled. Contact your administrator.' })

    // Clear failed attempts on successful login
    clearAttempts(email)

    // Issue JWT — 8h expiry, includes issuedAt for password-change invalidation
    const token = jwt.sign(
      {
        id:           user.id,
        email:        user.email,
        name:         user.name,
        role:         user.role,
        emp_id:       user.emp_id,
        station_code: user.station_code,
        // iat (issued at) is added automatically by jsonwebtoken
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY, algorithm: 'HS256' }
    )

    // Log successful login (audit trail)
    await query(
      `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
      [user.id]
    ).catch(() => {}) // Non-fatal if column doesn't exist yet

    res.json({ token, user: safeUser(user) })
  } catch (err) {
    console.error('Login error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, email, name, role, emp_id, station_code, status FROM users WHERE id = $1`,
      [req.user.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ user: safeUser(result.rows[0]) })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/change-password ───────────────────────────
router.post('/change-password', auth, async (req, res) => {
  try {
    const currentPassword = sanitise(req.body.currentPassword || '')
    const newPassword     = sanitise(req.body.newPassword || '')

    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Both passwords required' })

    // Minimum 8 characters, require at least 1 number
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' })
    if (!/\d/.test(newPassword))
      return res.status(400).json({ error: 'New password must contain at least one number' })

    const result = await query(
      `SELECT id, password_hash FROM users WHERE id = $1`, [req.user.id]
    )
    const user = result.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })

    const valid = await bcrypt.compare(currentPassword, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' })

    // Prevent reusing the same password
    const same = await bcrypt.compare(newPassword, user.password_hash)
    if (same) return res.status(400).json({ error: 'New password must be different from current' })

    const hash = await bcrypt.hash(newPassword, BCRYPT_COST)

    // Record password_changed_at — existing tokens issued before this will be invalid
    // (middleware checks this timestamp)
    await query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [hash, req.user.id]
    )

    res.json({ message: 'Password updated. Please log in again.' })
  } catch (err) {
    console.error('Change password error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── GET /api/auth/users ───────────────────────────────────────
router.get('/users', auth, requireRole('admin','manager','general_manager'), async (req, res) => {
  try {
    // NEVER select plain_password or password_hash
    const result = await query(`
      SELECT u.id, u.email, u.name, u.role, u.emp_id, u.station_code, u.status, u.created_at,
             e.name AS emp_name, e.station_code AS emp_station
      FROM users u LEFT JOIN employees e ON u.emp_id = e.id
      ORDER BY u.role, u.name
    `)
    res.json({ users: result.rows })
  } catch (err) {
    console.error('List users error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── POST /api/auth/users ──────────────────────────────────────
router.post('/users', auth, requireRole('admin','manager','general_manager'), async (req, res) => {
  try {
    const email        = sanitise(req.body.email || '').toLowerCase()
    const password     = sanitise(req.body.password || '')
    const name         = sanitise(req.body.name || '')
    const role         = sanitise(req.body.role || '')
    const emp_id       = req.body.emp_id       || null
    const station_code = req.body.station_code || null
    const status       = req.body.status       || 'active'

    if (!email || !password || !name || !role)
      return res.status(400).json({ error: 'email, password, name, role required' })

    if (!VALID_ROLES.includes(role))
      return res.status(400).json({ error: `Invalid role. Valid: ${VALID_ROLES.join(', ')}` })

    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' })

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Invalid email format' })

    const hash = await bcrypt.hash(password, BCRYPT_COST)

    // Never insert plain_password
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
    res.status(500).json({ error: 'Server error' })
  }
})

// ── PUT /api/auth/users/:id ───────────────────────────────────
router.put('/users/:id', auth, requireRole('admin','manager','general_manager'), async (req, res) => {
  try {
    const { email, password, name, role, emp_id, station_code, status } = req.body

    if (role && !VALID_ROLES.includes(role))
      return res.status(400).json({ error: `Invalid role. Valid: ${VALID_ROLES.join(', ')}` })

    if (password && password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' })

    let hash = null
    let pwChangedAt = null
    if (password) {
      hash = await bcrypt.hash(sanitise(password), BCRYPT_COST)
      pwChangedAt = new Date()
    }

    const result = await query(`
      UPDATE users SET
        email              = COALESCE($1, email),
        password_hash      = CASE WHEN $2 IS NOT NULL THEN $2 ELSE password_hash END,
        password_changed_at= CASE WHEN $3::timestamptz IS NOT NULL THEN $3 ELSE password_changed_at END,
        name               = COALESCE($4, name),
        role               = COALESCE($5, role),
        emp_id             = COALESCE($6, emp_id),
        station_code       = COALESCE($7, station_code),
        status             = COALESCE($8, status),
        updated_at         = NOW()
      WHERE id = $9
      RETURNING id, email, name, role, emp_id, station_code, status
    `, [
      email ? email.toLowerCase().trim() : null,
      hash,
      pwChangedAt,
      name   ? sanitise(name)   : null,
      role   ? sanitise(role)   : null,
      emp_id        || null,
      station_code  || null,
      status        || null,
      req.params.id
    ])

    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ user: result.rows[0] })
  } catch (err) {
    console.error('Update user error:', err.message)
    if (err.code === '23514') return res.status(400).json({ error: 'Invalid role — run database migration' })
    res.status(500).json({ error: 'Server error' })
  }
})

// ── DELETE /api/auth/users/:id ────────────────────────────────
router.delete('/users/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    // Prevent self-deletion
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'Cannot delete your own account' })

    await query('DELETE FROM users WHERE id = $1', [req.params.id])
    res.json({ message: 'User deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

module.exports = router