/**
 * Shared middleware for all backend services
 */

/**
 * Request logging middleware
 * Logs method, path, status, and duration
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, path } = req;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const { statusCode } = res;

    // Skip health check logging to reduce noise
    if (path === '/health' || path === '/api/health') return;

    console.log(`${method} ${path} ${statusCode} ${duration}ms`);
  });

  next();
}

/**
 * Health check handler
 * Returns service status and memory usage
 */
function healthCheck(serviceName) {
  return (_req, res) => {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);

    res.json({
      status: 'ok',
      service: serviceName,
      timestamp: new Date().toISOString(),
      memory: {
        heapUsed: `${heapUsedMB}MB`,
        heapTotal: `${heapTotalMB}MB`,
        heapPercent: `${Math.round((heapUsedMB / heapTotalMB) * 100)}%`
      },
      uptime: `${Math.round(process.uptime())}s`
    });
  };
}

/**
 * Error handler middleware
 * Catches errors and returns consistent error response
 */
function errorHandler(err, _req, res, _next) {
  console.error('Unhandled error:', err.message);
  console.error(err.stack);

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
}

/**
 * 404 handler
 */
function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

module.exports = {
  requestLogger,
  healthCheck,
  errorHandler,
  notFoundHandler,
};
