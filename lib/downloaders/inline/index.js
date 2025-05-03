const debug = require('debug')('patbrid:downloaders:aria2')
const fs = require('fs')
const request = require('request')
const querystring = require('querystring')
const path = require('path')

class inlinedownloader {
  constructor (watch, downloadPath, inProgressPath = null, completedPath = null) {
    debug('ctor')
    this.watch = watch
    this.downloadPath = downloadPath // Keep for backward compatibility in function signatures
    this.inProgressPath = inProgressPath || downloadPath
    this.completedPath = completedPath || downloadPath
    this.download = this._download.bind(this)
    this.success = false
  }

  // Helper method for safe file copying
  _copyFile(source, destination) {
    return new Promise((resolve, reject) => {
      // Ensure the parent directory exists
      const destDir = path.dirname(destination);
      fs.mkdir(destDir, { recursive: true }, (mkdirErr) => {
        if (mkdirErr) {
          console.log(`[!] Error creating directory ${destDir}: ${mkdirErr.message}`);
          reject(mkdirErr);
          return;
        }

        // First check if source exists
        fs.access(source, fs.constants.F_OK, (accessErr) => {
          if (accessErr) {
            console.log(`[!] Source file does not exist: ${source}`);
            reject(accessErr);
            return;
          }

          // Check if destination already exists (to avoid duplicate work)
          fs.access(destination, fs.constants.F_OK, (destAccessErr) => {
            if (!destAccessErr) {
              console.log(`[i] Destination file already exists: ${destination}`);
              resolve();
              return;
            }

            // Copy the file
            const readStream = fs.createReadStream(source);
            const writeStream = fs.createWriteStream(destination);

            readStream.on('error', (err) => {
              console.log(`[!] Error reading from source: ${err.message}`);
              reject(err);
            });

            writeStream.on('error', (err) => {
              console.log(`[!] Error writing to destination: ${err.message}`);
              reject(err);
            });

            writeStream.on('finish', () => {
              console.log(`[+] File successfully copied to: ${destination}`);
              resolve();
            });

            readStream.pipe(writeStream);
          });
        });
      });
    });
  }

  // Helper method to safely move a file (copy + delete)
  async _moveFile(source, destination) {
    try {
      // Copy the file first
      await this._copyFile(source, destination);
      
      // Then try to remove the source file
      try {
        await new Promise((resolve, reject) => {
          fs.access(source, fs.constants.F_OK, (accessErr) => {
            if (accessErr) {
              // File doesn't exist, which is fine for our purposes
              resolve();
              return;
            }
            
            fs.unlink(source, (unlinkErr) => {
              if (unlinkErr) {
                console.log(`[!] Warning: Could not delete source file after copy: ${unlinkErr.message}`);
                // We don't reject here because the copy succeeded
              }
              resolve();
            });
          });
        });
      } catch (err) {
        console.log(`[!] Error checking/removing source file: ${err.message}`);
        // Don't throw since the copy succeeded
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
      // Read the directory contents
      const files = await new Promise((resolve, reject) => {
        fs.readdir(dirPath, (err, files) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(files);
        });
      });
      
      // If directory is empty, remove it
      if (files.length === 0) {
        await new Promise((resolve, reject) => {
          fs.rmdir(dirPath, (err) => {
            if (err) {
              console.log(`[!] Error removing empty directory ${dirPath}: ${err.message}`);
              reject(err);
              return;
            }
            console.log(`[+] Removed empty directory: ${dirPath}`);
            resolve();
          });
        });
        return true;
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

  _download(links, supppath) {
    debug('_download', links)

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
    return new Promise(async (resolve, reject) => {
      try {
        // Create a unique folder for this download in the in-progress directory
        const inProgressFolder = path.join(this.inProgressPath, originalFileName);
        
        // Make sure the in-progress folder exists
        await new Promise((mkdirResolve, mkdirReject) => {
          fs.mkdir(inProgressFolder, { recursive: true }, (err) => {
            if (err) {
              console.log(`[!] Error creating in-progress folder: ${err.message}`);
              mkdirReject(err);
              return;
            }
            mkdirResolve();
          });
        });

        const completedFolder = path.join(this.completedPath, originalFileName);
        // Make sure the completed folder exists
        await new Promise((mkdirResolve, mkdirReject) => {
          fs.mkdir(completedFolder, { recursive: true }, (err) => {
            if (err) {
              console.log(`[!] Error creating completed folder: ${err.message}`);
              mkdirReject(err);
              return;
            }
            mkdirResolve();
          });
        });

        // Keep track of successful and failed downloads
        const results = {
          success: [],
          failed: []
        };

        // Process each file
        for (const link of links) {
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
          } catch (err) {
            console.log(`[!] Error processing link ${link}: ${err.message}`);
            results.failed.push(link);
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
          resolve(results);
        } else {
          reject(new Error(`Failed to download any files from ${links.length} links`));
        }
      } catch (err) {
        console.log(`[!] Download process error: ${err.message}`);
        reject(err);
      }
    });
  }

  // Process a single file download
  _downloadSingleFile(link, destFolder) {
    return new Promise((resolve, reject) => {
      let received = 0;
      let total = 0;
      let fileName = '';
      let outputStream = null;

      console.log(`[+] Starting download of: ${link}`);

      // Create a temp filename until we get the real one from headers
      const tempFileName = `temp_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const tempFilePath = path.join(destFolder, tempFileName);

      // Set up the request - we'll pipe it to the file later
      const req = request({
        method: 'GET',
        uri: link,
        timeout: 300000 // 5 minute timeout
      });

      // Handle request error
      req.on('error', (err) => {
        console.log(`[!] Download error: ${err.message}`);
        if (outputStream) {
          outputStream.close();
        }
        
        // Try to clean up the temp file
        try {
          fs.unlinkSync(tempFilePath);
        } catch (e) {
          // Ignore errors
        }
        
        reject(err);
      });

      // Handle timeout
      req.on('timeout', () => {
        console.log('[!] Download timeout');
        req.abort();
        
        if (outputStream) {
          outputStream.close();
        }
        
        // Try to clean up the temp file
        try {
          fs.unlinkSync(tempFilePath);
        } catch (e) {
          // Ignore errors
        }
        
        reject(new Error('Download timeout'));
      });

      // Handle the response headers
      req.on('response', (response) => {
        console.log(response.headers);
        
        // Get content length
        total = parseInt(response.headers['content-length'] || '0');
        
        // Extract filename from content-disposition header
        if (response.headers['content-disposition']) {
          fileName = querystring.unescape(response.headers['content-disposition'] || '');
          if (fileName.includes("'")) {
            fileName = fileName.substring(fileName.lastIndexOf("'") + 1);
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
          req.abort();
          reject(err);
        });
        
        console.log(`[+] Writing to in-progress folder: ${finalFilePath}`);
        
        // Pipe the response to the file
        response.pipe(outputStream);
        
        // When the download is finished
        outputStream.on('finish', () => {
          if (total > 0) {
            console.log(`[+] File downloaded: ${fileName} (${received} / ${total} bytes)`);
          } else {
            console.log(`[+] File downloaded: ${fileName} (${received} bytes)`);
          }
          
          resolve({ 
            success: true, 
            fileName: fileName, 
            size: received, 
            totalSize: total 
          });
        });
      });

      // Keep track of downloaded data
      req.on('data', (chunk) => {
        received += chunk.length;
      });
    });
  }
}

module.exports = inlinedownloader