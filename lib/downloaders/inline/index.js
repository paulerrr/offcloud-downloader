const debug = require('debug')('patbrid:downloaders:aria2')
const fs = require('fs')
const request = require('request')
const querystring = require('querystring')
const path = require('path')

class inlinedownloader {
  constructor (watch, path) {
    debug('ctor')
    this.watch = watch
    this.path = path
    this.download = this._download.bind(this)
    this.success = false
  }

  _download (links, supppath) {
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

    const promises = links.map(link => new Promise((resolve, reject) => {
      let received = 0
      let total = 0
      let fileName = ''

      // Create a unique folder for this download directly in the download path
      const downloadFolder = this.path + '/' + originalFileName
      fs.mkdir(downloadFolder, { recursive: true }, (err) => {
        if (err) {
          console.log('Error creating download folder:', err)
          reject(err)
          return
        }

        const req = request({
          method: 'GET',
          uri: link
        })
        
        req.on('response', data => {
          console.log(data.headers)
          total = parseInt(data.headers['content-length'])
          fileName = querystring.unescape(data.headers['content-disposition'])
          fileName = fileName.substr(fileName.lastIndexOf("'") + 1, fileName.length - (fileName.lastIndexOf("'") + 1))
          
          // If we couldn't get a filename from the headers, extract it from the URL
          if (!fileName || fileName.trim() === '') {
            const urlParts = link.split('/');
            fileName = urlParts[urlParts.length - 1];
            if (fileName.includes('?')) {
              fileName = fileName.split('?')[0];
            }
          }
          
          console.log('writing to: ' + downloadFolder + '/' + fileName)
          const out = fs.createWriteStream(downloadFolder + '/' + fileName)
          req.pipe(out)
        })
        
        req.on('data', chunk => {
          received += chunk.length
        })
        
        req.on('error', function (e) {
          reject(e)
        })
        
        req.on('timeout', function () {
          console.log('timeout')
          req.abort()
        })
        
        req.on('end', () => {
          console.log(downloadFolder + '/' + fileName + ' downloaded(' + received + ' / ' + total + ')')
          resolve('done')
        })
      })
    }))

    return Promise.all(promises)
  }
}

module.exports = inlinedownloader
