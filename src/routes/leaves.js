const router       = require('express').Router()
const { auth, requireRole } = require('../middleware/auth')
const V            = require('../middleware/validate')
const asyncHandler = require('../lib/asyncHandler')
const AppError     = require('../lib/AppError')
const leaveService = require('../services/leaveService')

router.get('/', auth, asyncHandler(async (req, res) => {
  const leaves = await leaveService.list(req.query, req.user)
  res.json({ leaves })
}))

router.post('/', auth, V.validateLeave, asyncHandler(async (req, res) => {
  const leave = await leaveService.create(req.body, req.user)
  req.io?.emit('leave:created', leave)
  res.status(201).json({ leave })
}))

// Step 1 — POC approves/rejects
router.patch('/:id/status', auth, requireRole('admin','general_manager','poc'), asyncHandler(async (req, res) => {
  const { status } = req.body
  if (!['approved','rejected'].includes(status)) throw new AppError('Invalid status', 400, 'INVALID_INPUT')
  const leave = await leaveService.pocApprove(req.params.id, status, req.user)
  req.io?.emit('leave:updated', leave)
  res.json({ leave })
}))

// Step 2 — Manager approves/rejects
router.patch('/:id/hr', auth, requireRole('admin','manager'), asyncHandler(async (req, res) => {
  const { status } = req.body
  if (!['approved','rejected'].includes(status)) throw new AppError('Invalid status', 400, 'INVALID_INPUT')
  const leave = await leaveService.managerApprove(req.params.id, status, req.user)
  req.io?.emit('leave:updated', leave)
  res.json({ leave })
}))

// Step 3 — Admin final decision
router.patch('/:id/manager', auth, requireRole('admin','general_manager'), asyncHandler(async (req, res) => {
  const { status } = req.body
  if (!['approved','rejected'].includes(status)) throw new AppError('Invalid status', 400, 'INVALID_INPUT')
  const leave = await leaveService.adminApprove(req.params.id, status, req.user)
  req.audit('FINAL_DECISION', 'leave', req.params.id,
    { mgr_status: 'pending' }, { mgr_status: status, decided_by: req.user.id })
  req.io?.emit('leave:updated', leave)
  res.json({ ok: true, leave })
}))

router.delete('/:id', auth, requireRole('admin','general_manager'), asyncHandler(async (req, res) => {
  await leaveService.remove(req.params.id)
  res.json({ message: 'Deleted' })
}))

module.exports = router
