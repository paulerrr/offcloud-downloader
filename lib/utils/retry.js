// lib/utils/retry.js
const logger = require('./logger');

/**
 * Execute a function with automatic retry using exponential backoff
 * 
 * @param {Function} asyncFn - Async function to execute and potentially retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} options.baseDelay - Base delay in ms for backoff calculation (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in ms (default: 60000)
 * @param {Function} options.shouldRetry - Function to determine if retry should be attempted based on error (default: connection errors only)
 * @param {string} options.operationName - Name of operation for logging purposes
 * @param {Array} args - Arguments to pass to the asyncFn
 * @returns {Promise} - Result of the asyncFn execution
 */
async function withRetry(asyncFn, options = {}, ...args) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 60000,
    shouldRetry = isRetriableError,
    operationName = 'operation'
  } = options;

  let retryCount = 0;
  let lastError = null;

  while (retryCount <= maxRetries) {
    try {
      return await asyncFn(...args);
    } catch (err) {
      lastError = err;
      
      // Check if we should retry based on the error
      if (!shouldRetry(err) || retryCount >= maxRetries) {
        throw err;
      }
      
      retryCount++;
      // Calculate backoff time with exponential increase
      const waitTime = Math.min(maxDelay, Math.pow(2, retryCount) * baseDelay);
      
      logger.warn(`${operationName} failed: ${err.message || err}. Retrying in ${waitTime/1000}s (attempt ${retryCount}/${maxRetries})`);
      
      // Wait before retrying
      await sleep(waitTime);
    }
  }
  
  // This should never be reached due to the throw above, but just in case
  throw lastError;
}

/**
 * Determine if an error is retriable (connection-related)
 * 
 * @param {Error} err - The error to check
 * @returns {boolean} - True if the error is retriable
 */
function isRetriableError(err) {
  return (
    err.code === 'ECONNRESET' || 
    err.code === 'ETIMEDOUT' || 
    err.code === 'ECONNABORTED' ||
    err.code === 'ECONNREFUSED' ||
    (err.message && (
      err.message.includes('timeout') ||
      err.message.includes('socket disconnected') ||
      err.message.includes('network error')
    ))
  );
}

/**
 * Sleep for the specified duration
 * 
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} - Resolves after the specified time
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determine if an HTTP status code is retriable
 * 
 * @param {number} statusCode - HTTP status code
 * @returns {boolean} - True if the status code is retriable
 */
function isRetriableStatus(statusCode) {
  // 5xx are server errors, 429 is rate limiting
  return statusCode >= 500 || statusCode === 429;
}

module.exports = {
  withRetry,
  isRetriableError,
  isRetriableStatus,
  sleep
};
