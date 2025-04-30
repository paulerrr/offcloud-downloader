const debug = require('debug')('patbrid:downloaders:aria2')
const fs = require('fs')
const request = require('request')//
const querystring = require('querystring')
// const { URL } = require('url')
// const http = require('http')

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

    const promises = links.map(link => new Promise((resolve, reject) => {
      let received = 0
      let total = 0
      let fileName = ''

      const subpath = supppath.substr(this.watch.length + 1)

      fs.mkdir(this.path + '/' + subpath, { recursive: true }, (err) => {
        if (err) console.log(err)
      })

      const req = request({
        method: 'GET',
        uri: link
      })
      req.on('response', data => {
        console.log(data.headers)
        total = parseInt(data.headers['content-length'])
        fileName = querystring.unescape(data.headers['content-disposition'])
        fileName = fileName.substr(fileName.lastIndexOf("'") + 1, fileName.length - (fileName.lastIndexOf("'") + 1))
        console.log('writing to: ' + this.path + '/' + subpath + '/' + fileName)
        const out = fs.createWriteStream(this.path + '/' + subpath + '/' + fileName)
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
        console.log(this.path + '/' + subpath + '/' + fileName + ' downloaded(' + received + ' / ' + total + ')')
        resolve('done')
      })
    }))

    return Promise.all(promises)
  }
}

module.exports = inlinedownloader
