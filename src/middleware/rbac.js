const { query } = require('../db/pool')
const AppError  = require('../lib/AppError')

let permCache = new Set()

async function loadPermissions() {
  try {
    const result = await query(`SELECT role, resource, action FROM permissions`)
    const next = new Set()
    for (const { role, resource, action } of result.rows) {
      next.add(`${role}:${resource}:${action}`)
    }
    permCache = next
  } catch (e) {
    console.error('[rbac] loadPermissions failed:', e.message)
  }
}

// Load on startup, then refresh every 5 minutes
loadPermissions()
setInterval(loadPermissions, 5 * 60 * 1000)

function requirePermission(resource, action) {
  return (req, _res, next) => {
    const key = `${req.user?.role}:${resource}:${action}`
    if (permCache.has(key)) return next()
    next(new AppError(
      `Your role (${req.user?.role}) cannot perform '${action}' on '${resource}'`,
      403,
      'FORBIDDEN'
    ))
  }
}

// Force a cache refresh (useful after seeding or permission changes)
function refreshPermissions() {
  return loadPermissions()
}

module.exports = { requirePermission, refreshPermissions }
