const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const { query } = require('../db/pool')

const JWT_SECRET  = process.env.JWT_SECRET || 'gcd-dev-secret-2024'
const VALID_ROLES = ['admin','manager','general_manager','hr','accountant','poc','driver']

/* ── inline auth middleware (no external dependency issues) ── */
function verifyToken(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error:'Authentication required' })
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET)
    next()
  } catch(e) {
    if (e.name === 'TokenExpiredError') return res.status(401).json({ error:'Session expired. Please log in again.' })
    return res.status(401).json({ error:'Invalid token' })
  }
}

function role(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(403).json({ error:'Insufficient permissions' })
    next()
  }
}

/* ── rate limiter ── */
const attempts = new Map()
function checkLimit(email) {
  const k = email.toLowerCase(), now = Date.now(), r = attempts.get(k)
  if (!r) return true
  if (r.lockedUntil && now < r.lockedUntil) return false
  if (now - r.firstAt > 15*60*1000) { attempts.delete(k); return true }
  return true
}
function failAttempt(email) {
  const k = email.toLowerCase(), now = Date.now()
  const r = attempts.get(k) || { count:0, firstAt:now, lockedUntil:0 }
  if (now - r.firstAt > 15*60*1000) { attempts.set(k,{count:1,firstAt:now,lockedUntil:0}); return }
  r.count++
  if (r.count >= 5) r.lockedUntil = now + 15*60*1000
  attempts.set(k, r)
}

/* ── POST /api/auth/login ── */
router.post('/login', async (req, res) => {
  try {
    const email    = (req.body.email    || '').trim().toLowerCase()
    const password = (req.body.password || '').trim()
    if (!email || !password) return res.status(400).json({ error:'Email and password required' })
    if (!checkLimit(email)) return res.status(429).json({ error:'Too many attempts. Wait 15 minutes.' })

    const r = await query(
      `SELECT id, email, name, role, emp_id, station_code, status, password_hash
       FROM users WHERE email = $1`, [email]
    )
    const user = r.rows[0]
    const hash = user?.password_hash || '$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCD'
    const valid = await bcrypt.compare(password, hash)

    if (!user || !valid) { failAttempt(email); return res.status(401).json({ error:'Invalid credentials' }) }
    if (user.status === 'inactive') return res.status(403).json({ error:'Account disabled.' })

    attempts.delete(email)
    const token = jwt.sign(
      { id:user.id, email:user.email, name:user.name, role:user.role, emp_id:user.emp_id, station_code:user.station_code },
      JWT_SECRET, { expiresIn:'8h' }
    )
    res.json({ token, user:{ id:user.id, email:user.email, name:user.name, role:user.role, emp_id:user.emp_id, station_code:user.station_code, status:user.status } })
  } catch(e) { console.error('LOGIN ERROR:', e.message, e.stack); res.status(500).json({ error:'Server error: '+e.message }) }
})

/* ── GET /api/auth/me ── */
router.get('/me', verifyToken, async (req, res) => {
  try {
    const r = await query(`SELECT id,email,name,role,emp_id,station_code,status FROM users WHERE id=$1`, [req.user.id])
    if (!r.rows[0]) return res.status(404).json({ error:'User not found' })
    res.json({ user: r.rows[0] })
  } catch(e) { console.error('ME ERROR:', e.message); res.status(500).json({ error:'Server error: '+e.message }) }
})

/* ── POST /api/auth/change-password ── */
router.post('/change-password', verifyToken, async (req, res) => {
  try {
    const cur  = (req.body.currentPassword || '').trim()
    const next = (req.body.newPassword     || '').trim()
    if (!cur || !next) return res.status(400).json({ error:'Both passwords required' })
    if (next.length < 6) return res.status(400).json({ error:'Password must be at least 6 characters' })

    const r = await query(`SELECT id, password_hash FROM users WHERE id=$1`, [req.user.id])
    if (!r.rows[0]) return res.status(404).json({ error:'User not found' })
    if (!await bcrypt.compare(cur, r.rows[0].password_hash)) return res.status(401).json({ error:'Current password incorrect' })

    const hash = await bcrypt.hash(next, 12)
    await query(`UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2`, [hash, req.user.id])
    res.json({ message:'Password updated successfully' })
  } catch(e) { console.error('CHANGE-PW ERROR:', e.message); res.status(500).json({ error:'Server error: '+e.message }) }
})

/* ── GET /api/auth/users ── */
router.get('/users', verifyToken, role('admin','manager','general_manager','hr','accountant'), async (req, res) => {
  try {
    const r = await query(`
      SELECT u.id, u.email, u.name, u.role, u.manager_type, u.emp_id, u.station_code, u.status, u.created_at,
             e.name AS emp_name, e.station_code AS emp_station
      FROM users u
      LEFT JOIN employees e ON u.emp_id = e.id
      ORDER BY u.role, u.name
    `)
    res.json({ users: r.rows })
  } catch(e) { console.error('LIST USERS ERROR:', e.message, e.stack); res.status(500).json({ error:'Server error: '+e.message }) }
})

/* ── POST /api/auth/users ── */
router.post('/users', verifyToken, role('admin','manager','general_manager'), async (req, res) => {
  try {
    const email        = (req.body.email    || '').trim().toLowerCase()
    const password     = (req.body.password || '').trim()
    const name         = (req.body.name     || '').trim()
    const rl           = (req.body.role     || '').trim()
    const manager_type = req.body.manager_type || null
    const emp_id       = req.body.emp_id       || null
    const station_code = req.body.station_code || null
    const status       = req.body.status       || 'active'

    if (!email||!password||!name||!rl) return res.status(400).json({ error:'email, password, name, role required' })
    if (!VALID_ROLES.includes(rl)) return res.status(400).json({ error:`Invalid role. Must be: ${VALID_ROLES.join(', ')}` })
    if (password.length < 6) return res.status(400).json({ error:'Password must be at least 6 characters' })

    const hash = await bcrypt.hash(password, 12)
    const r = await query(`
      INSERT INTO users (email, password_hash, name, role, manager_type, emp_id, station_code, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, email, name, role, manager_type, emp_id, station_code, status
    `, [email, hash, name, rl, rl==='general_manager'?manager_type:null, emp_id, station_code, status])

    res.status(201).json({ user: r.rows[0] })
  } catch(e) {
    console.error('CREATE USER ERROR:', e.message, e.stack)
    if (e.code === '23505') return res.status(409).json({ error:'Email already exists' })
    if (e.code === '23514') return res.status(400).json({ error:'Invalid role — run database migration first' })
    res.status(500).json({ error:'Server error: '+e.message })
  }
})

/* ── PUT /api/auth/users/:id ── */
router.put('/users/:id', verifyToken, role('admin','manager','general_manager'), async (req, res) => {
  try {
    const { email, password, name, role:rl, emp_id, station_code, status } = req.body
    if (rl && !VALID_ROLES.includes(rl)) return res.status(400).json({ error:`Invalid role` })

    let hash = null
    if (password) {
      if (password.length < 6) return res.status(400).json({ error:'Password must be at least 6 characters' })
      hash = await bcrypt.hash(password.trim(), 12)
    }

    const r = await query(`
      UPDATE users SET
        email        = COALESCE($1, email),
        password_hash= CASE WHEN $2::TEXT IS NOT NULL THEN $2::TEXT ELSE password_hash END,
        name         = COALESCE($3, name),
        role         = COALESCE($4, role),
        manager_type = COALESCE($5, manager_type),
        emp_id       = COALESCE($6, emp_id),
        station_code = COALESCE($7, station_code),
        status       = COALESCE($8, status),
        updated_at   = NOW()
      WHERE id=$9
      RETURNING id, email, name, role, manager_type, emp_id, station_code, status
    `, [email?.toLowerCase().trim()||null, hash, name||null, rl||null, req.body.manager_type||null, emp_id||null, station_code||null, status||null, req.params.id])

    if (!r.rows[0]) return res.status(404).json({ error:'User not found' })
    res.json({ user: r.rows[0] })
  } catch(e) {
    console.error('UPDATE USER ERROR:', e.message, e.stack)
    if (e.code === '23514') return res.status(400).json({ error:'Invalid role — run database migration' })
    res.status(500).json({ error:'Server error: '+e.message })
  }
})

/* ── DELETE /api/auth/users/:id ── */
router.delete('/users/:id', verifyToken, role('admin','manager'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error:'Cannot delete your own account' })
    await query(`DELETE FROM users WHERE id=$1`, [req.params.id])
    res.json({ message:'User deleted' })
  } catch(e) { res.status(500).json({ error:'Server error: '+e.message }) }
})

module.exports = router