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
  }

  addToQueue () {
    debug('addToQueue', this.file)
    console.log('adding to queue')
    // Add the torrent file
    if (this.magnetlink != null) {
      return this.client.addCloud(this.magnetlink)
        .then(result => {
          console.log('adding: ', result)
          this.id = result.requestId
          this.status = 'queued'
          this.alturl = result.url
          console.log(`[+] '${this.file}' added to queue (${this.id})`)

          return this._beginDownload()
        })
    } else {
      console.log('adding file ', this.file)
      return this.client.addFile(this.file)
        .then(async result => {
          if (result.success === true) {
            console.log('adding ', result.url)
            const extension = path.extname(this.file).toLowerCase()
            console.log('extension: ', extension)
            if (extension === '.nzb') {
              console.log('nzb result ', result.url, result.fileName)
              return this.client.addUsenet(result.url, result.fileName)
                .then(result => {
                  console.log('adding: ', result)
                  this.id = result.requestId
                  this.status = 'queued'
                  this.alturl = result.url
                  console.log(`[+] '${this.file}' added to queue (${this.id})`)

                  return this._beginDownload()
                })
            } else {
              console.log('torrent result ', result.url)
              return this.client.addCloud(result.url)
                .then(result => {
                  console.log('adding: ', result)
                  this.id = result.requestId
                  this.status = 'queued'
                  this.alturl = result.url
                  console.log(`[+] '${this.file}' added to queue (${this.id})`)

                  return this._beginDownload()
                })
            }
          } else {
            console.log('FAILED1: ', result)
          }
        })
        .catch(err => {
          console.error('ERRORL ', err)
        })
    }
  }

  update () {
    debug('update', this.file, this.id)
    if (typeof this.id === 'undefined' || this.id === 0 || this.status === 'invalid' || this.status === 'delete' || this.status === 'aria2dl') {
      return
    }
    // Get the info for the torrent
    return this.client.CloudStatus(this.id)
      .then(info => this._handleUpdate(info))
      .catch(err => {
        debug('update failed', err)

        if (err.errno === 'ECONNREFUSED') {
          return
        }

        this.status = 'invalid'

        console.log(`[+] '${this.file}' is invalid`)
      })
  }

  _beginDownload () {
    debug('_beginDownload', this.file)
    console.log(`[+] '${this.file}' downloading remotely`)
    this.status = 'downloading'
  }

  _handleUpdate (info) {
    debug('_handleUpdate', this.file)

    if (info.status.status === 'error' || info.status.status === 'canceled') {
      return this._delete()
    }

    // Show torrent status
    console.log(`[+] '${this.file}' id: ${this.id} local: ${this.status} remote: ${info.status.status} size: ${info.status.fileSize} bytes`)

    // Has the remote status finished downloading
    if (info.status.status === 'downloaded' && this.status === 'downloading') {
      // Mark torrent as downloaded
      this.status = 'downloaded'
      this.isdir = info.status.isDirectory

      // Extract the filename without extension to use as folder name
      const torrentFileName = path.basename(this.file).replace(/\.[^/.]+$/, "");
      
      if (this.isdir === false) {
        this.status = 'aria2dl'
        console.log('Downloadlink: ' + this.alturl + '/' + querystring.escape(info.status.fileName))
        return this.downloadFn([this.alturl + '/' + querystring.escape(info.status.fileName)], torrentFileName)
          .then(() => { this._delete() })
          .catch(err => console.error('[!] add download failed', err))
      }

      return this.client.explore(this.id)
        .then((res) => {
          this.status = 'aria2dl'
          console.log(`[+] '${this.file}' downloading locally '${res}'`)
          
          // Pass just the filename without extension for folder naming
          this.downloadFn(res, torrentFileName)
            .then(() => { this._delete() })
            .catch(err => console.error('[!] download failed', err))
        })
        .catch(err => {
          if (err === 'Bad archive') {
            this.status = 'aria2dl'
            console.log(`[+] '${this.file}' downloading locally (alt) '${err}'`)
            
            // Pass just the filename without extension for folder naming
            this.downloadFn([this.alturl], torrentFileName)
              .then(() => { this._delete() })
              .catch(err => console.error('[!] add download failed', err))
          } else {
            console.error('[!] explore failed', err)
          }
        })
    }
  }

  _delete () {
    debug('_delete', this.file)
    this.status = 'invalid'
    
    // Check if file exists before trying to delete it
    try {
      if (fs.existsSync(this.file)) {
        try {
          fs.unlinkSync(this.file)
          console.log(`[+] '${this.file}' deleted locally`)
        } catch (unlinkErr) {
          console.error(`[!] Error deleting local file: ${unlinkErr.message}`)
        }
      } else {
        console.log(`[!] File ${this.file} already deleted or doesn't exist`)
      }
    } catch (fsErr) {
      console.error(`[!] Error checking file existence: ${fsErr.message}`)
    }
    
    return this.client.delete(this.id)
      .then(() => {
        console.log(`[+] '${this.file}' deleted remotely`)
      })
      .catch(err => console.error('[!] remote delete failed', err))
  }
}

module.exports = OffCloudTorrent