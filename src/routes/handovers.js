const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const { sendPushToUsers } = require('./notifications')

// Try to load multer (optional)
let multer = null
try { multer = require('multer') } catch(e) { console.log('multer not available - photo upload disabled') }

const upload = multer
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => { if (file.mimetype.startsWith('image/')) cb(null, true); else cb(new Error('Only images')) } })
  : { array: () => (req, res, next) => next() }

function sbCreds() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  return (url && key) ? { url, key } : null
}

const BUCKET        = 'vehicle-photos'
const FILE_SIZE_MAX = 52428800 // 50 MB

// Ensure bucket exists with correct settings — runs at startup
async function ensureBucket() {
  const creds = sbCreds()
  if (!creds) return
  const headers = { Authorization: `Bearer ${creds.key}`, 'Content-Type': 'application/json' }
  const body    = JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: FILE_SIZE_MAX })
  try {
    const r = await fetch(`${creds.url}/storage/v1/bucket`, { method: 'POST', headers, body })
    const d = await r.json()
    const alreadyExists = (d.error || d.message || '').toLowerCase().includes('already exists')
    if (r.ok) {
      console.log('[handovers] vehicle-photos bucket created')
    } else if (alreadyExists) {
      await fetch(`${creds.url}/storage/v1/bucket/${BUCKET}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ public: true, file_size_limit: FILE_SIZE_MAX }),
      })
      console.log('[handovers] vehicle-photos bucket settings updated')
    } else {
      console.warn('[handovers] bucket init:', d.message || d.error)
    }
  } catch (e) { console.warn('[handovers] bucket init failed:', e.message) }
}
ensureBucket().catch(() => {})

async function uploadPhotos(files, handoverId) {
  const creds = sbCreds()
  if (!creds) { console.warn('[handovers] Supabase not configured — photos skipped'); return { urls: [], error: 'Supabase not configured' } }
  if (!files?.length) return { urls: [], error: null }
  const ts = Date.now()
  console.log(`[handovers] uploading ${files.length} photo(s) in parallel for handover ${handoverId}`)

  const results = await Promise.all(
    files.slice(0, 4).map(async (file, i) => {
      const ext     = (file.originalname?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
      const objPath = `handovers/${handoverId}/photo_${i + 1}_${ts}.${ext}`
      try {
        const r = await fetch(`${creds.url}/storage/v1/object/${BUCKET}/${objPath}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${creds.key}`, 'Content-Type': file.mimetype, 'x-upsert': 'true' },
          body: file.buffer,
        })
        if (r.ok) {
          const publicUrl = `${creds.url}/storage/v1/object/public/${BUCKET}/${objPath}`
          console.log(`[handovers] photo ${i + 1} uploaded: ${publicUrl}`)
          return { url: publicUrl, error: null }
        }
        const d = await r.json().catch(() => ({}))
        const msg = d.message || d.error || r.statusText
        console.error(`[handovers] photo ${i + 1} failed (${r.status}):`, msg)
        return { url: null, error: msg }
      } catch (e) {
        console.error(`[handovers] photo ${i + 1} exception:`, e.message)
        return { url: null, error: e.message }
      }
    })
  )

  const urls       = results.map(r => r.url)
  const firstError = results.find(r => r.error)?.error || null
  return { urls, error: firstError }
}

async function deletePhotos(photoUrls) {
  const creds = sbCreds()
  if (!creds) return
  const paths = photoUrls.filter(Boolean).map(url => { const m = url.match(/vehicle-photos\/(.+)/); return m ? m[1] : null }).filter(Boolean)
  if (!paths.length) return
  try {
    await fetch(`${creds.url}/storage/v1/object/vehicle-photos`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${creds.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    })
  } catch (e) { console.warn('[handovers] deletePhotos failed:', e.message) }
}

// GET /api/handovers
router.get('/', auth, async (req, res) => {
  try {
    const { vehicle_id, emp_id, type, limit, station_code, status } = req.query
    let sql = `
      SELECT h.*,
             e.name  AS emp_name,
             r.name  AS receiver_name,
             v.plate AS vehicle_plate, v.make, v.model, v.station_code AS vehicle_station
      FROM vehicle_handovers h
      JOIN employees e ON h.emp_id=e.id
      JOIN vehicles  v ON h.vehicle_id=v.id
      LEFT JOIN employees r ON h.receiver_emp_id=r.id
      WHERE 1=1`
    const vals = []

    if (req.user.role === 'driver') {
      // Drivers see their own handovers (as initiator OR as receiver)
      vals.push(req.user.emp_id)
      sql += ` AND (h.emp_id=$${vals.length} OR h.receiver_emp_id=$${vals.length})`
    } else if (req.user.role === 'poc') {
      vals.push(req.user.station_code); sql += ` AND h.station_code=$${vals.length}`
    } else {
      if (emp_id)       { vals.push(emp_id);       sql += ` AND (h.emp_id=$${vals.length} OR h.receiver_emp_id=$${vals.length})` }
      if (vehicle_id)   { vals.push(vehicle_id);   sql += ` AND h.vehicle_id=$${vals.length}` }
      if (station_code) { vals.push(station_code); sql += ` AND h.station_code=$${vals.length}` }
    }
    if (type)   { vals.push(type);   sql += ` AND h.type=$${vals.length}` }
    if (status) { vals.push(status); sql += ` AND h.status=$${vals.length}` }
    sql += ` ORDER BY h.submitted_at DESC`
    if (limit) sql += ` LIMIT ${parseInt(limit)}`
    const result = await query(sql, vals)
    res.json({ handovers: result.rows })
  } catch (err) { console.error('GET /handovers:', err.message); res.status(500).json({ error: err.message }) }
})

// GET /api/handovers/pending  ← must come BEFORE /:id
// Returns handovers awaiting Driver B's action (accept or complete)
router.get('/pending', auth, async (req, res) => {
  try {
    const emp_id = req.query.emp_id || req.user.emp_id
    // Admins/managers can query any driver's pending; drivers only see their own
    if (req.user.role === 'driver' && emp_id !== req.user.emp_id)
      return res.status(403).json({ error: 'Forbidden' })

    const result = await query(`
      SELECT h.*,
             e.name  AS emp_name,
             r.name  AS receiver_name,
             v.plate AS vehicle_plate, v.make, v.model, v.station_code AS vehicle_station
      FROM vehicle_handovers h
      JOIN employees e ON h.emp_id=e.id
      JOIN vehicles  v ON h.vehicle_id=v.id
      LEFT JOIN employees r ON h.receiver_emp_id=r.id
      WHERE h.receiver_emp_id=$1
        AND h.status IN ('pending_acceptance','accepted','poc_pending')
      ORDER BY h.submitted_at DESC
    `, [emp_id])
    res.json({ pending: result.rows })
  } catch (err) { console.error('GET /handovers/pending:', err.message); res.status(500).json({ error: err.message }) }
})

// GET /api/handovers/current  ← must come BEFORE /:id
router.get('/current', auth, async (req, res) => {
  try {
    const { station_code } = req.query
    let sql = `
      SELECT DISTINCT ON (h.vehicle_id)
             h.*, e.name AS emp_name,
             v.plate, v.make, v.model
      FROM vehicle_handovers h
      JOIN employees e ON h.emp_id=e.id
      JOIN vehicles  v ON h.vehicle_id=v.id
      WHERE h.type='received'
        AND h.status IN ('completed','poc_pending')
        AND NOT EXISTS (
          SELECT 1 FROM vehicle_handovers h2
          WHERE h2.vehicle_id=h.vehicle_id AND h2.type='returned'
          AND h2.submitted_at > h.submitted_at
        )`
    const vals = []
    if (station_code) { vals.push(station_code); sql += ` AND v.station_code=$${vals.length}` }
    sql += ` ORDER BY h.vehicle_id, h.submitted_at DESC`
    const result = await query(sql, vals)
    res.json({ current: result.rows })
  } catch (err) { console.error('GET /handovers/current:', err.message); res.status(500).json({ error: err.message }) }
})

// GET /api/handovers/:id — full detail with photos
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT h.*,
             e.name  AS emp_name,
             r.name  AS receiver_name,
             v.plate AS vehicle_plate, v.make, v.model, v.station_code AS vehicle_station
      FROM vehicle_handovers h
      JOIN employees e ON h.emp_id=e.id
      JOIN vehicles  v ON h.vehicle_id=v.id
      LEFT JOIN employees r ON h.receiver_emp_id=r.id
      WHERE h.id=$1
    `, [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    const h = result.rows[0]
    if (req.user.role === 'driver' && h.emp_id !== req.user.emp_id && h.receiver_emp_id !== req.user.emp_id)
      return res.status(403).json({ error: 'Forbidden' })
    res.json({ handover: h })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/handovers
// type='returned' → two-actor flow: no photos, receiver_emp_id required, status=pending_acceptance
// type='received' → direct flow: 4 photos required, status=completed
router.post('/', auth, upload.array('photos', 4), async (req, res) => {
  try {
    const { vehicle_id, type, odometer, fuel_level, condition_note, handover_to, handover_from, receiver_emp_id } = req.body
    if (!vehicle_id) return res.status(400).json({ error: 'vehicle_id required' })
    if (!type)       return res.status(400).json({ error: 'type required (received or returned)' })

    const emp_id = req.user.emp_id
    if (!emp_id) return res.status(400).json({ error: 'Your account is not linked to an employee record. Ask admin to set your Employee ID in User Accounts.' })

    const veh = await query('SELECT station_code, plate FROM vehicles WHERE id=$1', [vehicle_id])
    if (!veh.rows[0]) return res.status(404).json({ error: 'Vehicle not found' })

    const isReturn = type === 'returned'

    // Two-actor return: photos not allowed from Driver A
    if (isReturn && req.files?.length) {
      return res.status(400).json({ error: 'Photos must be uploaded by the receiving driver, not the returning driver.' })
    }
    // Two-actor return: receiver required
    if (isReturn && !receiver_emp_id) {
      return res.status(400).json({ error: 'receiver_emp_id required for a vehicle return' })
    }
    // Cannot return to yourself
    if (isReturn && receiver_emp_id === emp_id) {
      return res.status(400).json({ error: 'Cannot select yourself as the receiving driver' })
    }
    // Driver B must not already have a vehicle
    if (isReturn && receiver_emp_id) {
      const [activeHO, todayAsgn, receiverEmp] = await Promise.all([
        query(`SELECT v.plate FROM vehicle_handovers h JOIN vehicles v ON h.vehicle_id=v.id
               WHERE h.receiver_emp_id=$1 AND h.status='accepted' LIMIT 1`, [receiver_emp_id]),
        query(`SELECT v.plate FROM vehicle_assignments va JOIN vehicles v ON va.vehicle_id=v.id
               WHERE va.emp_id=$1 AND va.date=CURRENT_DATE LIMIT 1`, [receiver_emp_id]),
        query(`SELECT name FROM employees WHERE id=$1`, [receiver_emp_id]),
      ])
      const plate = activeHO.rows[0]?.plate || todayAsgn.rows[0]?.plate
      if (plate) {
        const name = receiverEmp.rows[0]?.name || 'That driver'
        return res.status(409).json({ error: `${name} already has vehicle ${plate}. They must return it before you can hand over to them.` })
      }
    }
    // Receiving: 4 photos required
    if (!isReturn && (!req.files || req.files.length < 4)) {
      return res.status(400).json({ error: 'Exactly 4 photos are required when receiving a vehicle' })
    }

    const status = isReturn ? 'pending_acceptance' : 'completed'
    const photosExpireAt = new Date()
    photosExpireAt.setDate(photosExpireAt.getDate() + 30)

    let result
    try {
      result = await query(`
        INSERT INTO vehicle_handovers
          (vehicle_id, emp_id, station_code, type, odometer, fuel_level,
           condition_note, handover_to, handover_from, receiver_emp_id, status,
           photos_expire_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
      `, [vehicle_id, emp_id, veh.rows[0].station_code, type,
          odometer||null, fuel_level||null, condition_note||null,
          handover_to||null, handover_from||null,
          isReturn ? receiver_emp_id : null,
          status, photosExpireAt])
    } catch(dbErr) {
      if (dbErr.message.includes('photos_expire_at') || dbErr.message.includes('receiver_emp_id')) {
        result = await query(`
          INSERT INTO vehicle_handovers
            (vehicle_id, emp_id, station_code, type, odometer, fuel_level,
             condition_note, handover_to, handover_from, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING *
        `, [vehicle_id, emp_id, veh.rows[0].station_code, type,
            odometer||null, fuel_level||null, condition_note||null,
            handover_to||null, handover_from||null, status])
      } else throw dbErr
    }

    const handover = result.rows[0]

    // Upload photos for direct-receive flow
    let photoUrls = [], uploadError = null, finalHandover = handover
    if (!isReturn && req.files?.length) {
      const uploadResult = await uploadPhotos(req.files, handover.id)
      photoUrls   = uploadResult.urls
      uploadError = uploadResult.error
      if (photoUrls.filter(Boolean).length > 0) {
        const updated = await query(`
          UPDATE vehicle_handovers
          SET photo_1=$1, photo_2=$2, photo_3=$3, photo_4=$4,
              completed_at=NOW()
          WHERE id=$5 RETURNING *
        `, [photoUrls[0]||null, photoUrls[1]||null, photoUrls[2]||null, photoUrls[3]||null, handover.id])
        finalHandover = updated.rows[0]
      }
    }

    // Broadcast to all so every connected driver refreshes their pending list
    req.io?.emit('handover:created', finalHandover)

    // Notify Driver B specifically when Driver A submits a return
    if (isReturn && receiver_emp_id) {
      try {
        const receiverUser = await query(`SELECT id FROM users WHERE emp_id=$1`, [receiver_emp_id])
        const plate = veh.rows[0]?.plate || finalHandover.vehicle_id
        if (receiverUser.rows[0]) {
          const ruid = receiverUser.rows[0].id
          // Targeted socket events — Driver B definitely gets these even if they were already online
          req.io?.to(`user:${ruid}`).emit('handover:incoming', finalHandover)
          req.io?.to(`emp:${receiver_emp_id}`).emit('handover:incoming', finalHandover)
          await query(`INSERT INTO notifications (user_id, title, body, type, ref_id) VALUES ($1,$2,$3,'handover',$4)`,
            [ruid, 'Vehicle Handover Request',
             `${req.user.name || 'A driver'} wants to hand over ${plate} to you. Tap to accept.`,
             finalHandover.id])
          req.io?.to(`user:${ruid}`).emit('notification:new', {
            title: 'Vehicle Handover Request',
            body: `${req.user.name || 'A driver'} wants to hand over ${plate} to you. Tap to accept.`,
            type: 'handover',
          })
          await sendPushToUsers([ruid], {
            title: 'Vehicle Handover Request',
            body: `${req.user.name || 'A driver'} wants to hand over ${plate} to you. Tap to accept.`,
            url: '/driver',
          })
        } else {
          // No user account linked — still emit to emp room
          req.io?.to(`emp:${receiver_emp_id}`).emit('handover:incoming', finalHandover)
        }
      } catch(e) { console.warn('[handovers] notify receiver failed:', e.message) }
    }

    const photosUploaded = photoUrls.filter(Boolean).length
    const photosWarning = !isReturn && req.files?.length && photosUploaded === 0
      ? `Photos could not be saved: ${uploadError || 'unknown error'}`
      : null
    res.status(201).json({ handover: finalHandover, photos_uploaded: photosUploaded, photos_warning: photosWarning })
  } catch (err) {
    console.error('POST /handovers:', err.message)
    if (err.message.includes('foreign key')) return res.status(400).json({ error: 'Invalid vehicle or employee ID' })
    res.status(500).json({ error: err.message || 'Server error' })
  }
})

// PATCH /api/handovers/:id/accept
// Driver B acknowledges and accepts the pending return
router.patch('/:id/accept', auth, async (req, res) => {
  try {
    const rec = await query('SELECT * FROM vehicle_handovers WHERE id=$1', [req.params.id])
    if (!rec.rows[0]) return res.status(404).json({ error: 'Handover not found' })
    const h = rec.rows[0]

    if (h.status !== 'pending_acceptance')
      return res.status(409).json({ error: `Cannot accept — current status is '${h.status}'` })

    const isAdmin = ['admin','manager','general_manager'].includes(req.user.role)
    if (!isAdmin && h.receiver_emp_id !== req.user.emp_id)
      return res.status(403).json({ error: 'Only the designated receiving driver can accept this handover' })

    const updated = await query(`
      UPDATE vehicle_handovers
      SET status='accepted', accepted_at=NOW(), updated_at=NOW()
      WHERE id=$1 RETURNING *
    `, [req.params.id])

    req.io?.emit('handover:updated', updated.rows[0])
    res.json({ handover: updated.rows[0] })
  } catch (err) { console.error('PATCH /handovers/:id/accept:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// PATCH /api/handovers/:id/reject
// Driver B declines the incoming handover — vehicle stays with Driver A
router.patch('/:id/reject', auth, async (req, res) => {
  try {
    const rec = await query('SELECT * FROM vehicle_handovers WHERE id=$1', [req.params.id])
    if (!rec.rows[0]) return res.status(404).json({ error: 'Handover not found' })
    const h = rec.rows[0]

    if (h.status !== 'pending_acceptance')
      return res.status(409).json({ error: `Cannot reject — current status is '${h.status}'` })

    const isAdmin = ['admin','manager','general_manager'].includes(req.user.role)
    if (!isAdmin && h.receiver_emp_id !== req.user.emp_id)
      return res.status(403).json({ error: 'Only the designated receiving driver can reject this handover' })

    const updated = await query(`
      UPDATE vehicle_handovers
      SET status='rejected', updated_at=NOW()
      WHERE id=$1 RETURNING *
    `, [req.params.id])

    req.io?.emit('handover:updated', updated.rows[0])

    // Notify Driver A that the handover was rejected
    try {
      const senderUser = await query(`SELECT id FROM users WHERE emp_id=$1`, [h.emp_id])
      if (senderUser.rows[0]) {
        const suid = senderUser.rows[0].id
        const plate = h.vehicle_id
        const receiverName = req.user.name || 'The driver'
        await query(`INSERT INTO notifications (user_id, title, body, type, ref_id) VALUES ($1,$2,$3,'handover',$4)`,
          [suid, 'Handover Rejected',
           `${receiverName} declined the handover for vehicle ${plate}. You still have the vehicle.`,
           h.id])
        req.io?.to(`user:${suid}`).emit('notification:new', {
          title: 'Handover Rejected',
          body: `${receiverName} declined the handover for vehicle ${plate}. You still have the vehicle.`,
          type: 'handover',
        })
        await sendPushToUsers([suid], {
          title: 'Handover Rejected',
          body: `${receiverName} declined the handover for vehicle ${plate}. You still have the vehicle.`,
          url: '/driver',
        })
      }
    } catch(e) { console.warn('[handovers] notify sender on reject failed:', e.message) }

    res.json({ handover: updated.rows[0] })
  } catch (err) { console.error('PATCH /handovers/:id/reject:', err.message); res.status(500).json({ error: 'Server error' }) }
})

// PATCH /api/handovers/:id/complete
// Driver B uploads exactly 4 photos and marks the handover complete.
// Also auto-creates a 'received' record for Driver B so their vehicle tracking works.
router.patch('/:id/complete', auth, upload.array('photos', 4), async (req, res) => {
  try {
    const rec = await query('SELECT * FROM vehicle_handovers WHERE id=$1', [req.params.id])
    if (!rec.rows[0]) return res.status(404).json({ error: 'Handover not found' })
    const h = rec.rows[0]

    if (h.status !== 'accepted')
      return res.status(409).json({ error: `Cannot complete — current status is '${h.status}'. Accept first.` })

    const isAdmin = ['admin','manager','general_manager'].includes(req.user.role)
    if (!isAdmin && h.receiver_emp_id !== req.user.emp_id)
      return res.status(403).json({ error: 'Only the designated receiving driver can complete this handover' })

    if (!req.files || req.files.length < 4)
      return res.status(400).json({ error: 'Exactly 4 photos required to complete the handover (front, back, left, right)' })

    const { odometer, fuel_level, condition_note } = req.body

    // Upload Driver B's photos
    const uploadResult = await uploadPhotos(req.files, h.id)
    const photoUrls    = uploadResult.urls
    const uploadError  = uploadResult.error

    // Update the return record to poc_pending (awaiting POC verification) with photos
    let updated
    try {
      updated = await query(`
        UPDATE vehicle_handovers
        SET status='poc_pending', completed_at=NOW(), updated_at=NOW(),
            photo_1=$1, photo_2=$2, photo_3=$3, photo_4=$4,
            odometer=COALESCE($5::integer, odometer),
            fuel_level=COALESCE($6, fuel_level),
            condition_note=COALESCE($7, condition_note)
        WHERE id=$8 RETURNING *
      `, [photoUrls[0]||null, photoUrls[1]||null, photoUrls[2]||null, photoUrls[3]||null,
          odometer||null, fuel_level||null, condition_note||null,
          h.id])
    } catch(dbErr) {
      // completed_at column may not exist on older DB — retry without it
      if (dbErr.message.includes('completed_at')) {
        updated = await query(`
          UPDATE vehicle_handovers
          SET status='poc_pending', updated_at=NOW(),
              photo_1=$1, photo_2=$2, photo_3=$3, photo_4=$4,
              odometer=COALESCE($5::integer, odometer),
              fuel_level=COALESCE($6, fuel_level),
              condition_note=COALESCE($7, condition_note)
          WHERE id=$8 RETURNING *
        `, [photoUrls[0]||null, photoUrls[1]||null, photoUrls[2]||null, photoUrls[3]||null,
            odometer||null, fuel_level||null, condition_note||null,
            h.id])
      } else throw dbErr
    }

    const finalReturn = updated.rows[0]

    // Auto-create a 'received' record for Driver B so findCurrentVehicle works
    const photosExpireAt = new Date()
    photosExpireAt.setDate(photosExpireAt.getDate() + 30)
    let receivedRecord = null
    try {
      const rx = await query(`
        INSERT INTO vehicle_handovers
          (vehicle_id, emp_id, station_code, type, odometer, fuel_level,
           condition_note, handover_from, status,
           photo_1, photo_2, photo_3, photo_4, photos_expire_at, completed_at)
        VALUES ($1,$2,$3,'received',$4,$5,$6,$7,'poc_pending',$8,$9,$10,$11,$12,NOW())
        RETURNING *
      `, [h.vehicle_id, h.receiver_emp_id, h.station_code,
          odometer || h.odometer || null,
          fuel_level || h.fuel_level || null,
          condition_note || null,
          h.emp_id,
          photoUrls[0]||null, photoUrls[1]||null, photoUrls[2]||null, photoUrls[3]||null,
          photosExpireAt])
      receivedRecord = rx.rows[0]
    } catch(e) {
      // Retry without completed_at
      try {
        const rx2 = await query(`
          INSERT INTO vehicle_handovers
            (vehicle_id, emp_id, station_code, type, odometer, fuel_level,
             condition_note, handover_from, status,
             photo_1, photo_2, photo_3, photo_4, photos_expire_at)
          VALUES ($1,$2,$3,'received',$4,$5,$6,$7,'poc_pending',$8,$9,$10,$11,$12)
          RETURNING *
        `, [h.vehicle_id, h.receiver_emp_id, h.station_code,
            odometer || h.odometer || null,
            fuel_level || h.fuel_level || null,
            condition_note || null,
            h.emp_id,
            photoUrls[0]||null, photoUrls[1]||null, photoUrls[2]||null, photoUrls[3]||null,
            photosExpireAt])
        receivedRecord = rx2.rows[0]
      } catch(e2) {
        console.warn('[handovers] auto-create received record failed:', e2.message)
      }
    }

    req.io?.emit('handover:completed', { returned: finalReturn, received: receivedRecord })

    // Notify all POCs at this station
    try {
      const pocUsers = await query(
        `SELECT id FROM users WHERE role='poc' AND station_code=$1 AND status='active'`,
        [h.station_code]
      )
      if (pocUsers.rows.length) {
        const plate = finalReturn.vehicle_plate || h.vehicle_id
        await sendPushToUsers(pocUsers.rows.map(r => r.id), {
          title: 'Vehicle Handover — POC Verification Required',
          body: `${req.user.name || 'Driver B'} completed handover of ${plate}. Tap to approve or reject.`,
          url: '/dashboard/poc/fleet',
        })
        for (const pu of pocUsers.rows) {
          await query(`INSERT INTO notifications (user_id, title, body, type, ref_id) VALUES ($1,$2,$3,'handover',$4)`,
            [pu.id, 'Handover Awaiting Verification',
             `${req.user.name || 'A driver'} completed a vehicle handover. Please verify.`,
             finalReturn.id])
          req.io?.to(`user:${pu.id}`).emit('notification:new', {
            title: 'Handover Awaiting Verification',
            body: `${req.user.name || 'A driver'} completed a vehicle handover. Please verify.`,
            type: 'handover',
          })
        }
      }
    } catch(e) { console.warn('[handovers] notify poc failed:', e.message) }

    const photosWarning = photoUrls.filter(Boolean).length === 0
      ? `Photos could not be saved: ${uploadError || 'unknown error'}`
      : null

    res.json({ handover: finalReturn, received: receivedRecord, photos_warning: photosWarning })
  } catch (err) {
    console.error('PATCH /handovers/:id/complete:', err.message)
    res.status(500).json({ error: err.message || 'Server error' })
  }
})

// PATCH /api/handovers/:id/poc-verify
// POC approves or rejects a completed handover
router.patch('/:id/poc-verify', auth, requireRole('admin','manager','general_manager','poc'), async (req, res) => {
  try {
    const { action } = req.body // 'approve' | 'reject'
    if (!action || !['approve','reject'].includes(action))
      return res.status(400).json({ error: "action must be 'approve' or 'reject'" })

    const rec = await query(`
      SELECT h.*,
             e.name  AS emp_name,
             r.name  AS receiver_name,
             v.plate AS vehicle_plate
      FROM vehicle_handovers h
      JOIN employees e ON h.emp_id=e.id
      JOIN vehicles  v ON h.vehicle_id=v.id
      LEFT JOIN employees r ON h.receiver_emp_id=r.id
      WHERE h.id=$1
    `, [req.params.id])
    if (!rec.rows[0]) return res.status(404).json({ error: 'Handover not found' })
    const h = rec.rows[0]

    if (h.status !== 'poc_pending')
      return res.status(409).json({ error: `Cannot verify — current status is '${h.status}'` })

    if (action === 'approve') {
      // Mark both the return record and the matching received record as completed
      const updated = await query(`
        UPDATE vehicle_handovers SET status='completed', updated_at=NOW() WHERE id=$1 RETURNING *
      `, [h.id])

      // Also complete the auto-created received record for Driver B
      await query(`
        UPDATE vehicle_handovers
        SET status='completed', updated_at=NOW()
        WHERE vehicle_id=$1
          AND emp_id=$2
          AND type='received'
          AND status='poc_pending'
      `, [h.vehicle_id, h.receiver_emp_id])

      req.io?.emit('handover:poc-approved', updated.rows[0])

      // Notify Driver A (initiator of return)
      try {
        const driverAUser = await query(`SELECT id FROM users WHERE emp_id=$1`, [h.emp_id])
        if (driverAUser.rows[0]) {
          await sendPushToUsers([driverAUser.rows[0].id], {
            title: 'Handover Approved',
            body: `Your handover of ${h.vehicle_plate} has been verified and approved.`,
            url: '/driver',
          })
          await query(`INSERT INTO notifications (user_id, title, body, type, ref_id) VALUES ($1,$2,$3,'handover',$4)`,
            [driverAUser.rows[0].id, 'Handover Approved',
             `Your handover of ${h.vehicle_plate} has been approved by POC.`,
             h.id])
          req.io?.to(`user:${driverAUser.rows[0].id}`).emit('notification:new', {
            title: 'Handover Approved',
            body: `Your handover of ${h.vehicle_plate} has been approved by POC.`,
            type: 'handover',
          })
        }
      } catch(e) { console.warn('[handovers] notify driver A on approve:', e.message) }

      return res.json({ handover: updated.rows[0], action: 'approved' })
    }

    // action === 'reject'
    // Delete Driver B's auto-created received record and revert return to 'rejected'
    await query(`
      DELETE FROM vehicle_handovers
      WHERE vehicle_id=$1 AND emp_id=$2 AND type='received' AND status='poc_pending'
    `, [h.vehicle_id, h.receiver_emp_id])

    const updated = await query(`
      UPDATE vehicle_handovers SET status='rejected', updated_at=NOW() WHERE id=$1 RETURNING *
    `, [h.id])

    req.io?.emit('handover:poc-rejected', updated.rows[0])

    // Notify Driver A that handover was rejected — vehicle is still theirs
    try {
      const driverAUser = await query(`SELECT id FROM users WHERE emp_id=$1`, [h.emp_id])
      if (driverAUser.rows[0]) {
        await sendPushToUsers([driverAUser.rows[0].id], {
          title: 'Handover Rejected by POC',
          body: `Your handover of ${h.vehicle_plate} was rejected. The vehicle remains assigned to you.`,
          url: '/driver',
        })
        await query(`INSERT INTO notifications (user_id, title, body, type, ref_id) VALUES ($1,$2,$3,'handover',$4)`,
          [driverAUser.rows[0].id, 'Handover Rejected',
           `Your handover of ${h.vehicle_plate} was rejected by POC. Vehicle is still yours.`,
           h.id])
        req.io?.to(`user:${driverAUser.rows[0].id}`).emit('notification:new', {
          title: 'Handover Rejected',
          body: `Your handover of ${h.vehicle_plate} was rejected. Vehicle is still yours.`,
          type: 'handover',
        })
      }
    } catch(e) { console.warn('[handovers] notify driver A on reject:', e.message) }

    res.json({ handover: updated.rows[0], action: 'rejected' })
  } catch (err) {
    console.error('PATCH /handovers/:id/poc-verify:', err.message)
    res.status(500).json({ error: err.message || 'Server error' })
  }
})

// DELETE /api/handovers/:id
router.delete('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const rec = await query('SELECT photo_1,photo_2,photo_3,photo_4 FROM vehicle_handovers WHERE id=$1', [req.params.id])
    if (rec.rows[0]) await deletePhotos([rec.rows[0].photo_1, rec.rows[0].photo_2, rec.rows[0].photo_3, rec.rows[0].photo_4])
    await query('DELETE FROM vehicle_handovers WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
