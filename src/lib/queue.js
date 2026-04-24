const { Queue } = require('bullmq')
const { bullConnection, isAvailable } = require('./redis')

function makeQueue(name) {
  if (!isAvailable || !bullConnection) return null
  return new Queue(name, {
    connection:     bullConnection,
    defaultJobOptions: {
      attempts:    3,
      backoff:     { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 100 },
      removeOnFail:     { count: 50  },
    },
  })
}

const payrollQueue = makeQueue('payroll')

module.exports = { payrollQueue }
