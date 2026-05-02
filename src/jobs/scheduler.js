const { query } = require('../db/pool')

async function runPhotoCleanup() {
  try {
    let createClient
    try { createClient = require('@supabase/supabase-js').createClient } catch(e) { return }
    const expired = await query(`
      SELECT id, photo_1, photo_2, photo_3, photo_4
      FROM vehicle_handovers
      WHERE photos_expire_at < NOW() AND photos_cleaned = false
        AND (photo_1 IS NOT NULL OR photo_2 IS NOT NULL OR photo_3 IS NOT NULL OR photo_4 IS NOT NULL)
    `)
    if (!expired.rows.length) return
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY
    if (!supabaseUrl || !supabaseKey) return
    const supabase = createClient(supabaseUrl, supabaseKey)
    for (const row of expired.rows) {
      const paths = [row.photo_1, row.photo_2, row.photo_3, row.photo_4]
        .filter(Boolean)
        .map(url => { const m = url.match(/vehicle-photos\/(.+)/); return m ? m[1] : null })
        .filter(Boolean)
      if (paths.length) await supabase.storage.from('vehicle-photos').remove(paths)
      await query(
        `UPDATE vehicle_handovers SET photo_1=NULL,photo_2=NULL,photo_3=NULL,photo_4=NULL,photos_cleaned=true,updated_at=NOW() WHERE id=$1`,
        [row.id]
      )
    }
    console.log(`Cleanup: removed photos from ${expired.rows.length} handovers`)
  } catch(e) { console.error('Cleanup error:', e.message) }
}

async function runTaskReminders() {
  try {
    const { sendPushToUsers } = require('../routes/notifications')
    const result = await query(`
      SELECT t.id, t.title, t.deadline, t.due_at, t.assigned_to
      FROM tasks t
      WHERE t.status != 'completed'
        AND t.assigned_to IS NOT NULL
        AND (
          t.last_reminder_sent_at IS NULL
          OR t.last_reminder_sent_at < NOW() - INTERVAL '5 hours'
        )
    `)
    for (const task of result.rows) {
      try {
        const uid = String(task.assigned_to)
        const due = task.due_at
          ? new Date(task.due_at).toLocaleString('en-AE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : (task.deadline?.slice ? task.deadline.slice(0, 10) : task.deadline)

        await query(
          `INSERT INTO notifications (user_id, title, body, type, ref_id) VALUES ($1::uuid, $2, $3, 'task', $4::uuid)`,
          [uid, `⏰ Task Reminder: ${task.title}`, `Due ${due} — Task still pending`, task.id]
        )
        await sendPushToUsers([uid], {
          title: '⏰ Task Reminder',
          body:  `${task.title} — Due ${due}`,
          url:   '/dashboard/tasks',
        }).catch(() => {})
        await query(`UPDATE tasks SET last_reminder_sent_at = NOW() WHERE id=$1`, [task.id])
      } catch(e) { console.warn(`Reminder failed for task ${task.id}:`, e.message) }
    }
    if (result.rows.length > 0) console.log(`Task reminders: sent ${result.rows.length}`)
  } catch(e) {
    if (!e.message?.includes('does not exist')) console.error('Task reminder error:', e.message)
  }
}

function start() {
  runPhotoCleanup()
  setInterval(runPhotoCleanup, 24 * 60 * 60 * 1000)
  runTaskReminders()
  setInterval(runTaskReminders, 60 * 60 * 1000)
}

module.exports = { start, runPhotoCleanup, runTaskReminders }
