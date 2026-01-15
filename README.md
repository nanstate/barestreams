# lazy-torrentio

Minimal Stremio addon that serves empty stream results with Redis-backed caching.

## Prereqs

- Node.js 20+
- Redis instance (or Docker)

## Run with Docker Compose

```bash
docker compose up --build
```

Addon will be available at:

- http://localhost:19080/manifest.json

Flaresolverr (optional) will be available at:

- http://localhost:8191

## Run locally

```bash
npm install
REDIS_URL=redis://localhost:6379 EZTV_URL=https://eztv.re YTS_URL=https://yts.lt TGX_URL=https://torrentgalaxy.hair PIRATEBAY_URL=https://thepiratebay.org X1337X_URL=https://1337x.to npm run dev
```

Addon will be available at:

- http://localhost:80/manifest.json

## Configuration

- `REDIS_URL`: Redis connection string.
- `EZTV_URL`: Comma-separated list of EZTV base URLs to try in order.
- `YTS_URL`: Comma-separated list of YTS base URLs to try in order.
- `TGX_URL`: Comma-separated list of TorrentGalaxy base URLs to try in order.
- `PIRATEBAY_URL`: Comma-separated list of Pirate Bay base URLs to try in order.
- `X1337X_URL`: Comma-separated list of 1337x base URLs to try in order.

## IMDb datasets

On startup the addon downloads and extracts the IMDb TSV datasets into `data/imdb`. If the files are older
than 24 hours they are refreshed in the background.

## Stremio install

Add the addon using:

- http://localhost:80/manifest.json
