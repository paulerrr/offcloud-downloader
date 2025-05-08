import debug from 'debug';
const log = debug('patbrid:watchers:offcloud:torrent');
import fs from 'fs';
import path from 'path';
import querystring from 'querystring';
import logger from '../../utils/logger.js';
import { withRetry, sleep } from '../../utils/retry.js';
import fileOps from '../../utils/fileOperations.js';

class OffCloudTorrent {
  constructor (client, downloadFn, file, magnetlink = null) {
    log('ctor', file);

    this.client = client;
    this.downloadFn = downloadFn;
    this.file = file;
    this.alturl = '';
    this.status = 'pending';
    this.magnetlink = magnetlink;
    this.ariainfo = [];
    this.id = 0;
    this.isdir = false;
    this.onComplete = null; // Callback for completion notification
    this.lastUpdate = Date.now();
    this.updateRetries = 0;
    this.maxUpdateRetries = 5;
    this.remoteStatus = ''; // Track the remote status
    this.errorMessage = ''; // Track any error messages
  }

  async addToQueue() {
    log('addToQueue', this.file);
    logger.info(`Adding to queue: ${this.file}`);
    
    try {
      // Add the torrent file
      if (this.magnetlink != null) {
        // Use retry utility for adding to cloud
        const result = await withRetry(
          async () => await this.client.addCloud(this.magnetlink),
          {
            maxRetries: 3,
            baseDelay: 1000,
            operationName: `Add magnet link from ${this.file}`
          }
        );
        
        logger.debug('Add result:', result);
        this.id = result.requestId;
        this.status = 'queued';
        this.alturl = result.url;
        logger.success(`'${this.file}' added to queue (${this.id})`);
        
        return await this._beginDownload();
      } else {
        logger.info(`Adding file: ${this.file}`);
        
        // Use retry utility for file upload
        const result = await withRetry(
          async () => await this.client.addFile(this.file),
          {
            maxRetries: 3,
            baseDelay: 1000,
            operationName: `Upload file ${this.file}`
          }
        );
        
        if (result.success === true) {
          logger.debug(`File uploaded, URL: ${result.url}`);
          const extension = path.extname(this.file).toLowerCase();
          logger.debug(`File extension: ${extension}`);
          
          if (extension === '.nzb') {
            logger.debug(`NZB file: ${result.url}, ${result.fileName}`);
            
            // Use retry utility for adding usenet
            const nzbResult = await withRetry(
              async () => await this.client.addUsenet(result.url, result.fileName),
              {
                maxRetries: 3,
                baseDelay: 1000,
                operationName: `Add NZB ${this.file}`
              }
            );
            
            logger.debug('NZB result:', nzbResult);
            this.id = nzbResult.requestId;
            this.status = 'queued';
            this.alturl = nzbResult.url;
            logger.success(`'${this.file}' added to queue (${this.id})`);
            
            return await this._beginDownload();
          } else {
            logger.debug(`Torrent URL: ${result.url}`);
            
            // Use retry utility for adding to cloud
            const torrentResult = await withRetry(
              async () => await this.client.addCloud(result.url),
              {
                maxRetries: 3,
                baseDelay: 1000,
                operationName: `Add torrent ${this.file}`
              }
            );
            
            logger.debug('Torrent result:', torrentResult);
            this.id = torrentResult.requestId;
            this.status = 'queued';
            this.alturl = torrentResult.url;
            logger.success(`'${this.file}' added to queue (${this.id})`);
            
            return await this._beginDownload();
          }
        } else {
          logger.error(`Failed to add file: ${JSON.stringify(result)}`);
          throw new Error(`Failed to add file: ${JSON.stringify(result)}`);
        }
      }
    } catch (err) {
      logger.error(`Error adding ${this.file} to queue:`, err.message);
      throw err;
    }
  }

  async update() {
    log('update', this.file, this.id);
    
    if (typeof this.id === 'undefined' || this.id === 0 || 
        this.status === 'invalid' || this.status === 'delete' || 
        this.status === 'downloading_locally') {
      return; // No need to update these statuses
    }
    
    // Check if we need to retry a failed update
    const now = Date.now();
    if (this.lastUpdateFailed && now - this.lastUpdate < 30000) {
      // Wait at least 30 seconds between retries
      log('Skipping update, waiting for retry timeout');
      return;
    }
    
    try {
      // Use retry utility for checking status
      const info = await withRetry(
        async () => await this.client.CloudStatus(this.id),
        {
          maxRetries: this.maxUpdateRetries - this.updateRetries,
          baseDelay: Math.min(60000, Math.pow(2, this.updateRetries) * 1000), // Cap at 60 seconds
          operationName: `Update status for ${this.file}`
        }
      );
      
      this.lastUpdate = Date.now();
      this.lastUpdateFailed = false;
      this.updateRetries = 0;

      // Save the remote status for failure reporting
      if (info && info.status && info.status.status) {
        this.remoteStatus = info.status.status;
        if (info.status.error) {
          this.errorMessage = info.status.error;
        }
      }
      
      return await this._handleUpdate(info);
    } catch (err) {
      log('update failed', err);
      this.lastUpdate = Date.now();
      this.lastUpdateFailed = true;

      if (this.updateRetries < this.maxUpdateRetries) {
        this.updateRetries++;
        const backoffMs = Math.min(60000, Math.pow(2, this.updateRetries) * 1000);
        logger.warn(`Update failed for ${this.file}, will retry (attempt ${this.updateRetries}/${this.maxUpdateRetries}) after ${backoffMs/1000}s`);
        return;
      }

      // If we've exceeded retry limits, invalidate
      this.status = 'invalid';
      logger.warn(`'${this.file}' is invalid after ${this.maxUpdateRetries} retries: ${err.message || err}`);
    }
  }

  _beginDownload() {
    log('_beginDownload', this.file);
    logger.info(`'${this.file}' downloading remotely`);
    this.status = 'downloading';
  }

  async _handleUpdate(info) {
    log('_handleUpdate', this.file);

    if (!info || !info.status) {
      logger.warn(`Invalid status info received for ${this.id}`);
      return;
    }

    if (info.status.status === 'error' || info.status.status === 'canceled') {
      // Store error message if available
      if (info.status.error) {
        this.errorMessage = info.status.error;
      }
      return await this._delete();
    }

    // Show torrent status
    logger.info(`'${this.file}' id: ${this.id} local: ${this.status} remote: ${info.status.status} size: ${info.status.fileSize} bytes`);

    // Has the remote status finished downloading
    if (info.status.status === 'downloaded' && this.status === 'downloading') {
      // Mark torrent as downloaded
      this.status = 'downloaded';
      this.isdir = info.status.isDirectory;

      // Extract the filename without extension to use as folder name
      const torrentFileName = path.basename(this.file).replace(/\.[^/.]+$/, "");
      
      if (this.isdir === false) {
        this.status = 'downloading_locally';
        const downloadUrl = this.alturl + '/' + querystring.escape(info.status.fileName);
        logger.info('Downloadlink: ' + downloadUrl);
        
        try {
          // Use the download function with retry
          await withRetry(
            async () => await this.downloadFn([downloadUrl], torrentFileName),
            {
              maxRetries: 3,
              baseDelay: 2000,
              operationName: `Download ${info.status.fileName}`
            }
          );
          return await this._delete();
        } catch (err) {
          logger.error('Download failed:', err.message);
          throw err;
        }
      }

      try {
        // Use retry utility for exploring content
        const res = await withRetry(
          async () => await this.client.explore(this.id),
          {
            maxRetries: 3,
            baseDelay: 1000,
            operationName: `Explore content of ${this.file}`
          }
        );
        
        this.status = 'downloading_locally';
        logger.info(`'${this.file}' downloading locally '${res}'`);
        
        // Pass just the filename without extension for folder naming
        await withRetry(
          async () => await this.downloadFn(res, torrentFileName),
          {
            maxRetries: 3,
            baseDelay: 2000,
            operationName: `Download content of ${this.file}`
          }
        );
        
        return await this._delete();
      } catch (err) {
        if (err === 'Bad archive' || (err.message && err.message.includes('Bad archive'))) {
          this.status = 'downloading_locally';
          logger.warn(`'${this.file}' downloading locally (alt) due to 'Bad archive'`);
          
          // Pass just the filename without extension for folder naming
          try {
            await withRetry(
              async () => await this.downloadFn([this.alturl], torrentFileName),
              {
                maxRetries: 3,
                baseDelay: 2000,
                operationName: `Alternative download of ${this.file}`
              }
            );
            return await this._delete();
          } catch (downloadErr) {
            logger.error('Alternative download failed:', downloadErr.message);
            throw downloadErr;
          }
        } else {
          logger.error('Explore failed:', err.message);
          throw err;
        }
      }
    }
  }

  async _delete() {
    log('_delete', this.file);
    
    // Check if this is a failed download or just cleanup after success
    const wasSuccessful = this.status === 'downloading_locally';
    const fileName = path.basename(this.file);
    
    if (!wasSuccessful) {
      // This is a failed download - log it clearly
      let errorMsg = `Torrent could not be downloaded: ${fileName}`;
      
      // Add error details if we have them
      if (this.errorMessage) {
        errorMsg += ` - Error: ${this.errorMessage}`;
      } else if (this.remoteStatus) {
        errorMsg += ` - Last status: ${this.remoteStatus}`;
      }
      
      logger.downloadFailed(errorMsg);
    }
    
    this.status = 'invalid';
    
    // Check if file exists before trying to delete it
    try {
      const fileExists = await fileOps.fileExists(this.file);
      if (fileExists) {
        try {
          await fs.promises.unlink(this.file);
          logger.success(`'${this.file}' deleted locally`);
        } catch (unlinkErr) {
          logger.error(`Error deleting local file: ${unlinkErr.message}`);
        }
      } else {
        logger.info(`File ${this.file} already deleted or doesn't exist`);
      }
    } catch (fsErr) {
      logger.error(`Error checking file existence: ${fsErr.message}`);
    }
    
    // Use retry utility for remote delete
    try {
      await withRetry(
        async () => await this.client.delete(this.id),
        {
          maxRetries: 3,
          baseDelay: 1000,
          operationName: `Delete remote file ${this.id}`
        }
      );
      
      logger.success(`'${this.file}' deleted remotely`);
      
      // Call the onComplete callback if defined
      if (typeof this.onComplete === 'function') {
        this.onComplete(this);
      }
    } catch (err) {
      logger.error('Remote delete failed after retries:', err.message);
      
      // Even if delete fails, still call onComplete to prevent stalling
      if (typeof this.onComplete === 'function') {
        logger.warn(`Executing completion callback despite delete error`);
        this.onComplete(this);
      }
    }
  }
}

export default OffCloudTorrent;