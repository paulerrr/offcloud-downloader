// lib/utils/logger.js
const fs = require('fs');
const path = require('path');

class Logger {
  constructor(options = {}) {
    this.options = {
      logLevel: process.env.LOG_LEVEL || 'info',
      showTimestamp: true,
      colorOutput: true,
      logToFile: process.env.LOG_TO_FILE === 'true',
      logFilePath: process.env.LOG_FILE_PATH || 'offcloud-downloader.log',
      truncateResponses: true,
      maxResponseLength: 200,
      ...options
    };

    this.levels = {
      error: { value: 0, label: 'ERROR', prefix: '❌', color: '\x1b[31m' },
      warn:  { value: 1, label: 'WARN ', prefix: '⚠️', color: '\x1b[33m' },
      info:  { value: 2, label: 'INFO ', prefix: 'ℹ️', color: '\x1b[36m' },
      http:  { value: 3, label: 'HTTP ', prefix: '🌐', color: '\x1b[35m' },
      debug: { value: 4, label: 'DEBUG', prefix: '🔍', color: '\x1b[90m' },
      success: { value: 2, label: 'DONE ', prefix: '✅', color: '\x1b[32m' }
    };

    this.currentLevel = this.levels[this.options.logLevel] || this.levels.info;
    
    if (this.options.logToFile) {
      this.ensureLogDirectory();
    }
  }

  ensureLogDirectory() {
    const dir = path.dirname(this.options.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Format the message with timestamp, level and consistent styling
  formatMessage(level, message) {
    const timestamp = this.options.showTimestamp ? new Date().toISOString() + ' ' : '';
    const levelInfo = this.levels[level];
    
    if (this.options.colorOutput) {
      return `${levelInfo.color}${timestamp}[${levelInfo.label}]${' \x1b[0m'} ${message}`;
    } else {
      return `${timestamp}[${levelInfo.label}] ${message}`;
    }
  }

  // Determine if a message at this level should be logged
  shouldLog(level) {
    return this.levels[level].value <= this.currentLevel.value;
  }

  // Format an object for logging (with truncation if needed)
  formatObject(obj) {
    try {
      const json = JSON.stringify(obj, null, 2);
      
      if (this.options.truncateResponses && json.length > this.options.maxResponseLength) {
        return json.substring(0, this.options.maxResponseLength) + '... (truncated)';
      }
      
      return json;
    } catch (err) {
      return '[Object cannot be stringified]';
    }
  }

  // Write to file if enabled
  writeToFile(message) {
    if (!this.options.logToFile) return;
    
    // Strip ANSI color codes for file output
    const cleanMessage = message.replace(/\x1b\[[0-9;]*m/g, '');
    
    fs.appendFileSync(
      this.options.logFilePath,
      cleanMessage + '\n',
      { encoding: 'utf8' }
    );
  }

  // Logging methods
  log(level, message, ...args) {
    if (!this.shouldLog(level)) return;

    let finalMessage = message;
    
    // Handle objects in args
    if (args.length > 0) {
      for (const arg of args) {
        if (typeof arg === 'object' && arg !== null) {
          finalMessage += ' ' + this.formatObject(arg);
        } else {
          finalMessage += ' ' + arg;
        }
      }
    }
    
    const formattedMessage = this.formatMessage(level, finalMessage);
    console.log(formattedMessage);
    this.writeToFile(formattedMessage);
  }

  error(message, ...args) {
    this.log('error', message, ...args);
  }

  warn(message, ...args) {
    this.log('warn', message, ...args);
  }

  info(message, ...args) {
    this.log('info', message, ...args);
  }

  http(message, ...args) {
    this.log('http', message, ...args);
  }

  debug(message, ...args) {
    this.log('debug', message, ...args);
  }

  success(message, ...args) {
    this.log('success', message, ...args);
  }
  
  // Special method for API requests
  request(url, options = {}) {
    if (!this.shouldLog('http')) return;
    
    // Mask API keys in URLs when logging
    const maskedUrl = url.replace(/(\?|&)key=([^&]+)/, '$1key=********');
    this.log('http', `Request: ${maskedUrl}`);
  }
  
  // Special method for API responses
  response(data, options = {}) {
    if (!this.shouldLog('http')) return;
    
    if (data === null || data === undefined) {
      this.log('http', 'Response: Empty');
      return;
    }
    
    if (Array.isArray(data)) {
      this.log('http', `Response: Array with ${data.length} items`);
      if (this.shouldLog('debug')) {
        this.debug('Response details:', data);
      }
      return;
    }
    
    if (typeof data === 'object') {
      const keys = Object.keys(data);
      if (keys.length === 0) {
        this.log('http', 'Response: Empty object');
      } else if (keys.length <= 3 && JSON.stringify(data).length < 100) {
        this.log('http', 'Response:', data);
      } else {
        this.log('http', `Response: Object with ${keys.length} properties`);
        if (this.shouldLog('debug')) {
          this.debug('Response details:', data);
        }
      }
      return;
    }
    
    this.log('http', `Response: ${data}`);
  }
}

// Create a singleton instance
const logger = new Logger();

module.exports = logger;
