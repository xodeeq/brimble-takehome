/**
 * Integration smoke test — requires the full stack running (`docker compose up`).
 * Run: npm test (from apps/api/)
 *
 * Set HELLO_NODE_REPO_URL to your public hello-node GitHub URL, e.g.:
 *   HELLO_NODE_REPO_URL=https://github.com/you/hello-node npm test
 *
 * Cold Railpack node builds take 30-60s; the test allows 90s.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns';

// On Linux systems where getaddrinfo does not implement RFC 6761 wildcard
// localhost resolution, *.brimble.localhost fails with ENOTFOUND. Patch
// dns.lookup (used by undici / Node.js fetch) to map the domain to loopback.
const _lookup = dns.lookup.bind(dns) as typeof dns.lookup;
(dns as any).lookup = (hostname: string, optionsOrCb: any, cb?: any) => {
  if (hostname === 'brimble.localhost' || hostname.endsWith('.brimble.localhost')) {
    const callback: (err: any, addr: string, family: number) => void =
      typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    if (typeof optionsOrCb === 'object' && optionsOrCb?.all) {
      (callback as any)(null, [{ address: '127.0.0.1', family: 4 }]);
    } else {
      callback(null, '127.0.0.1', 4);
    }
    return;
  }
  return _lookup(hostname, optionsOrCb, cb);
};

const API = process.env.API_URL ?? 'http://api.brimble.localhost';
const HELLO_NODE_REPO_URL =
  process.env.HELLO_NODE_REPO_URL ?? 'https://github.com/xodeeq/hello-node';
const BUILD_TIMEOUT_MS = 300_000;  // cold pulls can take 3-5 min on first run
const POLL_INTERVAL_MS = 3_000;

type Deployment = {
  id: string;
  status: string;
  image_tag: string | null;
  url: string | null;
};

test('pipeline: git deploy end-to-end', { timeout: BUILD_TIMEOUT_MS + 10_000 }, async () => {
  // 1. POST a new deployment
  const createRes = await fetch(`${API}/api/deployments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { type: 'git', url: HELLO_NODE_REPO_URL } }),
  });
  assert.equal(createRes.status, 202, `POST /api/deployments → expected 202, got ${createRes.status}`);

  const { id } = (await createRes.json()) as { id: string };
  assert.match(id, /^dep-[a-z0-9]{6}$/, `deployment ID "${id}" does not match expected slug format`);
  console.log(`deployment created: ${id}`);

  // 2. Poll until running or failed (or timeout)
  let dep: Deployment = { id, status: 'pending', image_tag: null, url: null };
  const deadline = Date.now() + BUILD_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

    const pollRes = await fetch(`${API}/api/deployments/${id}`);
    assert.equal(pollRes.ok, true, `GET /api/deployments/${id} failed with ${pollRes.status}`);
    dep = (await pollRes.json()) as Deployment;

    console.log(`  status: ${dep.status}`);
    if (dep.status === 'running' || dep.status === 'failed') break;
  }

  assert.equal(dep.status, 'running', `deployment ended in status "${dep.status}" instead of "running"`);
  assert.notEqual(dep.image_tag, null, 'image_tag should be set when running');

  // 3. Curl the deployed app through Caddy
  const appUrl = `http://${id}.brimble.localhost`;
  console.log(`hitting deployed app at ${appUrl}`);

  const appRes = await fetch(appUrl, { signal: AbortSignal.timeout(5_000) });
  assert.equal(appRes.ok, true, `deployed app at ${appUrl} returned ${appRes.status}`);

  const body = await appRes.text();
  assert.match(
    body,
    /Hello from Brimble deployment/,
    `response body did not contain expected greeting — got: ${body.slice(0, 200)}`,
  );

  // 4. Delete the deployment and verify the URL is gone
  const deleteRes = await fetch(`${API}/api/deployments/${id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204, `DELETE /api/deployments/${id} → expected 204, got ${deleteRes.status}`);

  // Give Caddy a moment to flush the route
  await new Promise<void>((r) => setTimeout(r, 1_500));

  let afterDeleteStatus: number | null = null;
  try {
    const afterRes = await fetch(appUrl, { signal: AbortSignal.timeout(3_000) });
    afterDeleteStatus = afterRes.status;
  } catch {
    // Connection refused or timeout — the route is gone, which is correct
    afterDeleteStatus = 0;
  }

  assert.notEqual(
    afterDeleteStatus,
    200,
    `app at ${appUrl} still returned 200 after DELETE — Caddy route was not removed`,
  );

  console.log(`smoke test passed — ${id} deployed, verified, and cleaned up`);
});
