const debug = require('debug')('patbrid:watchers:offcloud:torrent')
const fs = require('fs')
const path = require('path')
const querystring = require('querystring')

class OffCloudTorrent {
  constructor (client, downloadFn, file, magnetlink = null) {
    debug('ctor', file)

    this.client = client
    this.downloadFn = downloadFn
    this.file = file
    this.alturl = ''
    this.status = 'pending'
    this.magnetlink = magnetlink
    this.ariainfo = []
    this.id = 0
    this.isdir = false
    this.onComplete = null // Callback for completion notification
    this.lastUpdate = Date.now()
    this.updateRetries = 0
    this.maxUpdateRetries = 5
  }

  async addToQueue() {
    debug('addToQueue', this.file)
    console.log('adding to queue')
    
    try {
      // Add the torrent file
      if (this.magnetlink != null) {
        const result = await this.client.addCloud(this.magnetlink);
        console.log('adding: ', result);
        this.id = result.requestId;
        this.status = 'queued';
        this.alturl = result.url;
        console.log(`[+] '${this.file}' added to queue (${this.id})`);
        
        return await this._beginDownload();
      } else {
        console.log('adding file ', this.file);
        const result = await this.client.addFile(this.file);
        
        if (result.success === true) {
          console.log('adding ', result.url);
          const extension = path.extname(this.file).toLowerCase();
          console.log('extension: ', extension);
          
          if (extension === '.nzb') {
            console.log('nzb result ', result.url, result.fileName);
            const nzbResult = await this.client.addUsenet(result.url, result.fileName);
            console.log('adding: ', nzbResult);
            this.id = nzbResult.requestId;
            this.status = 'queued';
            this.alturl = nzbResult.url;
            console.log(`[+] '${this.file}' added to queue (${this.id})`);
            
            return await this._beginDownload();
          } else {
            console.log('torrent result ', result.url);
            const torrentResult = await this.client.addCloud(result.url);
            console.log('adding: ', torrentResult);
            this.id = torrentResult.requestId;
            this.status = 'queued';
            this.alturl = torrentResult.url;
            console.log(`[+] '${this.file}' added to queue (${this.id})`);
            
            return await this._beginDownload();
          }
        } else {
          console.log('FAILED1: ', result);
          throw new Error(`Failed to add file: ${JSON.stringify(result)}`);
        }
      }
    } catch (err) {
      console.error('ERROR: ', err);
      throw err;
    }
  }

  async update() {
    debug('update', this.file, this.id);
    
    if (typeof this.id === 'undefined' || this.id === 0 || 
        this.status === 'invalid' || this.status === 'delete' || 
        this.status === 'downloading_locally') {
      return; // No need to update these statuses
    }
    
    // Check if we need to retry a failed update
    const now = Date.now();
    if (this.lastUpdateFailed && now - this.lastUpdate < 30000) {
      // Wait at least 30 seconds between retries
      debug('Skipping update, waiting for retry timeout');
      return;
    }
    
    try {
      // Get the info for the torrent
      const info = await this.client.CloudStatus(this.id);
      this.lastUpdate = Date.now();
      this.lastUpdateFailed = false;
      this.updateRetries = 0;
      return await this._handleUpdate(info);
    } catch (err) {
      debug('update failed', err);
      this.lastUpdate = Date.now();
      this.lastUpdateFailed = true;

      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || 
          err.code === 'ETIMEDOUT' || 
          (err.message && err.message.includes('socket disconnected'))) {
        console.log(`[!] Connection error updating torrent status: ${err.message || err.code}`);
        
        // Don't invalidate on connection errors
        if (this.updateRetries < this.maxUpdateRetries) {
          this.updateRetries++;
          const backoffMs = Math.min(60000, Math.pow(2, this.updateRetries) * 1000);
          console.log(`[+] Will retry update for ${this.file} after ${backoffMs/1000}s (attempt ${this.updateRetries}/${this.maxUpdateRetries})`);
          return;
        }
      }

      // If we've exceeded retry limits or it's a non-connection error, invalidate
      this.status = 'invalid';
      console.log(`[+] '${this.file}' is invalid: ${err.message || err}`);
    }
  }

  _beginDownload() {
    debug('_beginDownload', this.file);
    console.log(`[+] '${this.file}' downloading remotely`);
    this.status = 'downloading';
  }

  async _handleUpdate(info) {
    debug('_handleUpdate', this.file);

    if (!info || !info.status) {
      console.log(`[!] Invalid status info received for ${this.id}`);
      return;
    }

    if (info.status.status === 'error' || info.status.status === 'canceled') {
      return await this._delete();
    }

    // Show torrent status
    console.log(`[+] '${this.file}' id: ${this.id} local: ${this.status} remote: ${info.status.status} size: ${info.status.fileSize} bytes`);

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
        console.log('Downloadlink: ' + downloadUrl);
        
        try {
          await this.downloadFn([downloadUrl], torrentFileName);
          return await this._delete();
        } catch (err) {
          console.error('[!] add download failed', err);
          throw err;
        }
      }

      try {
        const res = await this.client.explore(this.id);
        this.status = 'downloading_locally';
        console.log(`[+] '${this.file}' downloading locally '${res}'`);
        
        // Pass just the filename without extension for folder naming
        await this.downloadFn(res, torrentFileName);
        return await this._delete();
      } catch (err) {
        if (err === 'Bad archive' || (err.message && err.message.includes('Bad archive'))) {
          this.status = 'downloading_locally';
          console.log(`[+] '${this.file}' downloading locally (alt) '${err}'`);
          
          // Pass just the filename without extension for folder naming
          try {
            await this.downloadFn([this.alturl], torrentFileName);
            return await this._delete();
          } catch (downloadErr) {
            console.error('[!] add download failed', downloadErr);
            throw downloadErr;
          }
        } else {
          console.error('[!] explore failed', err);
          throw err;
        }
      }
    }
  }

  async _delete() {
    debug('_delete', this.file);
    this.status = 'invalid';
    
    // Check if file exists before trying to delete it
    try {
      if (fs.existsSync(this.file)) {
        try {
          fs.unlinkSync(this.file);
          console.log(`[+] '${this.file}' deleted locally`);
        } catch (unlinkErr) {
          console.error(`[!] Error deleting local file: ${unlinkErr.message}`);
        }
      } else {
        console.log(`[!] File ${this.file} already deleted or doesn't exist`);
      }
    } catch (fsErr) {
      console.error(`[!] Error checking file existence: ${fsErr.message}`);
    }
    
    // Implement retry logic for remote delete
    const attemptDelete = async (retryCount = 0) => {
      try {
        await this.client.delete(this.id);
        console.log(`[+] '${this.file}' deleted remotely`);
        
        // Call the onComplete callback if defined
        if (typeof this.onComplete === 'function') {
          this.onComplete(this);
        }
      } catch (err) {
        console.error('[!] remote delete failed', err);
        
        // Retry for connection errors
        const isConnectionError = 
          err.code === 'ECONNREFUSED' || 
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          (err.message && err.message.includes('socket disconnected'));
          
        if (isConnectionError && retryCount < 3) {
          const backoffMs = Math.pow(2, retryCount + 1) * 1000;
          console.log(`[!] Retrying remote delete after ${backoffMs}ms (attempt ${retryCount + 1}/3)`);
          
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          return await attemptDelete(retryCount + 1);
        }
        
        // If we exceed retry count or it's not a connection error, still call onComplete
        if (typeof this.onComplete === 'function') {
          console.log(`[+] Still executing completion callback despite delete error`);
          this.onComplete(this);
        }
      }
    };
    
    return await attemptDelete();
  }
}

module.exports = OffCloudTorrent