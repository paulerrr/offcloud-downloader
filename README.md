# offcloud-downloader

An offcloud.com blackhole downloader.

## Environment Variables

| Value | Description | Default |
| --- | --- | --- |
| OFFCLOUD_API_KEY | Offcloud API Key (required) | |
| WATCH_DIR | Directory to watch for new files | /watch |
| DOWNLOAD_DIR | Directory to put downloaded files in | /download |
| WATCH_RATE | Rate to check for updates (ms) | 5000 |

## Features

- Automatically watches a directory for new .torrent, .magnet, or .nzb files
- Sends files to offcloud.com for processing
- Downloads the content to your local machine when processing is complete
- Cleans up the original file after successful download

## Requirements

* An API-Key from offcloud.com
* Docker and Docker Compose

## Setup

1. Copy `.env.example` to `.env`
2. Add your Offcloud API key to the `.env` file
3. Create directories for watching and downloading:
   * Linux/Mac: Create directories as needed
   * Windows: Create directories (e.g., `E:\offcloud\watch`, `E:\offcloud\download`)
4. Update `docker-compose.yml` to mount these directories if different from defaults

### Windows-specific Setup

For Windows users, edit your `docker-compose.yml` to map your local directories:

```yaml
volumes:
  - /workspace/node_modules
  - .:/workspace
  - E:/offcloud/watch:/watch     # Your Windows watch directory
  - E:/offcloud/download:/download  # Your Windows download directory
