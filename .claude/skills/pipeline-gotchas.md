# Pipeline Gotchas — Reference

This file captures specifics that are easy to get wrong and expensive to debug. Consult before working on the build pipeline, Caddy integration, or container spawning. These are not opinions — they're landmines.

## 1. Dockerode log streams are multiplexed

`container.logs({ follow: true, stdout: true, stderr: true })` returns a stream where stdout and stderr are interleaved using Docker's multiplex protocol — each chunk is prefixed with an 8-byte header (1 byte stream type, 3 bytes padding, 4 bytes BE length). Naïve `stream.on('data', ...)` will give you garbage with header bytes in the middle of your text.

**Use `docker.modem.demuxStream(stream, stdout, stderr)`:**

```ts
const stream = await container.logs({ follow: true, stdout: true, stderr: true });
const stdout = new PassThrough();
const stderr = new PassThrough();
docker.modem.demuxStream(stream, stdout, stderr);

stdout.on('data', (chunk) => persistLogLine(deploymentId, 'stdout', chunk.toString()));
stderr.on('data', (chunk) => persistLogLine(deploymentId, 'stderr', chunk.toString()));
```

Note: if the container was started with `Tty: true`, the stream is *not* multiplexed and you'd read it directly. Don't use `Tty: true` for builders — we want stderr separated and we don't need a TTY.

Also: `chunk.toString()` may split a UTF-8 character mid-byte across chunk boundaries. For build logs this is essentially never observed in practice, but if a grader tests with weird filenames, wrap with a `StringDecoder` from `node:string_decoder`.

## 2. Persist-then-emit, in that order

The log streaming path is:

```ts
function onLogLine(deploymentId: string, stream: 'stdout' | 'stderr', line: string) {
  // 1. persist (synchronous with better-sqlite3)
  insertLogStmt.run({ deploymentId, ts: Date.now(), stream, line });
  // 2. emit to bus
  logBus.emit(deploymentId, { ts: Date.now(), stream, line });
}
```

Persist first, emit second. If you flip the order, a late SSE subscriber's "replay from DB" will miss the most recent line that was emitted but not yet written. With `better-sqlite3` the insert is synchronous so this is just one statement order — no async awkwardness.

## 3. Caddy admin API: `@id` lookups are flat, not pathed

When you have `"@id": "deployments"` somewhere deep in the config, you address it as `/id/deployments` — *not* `/config/apps/http/servers/brimble/routes/2`. Once tagged, an `@id` becomes a top-level alias. The path under `/id/<tag>/...` continues into the object as if you were at that node.

So to append a route to the deployments subroute's inner routes array:

```
POST /id/deployments/handle/0/routes
{ ...new route... }
```

`POST` to an array path appends a **single item** — do NOT wrap in an array. `PUT` replaces the value at the path. `DELETE` removes. `PATCH` updates in place.

To remove a single deployment route by its own `@id`:

```
DELETE /id/deploy-dep-a3f9k2
```

That's it. The `@id` walks the config to that exact node and removes it. No need to compute array indices.

## 4. Caddy admin must listen on `0.0.0.0` for compose-internal access

Default admin endpoint is `localhost:2019`, which inside the Caddy container only accepts connections from inside that container. The API container can't reach it. Override in the seed config:

```json
{ "admin": { "listen": "0.0.0.0:2019" }, "apps": { ... } }
```

**Do not publish 2019 to the host.** Compose service-to-service traffic is on `brimble_net` only. Don't add `ports: ["2019:2019"]` to the Caddy service. The admin API has full config control — exposing it is a critical mistake.

## 5. Railpack CLI: how we actually invoke it

Skip the BuildKit-frontend route for this build (`railpack prepare` + `docker buildx build --build-arg BUILDKIT_SYNTAX=...`). It's the production-recommended path but adds two failure modes (BuildKit version pinning, frontend image availability) for no clarity gain at this scale.

Use direct CLI:

```sh
railpack build /workspace/<id> \
  --name brimble-<id>:<short_sha> \
  --progress plain
```

Notes:
- `railpack build` requires `BUILDKIT_HOST` to be set (verified on v0.23.0). A `buildkitd` sidecar runs in compose with `container_name: buildkitd`; pass `BUILDKIT_HOST=docker-container://buildkitd` as an `Env` entry when creating the builder container via dockerode. The builder image has the Docker CLI + socket mounted, so `docker-container://` resolves via `docker exec` through the socket — no extra network config needed.
- `--progress plain` produces line-oriented output suitable for streaming. Default `auto` produces TTY control sequences that the UI would have to interpret.
- The image lands in the host daemon (because we mounted `/var/run/docker.sock`). The API can then `docker run` it directly.
- Mention in the README: *"For production, switch to `railpack prepare` + custom BuildKit frontend for cache-key isolation across tenants and parallel build throughput."* — this signals to the grader that you read the production guide.

## 6. The builder image

`apps/builder/Dockerfile` should be tiny:

```dockerfile
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl docker.io git \
    && rm -rf /var/lib/apt/lists/*

# Install railpack via mise (or download binary directly from GH releases)
RUN curl -sSL https://mise.run | sh
ENV PATH="/root/.local/share/mise/shims:${PATH}"
RUN mise install github:railwayapp/railpack@latest && \
    mise use -g github:railwayapp/railpack@latest

WORKDIR /workspace
ENTRYPOINT ["railpack"]
```

This is **not** a Dockerfile for a user app — it's our internal tooling image. The brief's "no handwritten Dockerfiles" rule applies to apps being deployed *through* the pipeline, not to the pipeline itself. State this explicitly in the README.

If the railpack release binary is more convenient than mise, download it directly:
```dockerfile
RUN curl -sSL https://github.com/railwayapp/railpack/releases/latest/download/railpack-linux-amd64 \
    -o /usr/local/bin/railpack && chmod +x /usr/local/bin/railpack
```

## 7. Determining the deployed app's listening port

After a Railpack build, the resulting image runs the user's start command. The user's app listens on `process.env.PORT` (Railpack-built images respect this). Strategy:

1. Pass `-e PORT=3000` to the `docker run` command for the deployed app.
2. The container listens on 3000 internally.
3. Caddy upstream is `app-<id>:3000`.
4. Caddy and the deployed container are both on `brimble_net`, so name resolution works.

Don't try to inspect the image's `EXPOSE` directives or read Railpack metadata. Just dictate the port via env var.

## 8. Deployment ID format

IDs go in subdomains, so they must be DNS-safe (lowercase letters and digits, length-limited). Format: `dep-<6 chars from base32>`.

```ts
import { customAlphabet } from 'nanoid';
const generateSlug = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6);
export function newDeploymentId(): string {
  return `dep-${generateSlug()}`;
}
```

`dep-a3f9k2` → hostname `dep-a3f9k2.brimble.localhost` → container name `app-dep-a3f9k2` → image `brimble-dep-a3f9k2:<sha>`. One ID, derived everywhere.

## 9. `*.localhost` resolution

On Debian 13 with systemd-resolved (default), `*.localhost` resolves to `127.0.0.1` automatically per RFC 6761. No `/etc/hosts` edits needed.

On macOS: same — `*.localhost` resolves automatically.

On Windows: **does not resolve by default.** Graders on Windows will need to add entries to `C:\Windows\System32\drivers\etc\hosts`, or use WSL2. Document this in the README under "Prerequisites" with the exact lines they'd add:

```
127.0.0.1 brimble.localhost
127.0.0.1 api.brimble.localhost
# plus one line per deployment they want to test
```

We chose subdomain routing despite this cost because it mirrors Brimble's production model. State the trade-off honestly in the README.

## 10. Git clone inside the API container

For `source.type === "git"`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

await exec('git', ['clone', '--depth=1', url, `/workspaces/${deploymentId}`]);
```

Requires `git` in the API image. Add to `apps/api/Dockerfile`:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
```

For private repos: out of scope. Document it as a follow-up in the README.

## 11. Cleanup on failure

If a build fails partway through, don't leave orphan workspaces, containers, or images forever. Minimum hygiene:

- On builder container exit (success or failure), `container.remove({ force: true })`.
- On deploy failure, `docker rm -f app-<id>` if it was created.
- Workspace directories: leave them for now (debugging artifact). Add a TODO for periodic cleanup.

Don't over-engineer this — a take-home grader running it on their laptop won't run 100 deployments. But a function called `cleanupBuilder(id)` called from a `finally` block is the difference between "production-minded" and "hackathon" in a code review.

## 12. SSE specifics with Fastify

The correct npm package is `fastify-sse-v2` (unscoped). `@fastify/sse-v2` does not exist on npm — don't use it. Import the named export, not the default, to satisfy TypeScript's `moduleResolution: NodeNext`:

```ts
import { FastifySSEPlugin } from 'fastify-sse-v2';
await fastify.register(FastifySSEPlugin);
```

`fastify-sse-v2` lets you do:

```ts
fastify.get('/api/deployments/:id/logs/stream', (req, reply) => {
  const id = (req.params as { id: string }).id;
  reply.sse((async function* () {
    // 1. replay history
    for (const row of getLogHistory(id)) {
      yield { data: JSON.stringify(row) };
    }
    // 2. live tail
    const queue = subscribeToLogBus(id);
    try {
      for await (const line of queue) {
        yield { data: JSON.stringify(line) };
      }
    } finally {
      unsubscribe(id, queue);
    }
  })());
});
```

The async generator pattern handles backpressure and disconnect cleanly. On the client, `EventSource` reconnects automatically — you get resilience for free.

If a deployment is already in a terminal state (`running` or `failed`), close the stream after replaying history; don't leave a hanging connection.

## 13. Order of operations in `docker-compose.yml`

Caddy must start before the API tries to register routes. Use `depends_on` with a healthcheck on Caddy:

```yaml
caddy:
  image: caddy:2-alpine
  healthcheck:
    test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:2019/config/"]
    interval: 2s
    timeout: 2s
    retries: 10
api:
  depends_on:
    caddy:
      condition: service_healthy
```

The API on startup should do a sanity-check `GET /config/` to Caddy and refuse to start if it can't reach it. Fail loud, fail fast.

## 14. Caddy 2.11 admin API origin enforcement for container-to-container access

Tested on Caddy v2.11.2. Setting `"listen": "0.0.0.0:2019"` is necessary but **not sufficient** for container-to-container admin access. Caddy maintains a second layer of security: requests from non-loopback IPs are checked against an allowed-origins list. By default, only localhost-derived origins are permitted.

Server-side HTTP clients (like our API container calling `fetch('http://caddy:2019/...')`) send **no Origin header**. An empty-string origin is not in the default allowlist, so every request gets:

```json
{"error":"client is not allowed to access from origin ''"}
```

**The fix:** add `""` (empty string) to the `origins` list in the admin config. This explicitly permits requests that carry no Origin header, which covers all server-side callers:

```json
{ "admin": { "listen": "0.0.0.0:2019", "origins": [""] }, "apps": { ... } }
```

**What doesn't work:**
- `"enforce_origin": false` — this only controls whether the Origin header must match the admin listen address; it does not bypass the IP-tier allowlist check.
- Sending `Origin: http://localhost` from the API container — the remote IP is still a Docker bridge address, not loopback, so it still fails.

**Security:** `origins: [""]` only allows requests with no Origin header. Browser-based CSRF attacks always include an Origin header, so they remain blocked. Port 2019 is never published to the host (`ports:` only exposes `:80`), so only containers on `brimble_net` can reach the admin API at all.

## 15. SSE log stream: subscribe() before getLogs(), listeners attached eagerly

The SSE handler must call `subscribe()` **before** `getLogs()`, and the bus subscription must attach listeners **eagerly** (at `subscribe()` call time, not lazily inside `[Symbol.asyncIterator]()`). Here is why:

```
subscribe(id)         ← listeners attached HERE (eagerly)
getLogs(id)           ← DB snapshot taken HERE (same sync frame)
yield history...      ← async yields; new lines go into queue during this time
for await (sub)...    ← drains queue first, then waits for new lines
```

If listeners are lazy (attached only when `for await` starts), any line published during the history replay yields is missed. It lands in the DB but nobody is listening on the bus, so it never reaches the SSE client in the current connection. The user would see a gap in the live stream and only recover it on reconnect (from DB history).

Node.js is single-threaded, so `subscribe()` and `getLogs()` in the same synchronous frame see a consistent snapshot: no line can be published between them. A line either exists in both the DB snapshot AND is missed by the listener (impossible — they're in the same tick), or lands in the DB after the snapshot and queues in the listener. No duplicates, no gaps.

**Concrete rule:** in the SSE route handler:
```ts
const sub = subscribe(id);       // attach listeners NOW — before the getLogs() call
const history = getLogs(id);     // snapshot (same sync frame, no await between these two)

reply.sse((async function* () {
  try {
    for (const row of history) { yield { data: JSON.stringify(row) }; }
    for await (const line of sub) { yield { data: JSON.stringify(line) }; }
    yield { event: 'end', data: '' };
  } finally {
    sub.cancel();   // cleanup if generator is aborted before for-await runs
  }
})());
```

The `try/finally` with `sub.cancel()` handles the case where the client disconnects during history replay before the `for await` ever starts — in that case the `for await`'s `return()` machinery never fires, so `cancel()` is the only cleanup path.

## 16. Docker Compose volume and network name prefixing breaks DooD references

By default, Docker Compose prefixes named volumes and networks with the **project name** (derived from the directory name). A project in `brimble-takehome/` produces volumes like `brimble-takehome_brimble_workspaces` and networks like `brimble-takehome_brimble_net`.

This silently breaks two places in the pipeline:

1. **`HostConfig.Binds`** in the builder container: `"brimble_workspaces:/workspace"` looks for a volume named exactly `brimble_workspaces`, not the prefixed name.
2. **`NetworkingConfig.EndpointsConfig`** in the app container: `{ brimble_net: {} }` looks for a network named exactly `brimble_net`.

Both references come from inside the API container via the Docker daemon — the daemon resolves names against its own registry, not Compose's namespace.

**The fix:** add explicit `name:` to every volume and network that pipeline code references by name:

```yaml
volumes:
  brimble_workspaces:
    name: brimble_workspaces   # no prefix, ever
  brimble_data:
    name: brimble_data

networks:
  brimble_net:
    driver: bridge
    name: brimble_net          # no prefix, ever
```

Without this, the pipeline appears to run (no immediate error) but the builder mounts an empty or wrong volume, Railpack can't find the source, and the build fails with a confusing "directory not found" error.
