const jwt = require('jsonwebtoken')

const JWT_SECRET    = process.env.JWT_SECRET    || 'fallback-dev-secret-change-in-production'
const ACCESS_SECRET = process.env.ACCESS_SECRET || JWT_SECRET

// Parse access_token from raw cookie header string
function parseCookieToken(cookieHeader) {
  if (!cookieHeader) return null
  const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

function verifySocketToken(socket, next) {
  // Priority: HttpOnly cookie → auth.token (legacy) → query.token (legacy)
  const token = parseCookieToken(socket.handshake.headers?.cookie)
    || socket.handshake.auth?.token
    || socket.handshake.query?.token

  if (!token) return next(new Error('Authentication required'))

  try {
    socket.user = jwt.verify(token, ACCESS_SECRET)
    next()
  } catch (e) {
    next(new Error(e.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token'))
  }
}

function requireSocketRole(...roles) {
  return (socket, next) => {
    if (!socket.user) return next(new Error('Authentication required'))
    if (!roles.includes(socket.user.role)) return next(new Error('Insufficient permissions'))
    next()
  }
}

module.exports = function setupSocket(io) {
  // ── Default namespace ───────────────────────────────────────
  io.use(verifySocketToken)

  io.on('connection', (socket) => {
    const { id, role, emp_id, name, station_code } = socket.user

    socket.join(`user:${id}`)
    socket.join(`role:${role}`)
    if (emp_id) socket.join(`emp:${emp_id}`)

    // POC/manager join their station room — validate input
    socket.on('join:station', (station) => {
      if (typeof station !== 'string' || station.length > 20) return
      const allowed = ['poc', 'manager', 'admin', 'general_manager']
      if (!allowed.includes(role)) return
      socket.join(`station:${station}`)
    })

    socket.on('disconnect', () => {
      console.log(`[socket] disconnected: ${name} (${role})`)
    })
  })

  // ── /notifications namespace ────────────────────────────────
  const notif = io.of('/notifications')
  notif.use(verifySocketToken)

  notif.on('connection', (socket) => {
    const { id, role } = socket.user
    socket.join(`user:${id}`)
    socket.join(`role:${role}`)

    // Client marks a notification as read
    socket.on('notification:read', async (notifId) => {
      if (typeof notifId !== 'string') return
      try {
        const { query } = require('../db/pool')
        await query(
          `UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2`,
          [notifId, id]
        )
        socket.emit('notification:read:ack', { id: notifId })
      } catch (e) {
        console.error('[socket/notifications] read error:', e.message)
      }
    })
  })

  // ── /payroll namespace (finance roles only) ─────────────────
  const payroll = io.of('/payroll')
  payroll.use(verifySocketToken)
  payroll.use(requireSocketRole('admin', 'general_manager', 'accountant'))

  payroll.on('connection', (socket) => {
    socket.join('payroll:updates')
    socket.on('disconnect', () => {})
  })
}
