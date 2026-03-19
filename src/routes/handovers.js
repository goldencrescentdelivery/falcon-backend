const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const multer  = require('multer')
const { createClient } = require('@supabase/supabase-js')

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('Only images allowed'))
  }
})

async function uploadPhotos(files, handoverId) {
  const supabase = getSupabase()
  if (!supabase || !files?.length) return []
  const urls = []
  for (let i = 0; i < Math.min(files.length, 4); i++) {
    const file = files[i]
    const ext  = file.originalname.split('.').pop() || 'jpg'
    const path = `handovers/${handoverId}/photo_${i+1}_${Date.now()}.${ext}`
    const { error } = await supabase.storage
      .from('vehicle-photos')
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: true })
    if (!error) {
      const { data } = supabase.storage.from('vehicle-photos').getPublicUrl(path)
      urls.push(data.publicUrl)
    } else {
      console.error('Upload error:', error.message)
      urls.push(null)
    }
  }
  return urls
}

// Delete photos from Supabase Storage
async function deletePhotos(photoUrls) {
  const supabase = getSupabase()
  if (!supabase) return
  const paths = photoUrls
    .filter(Boolean)
    .map(url => {
      // Extract path from URL: .../storage/v1/object/public/vehicle-photos/PATH
      const match = url.match(/vehicle-photos\/(.+)/)
      return match ? match[1] : null
    })
    .filter(Boolean)
  if (paths.length) {
    const { error } = await supabase.storage.from('vehicle-photos').remove(paths)
    if (error) console.error('Delete photos error:', error.message)
    else console.log(`🗑 Deleted ${paths.length} photos from storage`)
  }
}

// GET /api/handovers
router.get('/', auth, async (req, res) => {
  try {
    const { vehicle_id, emp_id, type, limit } = req.query
    let sql = `
      SELECT h.*,
             e.name  AS emp_name,  e.avatar AS emp_avatar,
             v.plate AS vehicle_plate, v.make, v.model,
             et.name AS handover_to_name,
             ef.name AS handover_from_name
      FROM vehicle_handovers h
      JOIN employees e  ON h.emp_id=e.id
      JOIN vehicles  v  ON h.vehicle_id=v.id
      LEFT JOIN employees et ON h.handover_to=et.id
      LEFT JOIN employees ef ON h.handover_from=ef.id
      WHERE 1=1`
    const vals = []
    if (req.user.role === 'driver') {
      vals.push(req.user.emp_id); sql += ` AND h.emp_id=$${vals.length}`
    } else {
      if (emp_id)     { vals.push(emp_id);     sql += ` AND h.emp_id=$${vals.length}` }
      if (vehicle_id) { vals.push(vehicle_id); sql += ` AND h.vehicle_id=$${vals.length}` }
    }
    if (type) { vals.push(type); sql += ` AND h.type=$${vals.length}` }
    sql += ` ORDER BY h.submitted_at DESC`
    if (limit) sql += ` LIMIT ${parseInt(limit)}`
    const result = await query(sql, vals)
    res.json({ handovers: result.rows })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }) }
})

// GET /api/handovers/current
router.get('/current', auth, async (req, res) => {
  try {
    const { station_code } = req.query
    let sql = `
      SELECT DISTINCT ON (h.vehicle_id)
             h.*, e.name AS emp_name, e.avatar AS emp_avatar,
             v.plate, v.make, v.model, v.status AS vehicle_status
      FROM vehicle_handovers h
      JOIN employees e ON h.emp_id=e.id
      JOIN vehicles  v ON h.vehicle_id=v.id
      WHERE h.type='received'
        AND NOT EXISTS (
          SELECT 1 FROM vehicle_handovers h2
          WHERE h2.vehicle_id=h.vehicle_id
            AND h2.type='returned'
            AND h2.submitted_at > h.submitted_at
        )`
    const vals = []
    if (station_code) { vals.push(station_code); sql += ` AND v.station_code=$${vals.length}` }
    sql += ` ORDER BY h.vehicle_id, h.submitted_at DESC`
    const result = await query(sql, vals)
    res.json({ current: result.rows })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

// POST /api/handovers
router.post('/', auth, upload.array('photos', 4), async (req, res) => {
  try {
    const { vehicle_id, type, odometer, fuel_level, condition_note, handover_to, handover_from } = req.body
    if (!vehicle_id || !type) return res.status(400).json({ error: 'vehicle_id and type required' })
    const emp_id = req.user.emp_id
    if (!emp_id) return res.status(400).json({ error: 'Account not linked to employee record' })

    const veh = await query('SELECT station_code FROM vehicles WHERE id=$1', [vehicle_id])
    if (!veh.rows[0]) return res.status(404).json({ error: 'Vehicle not found' })

    // Set photos_expire_at = 30 days from now
    const photosExpireAt = new Date()
    photosExpireAt.setDate(photosExpireAt.getDate() + 30)

    const result = await query(`
      INSERT INTO vehicle_handovers
        (vehicle_id, emp_id, station_code, type, odometer, fuel_level,
         condition_note, handover_to, handover_from, status, photos_expire_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10)
      RETURNING *
    `, [vehicle_id, emp_id, veh.rows[0].station_code, type,
        odometer||null, fuel_level||null, condition_note||null,
        handover_to||null, handover_from||null, photosExpireAt])

    const handover = result.rows[0]
    let photoUrls = []

    if (req.files?.length) {
      photoUrls = await uploadPhotos(req.files, handover.id)
      await query(`
        UPDATE vehicle_handovers SET photo_1=$1, photo_2=$2, photo_3=$3, photo_4=$4 WHERE id=$5
      `, [photoUrls[0]||null, photoUrls[1]||null, photoUrls[2]||null, photoUrls[3]||null, handover.id])
    }

    const final = await query('SELECT * FROM vehicle_handovers WHERE id=$1', [handover.id])
    req.io?.emit('handover:created', final.rows[0])
    res.status(201).json({ handover: final.rows[0], photos: photoUrls })
  } catch (err) {
    console.error('Handover error:', err)
    res.status(500).json({ error: err.message || 'Server error' })
  }
})

// POST /api/handovers/cleanup — called by cron/scheduler to delete expired photos
router.post('/cleanup', auth, requireRole('admin'), async (req, res) => {
  try {
    // Find all handovers with expired photos that haven't been cleaned yet
    const expired = await query(`
      SELECT id, photo_1, photo_2, photo_3, photo_4
      FROM vehicle_handovers
      WHERE photos_expire_at IS NOT NULL
        AND photos_expire_at < NOW()
        AND photos_cleaned = false
        AND (photo_1 IS NOT NULL OR photo_2 IS NOT NULL OR photo_3 IS NOT NULL OR photo_4 IS NOT NULL)
    `)

    if (!expired.rows.length) {
      return res.json({ message: 'No expired photos to clean', cleaned: 0 })
    }

    let cleaned = 0
    for (const row of expired.rows) {
      const urls = [row.photo_1, row.photo_2, row.photo_3, row.photo_4].filter(Boolean)
      await deletePhotos(urls)
      await query(`
        UPDATE vehicle_handovers
        SET photo_1=NULL, photo_2=NULL, photo_3=NULL, photo_4=NULL,
            photos_cleaned=true, updated_at=NOW()
        WHERE id=$1
      `, [row.id])
      cleaned++
    }

    console.log(`🧹 Photo cleanup: deleted photos from ${cleaned} handovers`)
    res.json({ message: `Cleaned photos from ${cleaned} handovers`, cleaned })
  } catch (err) {
    console.error('Cleanup error:', err)
    res.status(500).json({ error: 'Cleanup failed' })
  }
})

// DELETE /api/handovers/:id
router.delete('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const rec = await query('SELECT photo_1,photo_2,photo_3,photo_4 FROM vehicle_handovers WHERE id=$1', [req.params.id])
    if (rec.rows[0]) {
      await deletePhotos([rec.rows[0].photo_1, rec.rows[0].photo_2, rec.rows[0].photo_3, rec.rows[0].photo_4])
    }
    await query('DELETE FROM vehicle_handovers WHERE id=$1', [req.params.id])
    res.json({ message: 'Deleted' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router