const jwt = require('jsonwebtoken')

module.exports = function setupSocket(io) {
  // Auth middleware for socket connections
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token
    if (!token) return next(new Error('Authentication required'))
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET)
      next()
    } catch {
      next(new Error('Invalid token'))
    }
  })

  io.on('connection', (socket) => {
    const { role, emp_id, name } = socket.user
    console.log(`⚡ Socket connected: ${name} (${role})`)

    // Join role-based rooms
    socket.join(role)
    if (emp_id) socket.join(`emp:${emp_id}`)

    // POC joins their station room
    socket.on('join:station', (station) => {
      socket.join(`station:${station}`)
    })

    socket.on('disconnect', () => {
      console.log(`⚡ Socket disconnected: ${name}`)
    })
  })
}
