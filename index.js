const chokidar = require('chokidar')
const OffCloudWatcher = require('./lib/watchers/offcloud')
const Downloader = require('./lib/downloaders/inline')
const fs = require('fs')
const path = require('path')

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
  console.log('[!] OFFCLOUD_API_KEY env var is not set')
  process.exit(-1)
}

// Ensure all required directories exist
for (const dir of [WATCH_DIR, IN_PROGRESS_DIR, COMPLETED_DIR]) {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[+] Created directory: ${dir}`);
    } catch (err) {
      console.log(`[!] Error creating directory ${dir}: ${err.message}`);
    }
  }
}

// Create a downloader instance with the new directories
// Note: DOWNLOAD_DIR is kept as parameter for compatibility but not used
const downloader = new Downloader(WATCH_DIR, DOWNLOAD_DIR, IN_PROGRESS_DIR, COMPLETED_DIR);

console.log(`[+] Download configuration:`);
console.log(`    Watch directory: ${WATCH_DIR}`);
console.log(`    In-progress directory: ${IN_PROGRESS_DIR}`);
console.log(`    Completed directory: ${COMPLETED_DIR}`);
console.log(`    Max concurrent downloads: ${MAX_CONCURRENT_DOWNLOADS}`);
console.log(`    File poll interval: ${FILE_POLL_INTERVAL}ms`);
console.log(`    File stability threshold: ${FILE_STABLE_TIME}ms`);

// Create a watcher instance with the queue system
const watcher = new OffCloudWatcher(
  OFFCLOUD_API_KEY, 
  downloader.download,
  MAX_CONCURRENT_DOWNLOADS  // Now a number, not a string
)

console.log(`[+] Watching '${WATCH_DIR}' for new nzbs, magnets and torrents`)

// Track watcher state
let watcherHealthy = true
let lastFileAddedTime = Date.now()

// Set to track files that are being processed or have been processed
const processedFiles = new Set();

// Setup watcher with more robust configuration
let fileWatcher = chokidar.watch(`${WATCH_DIR}`, {
  persistent: true,
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: FILE_STABLE_TIME,  // Now a number, not a string
    pollInterval: FILE_POLL_INTERVAL       // Now a number, not a string
  },
  ignored: [
    /(^|[\/\\])\../,  // Ignore dotfiles
    '**/*.queued',     // Ignore .queued files
    '**/*.part',       // Ignore partial downloads
    '**/*.downloading' // Ignore downloading files
  ],
  depth: 99,
  usePolling: true,          // Add polling for more reliable detection
  interval: FILE_POLL_INTERVAL,  // Now a number, not a string
  binaryInterval: 3000,      // Interval for binary files
  alwaysStat: true,          // Always use fs.stat to check for changes
  atomic: 500                // Treat all events as newer than 500ms as atomic
})

// Handle file add event
fileWatcher.on('add', filePath => {
  console.log(`[+] Detected new file: '${filePath}'`)
  lastFileAddedTime = Date.now()
  
  // Check if this file is already being processed
  if (processedFiles.has(filePath)) {
    console.log(`[!] File '${filePath}' is already being processed, skipping`);
    return;
  }
  
  // Skip hidden files, .queued files, and other special files
  if (path.basename(filePath).startsWith('.') || 
      filePath.indexOf('.queued') !== -1 || 
      filePath.indexOf('.part') !== -1 || 
      filePath.indexOf('.downloading') !== -1) {
    console.log(`[!] Ignoring '${filePath}' because it is a work file or hidden file`);
    return;
  }
  
  // Check for supported file extensions
  const extension = path.extname(filePath).toLowerCase();
  if (['.torrent', '.magnet', '.nzb'].includes(extension)) {
    // Mark the file as processed to avoid duplicates
    processedFiles.add(filePath);
    
    // Add the file to the watcher's queue
    watcher.addFile(filePath);
    
    // Set a timeout to remove from processed files list after a while 
    // (in case the file was replaced with a new one)
    setTimeout(() => {
      processedFiles.delete(filePath);
    }, 3600000); // 1 hour
  } else {
    console.log(`[!] Ignoring '${filePath}' because it has an unknown extension`);
  }
})

// Handle errors
fileWatcher.on('error', error => {
  console.log(`[!] Watcher error: ${error}`)
  watcherHealthy = false
})

// Handle watcher ready state
fileWatcher.on('ready', () => {
  console.log('[+] Initial scan complete. Ready for changes')
  watcherHealthy = true
})

// Create function to safely recreate watcher
const recreateWatcher = () => {
  try {
    if (fileWatcher) {
      fileWatcher.close().then(() => {
        console.log('[+] Closed old watcher, creating new one');
        createNewWatcher();
      }).catch(err => {
        console.log(`[!] Error closing watcher: ${err.message}`);
        // Create new watcher anyway
        createNewWatcher();
      });
    } else {
      createNewWatcher();
    }
  } catch (err) {
    console.log(`[!] Error recreating watcher: ${err.message}`);
    createNewWatcher();
  }
};

// Function to create a new watcher
const createNewWatcher = () => {
  fileWatcher = chokidar.watch(`${WATCH_DIR}`, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: FILE_STABLE_TIME,  // Now a number, not a string
      pollInterval: FILE_POLL_INTERVAL       // Now a number, not a string
    },
    ignored: [
      /(^|[\/\\])\../,  // Ignore dotfiles
      '**/*.queued',     // Ignore .queued files
      '**/*.part',       // Ignore partial downloads
      '**/*.downloading' // Ignore downloading files
    ],
    depth: 99,
    usePolling: true,
    interval: FILE_POLL_INTERVAL,  // Now a number, not a string
    binaryInterval: 3000,
    alwaysStat: true,
    atomic: 500
  });
  
  // Reattach event handlers
  fileWatcher.on('add', filePath => {
    console.log(`[+] Detected new file: '${filePath}'`)
    lastFileAddedTime = Date.now()
    
    // Check if this file is already being processed
    if (processedFiles.has(filePath)) {
      console.log(`[!] File '${filePath}' is already being processed, skipping`);
      return;
    }
    
    // Skip hidden files, .queued files, and other special files
    if (path.basename(filePath).startsWith('.') || 
        filePath.indexOf('.queued') !== -1 || 
        filePath.indexOf('.part') !== -1 || 
        filePath.indexOf('.downloading') !== -1) {
      console.log(`[!] Ignoring '${filePath}' because it is a work file or hidden file`);
      return;
    }
    
    // Check for supported file extensions
    const extension = path.extname(filePath).toLowerCase();
    if (['.torrent', '.magnet', '.nzb'].includes(extension)) {
      // Mark the file as processed to avoid duplicates
      processedFiles.add(filePath);
      
      // Add the file to the watcher's queue
      watcher.addFile(filePath);
      
      // Set a timeout to remove from processed files list after a while 
      setTimeout(() => {
        processedFiles.delete(filePath);
      }, 3600000); // 1 hour
    } else {
      console.log(`[!] Ignoring '${filePath}' because it has an unknown extension`);
    }
  });
  
  fileWatcher.on('error', error => {
    console.log(`[!] Watcher error: ${error}`);
    watcherHealthy = false;
  });
  
  fileWatcher.on('ready', () => {
    console.log('[+] Initial scan complete. Ready for changes');
    watcherHealthy = true;
  });
};

// Periodic backup scan of the directory to ensure no files are missed
setInterval(() => {
  // Check watcher health
  if (!watcherHealthy) {
    console.log('[!] Watcher appears unhealthy, attempting to recover...')
    recreateWatcher();
  }

  // If it's been a while since a file was processed, do a manual check
  const timeSinceLastFile = Date.now() - lastFileAddedTime
  if (timeSinceLastFile > 30000) { // 30 seconds
    console.log('[+] Performing periodic directory scan')
    
    // Manual scan for new files that might have been missed
    fs.readdir(WATCH_DIR, { withFileTypes: true }, (err, dirents) => {
      if (err) {
        console.log(`[!] Error reading directory: ${err.message}`)
        return
      }
      
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
            console.log(`[+] Found unprocessed file during scan: '${filePath}'`);
            
            // Add to processed set to prevent duplicates
            processedFiles.add(filePath);
            
            // Add the file to the queue
            watcher.addFile(filePath);
            
            // Set a timeout to remove from processed files after a while
            setTimeout(() => {
              processedFiles.delete(filePath);
            }, 3600000); // 1 hour
          }
        }
      }
    });
    
    // Update timestamp to avoid too many manual scans
    lastFileAddedTime = Date.now()
  }

  // Check the torrent watch list
  watcher.checkWatchList()
}, WATCH_RATE)

// Clean up old entries in the processed files set
setInterval(() => {
  const oldSize = processedFiles.size;
  if (oldSize > 1000) {
    console.log(`[+] Cleaning up processed files cache (${oldSize} entries)`);
    processedFiles.clear();
  }
}, 3600000); // Every hour

// Handle process termination
process.on('SIGINT', () => {
  console.log('Closing watchers and exiting...')
  if (fileWatcher) {
    try {
      fileWatcher.close()
    } catch (err) {
      console.log(`[!] Error closing file watcher: ${err.message}`);
    }
  }
  
  if (watcher) {
    try {
      watcher.cleanup()
    } catch (err) {
      console.log(`[!] Error cleaning up watcher: ${err.message}`);
    }
  }
  
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('Closing watchers and exiting...')
  if (fileWatcher) {
    try {
      fileWatcher.close()
    } catch (err) {
      console.log(`[!] Error closing file watcher: ${err.message}`);
    }
  }
  
  if (watcher) {
    try {
      watcher.cleanup()
    } catch (err) {
      console.log(`[!] Error cleaning up watcher: ${err.message}`);
    }
  }
  
  process.exit(0)
})