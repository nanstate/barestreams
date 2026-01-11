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
REDIS_URL=redis://localhost:6379 npm run dev
```

Addon will be available at:

- http://localhost:80/manifest.json

## Stremio install

Add the addon using:

- http://localhost:80/manifest.json
