# offcloud-downloader

An offcloud.com blackhole downloader.

## Environment Variables

| Value | Description | Default |
| --- | --- | --- |
| OFFCLOUD_API_KEY | Offcloud API Key (required) | |
| WATCH_DIR | Directory to watch for new files | /watch |
| IN_PROGRESS_DIR | Directory for in-progress downloads | /in-progress |
| COMPLETED_DIR | Directory for completed downloads | /completed |
| WATCH_RATE | Rate to check for updates (ms) | 5000 |

## Features

- Automatically watches a directory for new .torrent, .magnet, or .nzb files
- Sends files to offcloud.com for processing
- Downloads the content to an in-progress directory while processing
- Moves completed downloads to a completed directory when done
- Cleans up the original file and empty directories after successful download
- Prevents jobs from starting prematurely by using separate in-progress and completed folders

## Requirements

* An API-Key from offcloud.com
* Docker and Docker Compose

## Setup

1. Copy `.env.example` to `.env`
2. Add your Offcloud API key to the `.env` file
3. Create directories for watching, in-progress, and completed:
   * Linux/Mac: Create directories as needed
   * Windows: Create directories (e.g., `E:\offcloud\watch`, `E:\offcloud\in-progress`, `E:\offcloud\completed`)
4. Update `docker-compose.yml` to mount these directories if different from defaults

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