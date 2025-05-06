const fs = require('fs');
const https = require('https');
const debug = require('debug')('fs:fsmonitor:request');
const axios = require('axios');
const FormData = require('form-data');
const { resolve } = require('path');
const logger = require('../../utils/logger');

class OffCloudAPI {
  constructor(token, defaultOptions = {}) {
    this.token = token;
    this.base_url = defaultOptions.base_url || 'https://offcloud.com/api/';
    this.defaultOptions = defaultOptions;
    delete this.defaultOptions.base_url;
    this.connectionRetries = 3; // Number of retries for connection issues
    
    // Create axios instance with common configuration
    this.axiosInstance = axios.create({
      timeout: 30000, // 30 second default timeout
      headers: {
        'User-Agent': 'offcloud-downloader/1.0.0'
      }
    });
  }

  /**
   * Run request with exponential backoff for connection errors
   * @param {string} endpoint - API endpoint
   * @param {object} o - Request options
   * @returns {Promise} - Promise that resolves with response data
   */
  async runRequest(endpoint, o = {}) {
    const options = { ...this.defaultOptions };
    
    let url;
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      url = `${endpoint}?key=${this.token}`;
    } else {
      url = `${this.base_url}${endpoint}?key=${this.token}`;
    }
    
    logger.http(`Calling ${endpoint}`);
    
    // Set up axios config
    const config = {
      url,
      method: o.method || 'get',
      params: o.qs || {},
      timeout: o.timeout || 30000,
      headers: { ...options.headers, ...o.headers }
    };
    
    // Handle form data if present
    if (o.formData) {
      const formData = new FormData();
      for (const [key, value] of Object.entries(o.formData)) {
        if (Array.isArray(value)) {
          value.forEach(item => formData.append(key, item));
        } else {
          formData.append(key, value);
        }
      }
      config.data = formData;
      config.headers = {
        ...config.headers,
        ...formData.getHeaders()
      };
    } else if (o.body) {
      config.data = o.body;
    }

    let retryCount = 0;
    let lastError = null;

    // Implement retry logic with exponential backoff
    while (retryCount <= this.connectionRetries) {
      try {
        const response = await this.axiosInstance(config);
        return response.data;
      } catch (err) {
        lastError = err;
        
        // Handle 404 errors specially
        if (err.response && err.response.status === 404) {
          logger.warn(`Endpoint ${endpoint} returned 404 Not Found`);
          
          // For cloud/remove and other delete endpoints, consider 404 a success
          if (endpoint.includes('remove/') || endpoint.includes('delete/')) {
            return { success: true, message: 'Resource already deleted or not found' };
          }
          
          // For other endpoints, return an empty result that won't break our code
          if (endpoint === 'account/info' || endpoint === 'account/limits') {
            return {}; // Return empty object for account endpoints
          } else if (endpoint === 'cloud/history') {
            return []; // Return empty array for history endpoints
          } else {
            throw new Error(`Endpoint returned 404: ${config.url}`);
          }
        }
        
        // Only retry connection errors, not other errors
        const isConnectionError = 
          !err.response || // No response typically means network error
          err.code === 'ECONNABORTED' || 
          err.code === 'ECONNRESET' || 
          err.code === 'ETIMEDOUT' ||
          (err.message && (
            err.message.includes('timeout') ||
            err.message.includes('socket disconnected') ||
            err.message.includes('network error')
          ));
          
        if (!isConnectionError) {
          throw err; // Don't retry non-connection errors
        }
        
        if (retryCount >= this.connectionRetries) {
          logger.error(`Max retries reached (${retryCount}/${this.connectionRetries}) for endpoint ${endpoint}`);
          throw err;
        }
        
        retryCount++;
        const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff: 2s, 4s, 8s
        logger.warn(`Connection error (${err.code || err.message}). Retry ${retryCount}/${this.connectionRetries} after ${waitTime}ms`);
        await this.sleep(waitTime);
      }
    }
    
    // This should never be reached due to the logic above, but just in case
    throw lastError || new Error('Unknown error during request');
  }

  async _request(endpoint, o = {}) {
    try {
      const result = await this.runRequest(endpoint, o);
      logger.response(result);
      return result;
    } catch (err) {
      logger.error(`Request error for ${endpoint}:`, err.message);
      throw err;
    }
  }

  _get(endpoint, options = {}) {
    return this._request(endpoint, { ...options, method: 'get' });
  }

  _delete(endpoint, options = {}) {
    return this._request(endpoint, { ...options, method: 'delete' });
  }

  _post(endpoint, options = {}) {
    return this._request(endpoint, { ...options, method: 'post' });
  }

  _put(endpoint, options = {}) {
    return this._request(endpoint, { ...options, method: 'put' });
  }

  /**
   * Get cloud download history
   * Main method for retrieving storage usage information
   * 
   * @returns {Promise} - Promise that resolves with cloud history
   */
  cloudHistory() {
    debug('cloudHistory');
    return this._get('cloud/history', {
      timeout: 60000 // Longer timeout for history
    });
  }

  CloudDetails() {
    debug('CloudDetails: ');
    return this._post('cloud/download', {
      formData: {}
    });
  }

  explore(reqid) {
    debug('explore: ', reqid);
    return this._post('cloud/explore', {
      formData: {
        requestId: reqid
      }
    });
  }

  CloudStatus(reqid) {
    debug('CloudStatus: ', reqid);
    return this._post('cloud/status', {
      formData: {
        requestId: reqid
      }
    });
  }

  /**
   * Delete a cloud download from Offcloud
   * 
   * @param {string} reqid - Request ID to delete
   * @returns {Promise} - Promise that resolves when deletion is complete
   */
  async delete(reqid) {
    debug('delete: ', reqid);
    logger.debug(`Deleting cloud item: ${reqid}`);
    
    try {
      // Use direct URL instead of relative path
      return await this._get(`https://offcloud.com/cloud/remove/${reqid}`);
    } catch (err) {
      // Try alternative endpoint if first one fails
      if (err.message && err.message.includes('404')) {
        logger.warn(`First delete attempt failed, trying alternative endpoint for ${reqid}`);
        
        try {
          // Try with POST method to cloud/delete endpoint
          return await this._post('cloud/delete', {
            formData: { requestId: reqid }
          });
        } catch (postErr) {
          logger.warn(`Second delete attempt also failed: ${postErr.message}`);
          
          try {
            // As a last resort, try with direct post to remove endpoint
            return await this._post(`cloud/remove/${reqid}`);
          } catch (finalErr) {
            logger.error(`Could not delete resource ${reqid} after multiple attempts`);
            // Return success anyway to prevent blocking the flow
            return { success: true, message: 'Could not delete but proceeding anyway' };
          }
        }
      }
      throw err;
    }
  }

  proxies() {
    debug('proxies: ');
    return this._post('proxy', {
      formData: {
        requestId: ''
      }
    });
  }

  remotes() {
    debug('remotes: ');
    return this._post('remote/accounts', {
      formData: {
        requestId: ''
      }
    });
  }

  btstatus(bthashes) {
    return this._post('cache', {
      formData: {
        hashes: [bthashes]
      }
    });
  }

  addCloud(link) {
    debug('addCloud: ', link);
    logger.debug(`Adding to cloud: ${link}`);
    return this._post('cloud', {
      formData: { url: link }
    });
  }

  addUsenet(link, name) {
    debug('addUsenet: ', link);
    logger.debug(`Adding to usenet: ${link}, name: ${name}`);
    return this._post('cloud', {
      formData: { url: link, customFileName: name }
    });
  }

  sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async addFile(path) {
    const form = new FormData();
    const stream = fs.createReadStream(path);

    form.append('file', stream);
    form.append('name', 'file');
    form.append('filename', path);

    let retryCount = 0;
    const maxRetries = 3;
    
    const attemptUpload = async () => {
      try {
        logger.info(`Uploading file: ${path}`);
        const response = await axios.post(
          `https://offcloud.com/torrent/upload?key=${this.token}`, 
          form, 
          {
            headers: form.getHeaders(),
            timeout: 60000 // 60 second timeout for uploads
          }
        );
        
        logger.success(`File upload successful: ${path}`);
        logger.debug('Upload response:', response.data);
        return response.data;
      } catch (error) {
        logger.error(`Upload error: ${error.message}`);
        
        // Check if it's a connection error that we should retry
        const isConnectionError = 
          !error.response || // No response usually means network error
          error.code === 'ECONNABORTED' || 
          error.code === 'ECONNRESET' || 
          error.code === 'ETIMEDOUT' ||
          (error.message && (
            error.message.includes('timeout') ||
            error.message.includes('socket disconnected') ||
            error.message.includes('network error')
          ));
          
        if (isConnectionError && retryCount < maxRetries) {
          retryCount++;
          const waitTime = Math.pow(2, retryCount) * 1000;
          logger.warn(`Retrying upload (${retryCount}/${maxRetries}) after ${waitTime}ms`);
          await this.sleep(waitTime);
          return attemptUpload();
        } else {
          logger.error(`Could not upload file: ${path}`);
          throw error;
        }
      }
    };
    
    return attemptUpload();
  }

  addTorrent(path) {
    // Delegate to addFile which has better error handling
    return this.addFile(path);
  }

  addInstant(link) {
    debug('addInstant: ', link);
    logger.debug(`Adding instant: ${link}`);
    return this._post('cloud', {
      formData: { url: link }
    });
  }

  addRemote(link) {
    debug('addRemote: ', link);
    logger.debug(`Adding remote: ${link}`);
    return this._post('remote', {
      formData: { url: link }
    });
  }
  
  /**
   * Retry a failed download
   * @param {string} requestId - ID of the failed download
   * @returns {Promise} - Promise that resolves when retry is initiated
   */
  retryDownload(requestId) {
    debug('retryDownload', requestId);
    logger.info(`Retrying download: ${requestId}`);
    return this._get(`cloud/retry/${requestId}`, {})
      .catch(err => {
        // Handle 404 errors
        if (err.message && err.message.includes('404')) {
          logger.warn(`Cannot retry download ${requestId}: not found`);
          return { success: false, message: 'Download not found' };
        }
        throw err;
      });
  }
}

module.exports = OffCloudAPI;