// lib/utils/retry.js
import logger from './logger.js';

/**
 * Execute a function with automatic retry using exponential backoff
 * 
 * @param {Function} asyncFn - Async function to execute and potentially retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} options.baseDelay - Base delay in ms for backoff calculation (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in ms (default: 60000)
 * @param {number} options.timeoutMs - Overall timeout for all retries (default: 0, no timeout)
 * @param {Function} options.shouldRetry - Function to determine if retry should be attempted based on error (default: connection errors only)
 * @param {Function} options.onRetry - Function called before each retry attempt
 * @param {string} options.operationName - Name of operation for logging purposes
 * @returns {Promise} - Result of the asyncFn execution
 */
async function withRetry(asyncFn, options = {}, ...args) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 60000,
    timeoutMs = 0,
    shouldRetry = isRetriableError,
    onRetry = null,
    operationName = 'operation'
  } = options;

  let retryCount = 0;
  let lastError = null;
  const startTime = Date.now();

  // Create a timeout promise if timeoutMs is specified
  let timeoutPromise = null;
  if (timeoutMs > 0) {
    timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Operation "${operationName}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  while (retryCount <= maxRetries) {
    try {
      // If we have a timeout, race against it
      if (timeoutPromise) {
        return await Promise.race([
          asyncFn(...args),
          timeoutPromise
        ]);
      } else {
        return await asyncFn(...args);
      }
    } catch (err) {
      lastError = err;
      
      // Check if we should retry based on the error
      if (!shouldRetry(err) || retryCount >= maxRetries) {
        logger.debug(`Not retrying "${operationName}": shouldRetry=${shouldRetry(err)}, retryCount=${retryCount}, maxRetries=${maxRetries}`);
        throw err;
      }
      
      // Check if we would exceed the overall timeout
      if (timeoutMs > 0 && (Date.now() - startTime + calculateBackoff(retryCount, baseDelay, maxDelay)) > timeoutMs) {
        throw new Error(`Operation "${operationName}" would exceed timeout after next retry. Last error: ${err.message}`);
      }
      
      retryCount++;
      // Calculate backoff time with exponential increase and jitter
      const waitTime = calculateBackoff(retryCount, baseDelay, maxDelay);
      
      logger.warn(`${operationName} failed: ${err.message || err}. Retrying in ${Math.round(waitTime/1000)}s (attempt ${retryCount}/${maxRetries})`);
      
      // Call onRetry callback if provided
      if (typeof onRetry === 'function') {
        try {
          await onRetry(retryCount, err);
        } catch (callbackErr) {
          logger.warn(`Error in retry callback: ${callbackErr.message}`);
        }
      }
      
      // Wait before retrying
      await sleep(waitTime);
    }
  }
  
  // This should never be reached due to the throw above, but just in case
  throw lastError;
}

/**
 * Calculate backoff time with exponential increase and jitter
 * 
 * @param {number} retryCount - Current retry attempt
 * @param {number} baseDelay - Base delay in ms
 * @param {number} maxDelay - Maximum delay in ms
 * @returns {number} - Backoff time in ms
 */
function calculateBackoff(retryCount, baseDelay, maxDelay) {
  // Calculate exponential backoff
  const expBackoff = Math.min(maxDelay, Math.pow(2, retryCount) * baseDelay);
  
  // Add jitter (±10%) to prevent thundering herd problem
  const jitter = expBackoff * 0.1;
  return expBackoff + (Math.random() * jitter * 2) - jitter;
}

/**
 * Determine if an error is retriable (connection-related)
 * 
 * @param {Error} err - The error to check
 * @returns {boolean} - True if the error is retriable
 */
function isRetriableError(err) {
  // Network errors
  if (err.code === 'ECONNRESET' || 
      err.code === 'ETIMEDOUT' || 
      err.code === 'ECONNABORTED' ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'ENETUNREACH' ||
      err.code === 'EHOSTUNREACH') {
    return true;
  }
  
  // Axios errors
  if (err.isAxiosError) {
    // No response means network error
    if (!err.response) return true;
    
    // Certain status codes are retriable
    if (err.response.status >= 500 || 
        err.response.status === 429 || 
        err.response.status === 408) {
      return true;
    }
  }
  
  // Other error messages that indicate temporary issues
  if (err.message && (
    err.message.includes('timeout') ||
    err.message.includes('socket disconnected') ||
    err.message.includes('network error') ||
    err.message.includes('connection reset') ||
    err.message.includes('ECONNRESET') ||
    err.message.includes('socket hang up') ||
    err.message.includes('connection timed out')
  )) {
    return true;
  }
  
  return false;
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
  // 5xx are server errors, 429 is rate limiting, 408 is request timeout
  return statusCode >= 500 || statusCode === 429 || statusCode === 408;
}

/**
 * Create a debounce function
 * 
 * @param {Function} func - Function to debounce
 * @param {number} wait - Milliseconds to wait
 * @param {boolean} immediate - Whether to call immediately
 * @returns {Function} - Debounced function
 */
function debounce(func, wait, immediate = false) {
  let timeout;
  
  return function executedFunction(...args) {
    const context = this;
    
    const later = () => {
      timeout = null;
      if (!immediate) func.apply(context, args);
    };
    
    const callNow = immediate && !timeout;
    
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    
    if (callNow) func.apply(context, args);
  };
}

/**
 * Create a throttled function
 * 
 * @param {Function} func - Function to throttle
 * @param {number} limit - Limit in milliseconds
 * @returns {Function} - Throttled function
 */
function throttle(func, limit) {
  let inThrottle;
  let lastResult;
  
  return function(...args) {
    const context = this;
    
    if (!inThrottle) {
      lastResult = func.apply(context, args);
      inThrottle = true;
      
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
    
    return lastResult;
  };
}

export {
  withRetry,
  isRetriableError,
  isRetriableStatus,
  sleep,
  debounce,
  throttle
};