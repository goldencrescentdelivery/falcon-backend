const Redis = require('ioredis')

const REDIS_URL = process.env.REDIS_URL

if (!REDIS_URL) {
  console.warn('[redis] REDIS_URL not set — Redis features disabled')
}

function createClient(name) {
  if (!REDIS_URL) return null
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck:     false,
    lazyConnect:          true,
  })
  client.on('error', e => console.error(`[redis:${name}]`, e.message))
  client.on('connect', () => console.log(`[redis:${name}] connected`))
  return client
}

// Separate clients: BullMQ requires dedicated connections for pub/sub
const redis          = createClient('cache')
const pubClient      = createClient('pub')
const subClient      = createClient('sub')
const bullConnection = createClient('bull')

module.exports = { redis, pubClient, subClient, bullConnection, isAvailable: !!REDIS_URL }
