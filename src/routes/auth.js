const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt    = require('jsonwebtoken')
const { query } = require('../db/pool')
const { auth }  = require('../middleware/auth')

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

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
})

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const result = await query('SELECT id,email,name,role,emp_id FROM users WHERE id=$1', [req.user.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json({ user: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

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
})

module.exports = router
