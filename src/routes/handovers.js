const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')

// Try to load optional dependencies
let multer = null
let createClient = null
try { multer = require('multer') } catch(e) { console.log('multer not available - photo upload disabled') }
try { createClient = require('@supabase/supabase-js').createClient } catch(e) { console.log('supabase not available') }

// Setup multer if available
const upload = multer
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => { if (file.mimetype.startsWith('image/')) cb(null, true); else cb(new Error('Only images')) } })
  : { array: () => (req, res, next) => next() }  // no-op middleware

function getSupabase() {
  if (!createClient) return null
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

async function uploadPhotos(files, handoverId) {
  const supabase = getSupabase()
  if (!supabase || !files?.length) return []
  const urls = []
  for (let i = 0; i < Math.min(files.length, 4); i++) {
    const file = files[i]
    const ext  = file.originalname?.split('.').pop() || 'jpg'
    const path = `handovers/${handoverId}/photo_${i+1}_${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('vehicle-photos').upload(path, file.buffer, { contentType: file.mimetype, upsert: true })
    if (!error) {
      const { data } = supabase.storage.from('vehicle-photos').getPublicUrl(path)
      urls.push(data.publicUrl)
    } else {
      console.error('Photo upload error:', error.message)
      urls.push(null)
    }
  }
  return urls
}

async function deletePhotos(photoUrls) {
  const supabase = getSupabase()
  if (!supabase) return
  const paths = photoUrls.filter(Boolean).map(url => { const m=url.match(/vehicle-photos\/(.+)/); return m?m[1]:null }).filter(Boolean)
  if (paths.length) await supabase.storage.from('vehicle-photos').remove(paths)
}

// GET /api/handovers
router.get('/', auth, async (req, res) => {
  try {
    const { vehicle_id, emp_id, type, limit, station_code } = req.query
    let sql = `
      SELECT h.*,
             e.name  AS emp_name,
             v.plate AS vehicle_plate, v.make, v.model, v.station_code AS vehicle_station
      FROM vehicle_handovers h
      JOIN employees e ON h.emp_id=e.id
      JOIN vehicles  v ON h.vehicle_id=v.id
      WHERE 1=1`
    const vals = []

    if (req.user.role === 'driver') {
      vals.push(req.user.emp_id); sql += ` AND h.emp_id=$${vals.length}`
    } else if (req.user.role === 'poc') {
      vals.push(req.user.station_code); sql += ` AND h.station_code=$${vals.length}`
    } else {
      // admin / general_manager / manager / accountant — full visibility
      if (emp_id)       { vals.push(emp_id);       sql += ` AND h.emp_id=$${vals.length}` }
      if (vehicle_id)   { vals.push(vehicle_id);   sql += ` AND h.vehicle_id=$${vals.length}` }
      if (station_code) { vals.push(station_code); sql += ` AND h.station_code=$${vals.length}` }
    }
    if (type) { vals.push(type); sql += ` AND h.type=$${vals.length}` }
    sql += ` ORDER BY h.submitted_at DESC`
    if (limit) sql += ` LIMIT ${parseInt(limit)}`
    const result = await query(sql, vals)
    res.json({ handovers: result.rows })
  } catch (err) { console.error('GET /handovers:', err.message); res.status(500).json({ error: err.message }) }
})

// GET /api/handovers/:id — full detail with photos
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT h.*,
             e.name  AS emp_name,
             v.plate AS vehicle_plate, v.make, v.model, v.station_code AS vehicle_station
      FROM vehicle_handovers h
      JOIN employees e ON h.emp_id=e.id
      JOIN vehicles  v ON h.vehicle_id=v.id
      WHERE h.id=$1
    `, [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    const h = result.rows[0]
    // Drivers can only see their own
    if (req.user.role === 'driver' && h.emp_id !== req.user.emp_id)
      return res.status(403).json({ error: 'Forbidden' })
    res.json({ handover: h })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// GET /api/handovers/current
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

// POST /api/handovers
router.post('/', auth, upload.array('photos', 4), async (req, res) => {
  try {
    const { vehicle_id, type, odometer, fuel_level, condition_note, handover_to, handover_from } = req.body
    if (!vehicle_id) return res.status(400).json({ error: 'vehicle_id required' })
    if (!type)       return res.status(400).json({ error: 'type required (received or returned)' })

    const emp_id = req.user.emp_id
    if (!emp_id) return res.status(400).json({ error: 'Your account is not linked to an employee record. Ask admin to set your Employee ID in User Accounts.' })

    const veh = await query('SELECT station_code FROM vehicles WHERE id=$1', [vehicle_id])
    if (!veh.rows[0]) return res.status(404).json({ error: 'Vehicle not found' })

    const photosExpireAt = new Date()
    photosExpireAt.setDate(photosExpireAt.getDate() + 30)

    // Insert record
    let result
    try {
      result = await query(`
        INSERT INTO vehicle_handovers
          (vehicle_id, emp_id, station_code, type, odometer, fuel_level,
           condition_note, handover_to, handover_from, status, photos_expire_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10)
        RETURNING *
      `, [vehicle_id, emp_id, veh.rows[0].station_code, type,
          odometer||null, fuel_level||null, condition_note||null,
          handover_to||null, handover_from||null, photosExpireAt])
    } catch(dbErr) {
      // Try without photos_expire_at if column doesn't exist
      if (dbErr.message.includes('photos_expire_at')) {
        result = await query(`
          INSERT INTO vehicle_handovers
            (vehicle_id, emp_id, station_code, type, odometer, fuel_level,
             condition_note, handover_to, handover_from, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted')
          RETURNING *
        `, [vehicle_id, emp_id, veh.rows[0].station_code, type,
            odometer||null, fuel_level||null, condition_note||null,
            handover_to||null, handover_from||null])
      } else throw dbErr
    }

    const handover = result.rows[0]

    // Upload photos if available
    let photoUrls = []
    if (req.files?.length) {
      photoUrls = await uploadPhotos(req.files, handover.id)
      if (photoUrls.filter(Boolean).length > 0) {
        await query(`
          UPDATE vehicle_handovers SET photo_1=$1,photo_2=$2,photo_3=$3,photo_4=$4 WHERE id=$5
        `, [photoUrls[0]||null, photoUrls[1]||null, photoUrls[2]||null, photoUrls[3]||null, handover.id])
      }
    }

    const final = await query('SELECT * FROM vehicle_handovers WHERE id=$1', [handover.id])
    req.io?.emit('handover:created', final.rows[0])
    res.status(201).json({ handover: final.rows[0] })
  } catch (err) {
    console.error('POST /handovers:', err.message)
    if (err.message.includes('foreign key')) return res.status(400).json({ error: 'Invalid vehicle or employee ID' })
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