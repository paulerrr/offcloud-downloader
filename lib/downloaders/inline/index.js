const debug = require('debug')('patbrid:downloaders:aria2');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const querystring = require('querystring');

class inlinedownloader {
  constructor(watch, downloadPath, inProgressPath = null, completedPath = null) {
    debug('ctor');
    this.watch = watch;
    this.downloadPath = downloadPath; // Keep for backward compatibility in function signatures
    this.inProgressPath = inProgressPath || downloadPath;
    this.completedPath = completedPath || downloadPath;
    this.download = this._download.bind(this);
    this.success = false;
    this.activeDownloads = new Map(); // Track active downloads by URL
  }

  // Helper method for safe file copying
  async _copyFile(source, destination) {
    try {
      // Ensure the parent directory exists
      const destDir = path.dirname(destination);
      try {
        await fs.promises.mkdir(destDir, { recursive: true });
      } catch (mkdirErr) {
        console.log(`[!] Error creating directory ${destDir}: ${mkdirErr.message}`);
        throw mkdirErr;
      }

      // First check if source exists
      try {
        await fs.promises.access(source, fs.constants.F_OK);
      } catch (accessErr) {
        console.log(`[!] Source file does not exist: ${source}`);
        throw accessErr;
      }

      // Check if destination already exists (to avoid duplicate work)
      try {
        await fs.promises.access(destination, fs.constants.F_OK);
        console.log(`[i] Destination file already exists: ${destination}`);
        return;
      } catch (destAccessErr) {
        // Destination doesn't exist, which is expected
      }

      // Copy the file using promises
      await fs.promises.copyFile(source, destination);
      console.log(`[+] File successfully copied to: ${destination}`);
    } catch (err) {
      console.log(`[!] Error copying file from ${source} to ${destination}: ${err.message}`);
      throw err;
    }
  }

  // Helper method to safely move a file (copy + delete)
  async _moveFile(source, destination) {
    try {
      // Copy the file first
      await this._copyFile(source, destination);
      
      // Then try to remove the source file
      try {
        await fs.promises.access(source, fs.constants.F_OK);
        await fs.promises.unlink(source);
      } catch (err) {
        console.log(`[!] Warning: Could not delete source file after copy: ${err.message}`);
        // We don't throw here because the copy succeeded
      }
      
      return true;
    } catch (err) {
      console.log(`[!] Error moving file from ${source} to ${destination}: ${err.message}`);
      return false;
    }
  }

  // Helper to remove a directory if it's empty
  async _removeDirectoryIfEmpty(dirPath) {
    try {
      // Check if directory exists first
      try {
        await fs.promises.access(dirPath, fs.constants.F_OK);
      } catch (err) {
        console.log(`[!] Directory doesn't exist: ${dirPath}`);
        return false;
      }
      
      // Read the directory contents
      const files = await fs.promises.readdir(dirPath);
      
      // If directory is empty, remove it
      if (files.length === 0) {
        try {
          await fs.promises.rmdir(dirPath);
          console.log(`[+] Removed empty directory: ${dirPath}`);
          return true;
        } catch (err) {
          console.log(`[!] Error removing empty directory ${dirPath}: ${err.message}`);
          throw err;
        }
      }
      return false;
    } catch (err) {
      console.log(`[!] Error checking/removing directory ${dirPath}: ${err.message}`);
      return false;
    }
  }

  // Make folder name safe for file system
  _sanitizeFolderName(name) {
    // Replace problematic characters
    return name.replace(/[\\/:*?"<>|]/g, '_');
  }

  async _download(links, supppath) {
    debug('_download', links);

    // Extract the original torrent/magnet/nzb filename to use as folder name
    let originalFileName = '';
    
    // Check if supppath is a path or just a filename
    if (typeof supppath === 'string' && supppath) {
      if (supppath.includes('/')) {
        // It's a full path
        originalFileName = path.basename(supppath);
        // Remove file extension if present
        originalFileName = originalFileName.replace(/\.[^/.]+$/, "");
      } else {
        // It's already just a filename (possibly without extension)
        originalFileName = supppath;
      }
    }
    
    // Only use timestamp as fallback if we couldn't extract a usable name
    if (!originalFileName || originalFileName.trim() === '') {
      originalFileName = 'download_' + Date.now();
    }

    // Sanitize folder name for safety
    originalFileName = this._sanitizeFolderName(originalFileName);

    // Process all links (but don't clean up the folder until all are done)
    try {
      // Create a unique folder for this download in the in-progress directory
      const inProgressFolder = path.join(this.inProgressPath, originalFileName);
      
      // Make sure the in-progress folder exists
      await fs.promises.mkdir(inProgressFolder, { recursive: true });

      const completedFolder = path.join(this.completedPath, originalFileName);
      // Make sure the completed folder exists
      await fs.promises.mkdir(completedFolder, { recursive: true });

      // Keep track of successful and failed downloads
      const results = {
        success: [],
        failed: []
      };

      // Remove any duplicate links
      const uniqueLinks = [...new Set(links)];
      
      // Process each file - use a more controlled approach to avoid parallel downloads
      for (const link of uniqueLinks) {
        try {
          // Check if this link is already being downloaded
          if (this.activeDownloads.has(link)) {
            console.log(`[!] Link ${link} is already being downloaded, skipping duplicate`);
            continue;
          }
          
          // Mark as active download
          this.activeDownloads.set(link, Date.now());
          
          try {
            // Download the file
            const fileDetails = await this._downloadSingleFile(link, inProgressFolder);
            
            if (fileDetails.success) {
              // Source file path in the in-progress directory
              const sourceFilePath = path.join(inProgressFolder, fileDetails.fileName);
              
              // Destination file path in the completed directory
              const completedFilePath = path.join(completedFolder, fileDetails.fileName);
              
              // Move the file to the completed folder
              await this._moveFile(sourceFilePath, completedFilePath);
              results.success.push(fileDetails.fileName);
            } else {
              results.failed.push(link);
            }
          } finally {
            // Remove from active downloads when done (success or failure)
            this.activeDownloads.delete(link);
          }
        } catch (err) {
          console.log(`[!] Error processing link ${link}: ${err.message}`);
          results.failed.push(link);
          
          // Make sure we remove from active downloads
          this.activeDownloads.delete(link);
        }
      }

      // Only now try to clean up the in-progress folder
      if (results.success.length > 0) {
        try {
          await this._removeDirectoryIfEmpty(inProgressFolder);
        } catch (cleanupErr) {
          console.log(`[!] Error during cleanup: ${cleanupErr.message}`);
        }
      }

      // Even if some files failed, we consider the download successful if at least one file worked
      if (results.success.length > 0) {
        return results;
      } else {
        throw new Error(`Failed to download any files from ${links.length} links`);
      }
    } catch (err) {
      console.log(`[!] Download process error: ${err.message}`);
      throw err;
    }
  }

  // Process a single file download with retry mechanism
  async _downloadSingleFile(link, destFolder, retryCount = 0) {
    const MAX_RETRIES = 3;
    let received = 0;
    let total = 0;
    let fileName = '';
    let outputStream = null;
    // Progress tracking variables
    let lastProgressTime = Date.now();
    const PROGRESS_UPDATE_INTERVAL = 10000; // Log progress every 10 seconds

    console.log(`[+] Starting download of: ${link}`);

    // Create a temp filename until we get the real one from headers
    const tempFileName = `temp_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const tempFilePath = path.join(destFolder, tempFileName);

    try {
      // Configure axios for streaming response
      const response = await axios({
        method: 'GET',
        url: link,
        responseType: 'stream',
        timeout: 300000, // 5 minute timeout
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      // Handle non-success status codes
      if (response.status !== 200) {
        console.log(`[!] Server returned status code ${response.status}`);
        
        if (retryCount < MAX_RETRIES && (response.status >= 500 || response.status === 429)) {
          // Server errors or rate limiting, retry
          const waitTime = Math.pow(2, retryCount + 1) * 1000;
          console.log(`[!] Retrying download after ${waitTime}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
          
          await new Promise(resolve => setTimeout(resolve, waitTime));
          return await this._downloadSingleFile(link, destFolder, retryCount + 1);
        } else {
          throw new Error(`Server returned status code ${response.status}`);
        }
      }
      
      console.log(response.headers);
      
      // Get content length
      total = parseInt(response.headers['content-length'] || '0');
      
      // Extract filename from content-disposition header
      if (response.headers['content-disposition']) {
        fileName = response.headers['content-disposition'];
        if (fileName.includes("'")) {
          fileName = fileName.substring(fileName.lastIndexOf("'") + 1);
        }
        
        // Extract from filename= parameter if present
        const filenameMatch = fileName.match(/filename=["']?([^"']+)["']?/);
        if (filenameMatch && filenameMatch[1]) {
          fileName = filenameMatch[1];
        }
        
        // Extract from filename*= parameter if present (has precedence)
        const filenameStarMatch = fileName.match(/filename\*=UTF-8''([^;]+)/);
        if (filenameStarMatch && filenameStarMatch[1]) {
          fileName = decodeURIComponent(filenameStarMatch[1]);
        }
      }
      
      // If we couldn't get a filename from the headers, extract it from the URL
      if (!fileName || fileName.trim() === '') {
        const urlParts = link.split('/');
        fileName = urlParts[urlParts.length - 1];
        if (fileName.includes('?')) {
          fileName = fileName.split('?')[0];
        }
      }
      
      // Remove any special characters from filename for safety
      fileName = fileName.replace(/[/\\?%*:|"<>]/g, '_');
      
      const finalFilePath = path.join(destFolder, fileName);
      
      // Create write stream for the actual file
      outputStream = fs.createWriteStream(finalFilePath);
      
      // Set up error handler for write stream
      outputStream.on('error', (err) => {
        console.log(`[!] Error writing file: ${err.message}`);
        throw err;
      });
      
      console.log(`[+] Writing to in-progress folder: ${finalFilePath}`);
      
      // If we have content length, show initial file size info
      if (total > 0) {
        const totalMB = (total / 1048576).toFixed(2);
        console.log(`[+] File size: ${totalMB} MB`);
      }

      // Return a promise that resolves when the download is complete
      return await new Promise((resolve, reject) => {
        // Set up progress tracking
        let dataReceived = 0;
        
        response.data.on('data', (chunk) => {
          dataReceived += chunk.length;
          
          // Show periodic progress updates for large files
          const now = Date.now();
          if ((total > 10485760 || dataReceived > 10485760) && 
              now - lastProgressTime > PROGRESS_UPDATE_INTERVAL) {
            const percent = total ? (dataReceived / total * 100).toFixed(2) : 'unknown';
            const downloadedMB = (dataReceived / 1048576).toFixed(2);
            const totalMB = total ? (total / 1048576).toFixed(2) : 'unknown';
            
            console.log(`[+] Download progress: ${downloadedMB}MB / ${totalMB}MB (${percent}%)`);
            lastProgressTime = now;
          }
        });
        
        // When download is finished
        response.data.on('end', () => {
          if (outputStream) {
            outputStream.end(() => {
              if (total > 0) {
                console.log(`[+] File downloaded: ${fileName} (${dataReceived} / ${total} bytes)`);
              } else {
                console.log(`[+] File downloaded: ${fileName} (${dataReceived} bytes)`);
              }
              
              resolve({ 
                success: true, 
                fileName: fileName, 
                size: dataReceived, 
                totalSize: total 
              });
            });
          }
        });
        
        // Handle errors on the response stream
        response.data.on('error', (err) => {
          console.log(`[!] Stream error: ${err.message}`);
          if (outputStream) {
            outputStream.close();
          }
          reject(err);
        });
        
        // Pipe the response to the file
        response.data.pipe(outputStream);
      });
    } catch (err) {
      console.log(`[!] Download error: ${err.message}`);
      if (outputStream) {
        outputStream.close();
      }
      
      // Try to clean up the temp file
      try {
        if (fs.existsSync(tempFilePath)) {
          await fs.promises.unlink(tempFilePath);
        }
      } catch (e) {
        // Ignore errors
      }
      
      // Retry logic for connection errors
      const isConnectionError = 
        err.code === 'ECONNRESET' || 
        err.code === 'ETIMEDOUT' || 
        err.code === 'ECONNABORTED' ||
        (err.message && (
          err.message.includes('timeout') ||
          err.message.includes('socket disconnected') ||
          err.message.includes('network error')
        ));
      
      if (retryCount < MAX_RETRIES && isConnectionError) {
        const waitTime = Math.pow(2, retryCount + 1) * 1000;
        console.log(`[!] Retrying download after ${waitTime}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return await this._downloadSingleFile(link, destFolder, retryCount + 1);
      } else {
        throw err;
      }
    }
  }
}

module.exports = inlinedownloader;