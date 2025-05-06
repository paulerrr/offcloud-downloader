const chokidar = require('chokidar')
const OffCloudWatcher = require('./lib/watchers/offcloud')
const Downloader = require('./lib/downloaders/inline')
const fs = require('fs')
const path = require('path')
const logger = require('./lib/utils/logger')
const fileOps = require('./lib/utils/fileOperations')
const { withRetry, sleep } = require('./lib/utils/retry')

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
} = process.env

// Convert string env vars to numbers
const WATCH_RATE = parseInt(watchRateStr, 10) || 5000
const MAX_CONCURRENT_DOWNLOADS = parseInt(maxDownloadsStr, 10) || 3
const FILE_POLL_INTERVAL = parseInt(pollIntervalStr, 10) || 1000
const FILE_STABLE_TIME = parseInt(stableTimeStr, 10) || 5000

if (!OFFCLOUD_API_KEY) {
  logger.error('OFFCLOUD_API_KEY environment variable is not set')
  process.exit(-1)
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
  // Note: DOWNLOAD_DIR is kept as parameter for compatibility but not used
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
    MAX_CONCURRENT_DOWNLOADS  // Now a number, not a string
  )

  logger.info(`Watching '${WATCH_DIR}' for new nzbs, magnets and torrents`)

  // Track watcher state
  let watcherHealthy = true
  let lastFileAddedTime = Date.now()

  // Set to track files that are being processed or have been processed
  const processedFiles = new Set();

  // Setup watcher with more robust configuration
  const createNewWatcher = () => {
    const watcher = chokidar.watch(`${WATCH_DIR}`, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: FILE_STABLE_TIME,
        pollInterval: FILE_POLL_INTERVAL
      },
      ignored: [
        /(^|[\/\\])\../,  // Ignore dotfiles
        '**/*.queued',     // Ignore .queued files
        '**/*.part',       // Ignore partial downloads
        '**/*.downloading' // Ignore downloading files
      ],
      depth: 99,
      usePolling: true,
      interval: FILE_POLL_INTERVAL,
      binaryInterval: 3000,
      alwaysStat: true,
      atomic: 500
    });
    
    return watcher;
  };
  
  // Process a file once detected
  const processFile = async (filePath) => {
    logger.info(`Detected new file: '${filePath}'`)
    lastFileAddedTime = Date.now()
    
    // Check if this file is already being processed
    if (processedFiles.has(filePath)) {
      logger.warn(`File '${filePath}' is already being processed, skipping`);
      return;
    }
    
    // Skip hidden files, .queued files, and other special files
    if (path.basename(filePath).startsWith('.') || 
        filePath.indexOf('.queued') !== -1 || 
        filePath.indexOf('.part') !== -1 || 
        filePath.indexOf('.downloading') !== -1) {
      logger.debug(`Ignoring '${filePath}' because it is a work file or hidden file`);
      return;
    }
    
    // Check for supported file extensions
    const extension = path.extname(filePath).toLowerCase();
    if (['.torrent', '.magnet', '.nzb'].includes(extension)) {
      // Mark the file as processed to avoid duplicates
      processedFiles.add(filePath);
      
      // Add the file to the watcher's queue
      try {
        await watcher.addFile(filePath);
      } catch (err) {
        logger.error(`Error adding file to queue: ${err.message}`);
      }
      
      // Set a timeout to remove from processed files list after a while 
      // (in case the file was replaced with a new one)
      setTimeout(() => {
        processedFiles.delete(filePath);
      }, 3600000); // 1 hour
    } else {
      logger.warn(`Ignoring '${filePath}' because it has an unknown extension (${extension})`);
    }
  };

  let fileWatcher = createNewWatcher();

  // Handle file add event
  fileWatcher.on('add', processFile);

  // Handle errors
  fileWatcher.on('error', error => {
    logger.error(`Watcher error:`, error)
    watcherHealthy = false
  })

  // Handle watcher ready state
  fileWatcher.on('ready', () => {
    logger.success('Initial scan complete. Ready for changes')
    watcherHealthy = true
  })

  // Create function to safely recreate watcher
  const recreateWatcher = async () => {
    try {
      if (fileWatcher) {
        try {
          await fileWatcher.close();
          logger.info('Closed old watcher, creating new one');
        } catch (err) {
          logger.error(`Error closing watcher:`, err.message);
        }
      }
      
      fileWatcher = createNewWatcher();
      
      // Reattach event handlers
      fileWatcher.on('add', processFile);
      
      fileWatcher.on('error', error => {
        logger.error(`Watcher error:`, error);
        watcherHealthy = false;
      });
      
      fileWatcher.on('ready', () => {
        logger.success('Initial scan complete. Ready for changes');
        watcherHealthy = true;
      });
      
      logger.success('Watcher recreated successfully');
    } catch (err) {
      logger.error(`Error recreating watcher:`, err.message);
    }
  };

  // Function to perform a manual directory scan
  const performManualScan = async () => {
    logger.debug('Performing periodic directory scan');
    
    try {
      // Manual scan for new files that might have been missed
      const dirents = await fs.promises.readdir(WATCH_DIR, { withFileTypes: true });
      
      // Process each file in the directory
      for (const dirent of dirents) {
        // Skip directories and non-files
        if (!dirent.isFile()) continue;
        
        const fileName = dirent.name;
        const filePath = path.join(WATCH_DIR, fileName);
        
        // Skip already processed files and hidden files
        if (processedFiles.has(filePath) || fileName.startsWith('.') || 
            fileName.includes('.queued') || fileName.includes('.part') || 
            fileName.includes('.downloading')) {
          continue;
        }
        
        // Check if file is a supported type
        const extension = path.extname(fileName).toLowerCase();
        if (['.torrent', '.magnet', '.nzb'].includes(extension)) {
          // Check if file is already being processed by the watcher
          // Updated check to properly handle Set vs Map for processingRequests
          const isAlreadyProcessing = watcher.watchList.some(torrent => torrent.file === filePath) ||
                                     (watcher.queueManager && watcher.queueManager.processingRequests && 
                                      (watcher.queueManager.processingRequests instanceof Set ? 
                                       watcher.queueManager.processingRequests.has(filePath) : 
                                       Array.from(watcher.queueManager.processingRequests.keys ? 
                                                 watcher.queueManager.processingRequests.keys() : 
                                                 []).includes(filePath)));
          
          if (!isAlreadyProcessing) {
            logger.info(`Found unprocessed file during scan: '${filePath}'`);
            await processFile(filePath);
          }
        }
      }
    } catch (err) {
      logger.error(`Error reading directory:`, err.message);
    }
    
    // Update timestamp to avoid too many manual scans
    lastFileAddedTime = Date.now();
  };

  // Periodic backup scan of the directory to ensure no files are missed
  setInterval(async () => {
    // Check watcher health
    if (!watcherHealthy) {
      logger.warn('Watcher appears unhealthy, attempting to recover...');
      await recreateWatcher();
    }

    // If it's been a while since a file was processed, do a manual check
    const timeSinceLastFile = Date.now() - lastFileAddedTime;
    if (timeSinceLastFile > 30000) { // 30 seconds
      await performManualScan();
    }

    // Check the torrent watch list
    await watcher.checkWatchList();
  }, WATCH_RATE);

  // Clean up old entries in the processed files set
  setInterval(() => {
    const oldSize = processedFiles.size;
    if (oldSize > 1000) {
      logger.info(`Cleaning up processed files cache (${oldSize} entries)`);
      processedFiles.clear();
    }
  }, 3600000); // Every hour

  // Handle process termination
  const gracefulShutdown = async (signal) => {
    logger.info(`Received ${signal}, closing watchers and exiting...`);
    
    if (fileWatcher) {
      try {
        await fileWatcher.close();
      } catch (err) {
        logger.error(`Error closing file watcher:`, err.message);
      }
    }
    
    if (watcher) {
      try {
        watcher.cleanup();
      } catch (err) {
        logger.error(`Error cleaning up watcher:`, err.message);
      }
    }
    
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
})().catch(err => {
  logger.error("Error during application startup:", err.message);
  process.exit(1);
});