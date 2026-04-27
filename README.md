# Brimble Take-Home

A one-page deployment pipeline: submit a Git URL, watch build logs stream live, and get a running container at a unique subdomain. Built with Vite + TanStack on the frontend, Fastify on the backend, Railpack for builds, and Caddy for ingress. Everything boots with `docker compose up`.

## Quick start

```sh
# 1. Build the builder image (one-time — needed before first deployment)
docker build apps/builder -t brimble-builder:latest

# 2. Bring the full stack up
docker compose up --build
```

Then open **http://brimble.localhost**.

Submit a public Node.js repo URL. For the included sample app, push `examples/hello-node/` to a public GitHub repo and use that URL. After 30–60 seconds (cold Railpack build) the status will show `running` and the URL will be live.

**Stack verification:**
- `http://brimble.localhost` — UI
- `http://api.brimble.localhost/api/health` → `{"status":"ok"}`
- `http://api.brimble.localhost/api/caddy-check` → `{"caddy":"ok"}`

## Prerequisites

- Docker (with Compose v2) and a recent Node toolchain (only needed for local dev; Docker handles everything for `docker compose up`).

**Linux / macOS:** `*.localhost` resolves to `127.0.0.1` automatically per RFC 6761. No `/etc/hosts` edits needed.

**Windows:** Windows does not resolve `*.localhost` wildcard subdomains by default. Add to `C:\Windows\System32\drivers\etc\hosts` (run Notepad as Administrator):
```
127.0.0.1 brimble.localhost
127.0.0.1 api.brimble.localhost
# add one line per deployment you want to test:
# 127.0.0.1 dep-xxxxxx.brimble.localhost
```
Or use WSL2 where it works natively.

## Architecture

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

The architecture makes one non-obvious choice in each layer:

- **DooD over DinD.** The API mounts `/var/run/docker.sock` and talks to the host daemon rather than running Docker-in-Docker. Avoids `--privileged`, shares image layers with the host, faster on a grader's laptop. The trade-off: if the API container ever had an RCE, it owns the host daemon. Mitigated by never publishing `:2019` or the Docker socket externally.

- **Subdomain routing on `*.localhost`** rather than path-based routing. Mirrors Brimble's production model where each deployment gets its own domain. Trade-off: requires hosts-file edits on Windows (documented above).

- **Caddy admin API with `@id` tags** for dynamic route registration. Each deployment is one `POST` to add a route and one `DELETE` to remove it — no config file reloads, no downtime. The `"@id"` tag lets us address the route directly without walking the config tree.

- **Persist-then-emit log streaming.** Logs are written to SQLite first (synchronous with `better-sqlite3`), then emitted to an in-memory pub/sub bus. An SSE subscriber calls `subscribe()` before `getLogs()` in the same synchronous frame so no line can fall between the two. A late subscriber gets full history from the DB; an early subscriber gets the live tail. No gap, no duplicates.

**Note on the builder image:** `apps/builder/Dockerfile` is our internal tooling container — not a user-app Dockerfile. The brief's "no handwritten Dockerfiles" rule applies to apps deployed *through* the pipeline; Railpack generates those. The builder image just packages the Railpack CLI and Docker CLI.

**Railpack invocation:** We call `railpack build` via the CLI (not the `railpack prepare` + BuildKit frontend route). The frontend route gives better cache-key isolation across tenants but adds two extra failure modes for no clarity gain at this scale. See "What I'd do with another weekend."

## Repo layout

```
brimble-takehome/
├── docker-compose.yml
├── Caddyfile.json            # seed config loaded at Caddy boot
├── apps/
│   ├── api/                  # Fastify backend
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── routes/       # deployments.ts, logs.ts
│   │   │   ├── pipeline/     # build.ts, deploy.ts, caddy.ts, orchestrator.ts
│   │   │   ├── db/           # schema.sql, queries.ts
│   │   │   └── lib/          # logBus.ts, docker.ts, git.ts, ids.ts
│   │   └── test/
│   │       └── pipeline.test.ts   # integration smoke test
│   ├── ui/                   # Vite + React + TanStack
│   │   └── src/
│   │       ├── routes/index.tsx   # entire one-page UI
│   │       └── lib/api.ts         # typed API client
│   └── builder/
│       └── Dockerfile        # railpack + docker CLI
└── examples/
    └── hello-node/           # sample Node app for testing
```

## Running the smoke test

The smoke test is an integration test — it requires the full stack to be running.

```sh
# In one terminal:
docker compose up --build

# In another (from apps/api/):
HELLO_NODE_REPO_URL=https://github.com/xodeeq/hello-node npm test
```

The test posts a deployment, polls until `running` (up to 5 min on a cold pull), curls the deployed app, asserts the response, then DELETEs the deployment and verifies the URL is gone. It is not a unit test — it proves the full pipeline works end-to-end.

## Troubleshooting

**Builder image fails with `curl: (22) 404` during `docker build`**

Railpack switched from a bare binary to versioned tarballs in v0.23.0. The Dockerfile now fetches the latest release tag from the GitHub API and extracts the binary from the tarball. If it fails, check that the build host can reach `api.github.com` and `github.com`.

**`npm test` fails immediately with `getaddrinfo ENOTFOUND api.brimble.localhost`**

Node.js's `getaddrinfo` does not resolve `*.brimble.localhost` on some Linux NSS configurations (e.g. `mdns4_minimal [NOTFOUND=return]`) even though curl works. The test patches `dns.lookup` at startup to map any `*.brimble.localhost` hostname to `127.0.0.1`, so this should be handled automatically. If you still see it, verify your Node.js version is ≥ 20.

**First build takes 3–5 minutes and the test times out**

The first `railpack build` cold-pulls the Node.js base image (~200 MB). The test allows 300 seconds for this. Subsequent builds use Docker's layer cache and finish in under 30 seconds. If the very first run times out, just run `npm test` again — the layers will already be cached.

**Deployment stuck in `building` forever (never transitions to `deploying`)**

This was caused by Docker's `follow=true` log stream not closing when the builder container exits in a DooD setup — `await logsDone` would hang indefinitely. Fixed in `pipeline/build.ts` by explicitly ending the PassThrough streams after `container.wait()` returns.

**Caddy returns 200 for unknown deployment subdomains**

A subroute with no matching routes returns an empty 200 in Caddy 2.11. Fixed by adding a `match: [{"host": ["*.brimble.localhost"]}]` to the outer deployments route and a `static_response 404` fallback as the last route in the subroute. Deployment routes are prepended (GET + PATCH on the subroute handler) so the fallback stays last.

## Trade-offs and decisions

- **`railpack build` CLI over `railpack prepare` + BuildKit frontend.** The frontend route is the production-recommended path for cache-key isolation across tenants and parallel build throughput. For a single-machine take-home it adds two failure modes (BuildKit version pinning, frontend image availability) with no clarity gain. Documented as the obvious next step.

- **SQLite over Postgres.** Single file in a named volume, zero second service. The queries module is the only coupling point — swappable behind an interface if scale demanded it. The `WAL` pragma keeps readers from blocking the writer during log ingestion.

- **One UI route despite TanStack Router being in the stack.** The brief required TanStack Router but the UI is genuinely a single page — faking multiple routes to justify the library would be worse than using it minimally. Noted here so a grader doesn't think it was missed.

- **Upload flow stubbed.** The API returns 501 for `source.type === "upload"` and the UI shows a disabled "Upload (coming soon)" button. The implementation path is clear (multipart upload → unzip into the workspace volume → same pipeline from there), but git-only satisfies the brief's testable requirement.

- **Concurrent Caddy route registration** is theoretically vulnerable to ETag collision if two deployments complete at the exact same millisecond. With a single-process API and human-rate submission this never fires. The fix (optimistic concurrency via ETag + conditional PUT) is documented in `.claude/skills/pipeline-gotchas.md §3`.

- **`system` log stream type.** Used to write pipeline status lines (clone, build start, deploy start, live URL). Useful for the UI's colored log viewer but adds surface area versus just writing plain strings. A close call; left in because the coloring is genuinely useful during debugging.

## What I'd do with another weekend

1. **Redeploy by previous image tag.** `POST /api/deployments/:id/redeploy?image_tag=<sha>` — skips clone and build, re-runs the deploy step with an existing image, swaps Caddy upstream via `@id` PATCH. ~30 lines. Highest-ROI bonus per the brief.

2. **Build cache reuse.** Pass `--cache-key <slug>` to `railpack build` derived from the source URL. Railpack's cache key determines which BuildKit layer cache it consults. Per-source-URL keys would cut rebuild time 60-80% for the same app. Currently every build starts cold.

3. **Switch to `railpack prepare` + BuildKit frontend.** Cache-key isolation across tenants, parallel build throughput, production-recommended. Add as the default path once the single-machine happy path is proven.

4. **Zero-downtime redeploys.** Spawn the new container alongside the old, health-check, swap Caddy upstream via `@id` PATCH, kill old. Sketched; didn't ship.

5. **Docker socket proxy.** A `tecnativa/docker-socket-proxy` sidecar between the API and the host daemon, limiting the API to only the Docker endpoints it needs (`containers/create`, `containers/start`, etc.). Production-grade hardening.

6. **Real upload support.** Multipart upload to the API, stream-unzip into the workspace volume, proceed identically from the build step.

## What I'd rip out

- **The 5-second poll on the deployment list.** It works but SSE on a "deployments-changed" channel (same pattern as logs) would be cleaner. The poll is acceptable here because the list is lightweight and the grader's patience is finite; for production it's the wrong model.

- **`pollReady()` in deploy.ts.** The 10-second readiness check before registering with Caddy is a band-aid. A proper health endpoint on the deployed app (or Caddy's active health checks) is the right primitive. Remove once the app contract is defined.

## Time spent

Approximately 8–10 hours across three sessions (scaffolding, pipeline, UI + polish).

## Live demo

The `deploy` branch carries two small changes needed for hosted deployment (a `SKIP_CADDY_CHECK` guard in the API and `VITE_API_BASE` env-var support in the UI). Everything else is identical to `main`.

- **Frontend (Brimble):** https://brimble-takehome.brimble.app
- **API (Railway):** https://brimble-api.up.railway.app/api/health

> Note: the Docker pipeline (Railpack builds, Caddy routing, spawned containers) only runs in the full `docker compose up` stack. The hosted API serves requests and persists deployments to SQLite, but build/deploy steps will fail without a Docker socket and Caddy.

## Brimble platform feedback

See [BRIMBLE_FEEDBACK.md](./BRIMBLE_FEEDBACK.md).
