# offcloud-downloader

An offcloud.com blackhole downloader with intelligent queue management and modern dependencies.

## Environment Variables

| Value | Description | Default |
| --- | --- | --- |
| OFFCLOUD_API_KEY | Offcloud API Key (required) | |
| WATCH_DIR | Directory to watch for new files | /watch |
| IN_PROGRESS_DIR | Directory for in-progress downloads | /in-progress |
| COMPLETED_DIR | Directory for completed downloads | /completed |
| WATCH_RATE | Rate to check for updates (ms) | 5000 |
| MAX_CONCURRENT_DOWNLOADS | Maximum number of concurrent downloads | 3 |
| FILE_STABLE_TIME | How long a file must be stable before processing (ms) | 5000 |
| FILE_POLL_INTERVAL | How often to poll for file changes (ms) | 1000 |
| FORCE_POLLING | Force file system polling even on non-Windows systems | false |
| LOG_LEVEL | Logging level (error, warn, info, http, debug) | info |
| LOG_TO_FILE | Enable logging to file (true/false) | false |
| LOG_FILE_PATH | Path to log file | ./logs/offcloud-downloader.log |
| LOG_ROTATION | Enable log rotation (true/false) | true |
| LOG_MAX_SIZE | Maximum log file size in bytes | 10485760 (10MB) |
| LOG_MAX_FILES | Number of rotated log files to keep | 5 |
| LOG_COLOR_OUTPUT | Enable colorized log output (true/false) | true |
| LOG_TIMESTAMP | Show timestamps in console output (true/false) | true |

## Features

- Automatically watches a directory for new .torrent, .magnet, or .nzb files
- Sends files to offcloud.com for processing
- Downloads the content to an in-progress directory while processing
- Moves completed downloads to a completed directory when done
- Cleans up the original file and empty directories after successful download
- Prevents jobs from starting prematurely by using separate in-progress and completed folders
- **Intelligent queue management based on available storage**
- **Auto-cleanup of old completed downloads to free up space**
- **Configurable concurrent download limit**
- **Modern HTTP handling with axios for increased reliability**
- **Improved error recovery and retry mechanism**
- **Enhanced progress tracking for large downloads**
- **Centralized utilities for retry logic and file operations**
- **Advanced file system monitoring with Chokidar v4**
- **Automatic watcher recovery for improved stability**
- **File locking mechanism to prevent conflicts**
- **Log rotation for better log management**

## Queue Management System

The application includes an intelligent queue management system that:

1. **Monitors available storage on offcloud.com**: Before sending new downloads to Offcloud, the system checks available storage to prevent failures due to storage limitations.

2. **Prioritizes downloads**: Files are queued based on priority and submission time, ensuring orderly processing.

3. **Auto-cleans old downloads**: The system periodically removes older completed downloads from your Offcloud account to free up space for new downloads. By default, any completed downloads older than 24 hours will be removed from Offcloud.com (but remain in your local completed folder).

4. **Manages concurrent downloads**: Limits the number of simultaneous downloads to optimize performance and reliability.

5. **Handles errors gracefully**: Failed downloads are automatically retried with a backoff strategy before being removed from the queue.

## File System Monitoring

The application uses Chokidar v4 for file system monitoring with several key features:

1. **Optimized Performance**: Reduces CPU usage by using native file system events where available
2. **Automatic Recovery**: Self-repairs when file system watchers encounter errors
3. **Stable File Detection**: Waits for files to stabilize before processing to avoid partial files
4. **Intelligent Deduplication**: Prevents duplicate processing of the same file

## Cleanup Configuration

The application automatically cleans up completed downloads on Offcloud.com:

- **Immediate cleanup**: When a download completes successfully to your local machine, it's immediately removed from Offcloud.com.
- **Periodic cleanup**: A background task runs every hour to remove any completed downloads that are older than 24 hours from Offcloud.com.

The periodic cleanup can be configured by modifying `lib/watchers/offcloud/queuemanager.js`:

```javascript
// To change the cleanup timeframe (e.g., to 72 hours)
async cleanupCompletedDownloads(maxAgeHours = 72) {
  // ...
}

// To disable periodic cleanup entirely
startPeriodicCleanup() {
  /*
  this.cleanupInterval = setInterval(() => {
    this.cleanupCompletedDownloads();
  }, 60 * 60 * 1000);
  */
  
  // Keep this part for local memory management
  this.processedFilesCleanupInterval = setInterval(() => {
    // ...
  }, 3600000);
}
```

**Note**: This cleanup only affects files on Offcloud.com. Files in your local `/completed` directory are never automatically deleted.

## Code Architecture

The application uses a modular architecture:

- **Core components**: 
  - `index.js`: Main application entry point with advanced file monitoring
  - `lib/watchers/offcloud`: Monitors Offcloud.com and manages downloads
  - `lib/downloaders/inline`: Handles the actual file downloads

- **Utility modules**:
  - `lib/utils/retry.js`: Enhanced retry logic with exponential backoff
  - `lib/utils/fileOperations.js`: Robust file handling with locking mechanism
  - `lib/utils/logger.js`: Advanced logging with rotation and formatting

## Requirements

* An API-Key from offcloud.com
* Docker and Docker Compose (or Node.js 18+ for non-Docker usage)

## Setup

1. Copy `.env.example` to `.env`
2. Add your Offcloud API key to the `.env` file
3. Create directories for watching, in-progress, and completed:
   * Linux/Mac: Create directories as needed
   * Windows: Create directories (e.g., `E:\offcloud\watch`, `E:\offcloud\in-progress`, `E:\offcloud\completed`)
4. Update `docker-compose.yml` to mount these directories if different from defaults
5. Optionally adjust configuration in your `.env` file

### Docker Setup

Build and run with Docker Compose:

```bash
# Build the image
docker-compose build

# Run the application
docker-compose up -d

# View logs
docker-compose logs -f
```

### Running in Headless Mode

The application is designed to run as a background service in "headless" mode, which means it doesn't require an active terminal session to continue working.

To run in headless mode:

```bash
# Start the container in detached mode
docker-compose up -d
```

This will launch the container in the background. It will continue running even after you close your terminal window or disconnect from the server.

#### Viewing Logs in Headless Mode

When running in headless mode, you have several options for monitoring logs:

1. **Using Docker Compose**:
   ```bash
   # View all logs
   docker-compose logs downloader
   
   # Follow/stream logs in real-time
   docker-compose logs -f downloader
   
   # View only the last 100 lines
   docker-compose logs --tail=100 downloader
   ```

2. **Using Docker Desktop**:
   If you're running Docker Desktop, you can view container logs through the graphical interface by selecting the container in the Containers tab.

3. **Enable File-Based Logging**:
   To keep persistent logs that you can access at any time, enable file logging in your `.env` file:
   ```
   LOG_TO_FILE=true
   LOG_FILE_PATH=./logs/offcloud-downloader.log
   ```
   This will write logs to a file that you can access even when the container is running headlessly.

#### Managing Headless Containers

To manage your headless container:

```bash
# Stop the container (it will restart automatically if using restart:unless-stopped)
docker-compose stop downloader

# Stop all services
docker-compose down

# Restart the container
docker-compose restart downloader

# Check container status
docker-compose ps
```

### Non-Docker Setup

If you prefer to run without Docker:

```bash
# Install dependencies
npm install

# Start the application
npm start

# For development with auto-restart
npm run watch
```

### Windows-specific Setup

For Windows users, edit your `docker-compose.yml` to map your local directories:

```yaml
volumes:
  - /workspace/node_modules
  - .:/workspace
  - E:/offcloud/watch:/watch
  - E:/offcloud/in-progress:/in-progress
  - E:/offcloud/completed:/completed
```

## Logging

The application provides detailed logging with configurable levels and rotation. To enable debug logging, set `LOG_LEVEL=debug` in your `.env` file. For persistent logs, enable file logging with `LOG_TO_FILE=true`.

Log files are automatically rotated when they reach the configured size (`LOG_MAX_SIZE`), and old log files are removed when they exceed the configured count (`LOG_MAX_FILES`).

## Progress Tracking

The application provides detailed progress tracking during downloads:

1. **Remote Phase**: When Offcloud.com is downloading from the source, you'll see status updates in the logs.
2. **Local Phase**: When downloading from Offcloud.com to your machine, detailed progress percentages are shown:
   ```
   [+] Download progress: 13.11MB / 40.70MB (32.21%)
   ```

## Performance Considerations

- **Windows Systems**: File polling is used by default for better compatibility
- **Linux/macOS**: Native file system events are used for better performance
- **High Volume**: If processing many files simultaneously, consider increasing `MAX_CONCURRENT_DOWNLOADS`
- **Limited Resources**: For systems with limited CPU/memory, reduce polling by setting `FILE_POLL_INTERVAL` higher

## Troubleshooting

If you encounter issues:

1. **Check logs**: Enable debug logging with `LOG_LEVEL=debug` for detailed information
2. **Verify permissions**: Ensure the application has appropriate permissions for all directories
3. **Inspect network**: Many issues stem from network connectivity problems with Offcloud
4. **Memory usage**: Monitor memory usage to ensure it remains stable over time
5. **Watcher issues**: If file detection problems occur, try setting `FORCE_POLLING=true`

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
