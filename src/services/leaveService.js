const leaveRepo    = require('../repositories/leaveRepository')
const employeeRepo = require('../repositories/employeeRepository')
const { withTransaction }   = require('../lib/transaction')
const AppError              = require('../lib/AppError')
const workflow              = require('./workflow')
const { query }             = require('../db/pool')

// sendPushToUsers lives in routes/notifications — it's a pure utility
// that will eventually move to a notificationService
const { sendPushToUsers }   = require('../routes/notifications')

const leaveService = {

  async list(filters, user) {
    return leaveRepo.findAll({
      role:         user.role,
      emp_id:       user.role === 'driver' ? user.emp_id : filters.emp_id,
      station_code: user.station_code,
      status:       filters.status,
      stage:        filters.stage,
    })
  },

  async create(data, user) {
    const emp_id = user.role === 'driver' ? user.emp_id : data.emp_id
    const leave  = await leaveRepo.create({ ...data, emp_id })
    workflow.createInstance('leave_approval', 'leave', leave.id)
      .catch(e => console.error('[workflow] createInstance:', e.message))
    return leave
  },

  async pocApprove(id, status, user) {
    if (user.role === 'poc') {
      const check = await query(`
        SELECT l.id FROM leaves l JOIN employees e ON l.emp_id=e.id
        WHERE l.id=$1 AND e.station_code=$2
      `, [id, user.station_code])
      if (!check.rows[0]) throw new AppError('Not your station', 403, 'FORBIDDEN')
    }

    const leave = await leaveRepo.updatePocStatus(id, status, user.id, user.station_code)
    if (!leave) throw new AppError('Leave not found', 404, 'NOT_FOUND')

    workflow.advance('leave', id, user.role, status, user)
      .catch(e => console.error('[workflow] advance POC:', e.message))
    return leave
  },

  async managerApprove(id, status, user) {
    const check = await leaveRepo.checkPocStatus(id)
    if (!check) throw new AppError('Leave not found', 404, 'NOT_FOUND')
    if (check.poc_status !== 'approved')
      throw new AppError('POC must approve before manager can act', 400, 'INVALID_STAGE')

    const leave = await leaveRepo.updateManagerStatus(id, status, user.id)
    if (!leave) throw new AppError('Leave not found', 404, 'NOT_FOUND')

    workflow.advance('leave', id, user.role, status, user)
      .catch(e => console.error('[workflow] advance manager:', e.message))

    if (status === 'approved') {
      const emp    = await employeeRepo.findByName(leave.emp_id)
      const admins = await employeeRepo.findActiveAdmins()
      sendPushToUsers(admins.map(r => r.id), {
        title: '✅ Leave Awaiting Final Approval',
        body:  `${emp?.name || leave.emp_id}'s leave has been approved by POC & Manager — your approval required`,
        url:   '/dashboard/hr/leaves',
      }).catch(() => {})
    }
    return leave
  },

  async adminApprove(id, status, user) {
    const check = await leaveRepo.checkHrStatus(id)
    if (!check) throw new AppError('Leave not found', 404, 'NOT_FOUND')
    if (check.hr_status !== 'approved')
      throw new AppError('Manager must approve before admin can act', 400, 'INVALID_STAGE')

    const leave = await withTransaction(async (client) => {
      const l = await leaveRepo.finalizeAdmin(id, status, user.id, client)
      if (!l) throw new AppError('Leave not found', 404, 'NOT_FOUND')
      if (status === 'approved' && l.type === 'Annual' && l.days > 0) {
        await client.query(
          `UPDATE employees SET annual_leave_balance = GREATEST(0, annual_leave_balance - $1) WHERE id=$2`,
          [l.days, l.emp_id]
        )
      }
      return l
    })

    workflow.advance('leave', id, user.role, status, user)
      .catch(e => console.error('[workflow] advance admin:', e.message))
    return leave
  },

  async remove(id) {
    await leaveRepo.deleteById(id)
    workflow.deleteForEntity('leave', id)
      .catch(e => console.error('[workflow] delete:', e.message))
  },
}

module.exports = leaveService
