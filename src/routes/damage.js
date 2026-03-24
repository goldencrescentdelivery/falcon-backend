const router  = require('express').Router()
const { query } = require('../db/pool')
const { auth, requireRole } = require('../middleware/auth')
const V = require('../middleware/validate')
let multer
try { multer = require('multer') } catch(e) {}
let createClient
try { createClient = require('@supabase/supabase-js').createClient } catch(e) {}

const upload = multer ? multer({ storage: multer.memoryStorage(), limits:{ fileSize:10*1024*1024 } }) : { array: () => (req,res,next) => next() }

async function uploadPhoto(file, reportId, idx) {
  if (!createClient) return null
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const ext  = file.originalname.split('.').pop()||'jpg'
  const path = `damage/${reportId}/photo_${idx}_${Date.now()}.${ext}`
  const { error } = await supabase.storage.from('vehicle-photos').upload(path, file.buffer, { contentType:file.mimetype, upsert:true })
  if (error) return null
  const { data } = supabase.storage.from('vehicle-photos').getPublicUrl(path)
  return data.publicUrl
}

router.get('/', auth, async (req, res) => {
  try {
    const { vehicle_id, status } = req.query
    let sql = `SELECT d.*, e.name AS emp_name, v.plate, v.make, v.model
               FROM damage_reports d JOIN employees e ON d.emp_id=e.id JOIN vehicles v ON d.vehicle_id=v.id WHERE 1=1`
    const vals = []
    if (req.user.role === 'driver') { vals.push(req.user.emp_id); sql += ` AND d.emp_id=$${vals.length}` }
    if (vehicle_id) { vals.push(vehicle_id); sql += ` AND d.vehicle_id=$${vals.length}` }
    if (status) { vals.push(status); sql += ` AND d.status=$${vals.length}` }
    sql += ' ORDER BY d.reported_at DESC'
    const result = await query(sql, vals)
    res.json({ reports: result.rows })
  } catch(err) { res.status(500).json({ error:'Server error' }) }
})

router.post('/', auth, upload.array('photos',4), V.validateDamageReport, async (req, res) => {
  try {
    const { vehicle_id, description, severity, station_code } = req.body
    const emp_id = req.user.emp_id || req.body.emp_id
    if (!vehicle_id||!description) return res.status(400).json({ error:'vehicle_id and description required' })
    const result = await query(`
      INSERT INTO damage_reports (vehicle_id, emp_id, station_code, description, severity, status)
      VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *
    `, [vehicle_id, emp_id, station_code||null, description, severity||'minor'])
    const report = result.rows[0]
    if (req.files?.length) {
      const urls = await Promise.all(req.files.slice(0,4).map((f,i)=>uploadPhoto(f,report.id,i+1)))
      await query(`UPDATE damage_reports SET photo_1=$1,photo_2=$2,photo_3=$3,photo_4=$4 WHERE id=$5`,
        [urls[0]||null,urls[1]||null,urls[2]||null,urls[3]||null,report.id])
    }
    res.status(201).json({ report })
  } catch(err) { console.error(err); res.status(500).json({ error:'Server error' }) }
})

router.patch('/:id/review', auth, V.validateParams({ id: 'uuid' }), V.validateDamageReview, requireRole('admin','manager','poc'), async (req, res) => {
  try {
    const { status, review_note, repair_cost, deduct_from_da } = req.body
    const result = await query(`
      UPDATE damage_reports SET status=$1, review_note=$2, repair_cost=$3,
        deduct_from_da=$4, reviewed_by=$5 WHERE id=$6 RETURNING *
    `, [status, review_note||null, repair_cost||null, deduct_from_da||false, req.user.id, req.params.id])
    res.json({ report: result.rows[0] })
  } catch(err) { res.status(500).json({ error:'Server error' }) }
})

module.exports = router