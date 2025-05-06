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

## Queue Management System

The application includes an intelligent queue management system that:

1. **Monitors available storage on offcloud.com**: Before sending new downloads to Offcloud, the system checks available storage to prevent failures due to storage limitations.

2. **Prioritizes downloads**: Files are queued based on priority and submission time, ensuring orderly processing.

3. **Auto-cleans old downloads**: The system periodically removes older completed downloads from your Offcloud account to free up space for new downloads.

4. **Manages concurrent downloads**: Limits the number of simultaneous downloads to optimize performance and reliability.

5. **Handles errors gracefully**: Failed downloads are automatically retried with a backoff strategy before being removed from the queue.

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

The application provides detailed logging with configurable levels. To enable debug logging, set `LOG_LEVEL=debug` in your `.env` file. For persistent logs, enable file logging with `LOG_TO_FILE=true`.

## Technical Details

- Built with Node.js
- Uses axios for API communication and downloads
- File monitoring with chokidar
- Intelligent queue management with priority-based processing
- Robust error handling with exponential backoff for retries

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
