// lib/utils/fileOperations.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Safely copy a file with directory creation
 * 
 * @param {string} source - Source file path
 * @param {string} destination - Destination file path
 * @returns {Promise} - Resolves when file is copied or rejects on error
 */
async function copyFile(source, destination) {
  try {
    // Ensure the parent directory exists
    const destDir = path.dirname(destination);
    await ensureDir(destDir);

    // Check if source exists
    try {
      await fs.promises.access(source, fs.constants.F_OK);
    } catch (accessErr) {
      logger.error(`Source file does not exist: ${source}`);
      throw accessErr;
    }

    // Check if destination already exists (to avoid duplicate work)
    try {
      await fs.promises.access(destination, fs.constants.F_OK);
      logger.info(`Destination file already exists: ${destination}`);
      return;
    } catch (destAccessErr) {
      // Destination doesn't exist, which is expected
    }

    // Copy the file using promises
    await fs.promises.copyFile(source, destination);
    logger.success(`File successfully copied to: ${destination}`);
  } catch (err) {
    logger.error(`Error copying file from ${source} to ${destination}: ${err.message}`);
    throw err;
  }
}

/**
 * Safely move a file (copy + delete)
 * 
 * @param {string} source - Source file path
 * @param {string} destination - Destination file path
 * @returns {Promise<boolean>} - Resolves with true when successful
 */
async function moveFile(source, destination) {
  try {
    // Copy the file first
    await copyFile(source, destination);
    
    // Then try to remove the source file
    try {
      await fs.promises.access(source, fs.constants.F_OK);
      await fs.promises.unlink(source);
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
      await fs.promises.access(dirPath, fs.constants.F_OK);
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
  // Replace problematic characters
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * Checks if a file exists
 * 
 * @param {string} filePath - Path to the file
 * @returns {Promise<boolean>} - True if file exists
 */
async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  copyFile,
  moveFile,
  removeDirectoryIfEmpty,
  ensureDir,
  sanitizeFolderName,
  fileExists
};
