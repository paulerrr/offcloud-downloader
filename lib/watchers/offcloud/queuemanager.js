// Queue manager for Offcloud downloads
import debug from 'debug';
const log = debug('patbrid:watchers:offcloud:queue');
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import logger from '../../utils/logger.js';
import { withRetry, sleep } from '../../utils/retry.js';
import fileOps from '../../utils/fileOperations.js';

class OffCloudQueueManager {
  constructor(client, maxConcurrentDownloads = 3) {
    log('Initializing queue manager');
    this.client = client;
    this.queue = [];
    this.maxConcurrentDownloads = maxConcurrentDownloads;
    this.activeDownloads = 0;
    this.lastStorageCheck = 0;
    this.storageInfo = null;
    this.isProcessing = false;
    this.minStorageRequired = 500 * 1024 * 1024; // 500MB minimum free space
    this.downloadHistory = [];
    this.cleanupInterval = null;
    this.processedFilesCleanupInterval = null;
    
    // Track processed files to prevent duplicates
    this.processedFiles = new Map(); // Map of file path to { hash, timestamp }
    this.processingRequests = new Set(); // Set of file paths currently being processed
    
    // Start periodic cleanup of completed downloads
    this.startPeriodicCleanup();
    
    logger.debug(`Queue manager initialized with max ${maxConcurrentDownloads} concurrent downloads`);
  }

  /**
   * Generate a hash of a file for tracking
   * @param {string} filePath - Path to the file
   * @returns {string} - MD5 hash of the file
   */
  async getFileHash(filePath) {
    try {
      const fileBuffer = await fs.promises.readFile(filePath);
      return crypto.createHash('md5').update(fileBuffer).digest('hex');
    } catch (err) {
      logger.error(`Error generating file hash for ${filePath}:`, err.message);
      // Fall back to file size and modification time if can't read file
      try {
        const stats = await fs.promises.stat(filePath);
        return `${stats.size}-${stats.mtimeMs}`;
      } catch (statErr) {
        logger.error(`Error getting file stats:`, statErr.message);
        return Date.now().toString(); // Last resort fallback
      }
    }
  }
  
  /**
   * Check if a file has already been processed recently
   * @param {string} filePath - Path to the file
   * @returns {Promise<boolean>} - True if file has been processed, false otherwise
   */
  async isFileProcessed(filePath) {
    // If file is currently being processed, consider it processed
    if (this.processingRequests.has(filePath)) {
      logger.warn(`File ${filePath} is already being processed`);
      return true;
    }
    
    // Check if file is in our processed history
    if (this.processedFiles.has(filePath)) {
      const fileInfo = this.processedFiles.get(filePath);
      const currentHash = await this.getFileHash(filePath);
      
      // If hash matches and it was processed in the last hour, consider it processed
      if (fileInfo.hash === currentHash && 
          (Date.now() - fileInfo.timestamp) < 3600000) {
        logger.warn(`File ${filePath} was already processed recently`);
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Mark a file as processed
   * @param {string} filePath - Path to the file
   */
  async markFileAsProcessed(filePath) {
    try {
      const hash = await this.getFileHash(filePath);
      this.processedFiles.set(filePath, {
        hash,
        timestamp: Date.now()
      });
      logger.info(`Marked file ${filePath} as processed`);
      
      // Clean up old entries if the map gets too large
      if (this.processedFiles.size > 1000) {
        const now = Date.now();
        for (const [path, info] of this.processedFiles.entries()) {
          if (now - info.timestamp > 86400000) { // older than 24 hours
            this.processedFiles.delete(path);
          }
        }
      }
    } catch (err) {
      logger.error(`Error marking file as processed:`, err.message);
    }
  }

  /**
   * Start periodic cleanup of completed downloads from Offcloud
   * to free up storage space
   */
  startPeriodicCleanup() {
    // Run cleanup every hour
    this.cleanupInterval = setInterval(() => {
      this.cleanupCompletedDownloads();
    }, 60 * 60 * 1000); // Every hour
    
    // Add periodic cleanup for processed files map
    this.processedFilesCleanupInterval = setInterval(() => {
      const now = Date.now();
      let count = 0;
      
      for (const [path, info] of this.processedFiles.entries()) {
        if (now - info.timestamp > 86400000) { // Older than 24 hours
          this.processedFiles.delete(path);
          count++;
        }
      }
      
      if (count > 0) {
        logger.debug(`Cleaned up ${count} entries from processed files cache`);
      }
    }, 3600000); // Every hour
    
    logger.debug('Scheduled periodic cleanup of completed downloads and processed files cache');
  }
  
  /**
   * Cleanup completed downloads that are older than the specified age
   * @param {number} maxAgeHours - Maximum age in hours before cleaning up
   */
  async cleanupCompletedDownloads(maxAgeHours = 24) {
    log('Running cleanup of completed downloads');
    logger.info(`Running cleanup of completed downloads older than ${maxAgeHours} hours`);
    
    try {
      // Get cloud history
      const history = await this.client.cloudHistory();
      
      if (!Array.isArray(history)) {
        logger.error('Invalid history format received from API');
        return;
      }
      
      const now = Date.now();
      let cleanedCount = 0;
      let cleanedSpace = 0;
      let retryErrors = 0;
      
      // Find downloads that are completed and older than maxAgeHours
      for (const item of history) {
        if (item.status === 'downloaded' && item.fileSize) {
          const createdDate = new Date(item.createdOn).getTime();
          const ageHours = (now - createdDate) / (1000 * 60 * 60);
          
          if (ageHours > maxAgeHours) {
            try {
              // Use our retry utility to delete items
              await withRetry(
                async () => await this.client.delete(item.requestId),
                {
                  maxRetries: 3,
                  baseDelay: 1000,
                  operationName: `Delete old download ${item.fileName}`
                }
              );
              
              cleanedCount++;
              if (item.fileSize) {
                cleanedSpace += parseInt(item.fileSize, 10);
              }
              
              logger.success(`Cleaned up old download: ${item.fileName} (${item.requestId})`);
            } catch (err) {
              logger.error(`Error cleaning up download ${item.requestId}:`, err.message);
              retryErrors++;
            }
          }
        }
      }
      
      if (cleanedCount > 0) {
        logger.success(`Cleaned up ${cleanedCount} old downloads, freed ${(cleanedSpace / (1024 * 1024)).toFixed(2)}MB of space`);
        // Force storage check refresh
        this.lastStorageCheck = 0;
      } else if (retryErrors === 0) {
        logger.debug('No old downloads to clean up');
      } else {
        logger.warn(`Attempted to clean up downloads but encountered ${retryErrors} errors`);
      }
    } catch (err) {
      logger.error(`Error during cleanup:`, err.message);
    }
  }

  /**
   * Add a file to the download queue
   * @param {string} file - Path to the file
   * @param {function} processFunction - Function to call to process the file
   * @returns {Promise} - Promise that resolves when file is queued
   */
  async addToQueue(file, processFunction) {
    log('addToQueue', file);
    
    // Check if this file is already being processed or was recently processed
    if (await this.isFileProcessed(file)) {
      logger.warn(`Skipping ${file} as it's already processed or being processed`);
      return;
    }
    
    // Mark that we're processing this file
    this.processingRequests.add(file);
    
    try {
      const extension = path.extname(file).toLowerCase();
      const queueItem = {
        file,
        extension,
        processFunction,
        addedTime: Date.now(),
        status: 'queued',
        priority: 1, // Default priority
        retries: 0,
        maxRetries: 3
      };
      
      // Read file size to estimate needed storage
      try {
        const stats = await fs.promises.stat(file);
        queueItem.fileSize = stats.size;
        // For torrents/magnets/nzbs, the actual download size will likely be much larger
        // We'll use a multiplier as an estimate
        if (extension === '.torrent' || extension === '.magnet' || extension === '.nzb') {
          queueItem.estimatedSize = stats.size * 1000; // Rough estimate
        } else {
          queueItem.estimatedSize = stats.size;
        }
      } catch (err) {
        logger.error(`Error reading file size:`, err.message);
        queueItem.fileSize = 0;
        queueItem.estimatedSize = 0;
      }
      
      // Mark file as processed to prevent duplicates
      await this.markFileAsProcessed(file);
      
      // Add to queue
      this.queue.push(queueItem);
      logger.info(`Added '${file}' to download queue (position: ${this.queue.length})`);
      
      // Start processing the queue if not already processing
      if (!this.isProcessing) {
        this.processQueue();
      }
    } finally {
      // If something goes wrong during queue addition, clean up the processing marker
      if (this.processingRequests.has(file) && this.queue.findIndex(item => item.file === file) === -1) {
        this.processingRequests.delete(file);
      }
    }
  }
  
  /**
   * Process the queue, respecting storage constraints
   */
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    try {
      // Check current storage status using cloud history (not account info)
      await this.updateStorageFromHistory();
      
      // Process queue items while there's available storage and we're under max concurrent downloads
      while (this.queue.length > 0 && this.activeDownloads < this.maxConcurrentDownloads) {
        const nextItem = this.getNextItem();
        if (!nextItem) break;
        
        // Check if we have enough storage
        if (!this.hasEnoughStorage(nextItem.estimatedSize)) {
          logger.warn(`Not enough storage available on Offcloud. Waiting for space to free up.`);
          logger.info(`Current queue length: ${this.queue.length} items, will retry later.`);
          
          // If we have a lot of items queued and not enough storage, try cleanup
          if (this.queue.length > 5) {
            logger.info(`Attempting to clean up old downloads to free space...`);
            await this.cleanupCompletedDownloads(12); // Try cleaning downloads older than 12 hours
            
            // Re-check storage
            await this.updateStorageFromHistory();
            if (this.hasEnoughStorage(nextItem.estimatedSize)) {
              logger.success(`Cleanup successful, continuing with queue processing`);
            } else {
              break; // Still not enough storage
            }
          } else {
            break; // Not enough storage and not many queued items
          }
        }
        
        // Process the item
        this.activeDownloads++;
        nextItem.status = 'processing';
        
        try {
          logger.info(`Processing queued file: ${nextItem.file} (${this.activeDownloads}/${this.maxConcurrentDownloads} active)`);
          
          // Use retry utility for processing
          await withRetry(
            async () => await nextItem.processFunction(nextItem.file),
            {
              maxRetries: nextItem.maxRetries - nextItem.retries,
              baseDelay: 5000,
              operationName: `Process ${nextItem.file}`
            }
          );
          
          this.removeFromQueue(nextItem);
        } catch (err) {
          logger.error(`Error processing ${nextItem.file}:`, err.message);
          nextItem.status = 'error';
          nextItem.lastError = err.message;
          nextItem.retries++;
          
          if (nextItem.retries >= nextItem.maxRetries) {
            logger.error(`Max retries reached for ${nextItem.file}, removing from queue`);
            this.removeFromQueue(nextItem);
          } else {
            // Put back in queue with lower priority
            nextItem.status = 'queued';
            nextItem.priority += 1;
            logger.info(`Requeued ${nextItem.file} for retry (attempt ${nextItem.retries}/${nextItem.maxRetries})`);
            
            // Add exponential backoff
            const backoffMs = Math.pow(2, nextItem.retries) * 5000;
            logger.debug(`Will retry after ${backoffMs/1000} seconds (backoff)`);
            await sleep(backoffMs);
          }
        } finally {
          this.activeDownloads = Math.max(0, this.activeDownloads - 1);
          // Remove from processing requests set
          this.processingRequests.delete(nextItem.file);
        }
      }
    } catch (err) {
      logger.error(`Error processing queue:`, err.message);
    } finally {
      this.isProcessing = false;
      
      // If there are still items in the queue and active downloads < max, process again
      if (this.queue.length > 0 && this.activeDownloads < this.maxConcurrentDownloads) {
        setTimeout(() => this.processQueue(), 5000);
      }
    }
  }
  
  /**
   * Get the next item to process based on priority and time added
   * @returns {Object|null} - Next queue item or null if none available
   */
  getNextItem() {
    if (this.queue.length === 0) return null;
    
    // Sort by priority (lower number = higher priority) and then by time added
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.addedTime - b.addedTime;
    });
    
    return this.queue[0];
  }
  
  /**
   * Remove an item from the queue
   * @param {Object} item - Queue item to remove
   */
  removeFromQueue(item) {
    const index = this.queue.findIndex(qItem => qItem.file === item.file);
    if (index !== -1) {
      this.queue.splice(index, 1);
      logger.info(`Removed '${item.file}' from download queue`);
      
      // Make sure to remove from processing set as well
      this.processingRequests.delete(item.file);
    }
  }
  
  /**
   * Update storage information from offcloud.com using cloud history only
   * Since the account info and limits endpoints don't work
   * @returns {Promise} - Promise that resolves when storage info is updated
   */
  async updateStorageFromHistory() {
    // Only update storage info if it's been more than 60 seconds since last check
    const now = Date.now();
    if (now - this.lastStorageCheck < 60000 && this.storageInfo) {
      return this.storageInfo;
    }
    
    try {
      // Get history and estimate storage usage
      const history = await this.client.cloudHistory();
      
      let usedSpace = 0;
      if (Array.isArray(history)) {
        history.forEach(item => {
          if (item.fileSize && item.status === 'downloaded') {
            usedSpace += parseInt(item.fileSize, 10);
          }
        });
      }
      
      // Assume a reasonable default total space
      // Since the account/limits endpoint doesn't work, we'll use a conservative estimate
      const totalSpace = 1024 * 1024 * 1024 * 50; // 50 GB limit for lifetime accounts
      
      this.storageInfo = {
        totalSpace: totalSpace,
        usedSpace: usedSpace,
        freeSpace: totalSpace - usedSpace,
        lastUpdated: now
      };
      
      this.lastStorageCheck = now;
      
      logger.info(`Storage info updated - Free: ${(this.storageInfo.freeSpace / (1024 * 1024)).toFixed(2)}MB, Used: ${(this.storageInfo.usedSpace / (1024 * 1024)).toFixed(2)}MB, Total: ${(this.storageInfo.totalSpace / (1024 * 1024)).toFixed(2)}MB`);
      
      return this.storageInfo;
    } catch (err) {
      logger.error(`Error getting storage info:`, err.message);
      
      // If we already have storage info, continue using it
      if (this.storageInfo) {
        logger.warn(`Using cached storage information from previous check`);
        return this.storageInfo;
      }
      
      // If we have no storage info, create a safe default
      this.storageInfo = {
        totalSpace: 1024 * 1024 * 1024 * 50, // 50GB
        usedSpace: 0,
        freeSpace: 1024 * 1024 * 1024 * 50, // 50GB
        lastUpdated: now
      };
      
      logger.warn(`Using default storage information due to error`);
      return this.storageInfo;
    }
  }
  
  /**
   * Check if there's enough storage for a download
   * @param {number} estimatedSize - Estimated size of the download
   * @returns {boolean} - True if there's enough storage, false otherwise
   */
  hasEnoughStorage(estimatedSize) {
    if (!this.storageInfo) return false;
    
    // Add a safety buffer to the estimated size
    const sizeWithBuffer = estimatedSize * 1.2; // 20% buffer for safety
    
    // Check if free space minus the minimum required is greater than the estimated size
    const hasEnough = (this.storageInfo.freeSpace - this.minStorageRequired) > sizeWithBuffer;
    
    if (!hasEnough) {
      logger.warn(`Storage check failed - Need: ${(sizeWithBuffer / (1024 * 1024)).toFixed(2)}MB, Available: ${((this.storageInfo.freeSpace - this.minStorageRequired) / (1024 * 1024)).toFixed(2)}MB`);
    }
    
    return hasEnough;
  }
  
  /**
   * Get current queue statistics
   * @returns {Object} - Queue statistics
   */
  getQueueStats() {
    return {
      queueLength: this.queue.length,
      activeDownloads: this.activeDownloads,
      pendingItems: this.queue.filter(item => item.status === 'queued').length,
      processingItems: this.queue.filter(item => item.status === 'processing').length,
      errorItems: this.queue.filter(item => item.status === 'error').length,
      storageInfo: this.storageInfo,
      processedFilesCount: this.processedFiles.size,
      processingRequestsCount: this.processingRequests.size
    };
  }
  
  /**
   * Handle download completion - should be called when a download is finished
   * This will trigger the queue to process more items if possible
   */
  downloadCompleted() {
    this.activeDownloads = Math.max(0, this.activeDownloads - 1);
    
    // Refresh storage info and process queue again
    this.lastStorageCheck = 0;
    
    // If not already processing, start processing the queue
    if (!this.isProcessing && this.queue.length > 0) {
      setTimeout(() => this.processQueue(), 2000);
    }
  }
  
  /**
   * Clean up resources when shutting down
   */
  cleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    if (this.processedFilesCleanupInterval) {
      clearInterval(this.processedFilesCleanupInterval);
    }
    
    logger.debug('Queue manager resources cleaned up');
  }
}

export default OffCloudQueueManager;