const { query } = require('../db/pool')

// Create a new workflow instance for an entity (fire-and-forget safe)
async function createInstance(definitionId, entityType, entityId) {
  await query(`
    INSERT INTO workflow_instances (definition_id, entity_type, entity_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (entity_type, entity_id) DO NOTHING
  `, [definitionId, entityType, String(entityId)])
}

// Advance (or terminate) the workflow for an entity
async function advance(entityType, entityId, actorRole, decision, actor) {
  const inst = await query(`
    SELECT wi.*, wd.steps
    FROM workflow_instances wi
    JOIN workflow_definitions wd ON wi.definition_id = wd.id
    WHERE wi.entity_type=$1 AND wi.entity_id=$2 AND wi.status='active'
  `, [entityType, String(entityId)])

  if (!inst.rows[0]) return  // no active instance — silently skip

  const { id, current_step, history, steps } = inst.rows[0]
  const stepDef = steps.find(s => s.step === current_step)

  if (!stepDef) return

  const entry = {
    step:       current_step,
    role:       actorRole,
    actor_id:   actor?.id   || null,
    actor_name: actor?.name || null,
    decision,
    acted_at:   new Date().toISOString(),
  }

  const newHistory = [...(history || []), entry]

  if (decision === 'rejected') {
    await query(`
      UPDATE workflow_instances
      SET status='rejected', history=$1, updated_at=NOW()
      WHERE id=$2
    `, [JSON.stringify(newHistory), id])
    return
  }

  // Approved — move to next step or complete
  const nextStep = steps.find(s => s.step === current_step + 1)
  if (nextStep) {
    await query(`
      UPDATE workflow_instances
      SET current_step=$1, history=$2, updated_at=NOW()
      WHERE id=$3
    `, [nextStep.step, JSON.stringify(newHistory), id])
  } else {
    await query(`
      UPDATE workflow_instances
      SET status='completed', history=$1, updated_at=NOW()
      WHERE id=$2
    `, [JSON.stringify(newHistory), id])
  }
}

// Get the workflow instance for an entity
async function getForEntity(entityType, entityId) {
  const result = await query(`
    SELECT wi.*, wd.name AS definition_name, wd.steps
    FROM workflow_instances wi
    JOIN workflow_definitions wd ON wi.definition_id = wd.id
    WHERE wi.entity_type=$1 AND wi.entity_id=$2
    ORDER BY wi.created_at DESC
    LIMIT 1
  `, [entityType, String(entityId)])
  return result.rows[0] || null
}

// Get the role expected to act at the current step
async function getCurrentRole(entityType, entityId) {
  const inst = await getForEntity(entityType, entityId)
  if (!inst || inst.status !== 'active') return null
  const step = inst.steps.find(s => s.step === inst.current_step)
  return step?.role || null
}

async function deleteForEntity(entityType, entityId) {
  await query(
    `DELETE FROM workflow_instances WHERE entity_type=$1 AND entity_id=$2`,
    [entityType, String(entityId)]
  )
}

module.exports = { createInstance, advance, getForEntity, getCurrentRole, deleteForEntity }
