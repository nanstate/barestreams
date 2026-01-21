# barestreams

Minimal Stremio addon that serves torrent stream results with Redis-backed caching. It does not crawl ahead of time; it fetches and parses sources only when a user requests a stream. It aggregates results from multiple public torrent sources, normalizes them into Stremio stream responses.

## Run with Docker Compose

```bash
docker compose up --build
```

Run without the VPN gateway (no `gluetun` dependency):

```bash
docker compose -f docker-compose.no-gluetun.yml up --build
```

Addon will be available at:

- http://localhost:19080/manifest.json

### Optional services

The Docker setup includes optional containers that you can remove if you don't need them:

- `gluetun`: VPN gateway ([qdm12/gluetun](https://github.com/qdm12/gluetun)). Current config is NordVPN-specific; Gluetun supports other providers as well and requires `.env` values if enabled.
- `redis`: Caching backend. If disabled, remove `REDIS_URL`.
- `flaresolverr`: Used by some scrapers to bypass protections ([FlareSolverr/FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)). If disabled, remove `FLARESOLVERR_URL`.

## Run e2e tests with FlareSolverr

```bash
docker compose -f docker-compose.test.yml up --abort-on-container-exit --build
```

## Configuration

- `REDIS_URL`: Redis connection URL (optional).
- `EZTV_URL`: Comma-separated list of EZTV base URLs to try in order.
- `YTS_URL`: Comma-separated list of YTS base URLs to try in order.
- `TGX_URL`: Comma-separated list of TorrentGalaxy base URLs to try in order.
- `PIRATEBAY_URL`: Comma-separated list of Pirate Bay base URLs to try in order.
- `X1337X_URL`: Comma-separated list of 1337x base URLs to try in order.
- `FLARESOLVERR_URL`: FlareSolverr base URL (optional).
- `FLARESOLVERR_SESSIONS`: Number of FlareSolverr sessions to keep (optional).

## Supported scrapers

Set a scraper URL list to an empty string to disable it (e.g. `EZTV_URL=""`).

| Scraper | Env var | Requires FlareSolverr |
| --- | --- | --- |
| EZTV | `EZTV_URL` | No |
| YTS | `YTS_URL` | No |
| TorrentGalaxy | `TGX_URL` | No |
| Pirate Bay | `PIRATEBAY_URL` | No |
| 1337x | `X1337X_URL` | Yes |

If you keep `gluetun` enabled, copy `.env.example` to `.env` and fill in entries such as:

```
NORDVPN_USER=...
NORDVPN_PASS=...
NORDVPN_SERVER_COUNTRIES=...
TZ=...
```

## Expose publicly with HTTPS

Stremio requires HTTPS when accessing addons over the internet. The simplest approach is a reverse proxy (for example, Nginx) with a Let's Encrypt certificate.

Example setup (replace `your.domain.example`):

1. Create an A/AAAA DNS record pointing to your server.
2. Install Nginx and Certbot, then request a certificate:

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.example
```

3. Configure Nginx to proxy to the addon:

```nginx
server {
  listen 80;
  server_name your.domain.example;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name your.domain.example;

  ssl_certificate /etc/letsencrypt/live/your.domain.example/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/your.domain.example/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:19080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

After this, your addon manifest should be available at:

- https://your.domain.example/manifest.json

## IMDb datasets

On startup the addon downloads and extracts the IMDb TSV datasets into `data/imdb`. If the files are older than 24 hours they are refreshed in the background.
