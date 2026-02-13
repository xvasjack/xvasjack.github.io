/**
 * Shared logging utilities for Railway services
 * Handles memory monitoring and global error handlers
 */

/**
 * Log current memory usage for debugging Railway OOM issues
 * @param {string} label - Optional label for context
 */
function logMemoryUsage(label = '') {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  console.log(
    `  [Memory${label ? ': ' + label : ''}] Heap: ${heapUsedMB}/${heapTotalMB}MB, RSS: ${rssMB}MB`
  );
}

/**
 * Setup global error handlers to prevent service crashes
 * Catches unhandled promise rejections and uncaught exceptions
 * @param {Object} options - Configuration options
 * @param {boolean} options.logMemory - Whether to log memory on errors (default: true)
 * @param {boolean} options.exitOnUnhandledRejection - Exit process after unhandled rejection
 * @param {boolean} options.exitOnUncaughtException - Exit process after uncaught exception
 */
function setupGlobalErrorHandlers(options = {}) {
  const {
    logMemory = true,
    exitOnUnhandledRejection = false,
    exitOnUncaughtException = false,
  } = options;

  process.on('unhandledRejection', (reason, promise) => {
    console.error('=== UNHANDLED PROMISE REJECTION ===');
    console.error('Reason:', reason);
    console.error('Promise:', promise);
    console.error('Stack:', reason?.stack || 'No stack trace');
    if (logMemory) {
      logMemoryUsage('at rejection');
    }
    if (exitOnUnhandledRejection) {
      console.error('[Fatal] Exiting due to unhandled promise rejection');
      process.exit(1);
    }
  });

  process.on('uncaughtException', (error) => {
    console.error('=== UNCAUGHT EXCEPTION ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    if (logMemory) {
      logMemoryUsage('at exception');
    }
    if (exitOnUncaughtException) {
      console.error('[Fatal] Exiting due to uncaught exception');
      process.exit(1);
    }
  });
}

module.exports = {
  logMemoryUsage,
  setupGlobalErrorHandlers,
};
