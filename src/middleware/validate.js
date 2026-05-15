/**
 * GCD — Input Validation & Sanitization Middleware
 *
 * Covers every input surface:
 *  - req.body fields (type, length, format, enum)
 *  - req.query parameters (type coercion, enum allowlists)
 *  - req.params (UUID and ID format checks)
 *  - File uploads (MIME type, extension, size)
 *  - XSS/script injection stripping
 */

// ── Primitives ────────────────────────────────────────────────

/** Strip any HTML/script tags and null bytes from a string */
function stripDangerous(str) {
  if (typeof str !== 'string') return str
  return str
    .replace(/\0/g, '')                          // null bytes
    .replace(/<[^>]*>/g, '')                     // HTML tags
    .replace(/javascript\s*:/gi, '')             // JS protocol
    .replace(/on\w+\s*=/gi, '')                  // event handlers
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // control chars
    .trim()
}

/** Sanitize and enforce max length */
function str(val, maxLen = 255) {
  if (val === null || val === undefined) return null
  return stripDangerous(String(val)).slice(0, maxLen)
}

/** Parse and validate a positive integer within a range */
function positiveInt(val, min = 0, max = 999999) {
  const n = parseInt(val, 10)
  if (isNaN(n) || n < min || n > max) return null
  return n
}

/** Parse a float, reject NaN/Inf, clamp to range */
function money(val, min = 0, max = 9999999) {
  const n = parseFloat(val)
  if (!isFinite(n) || n < min || n > max) return null
  return Math.round(n * 100) / 100  // max 2 decimal places
}

/** Validate ISO date string YYYY-MM-DD */
function isoDate(val) {
  if (!val) return null
  const s = String(val).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  return s
}

/** Validate YYYY-MM month string */
function isoMonth(val) {
  if (!val) return null
  const s = String(val).trim()
  if (!/^\d{4}-\d{2}$/.test(s)) return null
  return s
}

/** Validate UUID v4 */
function uuid(val) {
  if (!val) return null
  const s = String(val).trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return null
  return s.toLowerCase()
}

/** Validate employee ID format (GCD-XX or alphanumeric, max 30) */
function empId(val) {
  if (!val) return null
  const s = String(val).trim()
  if (!/^[A-Za-z0-9\-_]{1,30}$/.test(s)) return null
  return s.toUpperCase()
}

/** Allowlist enum check */
function allowlist(val, allowed) {
  const s = String(val || '').trim()
  return allowed.includes(s) ? s : null
}

/** Validate email format */
function email(val) {
  if (!val) return null
  const s = String(val).trim().toLowerCase().slice(0, 255)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null
  return s
}

// ── Allowed value sets ────────────────────────────────────────
const ROLES          = ['admin','manager','general_manager','hr','accountant','poc','driver']
const STATIONS       = ['DDB6','DDB7','DSH6','DXD3']
const STATUSES       = ['active','inactive']
const LEAVE_TYPES    = ['Annual','Sick','Emergency','Unpaid','Other']
const LEAVE_STATUSES = ['pending','approved','rejected']
const CYCLES         = ['A','B','C','D','E','E1','F','Rescue']
const SHIFT_TYPES    = ['regular','rescue','off','leave']
const SEV_TYPES      = ['minor','moderate','major','totaled']
const DAMAGE_STATUSES= ['pending','reviewed','resolved']
const ADV_STATUSES   = ['pending','approved','rejected']
const EXP_CATS       = [
  'Parking','Advances','Air Tickets','ENOC','Health Insurance',
  'Idfy','Mobile Expenses','Office Expenses','Petty Cash','RTA Top-up',
  'Vehicle Expenses','Vehicle Rent','Visa Expenses','Miscellaneous Expenses'
]
const EXP_STATUSES   = ['pending','approved','rejected']
const DED_TYPES      = ['traffic_fine','iloe_fee','iloe_fine','cash_variance','other']
const BON_TYPES      = ['performance','kpi','other']
const PROJ_TYPES     = ['pulser','cret','office']
const COMPLIANCE_TYPES = ['vehicle_insurance','driver_insurance','license','permit','other']
const ALLOWED_IMAGE_MIMES = ['image/jpeg','image/jpg','image/png','image/webp','image/heic']
const ALLOWED_IMAGE_EXTS  = ['jpg','jpeg','png','webp','heic']

// ── File upload validator ─────────────────────────────────────
function validateImageFile(file) {
  if (!file) return { ok: false, error: 'No file provided' }
  if (file.size > 8 * 1024 * 1024) return { ok: false, error: 'File too large (max 8 MB)' }
  if (!ALLOWED_IMAGE_MIMES.includes(file.mimetype?.toLowerCase()))
    return { ok: false, error: `Invalid file type. Allowed: ${ALLOWED_IMAGE_MIMES.join(', ')}` }
  const ext = (file.originalname || '').split('.').pop()?.toLowerCase()
  if (!ALLOWED_IMAGE_EXTS.includes(ext))
    return { ok: false, error: `Invalid file extension. Allowed: ${ALLOWED_IMAGE_EXTS.join(', ')}` }
  // Block path traversal in filenames
  if (/[\/\\\.\.]/g.test(file.originalname.replace(/\.[^.]+$/, '')))
    return { ok: false, error: 'Invalid filename' }
  return { ok: true }
}

// ── Query param validator (returns 400 if invalid) ───────────
function validateQuery(schema) {
  return (req, res, next) => {
    const errors = []
    const clean  = {}

    for (const [key, rule] of Object.entries(schema)) {
      const val = req.query[key]
      if (val === undefined) { clean[key] = rule.default ?? undefined; continue }

      if (rule.type === 'date'  && !isoDate(val))   errors.push(`${key}: invalid date (YYYY-MM-DD)`)
      if (rule.type === 'month' && !isoMonth(val))  errors.push(`${key}: invalid month (YYYY-MM)`)
      if (rule.type === 'int') {
        const n = positiveInt(val, rule.min ?? 0, rule.max ?? 999999)
        if (n === null) errors.push(`${key}: must be integer ${rule.min ?? 0}–${rule.max ?? 999999}`)
        else clean[key] = n
        continue
      }
      if (rule.enum && !allowlist(val, rule.enum)) errors.push(`${key}: must be one of ${rule.enum.join(', ')}`)
      if (rule.type === 'empId' && val && !empId(val)) errors.push(`${key}: invalid employee ID`)
      if (rule.type === 'uuid'  && val && !uuid(val))  errors.push(`${key}: invalid UUID`)

      clean[key] = val !== undefined ? str(val, rule.maxLen ?? 100) : undefined
    }

    if (errors.length) return res.status(400).json({ error: errors.join('; ') })
    req.cleanQuery = clean
    next()
  }
}

// ── Route param validator ─────────────────────────────────────
function validateParams(schema) {
  return (req, res, next) => {
    for (const [key, type] of Object.entries(schema)) {
      const val = req.params[key]
      if (type === 'uuid'  && !uuid(val))  return res.status(400).json({ error: `Invalid ${key} format` })
      if (type === 'empId' && !empId(val)) return res.status(400).json({ error: `Invalid ${key} format` })
      if (type === 'id' && !/^[A-Za-z0-9\-_]{1,50}$/.test(val)) return res.status(400).json({ error: `Invalid ${key}` })
    }
    next()
  }
}

// ── Body validators (per-route) ───────────────────────────────

const validateLogin = (req, res, next) => {
  const { email: e, password: p } = req.body
  if (!e || !p) return res.status(400).json({ error: 'Email and password required' })
  const cleanEmail = email(e)
  if (!cleanEmail) return res.status(400).json({ error: 'Invalid email format' })
  if (typeof p !== 'string' || p.length < 1 || p.length > 128)
    return res.status(400).json({ error: 'Invalid password' })
  req.body.email    = cleanEmail
  req.body.password = p.trim()
  next()
}

const validateEmployee = (req, res, next) => {
  const b = req.body
  const errors = []

  if (req.method === 'POST') {
    if (!b.id   || !empId(b.id))   errors.push('id: required, alphanumeric/dash, max 30 chars')
    if (!b.name || !str(b.name,100)) errors.push('name: required')
  }

  if (b.id           && !empId(b.id))                              errors.push('id: invalid format')
  if (b.email        && !email(b.email))                           errors.push('email: invalid format')
  if (b.station_code && !allowlist(b.station_code, STATIONS))      errors.push(`station_code: must be ${STATIONS.join(' or ')}`)
  if (b.status       && !allowlist(b.status, STATUSES))            errors.push(`status: must be ${STATUSES.join(' or ')}`)
  if (b.project_type && !allowlist(b.project_type, PROJ_TYPES))    errors.push(`project_type: must be ${PROJ_TYPES.join(' or ')}`)
  if (b.salary !== undefined) {
    const s = money(b.salary, 0, 999999)
    if (s === null) errors.push('salary: must be a positive number')
    else b.salary = s
  }
  if (b.hourly_rate !== undefined) {
    const r = money(b.hourly_rate, 0, 9999)
    if (r === null) errors.push('hourly_rate: must be a positive number')
    else b.hourly_rate = r
  }
  if (b.per_shipment_rate !== undefined) {
    const r = money(b.per_shipment_rate, 0, 99)
    if (r === null) errors.push('per_shipment_rate: invalid')
    else b.per_shipment_rate = r
  }
  if (b.visa_expiry  && !isoDate(b.visa_expiry))  errors.push('visa_expiry: invalid date (YYYY-MM-DD)')
  if (b.iloe_expiry  && !isoDate(b.iloe_expiry))  errors.push('iloe_expiry: invalid date (YYYY-MM-DD)')

  if (errors.length) return res.status(400).json({ error: errors.join('; ') })

  // Sanitize string fields
  ;['name','dept','nationality','phone','amazon_id','work_number'].forEach(k => {
    if (b[k]) b[k] = str(b[k], 100)
  })
  ;['emirates_id','transporter_id'].forEach(k => {
    if (b[k]) b[k] = str(b[k], 50)
  })

  next()
}

const validateAttendance = (req, res, next) => {
  const b = req.body
  const errors = []

  if (!b.emp_id) errors.push('emp_id required')
  else if (!empId(b.emp_id)) errors.push('emp_id: invalid format')

  if (!b.date || !isoDate(b.date)) errors.push('date: required, format YYYY-MM-DD')

  if (b.status && !allowlist(b.status, ['present','absent','leave','holiday']))
    errors.push('status: invalid value')

  if (b.cycle && !allowlist(b.cycle, CYCLES)) errors.push(`cycle: must be one of ${CYCLES.join(', ')}`)

  if (b.cycle_hours !== undefined) {
    const h = money(b.cycle_hours, 0, 24)
    if (h === null) errors.push('cycle_hours: must be 0–24')
    else b.cycle_hours = h
  }
  if (b.rescue_hours !== undefined) {
    const h = money(b.rescue_hours, 0, 24)
    if (h === null) errors.push('rescue_hours: must be 0–24')
    else b.rescue_hours = h
  }
  if (b.daily_rate !== undefined) {
    const r = money(b.daily_rate, 0, 9999)
    if (r === null) errors.push('daily_rate: invalid')
    else b.daily_rate = r
  }
  if (b.note) b.note = str(b.note, 500)
  if (b.check_in  && !/^\d{2}:\d{2}(:\d{2})?$/.test(b.check_in))  errors.push('check_in: invalid time (HH:MM)')
  if (b.check_out && !/^\d{2}:\d{2}(:\d{2})?$/.test(b.check_out)) errors.push('check_out: invalid time (HH:MM)')

  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  next()
}

const validateLeave = (req, res, next) => {
  const b = req.body
  const errors = []

  if (!b.emp_id) errors.push('emp_id required')
  if (b.type && !allowlist(b.type, LEAVE_TYPES)) errors.push(`type: must be ${LEAVE_TYPES.join(', ')}`)

  if (!b.from_date || !isoDate(b.from_date)) errors.push('from_date: required, YYYY-MM-DD')
  if (!b.to_date   || !isoDate(b.to_date))   errors.push('to_date: required, YYYY-MM-DD')
  if (b.from_date && b.to_date && b.from_date > b.to_date) errors.push('from_date must be before to_date')

  if (b.days !== undefined) {
    const d = positiveInt(b.days, 1, 365)
    if (d === null) errors.push('days: must be 1–365')
    else b.days = d
  }
  if (b.reason) b.reason = str(b.reason, 500)

  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  next()
}

const validateLeaveAction = (req, res, next) => {
  const { status, reason } = req.body
  if (!status || !allowlist(status, LEAVE_STATUSES))
    return res.status(400).json({ error: `status must be: ${LEAVE_STATUSES.join(', ')}` })
  if (reason) req.body.reason = str(reason, 500)
  next()
}

const validateExpense = (req, res, next) => {
  const b = req.body
  const errors = []

  if (!b.emp_id) errors.push('emp_id required')
  if (b.category && !allowlist(b.category, EXP_CATS)) errors.push(`category: invalid`)
  if (b.amount !== undefined) {
    const a = money(b.amount, 0.01, 999999)
    if (a === null) errors.push('amount: must be a positive number')
    else b.amount = a
  }
  if (!b.amount) errors.push('amount required')
  if (b.date  && !isoDate(b.date))   errors.push('date: invalid (YYYY-MM-DD)')
  if (b.month && !isoMonth(b.month)) errors.push('month: invalid (YYYY-MM)')
  if (b.description) b.description = str(b.description, 500)
  if (b.status && !allowlist(b.status, EXP_STATUSES)) errors.push('status: invalid')

  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  next()
}

const validatePayrollBonus = (req, res, next) => {
  const b = req.body
  const errors = []

  if (!b.emp_id) errors.push('emp_id required')
  if (b.type && !allowlist(b.type, BON_TYPES)) errors.push(`type: must be ${BON_TYPES.join(', ')}`)
  if (b.amount !== undefined) {
    const a = money(b.amount, 0.01, 999999)
    if (a === null) errors.push('amount: must be a positive number (max 999,999)')
    else b.amount = a
  }
  if (!b.amount) errors.push('amount required')
  if (b.month  && !isoMonth(b.month)) errors.push('month: invalid (YYYY-MM)')
  if (b.description) b.description = str(b.description, 255)

  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  next()
}

const validatePayrollDeduction = (req, res, next) => {
  const b = req.body
  const errors = []

  if (!b.emp_id) errors.push('emp_id required')
  if (b.type && !allowlist(b.type, DED_TYPES)) errors.push(`type: must be ${DED_TYPES.join(', ')}`)
  if (b.amount !== undefined) {
    const a = money(b.amount, 0.01, 999999)
    if (a === null) errors.push('amount: must be positive')
    else b.amount = a
  }
  if (!b.amount) errors.push('amount required')
  if (b.month      && !isoMonth(b.month))  errors.push('month: invalid (YYYY-MM)')
  if (b.description) b.description = str(b.description, 255)
  if (b.reference)   b.reference   = str(b.reference, 100)

  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  next()
}

const validateShift = (req, res, next) => {
  const b = req.body
  const errors = []

  if (!b.emp_id)     errors.push('emp_id required')
  if (!b.shift_date || !isoDate(b.shift_date)) errors.push('shift_date: required, YYYY-MM-DD')
  if (b.shift_type && !allowlist(b.shift_type, SHIFT_TYPES)) errors.push(`shift_type: must be ${SHIFT_TYPES.join(', ')}`)
  if (b.station_code && !allowlist(b.station_code, STATIONS)) errors.push(`station_code: invalid`)
  if (b.cycle && !allowlist(b.cycle, CYCLES)) errors.push(`cycle: invalid`)
  if (b.notes) b.notes = str(b.notes, 500)

  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  next()
}

const validateDamageReport = (req, res, next) => {
  const b = req.body
  const errors = []

  if (!b.vehicle_id || !uuid(b.vehicle_id)) errors.push('vehicle_id: required, must be UUID')
  if (!b.description || !str(b.description, 2000)) errors.push('description: required (max 2000 chars)')
  if (b.severity && !allowlist(b.severity, SEV_TYPES)) errors.push(`severity: must be ${SEV_TYPES.join(', ')}`)
  if (b.station_code && !allowlist(b.station_code, STATIONS)) errors.push('station_code: invalid')
  if (b.description) b.description = str(b.description, 2000)

  // Validate uploaded files
  if (req.files?.length) {
    const fileErrors = req.files.map(f => validateImageFile(f)).filter(r => !r.ok).map(r => r.error)
    if (fileErrors.length) errors.push(...fileErrors)
  }

  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  next()
}

const validateDamageReview = (req, res, next) => {
  const b = req.body
  const errors = []

  if (!b.status || !allowlist(b.status, DAMAGE_STATUSES)) errors.push(`status: must be ${DAMAGE_STATUSES.join(', ')}`)
  if (b.repair_cost !== undefined && b.repair_cost !== null) {
    const c = money(b.repair_cost, 0, 9999999)
    if (c === null) errors.push('repair_cost: invalid amount')
    else b.repair_cost = c
  }
  if (b.review_note)   b.review_note   = str(b.review_note, 1000)
  if (b.deduct_from_da !== undefined) b.deduct_from_da = !!b.deduct_from_da

  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  next()
}

const validateAdvance = (req, res, next) => {
  const b = req.body
  const errors = []

  if (!b.amount) errors.push('amount required')
  if (b.amount !== undefined) {
    const a = money(b.amount, 1, 999999)
    if (a === null) errors.push('amount: must be positive (max 999,999)')
    else b.amount = a
  }
  if (!b.month || !isoMonth(b.month)) errors.push('month: required (YYYY-MM)')
  if (b.deduct_month && !isoMonth(b.deduct_month)) errors.push('deduct_month: invalid (YYYY-MM)')
  if (b.reason) b.reason = str(b.reason, 500)

  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  next()
}

const validateAdvanceAction = (req, res, next) => {
  const { status, review_note } = req.body
  if (!status || !allowlist(status, ADV_STATUSES))
    return res.status(400).json({ error: `status must be: ${ADV_STATUSES.join(', ')}` })
  if (review_note) req.body.review_note = str(review_note, 500)
  next()
}

const validateAnnouncement = (req, res, next) => {
  const { title, body, station_code } = req.body
  const errors = []
  if (!title || !str(title, 200)) errors.push('title: required (max 200 chars)')
  if (!body  || !str(body, 2000)) errors.push('body: required (max 2000 chars)')
  if (station_code && !allowlist(station_code, STATIONS)) errors.push('station_code: invalid')
  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  req.body.title        = str(title, 200)
  req.body.body         = str(body, 2000)
  next()
}

const validateVehicle = (req, res, next) => {
  const b = req.body
  const errors = []
  if (b.plate && !/^[A-Z0-9\s\-]{2,15}$/i.test(b.plate)) errors.push('plate: invalid format (2-15 alphanumeric)')
  if (b.year  && (isNaN(parseInt(b.year)) || parseInt(b.year) < 1990 || parseInt(b.year) > 2030))
    errors.push('year: must be 1990–2030')
  if (b.station_code && !allowlist(b.station_code, STATIONS)) errors.push('station_code: invalid')
  if (b.status && !allowlist(b.status, ['active','grounded','maintenance','inactive'])) errors.push('status: invalid')
  ;['make','model','color','notes'].forEach(k => { if (b[k]) b[k] = str(b[k], 100) })
  if (errors.length) return res.status(400).json({ error: errors.join('; ') })
  next()
}

module.exports = {
  // Primitives (for use inside route handlers)
  sanitize: { str, email, empId, uuid, isoDate, isoMonth, money, positiveInt, allowlist },
  validateImageFile,

  // Express middleware
  validateQuery,
  validateParams,
  validateLogin,
  validateEmployee,
  validateAttendance,
  validateLeave,
  validateLeaveAction,
  validateExpense,
  validatePayrollBonus,
  validatePayrollDeduction,
  validateShift,
  validateDamageReport,
  validateDamageReview,
  validateAdvance,
  validateAdvanceAction,
  validateAnnouncement,
  validateVehicle,

  // Exported allowlists
  ROLES, STATIONS, LEAVE_TYPES, CYCLES, EXP_CATS, DED_TYPES, BON_TYPES, PROJ_TYPES,
}