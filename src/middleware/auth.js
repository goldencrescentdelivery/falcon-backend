const jwt = require('jsonwebtoken')

const JWT_SECRET    = process.env.JWT_SECRET    || 'fallback-dev-secret-change-in-production'
const ACCESS_SECRET = process.env.ACCESS_SECRET || JWT_SECRET

const ROLE_LEVEL = {
  driver: 1, poc: 2, accountant: 3, hr: 3,
  general_manager: 4, manager: 5, admin: 6,
}

async function auth(req, res, next) {
  try {
    // Accept token from HttpOnly cookie (new) or Authorization header (legacy)
    const token = req.cookies?.access_token
      || (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : null)

    if (!token) return res.status(401).json({ error: 'Authentication required' })

    let decoded
    try {
      decoded = jwt.verify(token, ACCESS_SECRET)
    } catch (err) {
      if (err.name === 'TokenExpiredError')
        return res.status(401).json({ error: 'Session expired. Please log in again.' })
      return res.status(401).json({ error: 'Invalid token' })
    }

    req.user = {
      id:           decoded.id,
      email:        decoded.email,
      name:         decoded.name,
      role:         decoded.role,
      emp_id:       decoded.emp_id,
      station_code: decoded.station_code,
    }
    next()
  } catch (err) {
    console.error('Auth middleware error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' })
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient permissions' })
    next()
  }
}

function requireLevel(minLevel) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' })
    if ((ROLE_LEVEL[req.user.role] || 0) < minLevel)
      return res.status(403).json({ error: 'Insufficient permissions' })
    next()
  }
}

module.exports = { auth, requireRole, requireLevel, ROLE_LEVEL }