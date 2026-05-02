const { query } = require('../db/pool')

class BaseRepository {
  constructor(table) {
    this.table = table
  }

  async findById(id) {
    const result = await query(`SELECT * FROM ${this.table} WHERE id=$1`, [id])
    return result.rows[0] || null
  }

  async deleteById(id) {
    await query(`DELETE FROM ${this.table} WHERE id=$1`, [id])
  }

  // Exposes raw query for subclasses that need complex SQL
  async query(sql, params) {
    return query(sql, params)
  }
}

module.exports = BaseRepository
