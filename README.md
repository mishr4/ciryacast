# TMCast

Lightweight self-hosted internet radio station platform by **The Mavion Corporation**.

TMCast is a minimal alternative to AzuraCast — no Docker, no Liquidsoap, no Icecast. Just Node.js and your MP3s.

## Features

- **Multi-station support** — run multiple radio stations from one instance
- **AutoDJ** — shuffled playlist playback at the correct bitrate, no external tools needed
- **Pure Node.js streaming** — MP3 audio served over HTTP with Icecast-compatible headers
- **Web dashboard** — dark-themed admin panel to manage stations, media, and playlists
- **Public player page** — embeddable player with live metadata, visualizer, and listener count
- **Real-time updates** — WebSocket-powered now playing, listener counts, and track changes
- **Media library** — upload MP3/OGG/FLAC/WAV/M4A with automatic metadata parsing
- **Play history** — track log with listener counts
- **SQLite database** — zero-config, single file, no external DB needed
- **Drag & drop uploads** — drop audio files right into the dashboard

## Requirements

- Node.js 18+
- That's it

## Quick Start

```bash
npm install
npm start
```

Dashboard: `http://localhost:8420`

## How It Works

1. Create a station in the dashboard
2. Upload audio files (drag & drop or browse)
3. Files are auto-added to the station's default playlist
4. Start AutoDJ — it shuffles through your library at the configured bitrate
5. Listeners connect to `/listen/:stationId/radio.mp3`
6. Public player at `/player/:stationId`

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stations` | List all stations |
| POST | `/api/stations` | Create a station |
| PUT | `/api/stations/:id` | Update a station |
| DELETE | `/api/stations/:id` | Delete a station |
| POST | `/api/stations/:id/autodj/start` | Start AutoDJ |
| POST | `/api/stations/:id/autodj/stop` | Stop AutoDJ |
| POST | `/api/stations/:id/autodj/skip` | Skip current track |
| GET | `/api/stations/:id/media` | List station media |
| POST | `/api/stations/:id/media` | Upload media (multipart) |
| DELETE | `/api/media/:id` | Delete a media file |
| GET | `/api/stations/:id/playlists` | List playlists |
| GET | `/api/stations/:id/history` | Play history |
| GET | `/api/nowplaying` | All stations now playing |
| GET | `/api/nowplaying/:id` | Single station now playing |
| GET | `/api/stats` | Global stats |

## Stream URL

```
http://localhost:8420/listen/{stationId}/radio.mp3
```

Compatible with VLC, foobar2000, any media player, or an HTML5 `<audio>` element.

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | 8420 | HTTP server port |

## Architecture

- **Express** — HTTP server + REST API
- **better-sqlite3** — embedded SQLite database
- **WebSocket (ws)** — real-time dashboard updates
- **Node.js streams** — bitrate-paced MP3 file streaming
- **multer** — file upload handling
- **music-metadata** — audio file tag parsing

No ffmpeg. No Liquidsoap. No Icecast. No Docker. Just Node.

---

**The Mavion Corporation** — [tmc.gg](https://tmc.gg) | Built for TMCast hosting
