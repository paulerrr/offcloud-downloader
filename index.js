// Updated Chokidar implementation for index.js
import chokidar from 'chokidar';
import OffCloudWatcher from './lib/watchers/offcloud/index.js';
import Downloader from './lib/downloaders/inline/index.js';
import fs from 'fs';
import path from 'path';
import logger from './lib/utils/logger.js';
import fileOps from './lib/utils/fileOperations.js';
import { withRetry, sleep } from './lib/utils/retry.js';

// Parse environment variables, ensuring numeric values are converted from strings to numbers
const {
  OFFCLOUD_API_KEY,
  WATCH_DIR = '/watch',
  DOWNLOAD_DIR = '/download', // Keep for backward compatibility
  IN_PROGRESS_DIR = '/in-progress',
  COMPLETED_DIR = '/completed',
  WATCH_RATE: watchRateStr = '5000',
  MAX_CONCURRENT_DOWNLOADS: maxDownloadsStr = '3',
  FILE_POLL_INTERVAL: pollIntervalStr = '1000',
  FILE_STABLE_TIME: stableTimeStr = '5000'
} = process.env;

// Convert string env vars to numbers
const WATCH_RATE = parseInt(watchRateStr, 10) || 5000;
const MAX_CONCURRENT_DOWNLOADS = parseInt(maxDownloadsStr, 10) || 3;
const FILE_POLL_INTERVAL = parseInt(pollIntervalStr, 10) || 1000;
const FILE_STABLE_TIME = parseInt(stableTimeStr, 10) || 5000;

if (!OFFCLOUD_API_KEY) {
  logger.error('OFFCLOUD_API_KEY environment variable is not set');
  process.exit(-1);
}

// Ensure all required directories exist
const createDirectories = async () => {
  for (const dir of [WATCH_DIR, IN_PROGRESS_DIR, COMPLETED_DIR]) {
    try {
      await fileOps.ensureDir(dir);
      logger.success(`Ensured directory exists: ${dir}`);
    } catch (err) {
      logger.error(`Error creating directory ${dir}:`, err.message);
    }
  }
};

// Self-executing async function to set up the application
(async () => {
  // Create required directories
  await createDirectories();

  // Create a downloader instance with the new directories
  const downloader = new Downloader(WATCH_DIR, DOWNLOAD_DIR, IN_PROGRESS_DIR, COMPLETED_DIR);

  logger.info('Download configuration:');
  logger.info(`Watch directory: ${WATCH_DIR}`);
  logger.info(`In-progress directory: ${IN_PROGRESS_DIR}`);
  logger.info(`Completed directory: ${COMPLETED_DIR}`);
  logger.info(`Max concurrent downloads: ${MAX_CONCURRENT_DOWNLOADS}`);
  logger.info(`File poll interval: ${FILE_POLL_INTERVAL}ms`);
  logger.info(`File stability threshold: ${FILE_STABLE_TIME}ms`);

  // Create a watcher instance with the queue system
  const watcher = new OffCloudWatcher(
    OFFCLOUD_API_KEY, 
    downloader.download,
    MAX_CONCURRENT_DOWNLOADS
  );

  logger.info(`Watching '${WATCH_DIR}' for new nzbs, magnets and torrents`);

  // Set to track files that are being processed or have been processed
  const processedFiles = new Map(); // Map of file path to { timestamp, processingStatus }
  
  // Track watcher state
  let watcherHealthy = true;
  let watcherStartTime = Date.now();
  let consecutiveErrorCount = 0;
  let lastFileAddedTime = Date.now();
  let fileWatcher = null;

  // Function to check if a file should be ignored
  const shouldIgnoreFile = (filePath, stats) => {
    // Skip if it's a directory
    if (stats && stats.isDirectory()) return false;
    
    const fileName = path.basename(filePath);
    
    // Ignore hidden files (dotfiles)
    if (fileName.startsWith('.')) return true;
    
    // Ignore temporary and in-progress files
    if (fileName.endsWith('.queued') || 
        fileName.endsWith('.part') || 
        fileName.endsWith('.downloading')) return true;
    
    // Only process specific extensions
    const extension = path.extname(filePath).toLowerCase();
    if (!['.torrent', '.magnet', '.nzb'].includes(extension)) return true;
    
    return false;
  };

  // Setup watcher with more robust configuration
  const createNewWatcher = () => {
    watcherStartTime = Date.now();
    
    const watcher = chokidar.watch(WATCH_DIR, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: FILE_STABLE_TIME,
        pollInterval: FILE_POLL_INTERVAL
      },
      // Updated ignored to use function instead of glob patterns for Chokidar v4 compatibility
      ignored: shouldIgnoreFile,
      depth: 99,
      // Use polling only if needed - on platforms where FSEvents isn't available
      usePolling: process.platform === 'win32' || process.env.FORCE_POLLING === 'true',
      interval: FILE_POLL_INTERVAL,
      binaryInterval: 3000,
      alwaysStat: true,
      atomic: 500
    });
    
    // Add event handlers
    watcher
      .on('ready', () => {
        logger.success('Initial scan complete. Ready for changes');
        watcherHealthy = true;
        consecutiveErrorCount = 0;
      })
      .on('error', (error) => {
        logger.error(`Watcher error:`, error);
        consecutiveErrorCount++;
        
        if (consecutiveErrorCount > 5) {
          watcherHealthy = false;
          logger.warn(`Multiple consecutive errors detected. Watcher will be recreated.`);
        }
      })
      .on('add', async (filePath, stats) => {
        try {
          await processFile(filePath, stats);
        } catch (err) {
          logger.error(`Error processing file ${filePath}:`, err.message);
        }
      });
    
    return watcher;
  };
  
  // Process a file once detected
  const processFile = async (filePath, stats) => {
    if (!stats) {
      try {
        stats = await fs.promises.stat(filePath);
      } catch (err) {
        logger.error(`Error getting stats for ${filePath}:`, err.message);
        return;
      }
    }
    
    // Skip ignored files
    if (shouldIgnoreFile(filePath, stats)) {
      const extension = path.extname(filePath).toLowerCase();
      if (!['.torrent', '.magnet', '.nzb'].includes(extension)) {
        logger.debug(`Ignoring '${filePath}' because it has an unknown extension (${extension})`);
      } else {
        logger.debug(`Ignoring '${filePath}' because it matched ignore patterns`);
      }
      return;
    }
    
    logger.info(`Detected file: '${filePath}'`);
    lastFileAddedTime = Date.now();
    
    // Get the file id (path + size + mtime) for better deduplication
    const fileId = `${filePath}:${stats.size}:${stats.mtimeMs}`;
    
    // Check if this file is already being processed
    if (processedFiles.has(fileId)) {
      const fileInfo = processedFiles.get(fileId);
      
      // If the file was processed in the last hour, skip it
      if (Date.now() - fileInfo.timestamp < 3600000) {
        logger.warn(`File '${filePath}' was processed recently (${new Date(fileInfo.timestamp).toLocaleTimeString()}), skipping`);
        return;
      }
      
      // If the file is currently being processed, skip it
      if (fileInfo.status === 'processing') {
        logger.warn(`File '${filePath}' is currently being processed, skipping`);
        return;
      }
    }
    
    // Mark file as being processed
    processedFiles.set(fileId, { 
      timestamp: Date.now(),
      status: 'processing'
    });
    
    try {
      // Add the file to the watcher's queue
      await watcher.addFile(filePath);
      
      // Update status to 'processed'
      processedFiles.set(fileId, {
        timestamp: Date.now(),
        status: 'processed'
      });
      
      logger.success(`Successfully queued file: ${filePath}`);
    } catch (err) {
      logger.error(`Error adding file to queue: ${err.message}`);
      
      // Update status to 'error'
      processedFiles.set(fileId, {
        timestamp: Date.now(),
        status: 'error',
        error: err.message
      });
    }
  };

  // Initialize the watcher
  fileWatcher = createNewWatcher();

  // Function to safely recreate watcher
  const recreateWatcher = async () => {
    logger.warn('Recreating file watcher...');
    
    try {
      if (fileWatcher) {
        try {
          await fileWatcher.close();
          logger.info('Closed old watcher');
        } catch (err) {
          logger.error(`Error closing watcher:`, err.message);
        }
      }
      
      fileWatcher = createNewWatcher();
      logger.success('Watcher recreated successfully');
      
      // Wait for the ready event or timeout after 30 seconds
      await Promise.race([
        new Promise(resolve => fileWatcher.once('ready', resolve)),
        new Promise(resolve => setTimeout(resolve, 30000))
      ]);
      
      return true;
    } catch (err) {
      logger.error(`Error recreating watcher:`, err.message);
      return false;
    }
  };

  // Function to perform a manual directory scan
  const performManualScan = async () => {
    logger.debug('Performing manual directory scan');
    
    try {
      const dirents = await fs.promises.readdir(WATCH_DIR, { withFileTypes: true });
      
      for (const dirent of dirents) {
        if (!dirent.isFile()) continue;
        
        const filePath = path.join(WATCH_DIR, dirent.name);
        
        try {
          const stats = await fs.promises.stat(filePath);
          
          // Don't reprocess files that are being processed or were recently processed
          const fileId = `${filePath}:${stats.size}:${stats.mtimeMs}`;
          
          if (processedFiles.has(fileId)) {
            const fileInfo = processedFiles.get(fileId);
            
            if (fileInfo.status === 'processing' || 
                (fileInfo.status === 'processed' && Date.now() - fileInfo.timestamp < 3600000)) {
              continue;
            }
          }
          
          await processFile(filePath, stats);
        } catch (err) {
          logger.error(`Error processing file during scan (${filePath}):`, err.message);
        }
      }
    } catch (err) {
      logger.error(`Error reading watch directory:`, err.message);
    }
  };

  // Health check and task processing
  setInterval(async () => {
    // Check watcher health based on multiple criteria
    const watcherRuntime = Date.now() - watcherStartTime;
    
    const needsRecreation = 
      !watcherHealthy || 
      consecutiveErrorCount > 5 ||
      watcherRuntime > 86400000; // Recreate watcher every 24 hours for good measure
    
    if (needsRecreation) {
      logger.warn(`Watcher needs recreation. Healthy: ${watcherHealthy}, Errors: ${consecutiveErrorCount}, Runtime: ${Math.floor(watcherRuntime / 60000)}m`);
      await recreateWatcher();
    }
    
    // If it's been a while since a file was processed, do a manual check
    const timeSinceLastFile = Date.now() - lastFileAddedTime;
    if (timeSinceLastFile > 60000) { // 60 seconds
      await performManualScan();
    }

    // Check the torrent watch list
    try {
      await watcher.checkWatchList();
    } catch (err) {
      logger.error(`Error checking watch list:`, err.message);
    }
  }, WATCH_RATE);

  // Clean up old entries in the processed files set
  setInterval(() => {
    const now = Date.now();
    let cleanupCount = 0;
    
    // Remove entries older than 24 hours
    for (const [fileId, info] of processedFiles.entries()) {
      if (now - info.timestamp > 86400000) {
        processedFiles.delete(fileId);
        cleanupCount++;
      }
    }
    
    if (cleanupCount > 0) {
      logger.info(`Cleaned up ${cleanupCount} old processed file entries`);
    }
  }, 3600000); // Every hour

  // Handle process termination gracefully
  const gracefulShutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    
    // Close file watcher
    if (fileWatcher) {
      try {
        await fileWatcher.close();
        logger.info('File watcher closed');
      } catch (err) {
        logger.error(`Error closing file watcher:`, err.message);
      }
    }
    
    // Clean up offcloud watcher
    if (watcher) {
      try {
        watcher.cleanup();
        logger.info('Offcloud watcher cleaned up');
      } catch (err) {
        logger.error(`Error cleaning up offcloud watcher:`, err.message);
      }
    }
    
    logger.info('Shutdown complete');
    process.exit(0);
  };

  // Register shutdown handlers
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception:`, err);
    // Don't exit, try to keep the process running
  });
  
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled promise rejection:`, reason);
    // Don't exit, try to keep the process running
  });

})().catch(err => {
  logger.error("Error during application startup:", err.message);
  process.exit(1);
});