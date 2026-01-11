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

## Run locally

```bash
npm install
REDIS_URL=redis://localhost:6379 EZTV_URL=https://eztv.re YTS_URL=https://yts.mx npm run dev
```

Addon will be available at:

- http://localhost:80/manifest.json

## Configuration

- `REDIS_URL`: Redis connection string.
- `EZTV_URL`: Comma-separated list of EZTV base URLs to try in order.
- `YTS_URL`: Comma-separated list of YTS base URLs to try in order.

## Stremio install

Add the addon using:

- http://localhost:80/manifest.json
