# Brimble Take-Home

A one-page deployment pipeline: paste a Git URL, watch the build logs stream live, and get a live URL — all running locally via Docker Compose.

## Quick Start

```sh
# 1. Build the builder image (one-time, needed before first deployment)
./scripts/build-builder.sh

# 2. Bring the full stack up
docker compose up --build

# 3. Open http://brimble.localhost in your browser
```

**Verify the stack is wired up:**
- `http://brimble.localhost` — UI (shows API health status)
- `http://api.brimble.localhost/api/health` → `{"status":"ok"}`
- `http://api.brimble.localhost/api/caddy-check` → `{"caddy":"ok"}`

## Prerequisites

### Linux / macOS
`*.localhost` resolves to `127.0.0.1` automatically (RFC 6761 + systemd-resolved / macOS resolver). No hosts file edits needed.

### Windows
Windows does not resolve `*.localhost` wildcard subdomains by default. Add these lines to `C:\Windows\System32\drivers\etc\hosts` (run Notepad as Administrator):

```
127.0.0.1 brimble.localhost
127.0.0.1 api.brimble.localhost
# Add one line per deployment ID you want to test, e.g.:
# 127.0.0.1 dep-a3f9k2.brimble.localhost
```

We use subdomain routing (not path routing) because it mirrors Brimble's production model. The Windows hosts-file requirement is the trade-off we accepted for that architectural match.

## Architecture

Each request enters through Caddy on port 80. Caddy is the **only** port exposed to the host. It routes by hostname: the UI at `brimble.localhost`, the API at `api.brimble.localhost`, and each deployed app at `<id>.brimble.localhost`. The API spawns builder containers on-demand using the host's Docker daemon (Docker-out-of-Docker via `/var/run/docker.sock`), then routes traffic to the resulting app container by patching Caddy's config through its admin API at `:2019` (internal only — never exposed to the host).

```
                 host:80
                    │
              ┌─────▼─────┐
              │   Caddy   │ ── admin API :2019 (compose-internal only)
              └─────┬─────┘
        ┌──────────┼──────────────────────┐
        │          │                      │
  brimble.       api.brimble.       <id>.brimble.
  localhost      localhost          localhost
        │          │                      │
     ┌──▼──┐    ┌──▼──┐              ┌────▼────┐
     │ UI  │    │ API │── docker.sock│ app-<id>│ (spawned by API)
     └─────┘    └──┬──┘              └─────────┘
                   │ spawns
                   ▼
              ┌─────────┐
              │ builder │── docker.sock + workspace volume
              │  (sibling container, runs railpack build)
              └─────────┘
```

**Key constraint — DooD volume-path trap:** The API container mounts `/var/run/docker.sock` and talks to the host daemon. When it tells the daemon to mount a path into a sibling container, the daemon resolves that path **on the host**, not inside the API container. We sidestep this by using named Docker volumes (`brimble_workspaces`) instead of bind paths.

**Note on the builder image:** `apps/builder/Dockerfile` is our internal tooling image — not a Dockerfile for a user's app. The brief's "no handwritten Dockerfiles" rule applies to apps deployed *through* the pipeline. Railpack generates those. The builder image just packages the Railpack CLI + Docker CLI.

**Railpack invocation:** We call `railpack build` directly (the CLI path, not the BuildKit frontend route). This trades some cache-key isolation for simplicity. For production, switch to `railpack prepare` + custom BuildKit frontend for cache-key isolation across tenants and parallel build throughput.

## Status

- [x] Scaffolding: all services boot, network and volumes wired up
- [x] `docker compose up --build` brings caddy + api + ui healthy
- [ ] `POST /api/deployments` — pipeline session
- [ ] Live log streaming (SSE) — pipeline session
- [ ] Caddy route registration per deployment — pipeline session
- [ ] Deployed app reachable at `<id>.brimble.localhost` — pipeline session

## Trade-offs

_To be filled in at completion._

## What I'd do with another weekend

_To be filled in at completion._

## Brimble platform feedback

_Honest written feedback prepared as a separate document._
