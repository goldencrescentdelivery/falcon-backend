const BaseRepository = require('./base')
const { query }      = require('../db/pool')

class LeaveRepository extends BaseRepository {
  constructor() { super('leaves') }

  // All joins needed for list views
  async findAll({ role, emp_id, station_code, status, stage } = {}) {
    let sql = `
      SELECT l.*, e.name, e.avatar, e.station_code,
             u1.name AS poc_approver_name,
             u2.name AS mgr_approver_name,
             u3.name AS admin_approver_name
      FROM leaves l
      JOIN employees e ON l.emp_id=e.id
      LEFT JOIN users u1 ON l.poc_id=u1.id
      LEFT JOIN users u2 ON l.hr_id=u2.id
      LEFT JOIN users u3 ON l.mgr_id=u3.id
      WHERE 1=1`
    const vals = []

    if (role === 'driver') {
      vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}`
    } else if (role === 'poc') {
      vals.push(station_code); sql += ` AND e.station_code=$${vals.length}`
      if (stage === 'pending')     sql += ` AND l.poc_status='pending'`
      else if (status)           { vals.push(status); sql += ` AND l.status=$${vals.length}` }
    } else if (role === 'manager') {
      if (emp_id) { vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}` }
      if (stage === 'pending')     sql += ` AND l.poc_status='approved' AND l.hr_status NOT IN ('approved','rejected')`
      else if (status)           { vals.push(status); sql += ` AND l.status=$${vals.length}` }
    } else {
      if (emp_id) { vals.push(emp_id); sql += ` AND l.emp_id=$${vals.length}` }
      if (stage === 'pending')     sql += ` AND l.hr_status='approved' AND l.mgr_status NOT IN ('approved','rejected')`
      else if (status)           { vals.push(status); sql += ` AND l.status=$${vals.length}` }
    }

    sql += ' ORDER BY l.created_at DESC'
    const result = await query(sql, vals)
    return result.rows
  }

  async create({ emp_id, type, from_date, to_date, days, reason }) {
    const result = await query(`
      INSERT INTO leaves (emp_id, type, from_date, to_date, days, reason, poc_status, hr_status, mgr_status)
      VALUES ($1,$2,$3,$4,$5,$6,'pending','pending','pending') RETURNING *
    `, [emp_id, type, from_date, to_date, days, reason || null])
    return result.rows[0]
  }

  async checkPocStatus(id) {
    const result = await query(`SELECT poc_status FROM leaves WHERE id=$1`, [id])
    return result.rows[0] || null
  }

  async checkHrStatus(id) {
    const result = await query(`SELECT hr_status FROM leaves WHERE id=$1`, [id])
    return result.rows[0] || null
  }

  async updatePocStatus(id, status, userId, stationCode) {
    const result = await query(`
      UPDATE leaves SET
        poc_status      = $1,
        poc_id          = $2,
        poc_station     = $3,
        approved_by_poc = $2,
        hr_status       = CASE WHEN $1='approved' THEN 'pending' ELSE hr_status END,
        status          = CASE WHEN $1='rejected' THEN 'rejected' ELSE status END,
        updated_at      = NOW()
      WHERE id=$4 RETURNING *
    `, [status, userId, stationCode || null, id])
    return result.rows[0] || null
  }

  async updateManagerStatus(id, status, userId) {
    const result = await query(`
      UPDATE leaves SET
        hr_status  = $1,
        hr_id      = $2,
        mgr_status = CASE WHEN $1='approved' THEN 'pending' ELSE mgr_status END,
        status     = CASE WHEN $1='rejected' THEN 'rejected' ELSE status END,
        updated_at = NOW()
      WHERE id=$3 RETURNING *
    `, [status, userId, id])
    return result.rows[0] || null
  }

  // Called inside an existing transaction — accepts a pg client, not pool
  async finalizeAdmin(id, status, userId, client) {
    const result = await client.query(`
      UPDATE leaves SET
        mgr_status = $1,
        mgr_id     = $2,
        status     = $1,
        updated_at = NOW()
      WHERE id=$3 RETURNING *
    `, [status, userId, id])
    return result.rows[0] || null
  }
}

module.exports = new LeaveRepository()
