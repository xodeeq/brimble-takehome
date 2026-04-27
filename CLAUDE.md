# Brimble Take-Home — Project Context

This repo is a take-home submission for a Brimble Fullstack/Infra Engineer role. It is a one-page deployment pipeline that takes a Git URL or uploaded project, builds it into a container image with Railpack, runs it via Docker, and routes traffic to it through Caddy. Everything boots with `docker compose up`.

You are the engineer building this. Read this file fully before making changes. When in doubt, ask before invading scope — this is a take-home, not a production platform, and the grading rubric punishes over-engineering.

## Hard requirements (non-negotiable, from the brief)

1. **`docker compose up` brings the entire stack up on a clean machine.** Frontend, backend, Caddy, and any helper services. No external accounts required to test. Sensible defaults for every env var.
2. **Build and deploy logs stream live to the UI over SSE.** Polling a `/logs` endpoint does not count. Logs must be visible *while* the build runs, and must persist so a user can scroll back afterward.
3. **Railpack builds the user's app into a container image.** No handwritten Dockerfiles for user apps. (Dockerfiles for our own infra — API, UI, builder image — are fine and expected.)
4. **Caddy is the single point of ingress.** It fronts every deployment and routes to the running containers. The host publishes only port 80 via Caddy.

## Stack (locked)

- **Frontend:** Vite + React + TanStack Router + TanStack Query
- **Backend:** TypeScript, Fastify, `fastify-sse-v2`, `dockerode`, `better-sqlite3`
- **Build tool:** Railpack CLI (`railpack build` direct, not the BuildKit frontend route)
- **Ingress:** Caddy 2, configured at boot via JSON, mutated at runtime via the admin API on `:2019`
- **State:** SQLite, single file in a named volume
- **Routing model:** subdomain-based on `*.localhost` (matches Brimble's production model)

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

All containers attach to a single user-defined bridge network `brimble_net`. The API talks to Caddy at `caddy:2019`, to Docker at `/var/run/docker.sock` (mounted), and writes/reads SQLite at `/data/brimble.db`.

## The DooD volume-path trap (read this before touching the pipeline)

The API runs in a container and uses the host's Docker daemon (Docker-out-of-Docker) by mounting `/var/run/docker.sock`. **When the API tells the daemon to mount a path into a sibling container, the daemon resolves that path on the *host*, not inside the API container.** A bind mount of `/workspaces/dep-a3f9k2` from the API's filesystem will fail or silently mount the wrong directory.

**Solution:** use a named Docker volume `brimble_workspaces`, mounted at `/workspaces` inside the API. When spawning a builder container, reference the *named volume* (not a bind path):

```ts
await docker.createContainer({
  Image: "brimble-builder:latest",
  HostConfig: {
    Binds: [
      "brimble_workspaces:/workspace",        // named volume — works
      "/var/run/docker.sock:/var/run/docker.sock",
    ],
  },
  Cmd: ["railpack", "build", "/workspace/dep-a3f9k2", "--name", "brimble-dep-a3f9k2:abc1234"],
});
```

If you ever find yourself writing a bind mount with an absolute path coming from the API container's filesystem, stop. You're walking into the trap.

## Deployment lifecycle

```
pending → building → deploying → running
   ↓          ↓          ↓
 failed    failed     failed
```

State stored in a `deployments` table (SQLite) with a CHECK constraint on the status column. Transitions are the only writes. Logs persist to a `logs` table `(deployment_id, ts, stream, line)`.

### Per-deployment flow

1. `POST /api/deployments` with `{ source: { type: "git" | "upload", url? | file? } }` → creates row, status `pending`, returns `{ id, status }`.
2. API materializes source into `brimble_workspaces:/workspaces/<id>/`. For git, `git clone` inside the API container. For uploads, unzip via stream.
3. API spawns a sibling `brimble-builder` container with the workspace volume + docker socket. Status → `building`. Builder runs `railpack build /workspace/<id> --name brimble-<id>:<short_sha>`. The image lands in the host daemon.
4. API streams the builder container's stdout/stderr via `dockerode`'s `container.logs({ follow: true })`, demuxes (Docker multiplexes stdout/stderr in a single stream), persists each line to `logs` table, and emits to an in-memory pub/sub bus keyed by deployment ID.
5. On builder exit 0: status → `deploying`. API runs `docker run -d --network brimble_net --name app-<id> brimble-<id>:<sha>`.
6. API determines the app's listening port (start with `process.env.PORT` convention; Railpack-built Node images respect `PORT`, default `3000`). API patches Caddy: `POST /id/deployments` with a new route object for `<id>.brimble.localhost` → `app-<id>:<port>`. Status → `running`.
7. On any failure: status → `failed`, error captured in logs.

## Caddy config shape

Seed config (`Caddyfile.json` at repo root, mounted into Caddy at `/etc/caddy/caddy.json`):

```json
{
  "admin": { "listen": "0.0.0.0:2019" },
  "apps": {
    "http": {
      "servers": {
        "brimble": {
          "listen": [":80"],
          "routes": [
            {
              "match": [{ "host": ["brimble.localhost"] }],
              "handle": [{ "handler": "reverse_proxy", "upstreams": [{ "dial": "ui:80" }] }]
            },
            {
              "match": [{ "host": ["api.brimble.localhost"] }],
              "handle": [{ "handler": "reverse_proxy", "upstreams": [{ "dial": "api:3000" }] }]
            },
            {
              "@id": "deployments",
              "group": "deployments",
              "handle": [{
                "handler": "subroute",
                "routes": []
              }]
            }
          ]
        }
      }
    }
  }
}
```

The `deployments` route holds a subroute whose inner `routes` array starts empty. The API appends to it via:

```
POST http://caddy:2019/id/deployments/handle/0/routes
[{ "@id": "deploy-<id>", "match": [{ "host": ["<id>.brimble.localhost"] }], "handle": [...] }]
```

Removing a deployment: `DELETE http://caddy:2019/id/deploy-<id>`. The `@id` lookup goes straight to the route — no need to walk the config tree.

## SSE log streaming

Endpoint: `GET /api/deployments/:id/logs/stream`. Behavior:

1. Open the SSE connection (`fastify-sse-v2`).
2. Replay all persisted lines from the `logs` table for this deployment, oldest first.
3. Subscribe to the in-memory log bus for this deployment ID.
4. Forward each new line as an SSE `data:` event.
5. On client disconnect, unsubscribe.

The "write to DB and emit to bus in the same loop" pattern means there is no race where a line is emitted before it's persisted (or vice versa). A late subscriber gets full history from the DB; an early subscriber gets the live tail from the bus.

## Repo layout

```
brimble-takehome/
├── docker-compose.yml
├── Caddyfile.json                  # seed config
├── README.md                       # for graders
├── .env.example
├── CLAUDE.md                       # this file
├── .claude/
│   └── skills/
│       └── pipeline-gotchas.md     # reference for build/deploy specifics
├── apps/
│   ├── api/                        # Fastify backend
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   │   ├── deployments.ts
│   │   │   │   └── logs.ts
│   │   │   ├── pipeline/
│   │   │   │   ├── build.ts        # spawn builder, stream logs
│   │   │   │   ├── deploy.ts       # docker run + caddy register
│   │   │   │   └── caddy.ts        # admin API client
│   │   │   ├── db/
│   │   │   │   ├── schema.sql
│   │   │   │   └── queries.ts
│   │   │   └── lib/
│   │   │       ├── logBus.ts
│   │   │       ├── docker.ts
│   │   │       ├── git.ts
│   │   │       └── ids.ts          # short-slug generator
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   ├── ui/                         # Vite + React + TanStack
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   ├── components/
│   │   │   └── lib/api.ts
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── package.json
│   │   └── Dockerfile
│   └── builder/
│       └── Dockerfile              # railpack + docker CLI
├── examples/
│   └── hello-node/                 # sample app to deploy
│       ├── package.json
│       └── index.js
└── scripts/
    └── seed-example.sh             # optional convenience for graders
```

## Conventions

- **Code style:** TypeScript strict mode, ESM, no `any`. Two-space indent. Prefer `for...of` over `.forEach` when async is involved.
- **Error handling:** every pipeline step wraps its work in try/catch and writes a terminal log line + transitions deployment to `failed` on throw. Never let a worker promise reject silently.
- **Logging:** API logs to stdout via Fastify's pino. Build/deploy logs for *deployments* go to the `logs` table — never mix them with the API's own logs.
- **Tests:** a few meaningful integration tests beat broad unit coverage. Specifically: a smoke test that posts a deployment for `examples/hello-node`, polls until `running`, and curls the deployed URL through Caddy. Skip if it adds friction.

## What's explicitly out of scope

- Auth, multi-tenancy, billing.
- Kubernetes (the brief says "please no Kubernetes").
- A polished UI. Tailwind defaults are fine. Functional > pretty.
- Exhaustive test coverage.
- Production-grade secrets management.

## Bonus targets (only if core is solid)

In priority order:
1. **Redeploy a previous image tag** — cheapest win. Add `POST /api/deployments/:id/redeploy?tag=<sha>` that re-runs the deploy step with an existing image tag and swaps Caddy upstream via `@id` PATCH.
2. **Build cache reuse** — Railpack handles this if we keep a stable cache key per app. Pass `--cache-key <slug>` derived from the source URL.
3. **Zero-downtime redeploys** — run new container alongside old, health check, swap Caddy upstream, kill old. Skip unless steps 1+2 are already done.

## What "done" looks like

- [ ] `docker compose up` on a clean Debian box brings the stack up.
- [ ] UI at `http://brimble.localhost` lets the user submit a Git URL.
- [ ] After submission, the deployment moves through `pending → building → deploying → running` visibly in the UI.
- [ ] Build logs stream live to the UI during the build, and persist on refresh.
- [ ] Deployed app is reachable at `http://<id>.brimble.localhost`.
- [ ] README explains: setup, architecture, trade-offs, what we'd do with another weekend.
- [ ] Loom walkthrough recorded.
- [ ] Brimble platform deploy + honest written feedback prepared as a separate document.

## When asking for direction

If a decision could go multiple ways and the trade-off matters, surface it before committing. If it's a local style choice with no real consequence, just pick and move on. The grading rubric weights "code structured like you'd want to maintain it in six months" — bias toward clarity over cleverness.
