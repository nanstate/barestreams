# barestreams

Minimal Stremio addon that serves torrent stream results with Redis-backed caching. It does not crawl ahead of time; it fetches and parses sources only when a user requests a stream. It aggregates results from multiple public torrent sources, normalizes them into Stremio stream responses, and returns results ordered by seeders (descending).

## Run with Docker Compose

```bash
docker compose up --build
```

Run with the VPN gateway (`gluetun`):

```bash
docker compose -f docker-compose.gluetun.yml up --build
```

Addon will be available at:

- http://localhost:19080/manifest.json

### Optional services

The Docker setup includes optional containers that you can remove if you don't need them. The VPN gateway is only included in `docker-compose.gluetun.yml`:

- `gluetun`: VPN gateway ([qdm12/gluetun](https://github.com/qdm12/gluetun)). Current config is NordVPN-specific; Gluetun supports other providers as well and requires `.env` values if enabled.
- `redis`: Caching backend. If disabled, remove `REDIS_*` configurations.
- `flaresolverr`: Used by some scrapers to bypass cloudflare protections ([FlareSolverr/FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)). If disabled, remove `FLARESOLVERR_*` configurations.

## Run e2e tests with FlareSolverr

```bash
docker compose -f docker-compose.test.yml up --abort-on-container-exit --build
```

## Configuration

- `REDIS_URL`: Redis connection URL (optional).
- `REDIS_TTL_HOURS`: Redis cache TTL in hours (optional).
- `MAX_REQUEST_WAIT_SECONDS`: Maximum time in seconds to wait for scraper results before returning partial results (optional).
- `EZTV_URL`: Comma-separated list of EZTV base URLs to try in order.
- `YTS_URL`: Comma-separated list of YTS base URLs to try in order.
- `TGX_URL`: Comma-separated list of TorrentGalaxy base URLs to try in order.
- `APIBAY_URL`: Comma-separated list of ApiBay base URLs to try in order.
- `X1337X_URL`: Comma-separated list of 1337x base URLs to try in order.
- `FLARESOLVERR_URL`: FlareSolverr base URL (optional).
- `FLARESOLVERR_SESSIONS`: Maximum FlareSolverr sessions per scraper (optional).
- `FLARESOLVERR_SESSION_REFRESH_MS`: FlareSolverr session refresh interval in ms (optional).

## Supported scrapers

Remove a scraper URL env var to disable it (for example, omit `EZTV_URL`).

| Scraper | Env var | Content |
| --- | --- | --- |
| EZTV | `EZTV_URL` | Series |
| YTS | `YTS_URL` | Movies |
| TorrentGalaxy | `TGX_URL` | Movies, Series |
| The Pirate Bay (ApiBay) | `APIBAY_URL` | Movies, Series |
| 1337x | `X1337X_URL` | Movies, Series |

On startup, the addon probes each scraper front page; if a scraper returns a 401/403, it retries via FlareSolverr and sticks to FlareSolverr for the rest of the process. FlareSolverr is used to bypass Cloudflare checks when detected.

If you keep `gluetun` enabled, copy `.env.example` to `.env` and fill in entries such as:

```
NORDVPN_USER=...
NORDVPN_PASS=...
NORDVPN_SERVER_COUNTRIES=...
TZ=...
```

## Expose publicly

If you want to share the API beyond your local network, you will need to make it publicly reachable and share it via HTTPS for Stremio clients.

After this, your addon manifest should be available at:

- https://your.domain.example/manifest.json

## IMDb datasets

On startup the addon downloads and extracts the IMDb TSV datasets into `data/imdb`. If the files are older than 24 hours they are refreshed in the background.
