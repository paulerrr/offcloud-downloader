// lib/utils/fileOperations.js
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import crypto from 'crypto';
import logger from './logger.js';

// Promisify necessary fs functions
const fsAccess = promisify(fs.access);
const fsOpen = promisify(fs.open);
const fsClose = promisify(fs.close);

/**
 * Creates a lock file to prevent concurrent access
 * @param {string} filePath - Path to create a lock for
 * @param {number} timeout - How long to wait for lock (ms)
 * @returns {Promise<boolean>} - True if lock was acquired
 */
async function acquireLock(filePath, timeout = 10000) {
  const lockPath = `${filePath}.lock`;
  const startTime = Date.now();
  
  while (true) {
    try {
      // Try to create lock file
      const fd = await fsOpen(lockPath, 'wx');
      await fsClose(fd);
      return true;
    } catch (err) {
      // If lock exists, wait and retry
      if (err.code === 'EEXIST') {
        // Check if we've timed out
        if (Date.now() - startTime > timeout) {
          logger.warn(`Lock acquisition timed out for ${filePath}`);
          return false;
        }
        
        // Check if the lock is stale (older than 5 minutes)
        try {
          const stats = await fs.promises.stat(lockPath);
          if (Date.now() - stats.mtimeMs > 300000) { // 5 minutes
            logger.warn(`Removing stale lock for ${filePath}`);
            await fs.promises.unlink(lockPath);
            continue;
          }
        } catch (statErr) {
          // If we can't stat the lock file, it might have been removed
          continue;
        }
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 100));
      } else {
        logger.error(`Error acquiring lock for ${filePath}: ${err.message}`);
        return false;
      }
    }
  }
}

/**
 * Releases a lock file
 * @param {string} filePath - Path to release lock for
 * @returns {Promise<boolean>} - True if lock was released
 */
async function releaseLock(filePath) {
  const lockPath = `${filePath}.lock`;
  try {
    await fs.promises.unlink(lockPath);
    return true;
  } catch (err) {
    logger.warn(`Error releasing lock for ${filePath}: ${err.message}`);
    return false;
  }
}

/**
 * Safely copy a file with directory creation and locking
 * 
 * @param {string} source - Source file path
 * @param {string} destination - Destination file path
 * @param {Object} options - Options object
 * @param {boolean} options.useLock - Whether to use file locking
 * @returns {Promise} - Resolves when file is copied or rejects on error
 */
async function copyFile(source, destination, options = { useLock: true }) {
  try {
    // Ensure the parent directory exists
    const destDir = path.dirname(destination);
    await ensureDir(destDir);

    // Check if source exists
    try {
      await fsAccess(source, fs.constants.F_OK);
    } catch (accessErr) {
      logger.error(`Source file does not exist: ${source}`);
      throw accessErr;
    }

    // If using locks, acquire lock for the destination
    let lockAcquired = true;
    if (options.useLock) {
      lockAcquired = await acquireLock(destination);
      if (!lockAcquired) {
        logger.warn(`Couldn't acquire lock for ${destination}, proceeding without lock`);
      }
    }

    try {
      // Check if destination already exists (to avoid duplicate work)
      try {
        await fsAccess(destination, fs.constants.F_OK);
        
        // If destination exists, compare file sizes and mtimes to see if we need to copy
        const [srcStats, destStats] = await Promise.all([
          fs.promises.stat(source),
          fs.promises.stat(destination)
        ]);
        
        if (srcStats.size === destStats.size && srcStats.mtimeMs <= destStats.mtimeMs) {
          logger.info(`Destination file already exists and is current: ${destination}`);
          return;
        } else {
          logger.info(`Destination file exists but needs updating: ${destination}`);
        }
      } catch (destAccessErr) {
        // Destination doesn't exist, which is expected
      }

      // Create a temporary file for the copy to ensure atomicity
      const tempDestination = `${destination}.tmp`;
      
      // Copy to temp file first
      await fs.promises.copyFile(source, tempDestination);
      
      // Rename temp file to final destination (atomic operation)
      await fs.promises.rename(tempDestination, destination);
      
      logger.success(`File successfully copied to: ${destination}`);
    } finally {
      // Release lock if it was acquired
      if (options.useLock && lockAcquired) {
        await releaseLock(destination);
      }
    }
  } catch (err) {
    logger.error(`Error copying file from ${source} to ${destination}: ${err.message}`);
    throw err;
  }
}

/**
 * Safely move a file (copy + delete) with atomic operations
 * 
 * @param {string} source - Source file path
 * @param {string} destination - Destination file path
 * @param {Object} options - Options object
 * @param {boolean} options.useLock - Whether to use file locking
 * @returns {Promise<boolean>} - Resolves with true when successful
 */
async function moveFile(source, destination, options = { useLock: true }) {
  try {
    // If source and destination are on the same filesystem, we can use rename
    // which is atomic and much faster than copy+delete
    try {
      await fs.promises.rename(source, destination);
      logger.success(`File moved (renamed) to: ${destination}`);
      return true;
    } catch (renameErr) {
      // If rename fails (e.g., across filesystems), fall back to copy+delete
      if (renameErr.code === 'EXDEV') {
        logger.debug(`Cannot use rename for ${source} to ${destination}, falling back to copy+delete`);
      } else {
        logger.warn(`Rename failed: ${renameErr.message}, falling back to copy+delete`);
      }
    }
    
    // Copy the file first
    await copyFile(source, destination, options);
    
    // Then try to remove the source file
    try {
      await fs.promises.unlink(source);
      logger.debug(`Source file deleted after copy: ${source}`);
    } catch (err) {
      logger.warn(`Warning: Could not delete source file after copy: ${err.message}`);
      // We don't throw here because the copy succeeded
    }
    
    return true;
  } catch (err) {
    logger.error(`Error moving file from ${source} to ${destination}: ${err.message}`);
    return false;
  }
}

/**
 * Remove a directory if it's empty
 * 
 * @param {string} dirPath - Directory path to remove
 * @returns {Promise<boolean>} - True if directory was removed
 */
async function removeDirectoryIfEmpty(dirPath) {
  try {
    // Check if directory exists first
    try {
      await fsAccess(dirPath, fs.constants.F_OK);
    } catch (err) {
      logger.debug(`Directory doesn't exist: ${dirPath}`);
      return false;
    }
    
    // Read the directory contents
    const files = await fs.promises.readdir(dirPath);
    
    // If directory is empty, remove it
    if (files.length === 0) {
      try {
        await fs.promises.rmdir(dirPath);
        logger.success(`Removed empty directory: ${dirPath}`);
        return true;
      } catch (err) {
        logger.error(`Error removing empty directory ${dirPath}: ${err.message}`);
        throw err;
      }
    }
    return false;
  } catch (err) {
    logger.error(`Error checking/removing directory ${dirPath}: ${err.message}`);
    return false;
  }
}

/**
 * Recursively remove a directory and all its contents
 * 
 * @param {string} dirPath - Directory path to remove
 * @returns {Promise<boolean>} - True if directory was removed
 */
async function removeDirectory(dirPath) {
  try {
    // Check if directory exists first
    try {
      await fsAccess(dirPath, fs.constants.F_OK);
    } catch (err) {
      logger.debug(`Directory doesn't exist: ${dirPath}`);
      return true; // Already gone
    }
    
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    
    // Process all entries in the directory
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        // Recursively remove subdirectories
        await removeDirectory(fullPath);
      } else {
        // Remove files
        await fs.promises.unlink(fullPath);
      }
    }
    
    // Remove the now-empty directory
    await fs.promises.rmdir(dirPath);
    logger.success(`Removed directory: ${dirPath}`);
    return true;
  } catch (err) {
    logger.error(`Error removing directory ${dirPath}: ${err.message}`);
    return false;
  }
}

/**
 * Ensure a directory exists
 * 
 * @param {string} dirPath - Directory path to create
 * @returns {Promise} - Resolves when directory exists
 */
async function ensureDir(dirPath) {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
    return true;
  } catch (mkdirErr) {
    logger.error(`Error creating directory ${dirPath}: ${mkdirErr.message}`);
    throw mkdirErr;
  }
}

/**
 * Make folder name safe for file system
 * 
 * @param {string} name - Original folder name
 * @returns {string} - Sanitized folder name
 */
function sanitizeFolderName(name) {
  if (!name) return 'unnamed_' + Date.now();
  
  // Replace problematic characters
  const sanitized = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ') // Replace multiple spaces with a single space
    .trim(); // Remove leading/trailing whitespace
  
  // Limit length to 255 characters to be safe on all filesystems
  return sanitized.length > 255 ? sanitized.substring(0, 252) + '...' : sanitized;
}

/**
 * Checks if a file exists
 * 
 * @param {string} filePath - Path to the file
 * @returns {Promise<boolean>} - True if file exists
 */
async function fileExists(filePath) {
  try {
    await fsAccess(filePath, fs.constants.F_OK);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Gets file hash for integrity checking
 * 
 * @param {string} filePath - Path to the file
 * @param {string} algorithm - Hash algorithm to use
 * @returns {Promise<string>} - Hash of the file
 */
async function getFileHash(filePath, algorithm = 'md5') {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash(algorithm);
      const stream = fs.createReadStream(filePath);
      
      stream.on('error', err => reject(err));
      
      stream.on('data', chunk => {
        hash.update(chunk);
      });
      
      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Gets a unique identifier for a file based on path, size and mtime
 * 
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} - Unique identifier
 */
async function getFileIdentifier(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    return `${filePath}:${stats.size}:${stats.mtimeMs}`;
  } catch (err) {
    logger.error(`Error getting file identifier for ${filePath}: ${err.message}`);
    // Fallback to just the path
    return filePath;
  }
}

/**
 * Safe write file that uses a temporary file and rename
 * 
 * @param {string} filePath - Path to write
 * @param {string|Buffer} data - Data to write
 * @param {Object} options - Options to pass to writeFile
 * @returns {Promise<void>} 
 */
async function safeWriteFile(filePath, data, options = {}) {
  const tempFilePath = `${filePath}.tmp`;
  try {
    // Ensure the parent directory exists
    const dirPath = path.dirname(filePath);
    await ensureDir(dirPath);
    
    // Write to temp file first
    await fs.promises.writeFile(tempFilePath, data, options);
    
    // Rename to final file (atomic operation)
    await fs.promises.rename(tempFilePath, filePath);
  } catch (err) {
    // Clean up temp file if an error occurred
    try {
      if (await fileExists(tempFilePath)) {
        await fs.promises.unlink(tempFilePath);
      }
    } catch (cleanupErr) {
      logger.error(`Error cleaning up temp file: ${cleanupErr.message}`);
    }
    
    throw err;
  }
}

// Export all functions
export default {
  copyFile,
  moveFile,
  removeDirectoryIfEmpty,
  removeDirectory,
  ensureDir,
  sanitizeFolderName,
  fileExists,
  getFileHash,
  getFileIdentifier,
  safeWriteFile,
  acquireLock,
  releaseLock
};