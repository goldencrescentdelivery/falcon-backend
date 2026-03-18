const jwt = require('jsonwebtoken')

const ALL_ROLES = ['admin','manager','general_manager','hr','accountant','poc','driver']

// Role hierarchy — higher index = more permissions
const ROLE_LEVEL = {
  driver: 0, poc: 1, accountant: 2, hr: 3,
  general_manager: 4, manager: 5, admin: 6
}

function auth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' })
  const token = header.split(' ')[1]
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ error: 'Insufficient permissions' })
    next()
  }
}

// requireLevel(3) = hr and above
function requireLevel(level) {
  return (req, res, next) => {
    const userLevel = ROLE_LEVEL[req.user?.role] ?? -1
    if (userLevel < level)
      return res.status(403).json({ error: 'Insufficient permissions' })
    next()
  }
}

module.exports = { auth, requireRole, requireLevel, ROLE_LEVEL }
