/**
 * Security middleware for Express — add to index.js
 * Adds HTTP security headers and tightens CORS
 */

function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY')
  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block')
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  // Remove Express fingerprint
  res.removeHeader('X-Powered-By')
  next()
}

// Tight CORS — only allow your actual frontend domain
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean)

// Always allow local dev
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000')
}

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin
  if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes('*'))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
}

module.exports = { securityHeaders, corsMiddleware }