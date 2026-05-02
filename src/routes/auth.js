const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const crypto  = require('crypto')
const { query } = require('../db/pool')

const JWT_SECRET     = process.env.JWT_SECRET     || 'fallback-dev-secret-change-in-production'
const ACCESS_SECRET  = process.env.ACCESS_SECRET  || JWT_SECRET
const REFRESH_SECRET = process.env.REFRESH_SECRET || JWT_SECRET + '-refresh'
const VALID_ROLES    = ['admin','manager','general_manager','hr','accountant','poc','driver']
const IS_PROD        = process.env.NODE_ENV === 'production'

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: IS_PROD ? 'strict' : 'lax',
  secure:   IS_PROD,
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/* ── inline auth middleware ── */
function verifyToken(req, res, next) {
  // Cookie (new) or Authorization header (legacy) — both accepted
  const token = req.cookies?.access_token
    || (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7) : null)
  if (!token) return res.status(401).json({ error:'Authentication required' })
  try {
    req.user = jwt.verify(token, ACCESS_SECRET)
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

    const payload = { id:user.id, email:user.email, name:user.name, role:user.role, emp_id:user.emp_id, station_code:user.station_code }
    const accessToken  = jwt.sign(payload, ACCESS_SECRET,  { expiresIn: '8h' })
    const refreshRaw   = jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' })
    const family       = crypto.randomUUID()
    const expiresAt    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family, expires_at) VALUES ($1,$2,$3,$4)`,
      [user.id, hashToken(refreshRaw), family, expiresAt]
    )

    // Set HttpOnly cookies — also return token in body for backward compat
    res.cookie('access_token',  accessToken, { ...COOKIE_BASE, maxAge: 8  * 60 * 60 * 1000 })
    res.cookie('refresh_token', refreshRaw,  { ...COOKIE_BASE, maxAge: 7  * 24 * 60 * 60 * 1000, path: '/api/auth' })

    const safeUser = { id:user.id, email:user.email, name:user.name, role:user.role, emp_id:user.emp_id, station_code:user.station_code, status:user.status }
    res.json({ token: accessToken, user: safeUser })
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
    const upd = await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, req.user.id])
    if (upd.rowCount === 0) return res.status(500).json({ error:'Password update failed — user record not found in DB' })
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
    `, [email, hash, name, rl, manager_type, emp_id, station_code, status])

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
router.delete('/users/:id', verifyToken, role('admin','general_manager'), async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error:'Cannot delete your own account' })
    const userRes = await query(`SELECT emp_id FROM users WHERE id=$1`, [req.params.id])
    if (!userRes.rows[0]) return res.status(404).json({ error:'User not found' })
    const empId = userRes.rows[0].emp_id
    const uid = req.params.id

    // NULL out all FK references to this user across every table
    const nullQueries = [
      `UPDATE attendance          SET logged_by       = NULL WHERE logged_by       = $1`,
      `UPDATE leaves              SET approved_by     = NULL WHERE approved_by     = $1`,
      `UPDATE leaves              SET poc_id          = NULL WHERE poc_id          = $1`,
      `UPDATE leaves              SET hr_id           = NULL WHERE hr_id           = $1`,
      `UPDATE leaves              SET gm_id           = NULL WHERE gm_id           = $1`,
      `UPDATE leaves              SET mgr_id          = NULL WHERE mgr_id          = $1`,
      `UPDATE leaves              SET approved_by_poc = NULL WHERE approved_by_poc = $1`,
      `UPDATE salary_deductions   SET added_by        = NULL WHERE added_by        = $1`,
      `UPDATE salary_bonuses      SET added_by        = NULL WHERE added_by        = $1`,
      `UPDATE payroll             SET paid_by         = NULL WHERE paid_by         = $1`,
      `UPDATE expenses            SET approved_by     = NULL WHERE approved_by     = $1`,
      `UPDATE announcements       SET posted_by       = NULL WHERE posted_by       = $1`,
      `UPDATE shifts              SET assigned_by     = NULL WHERE assigned_by     = $1`,
      `UPDATE damage_reports      SET reviewed_by     = NULL WHERE reviewed_by     = $1`,
      `UPDATE salary_advances     SET reviewed_by     = NULL WHERE reviewed_by     = $1`,
      `UPDATE daily_deliveries    SET logged_by       = NULL WHERE logged_by       = $1`,
      `UPDATE payslip_exports     SET exported_by     = NULL WHERE exported_by     = $1`,
      `UPDATE backup_log          SET triggered_by    = NULL WHERE triggered_by    = $1`,
      `UPDATE sim_cards           SET assigned_by     = NULL WHERE assigned_by     = $1`,
      `UPDATE vehicle_assignments SET assigned_by     = NULL WHERE assigned_by     = $1`,
      `UPDATE employee_documents  SET uploaded_by     = NULL WHERE uploaded_by     = $1`,
      `UPDATE employees           SET user_id         = NULL WHERE user_id         = $1`,
    ]
    for (const sql of nullQueries) {
      try { await query(sql, [uid]) } catch(_) {}
    }

    await query(`DELETE FROM users WHERE id=$1`, [uid])
    if (empId) {
      await query(`DELETE FROM employees WHERE id=$1`, [empId])
    }
    res.json({ message:'User deleted' })
  } catch(e) { console.error('DELETE USER ERROR:', e.message); res.status(500).json({ error:'Server error: '+e.message }) }
})

/* ── POST /api/auth/refresh — rotate refresh token ── */
router.post('/refresh', async (req, res) => {
  try {
    const refreshRaw = req.cookies?.refresh_token || req.body?.refresh_token
    if (!refreshRaw) return res.status(401).json({ error: 'Refresh token required' })

    let decoded
    try {
      decoded = jwt.verify(refreshRaw, REFRESH_SECRET)
    } catch(e) {
      res.clearCookie('access_token')
      res.clearCookie('refresh_token', { path: '/api/auth' })
      return res.status(401).json({ error: 'Invalid or expired refresh token' })
    }

    const hash = hashToken(refreshRaw)
    const stored = await query(
      `SELECT * FROM refresh_tokens WHERE token_hash=$1`, [hash]
    )

    if (!stored.rows[0]) {
      // Token not in DB — possible reuse attack. We can't identify the family
      // from a hash that doesn't exist, so revoke ALL tokens for this user.
      await query(`UPDATE refresh_tokens SET revoked=true WHERE user_id=$1`, [decoded.id])
      res.clearCookie('access_token')
      res.clearCookie('refresh_token', { path: '/api/auth' })
      return res.status(401).json({ error: 'Refresh token reuse detected' })
    }

    const rt = stored.rows[0]
    if (rt.revoked || new Date(rt.expires_at) < new Date()) {
      await query(`UPDATE refresh_tokens SET revoked=true WHERE family=$1`, [rt.family])
      res.clearCookie('access_token')
      res.clearCookie('refresh_token', { path: '/api/auth' })
      return res.status(401).json({ error: 'Refresh token expired or revoked' })
    }

    const userRow = await query(
      `SELECT id,email,name,role,emp_id,station_code,status FROM users WHERE id=$1`, [decoded.id]
    )
    if (!userRow.rows[0] || userRow.rows[0].status === 'inactive') {
      return res.status(403).json({ error: 'Account disabled' })
    }
    const user = userRow.rows[0]

    // Rotate: revoke old token, issue new pair
    await query(`UPDATE refresh_tokens SET revoked=true WHERE id=$1`, [rt.id])

    const payload      = { id:user.id, email:user.email, name:user.name, role:user.role, emp_id:user.emp_id, station_code:user.station_code }
    const newAccess    = jwt.sign(payload, ACCESS_SECRET,  { expiresIn: '8h' })
    const newRefreshRaw= jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' })
    const expiresAt    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family, expires_at) VALUES ($1,$2,$3,$4)`,
      [user.id, hashToken(newRefreshRaw), rt.family, expiresAt]
    )

    res.cookie('access_token',  newAccess,     { ...COOKIE_BASE, maxAge: 8 * 60 * 60 * 1000 })
    res.cookie('refresh_token', newRefreshRaw, { ...COOKIE_BASE, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/api/auth' })

    res.json({ token: newAccess, user })
  } catch(e) { console.error('REFRESH ERROR:', e.message); res.status(500).json({ error: 'Server error' }) }
})

/* ── POST /api/auth/logout ── */
router.post('/logout', async (req, res) => {
  try {
    const refreshRaw = req.cookies?.refresh_token || req.body?.refresh_token
    if (refreshRaw) {
      const hash = hashToken(refreshRaw)
      await query(`UPDATE refresh_tokens SET revoked=true WHERE token_hash=$1`, [hash]).catch(() => {})
    }
    res.clearCookie('access_token')
    res.clearCookie('refresh_token', { path: '/api/auth' })
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router