const chokidar = require('chokidar')
const OffCloudWatcher = require('./lib/watchers/offcloud')
const Downloader = require('./lib/downloaders/inline')
const fs = require('fs')
const path = require('path')

const {
  OFFCLOUD_API_KEY,
  WATCH_DIR = '/watch',
  DOWNLOAD_DIR = '/download', // Keep for backward compatibility
  IN_PROGRESS_DIR = '/in-progress',
  COMPLETED_DIR = '/completed',
  WATCH_RATE = 5000
} = process.env

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

// Create a watcher instance
const watcher = new OffCloudWatcher(OFFCLOUD_API_KEY, downloader.download)

console.log(`[+] Watching '${WATCH_DIR}' for new nzbs, magnets and torrents`)

// Track watcher state
let watcherHealthy = true
let lastFileAddedTime = Date.now()

// Setup watcher with more robust configuration
const fileWatcher = chokidar.watch(`${WATCH_DIR}`, {
  persistent: true,
  ignoreInitial: false,
  awaitWriteFinish: true,
  ignored: '(?<![^/])\\.',
  depth: 99,
  usePolling: true,          // Add polling for more reliable detection
  interval: 1000,            // Check every second (adjust as needed)
  binaryInterval: 3000,      // Interval for binary files
  alwaysStat: true,          // Always use fs.stat to check for changes
  atomic: 500                // Treat all events as newer than 500ms as atomic
})

// Handle file add event
fileWatcher.on('add', path => {
  console.log(`[+] Detected new file: '${path}'`)
  lastFileAddedTime = Date.now()
  
  if (path.indexOf('/.') !== -1 || path.indexOf('.queued') !== -1) {
    console.log(`Ignoring '${path}' because it is a work file`)
  } else if (path.indexOf('.torrent') !== -1 || path.indexOf('.magnet') !== -1 || path.indexOf('.nzb') !== -1) {
    watcher.addFile(path)
  } else {
    console.log(`Ignoring '${path}' because it has an unknown extension`)
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

// Periodic backup scan of the directory to ensure no files are missed
setInterval(() => {
  // Check watcher health
  if (!watcherHealthy) {
    console.log('[!] Watcher appears unhealthy, attempting to recover...')
    try {
      fileWatcher.close().then(() => {
        fileWatcher = chokidar.watch(`${WATCH_DIR}`, {
          persistent: true,
          ignoreInitial: false,
          awaitWriteFinish: true,
          ignored: '(?<![^/])\\.',
          depth: 99,
          usePolling: true,
          interval: 1000,
          binaryInterval: 3000,
          alwaysStat: true,
          atomic: 500
        })
      })
    } catch (err) {
      console.log(`[!] Error attempting to recover watcher: ${err}`)
    }
  }

  // If it's been a while since a file was processed, do a manual check
  const timeSinceLastFile = Date.now() - lastFileAddedTime
  if (timeSinceLastFile > 30000) { // 30 seconds
    console.log('[+] Performing periodic directory scan')
    
    // Manual scan for new files that might have been missed
    fs.readdir(WATCH_DIR, (err, files) => {
      if (err) {
        console.log(`[!] Error reading directory: ${err}`)
        return
      }
      
      files.forEach(file => {
        const filePath = path.join(WATCH_DIR, file)
        
        // Check if file is already being processed
        const isAlreadyProcessing = watcher.watchList.some(torrent => torrent.file === filePath)
        
        if (!isAlreadyProcessing) {
          if (file.indexOf('.torrent') !== -1 || file.indexOf('.magnet') !== -1 || file.indexOf('.nzb') !== -1) {
            console.log(`[+] Found unprocessed file during scan: '${filePath}'`)
            watcher.addFile(filePath)
          }
        }
      })
    })
    
    // Update timestamp to avoid too many manual scans
    lastFileAddedTime = Date.now()
  }

  // Check the torrent watch list
  watcher.checkWatchList()
}, WATCH_RATE)

// Handle process termination
process.on('SIGINT', () => {
  console.log('Closing watchers and exiting...')
  fileWatcher.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('Closing watchers and exiting...')
  fileWatcher.close()
  process.exit(0)
})