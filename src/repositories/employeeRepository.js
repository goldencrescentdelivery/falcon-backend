const BaseRepository = require('./base')
const { query }      = require('../db/pool')

class EmployeeRepository extends BaseRepository {
  constructor() { super('employees') }

  // Batch-fetch by IDs — used by attendance bulk and payroll to avoid N+1
  async findManyByIds(ids) {
    if (!ids.length) return []
    const result = await query(
      'SELECT id, hourly_rate, station_code FROM employees WHERE id = ANY($1::text[])',
      [ids]
    )
    return result.rows
  }

  // Returns a Map<id, employee> for O(1) lookup in loop-heavy routes
  async mapByIds(ids) {
    const rows = await this.findManyByIds(ids)
    return new Map(rows.map(e => [e.id, e]))
  }

  async findByName(id) {
    const result = await query(`SELECT name FROM employees WHERE id=$1`, [id])
    return result.rows[0] || null
  }

  async findActiveAdmins() {
    const result = await query(
      `SELECT id FROM users WHERE role IN ('admin','general_manager') AND status='active'`
    )
    return result.rows
  }
}

module.exports = new EmployeeRepository()
