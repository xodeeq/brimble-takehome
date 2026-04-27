const CADDY_URL = process.env.CADDY_URL ?? 'http://caddy:2019';
const TIMEOUT_MS = 5000;

async function caddyFetch(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${CADDY_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`Caddy ${method} ${path} → ${res.status}: ${text}`);
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${CADDY_URL}/config/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function addDeploymentRoute(opts: {
  deploymentId: string;
  hostname: string;
  upstream: string;
}): Promise<void> {
  const route = {
    '@id': `deploy-${opts.deploymentId}`,
    match: [{ host: [opts.hostname] }],
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: opts.upstream }],
      },
    ],
  };

  // PUT /id/…/routes returns 409 in Caddy 2.11 ("key already exists").
  // Instead: GET the current routes array, prepend the new route (keeping the
  // no-@id fallback last), then PATCH the subroute handler as a whole.
  const res = await fetch(`${CADDY_URL}/id/deployments/handle/0/routes`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Caddy GET routes → ${res.status}`);
  const routes = (await res.json()) as unknown[];
  routes.unshift(route);  // new route first; fallback stays last
  await caddyFetch('PATCH', '/id/deployments/handle/0', { handler: 'subroute', routes });
}

export async function removeDeploymentRoute(deploymentId: string): Promise<void> {
  await caddyFetch('DELETE', `/id/deploy-${deploymentId}`);
}
