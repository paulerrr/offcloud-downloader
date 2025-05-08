// lib/utils/logger.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import os from 'os';

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse log-related environment variables
const {
  LOG_LEVEL = 'info',
  LOG_TO_FILE = 'false',
  LOG_FILE_PATH = './logs/offcloud-downloader.log',
  LOG_ROTATION = 'true',
  LOG_MAX_SIZE = '10485760', // 10MB default
  LOG_MAX_FILES = '5',
  LOG_COLOR_OUTPUT = 'true',
  LOG_TIMESTAMP = 'true'
} = process.env;

class Logger {
  constructor(options = {}) {
    this.options = {
      logLevel: LOG_LEVEL,
      showTimestamp: LOG_TIMESTAMP === 'true',
      colorOutput: LOG_COLOR_OUTPUT === 'true',
      logToFile: LOG_TO_FILE === 'true',
      logFilePath: LOG_FILE_PATH,
      logRotation: LOG_ROTATION === 'true',
      logMaxSize: parseInt(LOG_MAX_SIZE, 10) || 10485760,
      logMaxFiles: parseInt(LOG_MAX_FILES, 10) || 5,
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
    
    // Initialize log rotation state
    this.currentLogSize = 0;
    this.logFiles = [];
    
    // Initialize log file if needed
    if (this.options.logToFile) {
      this.ensureLogDirectory();
      this.initializeLogRotation();
    }
    
    // Track startup time
    this.startTime = Date.now();
    
    // Get system info for debugging
    this.systemInfo = this.getSystemInfo();
    
    // Log startup header
    this.logStartupHeader();
  }

  // New method for download failures
  downloadFailed(message, ...args) {
    const formattedMessage = `********** DOWNLOAD FAILED: ${message} **********`;
    this.error(formattedMessage, ...args);
  }

  // Get system information for debugging
  getSystemInfo() {
    return {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memory: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + 'GB',
      nodeVersion: process.version,
      pid: process.pid
    };
  }

  // Log startup information
  logStartupHeader() {
    const headerLines = [
      '=================================================',
      '        OFFCLOUD DOWNLOADER - STARTING UP        ',
      '=================================================',
      `Date: ${new Date().toISOString()}`,
      `PID: ${this.systemInfo.pid}`,
      `Node: ${this.systemInfo.nodeVersion}`,
      `System: ${this.systemInfo.platform} ${this.systemInfo.release} (${this.systemInfo.arch})`,
      `CPUs: ${this.systemInfo.cpus}`,
      `Memory: ${this.systemInfo.memory}`,
      `Log Level: ${this.options.logLevel}`,
      this.options.logToFile ? `Log File: ${this.options.logFilePath}` : 'Console logging only',
      '================================================='
    ];
    
    // Print to console
    headerLines.forEach(line => console.log(this.options.colorOutput ? '\x1b[36m' + line + '\x1b[0m' : line));
    
    // Write to log file if enabled
    if (this.options.logToFile) {
      const header = headerLines.join('\n') + '\n';
      fs.appendFileSync(this.options.logFilePath, header, { encoding: 'utf8' });
      this.currentLogSize += Buffer.byteLength(header, 'utf8');
    }
  }

  ensureLogDirectory() {
    const dir = path.dirname(this.options.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  initializeLogRotation() {
    if (!this.options.logRotation) return;
    
    // Check if the log file exists and get its size
    try {
      if (fs.existsSync(this.options.logFilePath)) {
        const stats = fs.statSync(this.options.logFilePath);
        this.currentLogSize = stats.size;
      }
      
      // Get existing log files for rotation purposes
      const dir = path.dirname(this.options.logFilePath);
      const baseFileName = path.basename(this.options.logFilePath);
      
      if (fs.existsSync(dir)) {
        this.logFiles = fs.readdirSync(dir)
          .filter(file => file.startsWith(baseFileName) && file.includes('.'))
          .map(file => path.join(dir, file))
          .sort((a, b) => {
            // Sort by modification time (newest first)
            return fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime();
          });
      }
    } catch (err) {
      console.error(`Error initializing log rotation: ${err.message}`);
    }
  }

  // Handle log rotation if needed
  checkRotation(messageSize) {
    if (!this.options.logRotation) return;
    
    this.currentLogSize += messageSize;
    
    // Check if we need to rotate logs
    if (this.currentLogSize > this.options.logMaxSize) {
      this.rotateLog();
    }
  }

  // Rotate log files
  rotateLog() {
    try {
      const dir = path.dirname(this.options.logFilePath);
      const ext = path.extname(this.options.logFilePath);
      const baseFileName = path.basename(this.options.logFilePath, ext);
      
      // Rotate existing log files
      for (let i = this.options.logMaxFiles - 1; i > 0; i--) {
        const oldFile = path.join(dir, `${baseFileName}.${i}${ext}`);
        const newFile = path.join(dir, `${baseFileName}.${i + 1}${ext}`);
        
        if (fs.existsSync(oldFile)) {
          if (fs.existsSync(newFile)) {
            fs.unlinkSync(newFile);
          }
          fs.renameSync(oldFile, newFile);
        }
      }
      
      // Rotate current log file
      const newFile = path.join(dir, `${baseFileName}.1${ext}`);
      if (fs.existsSync(newFile)) {
        fs.unlinkSync(newFile);
      }
      
      if (fs.existsSync(this.options.logFilePath)) {
        fs.renameSync(this.options.logFilePath, newFile);
      }
      
      // Reset size counter
      this.currentLogSize = 0;
      
      // Update log file list
      this.initializeLogRotation();
      
      // Create a new log file with header
      this.logStartupHeader();
      
      console.log(`Log file rotated to ${newFile}`);
    } catch (err) {
      console.error(`Error rotating log file: ${err.message}`);
    }
  }

  // Format the message with timestamp, level and consistent styling
  formatMessage(level, message) {
    // Calculate uptime for more precise timestamps in logs
    const uptime = Date.now() - this.startTime;
    const uptimeStr = this.formatUptime(uptime);
    
    const timestamp = this.options.showTimestamp ? 
      `${new Date().toISOString()} [+${uptimeStr}] ` : '';
    
    const levelInfo = this.levels[level];
    
    if (this.options.colorOutput) {
      return `${levelInfo.color}${timestamp}[${levelInfo.label}]${' \x1b[0m'} ${message}`;
    } else {
      return `${timestamp}[${levelInfo.label}] ${message}`;
    }
  }

  // Format uptime as HH:MM:SS or DD:HH:MM:SS
  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      return `${days}d:${hours % 24}h:${minutes % 60}m:${seconds % 60}s`;
    } else {
      return `${hours}h:${minutes % 60}m:${seconds % 60}s`;
    }
  }

  // Determine if a message at this level should be logged
  shouldLog(level) {
    return this.levels[level].value <= this.currentLevel.value;
  }

  // Format an object for logging (with truncation if needed)
  formatObject(obj) {
    try {
      if (obj instanceof Error) {
        return obj.stack || `${obj.name}: ${obj.message}`;
      }
      
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
    const messageWithNewline = cleanMessage + '\n';
    
    try {
      fs.appendFileSync(
        this.options.logFilePath,
        messageWithNewline,
        { encoding: 'utf8' }
      );
      
      // Check if we need to rotate the log
      this.checkRotation(Buffer.byteLength(messageWithNewline, 'utf8'));
    } catch (err) {
      console.error(`Error writing to log file: ${err.message}`);
    }
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

export default logger;