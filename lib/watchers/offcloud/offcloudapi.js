import fs from 'fs';
import https from 'https';
import debug from 'debug';
const log = debug('fs:fsmonitor:request');
import axios from 'axios';
import FormData from 'form-data';
import { resolve } from 'path';
import logger from '../../utils/logger.js';
import { withRetry, sleep, isRetriableStatus } from '../../utils/retry.js';

class OffCloudAPI {
  constructor(token, defaultOptions = {}) {
    this.token = token;
    this.base_url = defaultOptions.base_url || 'https://offcloud.com/api/';
    this.defaultOptions = defaultOptions;
    delete this.defaultOptions.base_url;
    
    // Create axios instance with common configuration
    this.axiosInstance = axios.create({
      timeout: 30000, // 30 second default timeout
      headers: {
        'User-Agent': 'offcloud-downloader/1.0.0'
      }
    });
  }

  /**
   * Run request with automatic retry for certain errors
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

    // Custom shouldRetry function that handles HTTP status codes
    const shouldRetry = (err) => {
      // If it has a response, check status code
      if (err.response) {
        return isRetriableStatus(err.response.status);
      }
      // Otherwise use default connection error detection
      return true; // Default behavior in withRetry
    };

    try {
      // Use our common retry utility
      const response = await withRetry(
        async () => {
          const response = await this.axiosInstance(config);
          return response;
        },
        {
          maxRetries: 3,
          baseDelay: 1000,
          shouldRetry,
          operationName: `API call to ${endpoint}`
        }
      );
      
      // Handle 404 errors specially before returning
      if (response.status === 404) {
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
      
      return response.data;
    } catch (err) {
      logger.error(`Failed API call to ${endpoint}: ${err.message}`);
      throw err;
    }
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

  async _get(endpoint, options = {}) {
    return await this._request(endpoint, { ...options, method: 'get' });
  }

  async _delete(endpoint, options = {}) {
    return await this._request(endpoint, { ...options, method: 'delete' });
  }

  async _post(endpoint, options = {}) {
    return await this._request(endpoint, { ...options, method: 'post' });
  }

  async _put(endpoint, options = {}) {
    return await this._request(endpoint, { ...options, method: 'put' });
  }

  /**
   * Get cloud download history
   * Main method for retrieving storage usage information
   * 
   * @returns {Promise} - Promise that resolves with cloud history
   */
  async cloudHistory() {
    log('cloudHistory');
    return await this._get('cloud/history', {
      timeout: 60000 // Longer timeout for history
    });
  }

  async CloudDetails() {
    log('CloudDetails: ');
    return await this._post('cloud/download', {
      formData: {}
    });
  }

  async explore(reqid) {
    log('explore: ', reqid);
    return await this._post('cloud/explore', {
      formData: {
        requestId: reqid
      }
    });
  }

  async CloudStatus(reqid) {
    log('CloudStatus: ', reqid);
    return await this._post('cloud/status', {
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
    log('delete: ', reqid);
    logger.debug(`Deleting cloud item: ${reqid}`);
    
    // Try multiple deletion methods in sequence
    const deletionMethods = [
      // Method 1: Direct GET to remove endpoint
      async () => await this._get(`https://offcloud.com/cloud/remove/${reqid}`),
      
      // Method 2: POST to cloud/delete endpoint
      async () => await this._post('cloud/delete', {
        formData: { requestId: reqid }
      }),
      
      // Method 3: Direct POST to remove endpoint
      async () => await this._post(`cloud/remove/${reqid}`)
    ];
    
    // Try each method in sequence until one works
    for (let i = 0; i < deletionMethods.length; i++) {
      try {
        const result = await deletionMethods[i]();
        logger.debug(`Successfully deleted ${reqid} using method ${i+1}`);
        return result;
      } catch (err) {
        if (i === deletionMethods.length - 1) {
          logger.error(`Could not delete resource ${reqid} after trying all methods`);
          // Return success anyway to prevent blocking the flow
          return { success: true, message: 'Could not delete but proceeding anyway' };
        }
        logger.warn(`Delete method ${i+1} failed for ${reqid}, trying next method`);
      }
    }
  }

  async proxies() {
    log('proxies: ');
    return await this._post('proxy', {
      formData: {
        requestId: ''
      }
    });
  }

  async remotes() {
    log('remotes: ');
    return await this._post('remote/accounts', {
      formData: {
        requestId: ''
      }
    });
  }

  async btstatus(bthashes) {
    return await this._post('cache', {
      formData: {
        hashes: [bthashes]
      }
    });
  }

  async addCloud(link) {
    log('addCloud: ', link);
    logger.debug(`Adding to cloud: ${link}`);
    return await this._post('cloud', {
      formData: { url: link }
    });
  }

  async addUsenet(link, name) {
    log('addUsenet: ', link);
    logger.debug(`Adding to usenet: ${link}, name: ${name}`);
    return await this._post('cloud', {
      formData: { url: link, customFileName: name }
    });
  }

  async addFile(path) {
    const form = new FormData();
    const stream = fs.createReadStream(path);

    form.append('file', stream);
    form.append('name', 'file');
    form.append('filename', path);

    async function uploadFile() {
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
    }

    // Use our common retry utility for file uploads
    try {
      return await withRetry(
        uploadFile.bind(this),
        {
          maxRetries: 3,
          baseDelay: 1000,
          operationName: `File upload ${path}`
        }
      );
    } catch (error) {
      logger.error(`Could not upload file after retries: ${path}`);
      throw error;
    }
  }

  async addTorrent(path) {
    // Delegate to addFile which has better error handling
    return await this.addFile(path);
  }

  async addInstant(link) {
    log('addInstant: ', link);
    logger.debug(`Adding instant: ${link}`);
    return await this._post('cloud', {
      formData: { url: link }
    });
  }

  async addRemote(link) {
    log('addRemote: ', link);
    logger.debug(`Adding remote: ${link}`);
    return await this._post('remote', {
      formData: { url: link }
    });
  }
  
  /**
   * Retry a failed download
   * @param {string} requestId - ID of the failed download
   * @returns {Promise} - Promise that resolves when retry is initiated
   */
  async retryDownload(requestId) {
    log('retryDownload', requestId);
    logger.info(`Retrying download: ${requestId}`);
    try {
      return await this._get(`cloud/retry/${requestId}`, {});
    } catch (err) {
      // Handle 404 errors
      if (err.message && err.message.includes('404')) {
        logger.warn(`Cannot retry download ${requestId}: not found`);
        return { success: false, message: 'Download not found' };
      }
      throw err;
    }
  }
}

export default OffCloudAPI;