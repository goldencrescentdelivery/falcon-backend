/**
 * GOLDEN CRESCENT — Secure Auth Middleware
 * - Verifies JWT signature and expiry
 * - Checks token was not issued before last password change
 * - Never trusts role from token alone for sensitive ops
 */

const jwt = require('jsonwebtoken')
const { query } = require('../db/pool')

const JWT_SECRET = process.env.JWT_SECRET

// Role hierarchy — higher number = more access
const ROLE_LEVEL = {
  driver:          1,
  poc:             2,
  accountant:      3,
  hr:              3,
  general_manager: 4,
  manager:         5,
  admin:           6,
}

// ── Core JWT verification ─────────────────────────────────────
async function auth(req, res, next) {
  try {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer '))
      return res.status(401).json({ error: 'Authentication required' })

    const token = header.slice(7)

    // Verify signature and expiry
    let decoded
    try {
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })
    } catch (err) {
      if (err.name === 'TokenExpiredError')
        return res.status(401).json({ error: 'Session expired. Please log in again.' })
      return res.status(401).json({ error: 'Invalid token' })
    }

    // Verify user still exists and is active
    const result = await query(
      `SELECT id, role, status, password_changed_at FROM users WHERE id = $1`,
      [decoded.id]
    )
    const user = result.rows[0]

    if (!user)
      return res.status(401).json({ error: 'User not found' })

    if (user.status === 'inactive')
      return res.status(403).json({ error: 'Account disabled' })

    // Invalidate tokens issued before a password change
    if (user.password_changed_at) {
      const changedAt = Math.floor(new Date(user.password_changed_at).getTime() / 1000)
      const issuedAt  = decoded.iat
      if (issuedAt < changedAt)
        return res.status(401).json({ error: 'Password changed. Please log in again.' })
    }

    // Attach verified user data to request — use DB role, not token role
    req.user = {
      id:           decoded.id,
      email:        decoded.email,
      name:         decoded.name,
      role:         user.role,       // Always use DB role, not token role
      emp_id:       decoded.emp_id,
      station_code: decoded.station_code,
    }

    next()
  } catch (err) {
    console.error('Auth middleware error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
}

// ── Role whitelist check ──────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' })
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient permissions' })
    next()
  }
}

// ── Minimum role level check ──────────────────────────────────
function requireLevel(minLevel) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' })
    if ((ROLE_LEVEL[req.user.role] || 0) < minLevel)
      return res.status(403).json({ error: 'Insufficient permissions' })
    next()
  }
}

module.exports = { auth, requireRole, requireLevel, ROLE_LEVEL }