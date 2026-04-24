const { query } = require('../db/pool')

function auditMiddleware(req, _res, next) {
  req.audit = (action, entity, entityId, oldVal = null, newVal = null) => {
    query(
      `INSERT INTO audit_logs
         (user_id, user_name, user_role, action, entity, entity_id,
          old_value, new_value, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        req.user?.id   ?? null,
        req.user?.name ?? null,
        req.user?.role ?? null,
        action,
        entity,
        entityId != null ? String(entityId) : null,
        oldVal  != null ? JSON.stringify(oldVal)  : null,
        newVal  != null ? JSON.stringify(newVal)  : null,
        req.ip,
        req.headers['user-agent'] ?? null,
      ]
    ).catch(e => console.error('[audit] insert failed:', e.message))
  }
  next()
}

module.exports = auditMiddleware
