const fs = require('fs')
const path = require('path')
const debug = require('debug')('patbrid:watchers:offcloud')
const OffCloudAPI = require('./offcloudapi')
const OffCloudTorrent = require('./torrent')
const OffCloudQueueManager = require('./queuemanager')

class OffCloudWatcher {
  constructor (apiKey, downloadFn, maxConcurrentDownloads = 3) {
    debug('ctor', apiKey)

    this.client = new OffCloudAPI(apiKey)
    console.log('this.client ', this.client)
    this.downloadFn = downloadFn
    this.watchList = []
    
    // Initialize the queue manager
    this.queueManager = new OffCloudQueueManager(this.client, maxConcurrentDownloads)
    
    // Set interval to periodically check storage and process queue
    this.queueInterval = setInterval(() => {
      this.processQueue()
    }, 30000) // Check every 30 seconds
    
    // Set interval to periodically check for hung or stalled downloads
    this.healthCheckInterval = setInterval(() => {
      this.healthCheck()
    }, 300000) // Check every 5 minutes
  }
  
  /**
   * Process the download queue
   */
  async processQueue() {
    if (this.queueManager.queue.length > 0) {
      const stats = this.queueManager.getQueueStats()
      console.log(`[+] Queue status: ${stats.queueLength} items total, ${stats.activeDownloads} active, ${stats.pendingItems} pending`)
      
      // Trigger queue processing
      await this.queueManager.processQueue()
    }
  }
  
  /**
   * Perform health check on the watch list and queue
   * Check for stalled or hung downloads
   */
  async healthCheck() {
    // Check for stalled downloads in the watch list
    const now = Date.now()
    const stalledDownloads = this.watchList.filter(torrent => {
      // If a download has been in the 'downloading' state for more than 30 minutes
      return torrent.status === 'downloading' && 
             torrent.lastUpdate && 
             (now - torrent.lastUpdate > 1800000);
    });
    
    if (stalledDownloads.length > 0) {
      console.log(`[!] Found ${stalledDownloads.length} stalled downloads, forcing status check`);
      
      // Force check these stalled downloads
      for (const torrent of stalledDownloads) {
        torrent.lastUpdateFailed = false; // Reset the failure flag
        try {
          await torrent.update();
        } catch (err) {
          console.log(`[!] Error checking stalled download ${torrent.file}: ${err.message}`);
        }
      }
    }
    
    // Clean up any completed or hung processing requests
    this.queueManager.processingRequests.forEach((file, timestamp) => {
      if (now - timestamp > 3600000) { // Older than 1 hour
        console.log(`[!] Cleaning up stale processing request for ${file}`);
        this.queueManager.processingRequests.delete(file);
      }
    });
  }

  /**
   * Add a file to be processed
   * @param {string} file - Path to the file
   */
  async addFile(file) {
    debug('addFile', file)

    const extension = path.extname(file).toLowerCase()
    
    // Create a specialized processing function based on file type
    let processFunction
    
    if (extension === '.magnet') {
      processFunction = this.addMagnet.bind(this)
    } else {
      processFunction = this.addTorrent.bind(this)
    }
    
    // Add the file to the queue instead of processing immediately
    await this.queueManager.addToQueue(file, processFunction)
  }

  async addTorrent(file) {
    debug('addTorrent', file)
    console.log('processing file: ', file)

    try {
      // Create a torrent instance
      const torrent = new OffCloudTorrent(this.client, this.downloadFn, file)
      console.log('created file: ', file)
      
      // Set the completion callback to inform the queue manager
      torrent.onComplete = () => {
        this.queueManager.downloadCompleted()
        // Remove from watch list
        this.removeFromWatchList(torrent)
      }
      
      // Add the torrent to the queue
      await torrent.addToQueue();
      // Save to the watch list
      this.addToWatchList(torrent);
    } catch (err) {
      console.error('[!] addTorrent failed', err);
      
      // Notify queue manager of completion regardless of error
      // This ensures we don't block the queue
      this.queueManager.downloadCompleted();
      
      throw err;
    }
  }

  async addMagnet(file) {
    debug('addMagnet', file)

    try {
      const data = await fs.promises.readFile(file, 'utf8');
      
      // Create a torrent instance
      const torrent = new OffCloudTorrent(this.client, this.downloadFn, file, data);
      
      // Set the completion callback to inform the queue manager
      torrent.onComplete = () => {
        this.queueManager.downloadCompleted();
        // Remove from watch list
        this.removeFromWatchList(torrent);
      };

      // Add the torrent to the queue
      await torrent.addToQueue();
      // Save to the watch list
      this.addToWatchList(torrent);
    } catch (err) {
      console.error('[!] addTorrent failed', err);
      
      // Notify queue manager of completion regardless of error
      this.queueManager.downloadCompleted();
      
      throw err;
    }
  }

  async checkWatchList() {
    debug('checkWatchList', this.watchList.length)

    // Remove invalid torrents
    this.removeInvalidTorrents()

    try {
      // Go through each torrent and update it, but don't overwhelm the server with parallel requests
      // Use a more sequential approach with a small delay between requests
      for (const torrent of this.watchList) {
        try {
          await torrent.update();
          // Small delay between requests to avoid overwhelming the server
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) {
          console.error(`[!] Error updating torrent ${torrent.id}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error('[!] checkWatchList failed', err);
    }
  }

  addToWatchList(torrent) {
    debug('addToWatchList', torrent.file)

    // Check if this torrent is already in the watch list
    const existingIndex = this.watchList.findIndex(t => t.id === torrent.id || t.file === torrent.file);
    
    if (existingIndex >= 0) {
      console.log(`[!] Torrent ${torrent.file} already in watch list, not adding duplicate`);
      return;
    }
    
    // Add the torrent to the watch list
    this.watchList.push(torrent)
  }

  removeFromWatchList(torrent) {
    debug('removeFromWatchList', torrent.file)

    // Remove the torrent from the watch list
    const index = this.watchList.findIndex(t => t === torrent || t.id === torrent.id);

    if (index !== -1) {
      this.watchList.splice(index, 1)
      console.log(`[+] Removed torrent ${torrent.file} from watch list`);
    }
  }

  removeInvalidTorrents() {
    debug('removeInvalidTorrents')

    // Remove any invalid torrents from the watch list
    const initialCount = this.watchList.length;
    
    this.watchList = this.watchList.filter(torrent => {
      const isValid = torrent.status !== 'invalid';
      if (!isValid) {
        console.log(`[+] Removing invalid torrent ${torrent.file} from watch list`);
      }
      return isValid;
    });
    
    const removedCount = initialCount - this.watchList.length;
    if (removedCount > 0) {
      console.log(`[+] Removed ${removedCount} invalid torrents from watch list`);
    }
  }
  
  /**
   * Clean up resources when shutting down
   */
  cleanup() {
    if (this.queueInterval) {
      clearInterval(this.queueInterval)
    }
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
    }
    
    if (this.queueManager) {
      this.queueManager.cleanup()
    }
    
    console.log('[+] Cleaned up all watcher resources');
  }
}

module.exports = OffCloudWatcher