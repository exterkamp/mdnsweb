# mDNS Manager

A lightweight mDNS responder with a web dashboard for managing `.local` DNS records on your home network. Useful for routing Docker-hosted web apps to friendly hostnames without editing `/etc/hosts` on every device.

## How It Works

The server listens on the mDNS multicast address (UDP port 5353) and responds to:

- **A record queries** — resolves `.local` hostnames to IP addresses for any device on the LAN.
- **DNS-SD / Bonjour service advertisements** — when a record has a port set, the server also responds to PTR, SRV, and TXT queries so that Bonjour browsers (Finder sidebar, `dns-sd`, Avahi, etc.) can discover your web apps automatically without knowing their hostnames in advance.

## Running

### Docker Compose (recommended)

```bash
docker compose up -d
```

Requires `network_mode: host` (already set) so the container can send and receive multicast DNS packets on the LAN.

To rebuild the image after code changes and relaunch:

```bash
docker compose build --pull=false && docker compose up -d
```

`--pull=false` skips re-pulling the base image from Docker Hub (avoids network timeouts when the image is already cached locally).

### Development mode (hot reload)

A separate Compose file mounts the source tree as live volumes. Changes to `server.js` trigger an automatic nodemon restart; changes to anything under `public/` (HTML, CSS) push a browser reload via SSE — no rebuild needed.

```bash
# First-time build
docker compose -f docker-compose.dev.yml build

# Start dev stack
docker compose -f docker-compose.dev.yml up -d

# Tail logs (shows nodemon restarts and file-change events)
docker compose -f docker-compose.dev.yml logs -f
```

The dashboard at `http://<server-ip>:8090` will automatically refresh whenever you save a file.

### Bare Node

```bash
npm install
node server.js
```

Needs access to UDP port 5353 (mDNS). On Linux this may require `sudo` or a `CAP_NET_BIND_SERVICE` capability grant.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `8090`  | Web dashboard port |

## Web Dashboard

Open `http://<server-ip>:8090` in a browser.

From the dashboard you can:

- **Add a record** — enter a hostname (`.local` is appended automatically if omitted), an IP address (defaults to server IP), and optionally a **port** and **protocol** (HTTP/HTTPS). Providing a port enables Bonjour/DNS-SD advertisement so devices discover the service automatically.
- **Enable / disable** a record without deleting it.
- **Edit** the hostname, IP, port, protocol, or description of an existing record.
- **Delete** a record.
- **View the activity log** — shows recent mDNS queries, responses, and API calls.

Records with a port set display a green Bonjour badge (`http:8080`) and their link/copy button uses the correct protocol and port.

Records are persisted to `data/records.json` and survive restarts.

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/records` | List all records + server info |
| `POST` | `/api/records` | Create a record |
| `PUT` | `/api/records/:id` | Update a record |
| `DELETE` | `/api/records/:id` | Delete a record |
| `GET` | `/api/status` | Activity log + system stats |

### Example: create a record (A record only)

```bash
curl -X POST http://localhost:8090/api/records \
  -H 'Content-Type: application/json' \
  -d '{"name": "myapp.local", "ip": "192.168.1.50", "description": "My app"}'
```

### Example: create a record with Bonjour advertisement

```bash
curl -X POST http://localhost:8090/api/records \
  -H 'Content-Type: application/json' \
  -d '{"name": "stirling-pdf.local", "ip": "192.168.1.50", "port": 8080, "serviceType": "_http._tcp", "description": "Stirling PDF"}'
```

With a port set, the service is discoverable via `dns-sd -B _http._tcp local` on macOS or `avahi-browse -t _http._tcp` on Linux.

## Notes

- Only IPv4 A records are supported.
- Hostnames are normalized to lowercase and always end with `.local`.
- The container must run with `network_mode: host` — bridge networking will not receive multicast DNS multicast packets from other LAN devices.
- Bonjour service advertisement (DNS-SD) is opt-in per record: only records with a port set are advertised as services. Records without a port function as plain A records.
- Supported service types: `_http._tcp` (HTTP) and `_https._tcp` (HTTPS).
