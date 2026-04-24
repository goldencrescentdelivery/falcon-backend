function errorHandler(err, req, res, _next) {
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      ok: false,
      error: err.message,
      ...(err.code && { code: err.code }),
    })
  }

  console.error('[unhandled error]', {
    message:  err.message,
    stack:    err.stack,
    url:      req.originalUrl,
    user_id:  req.user?.id,
  })

  res.status(500).json({
    ok: false,
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  })
}

module.exports = errorHandler
