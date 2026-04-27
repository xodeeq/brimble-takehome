export const API_BASE = 'http://api.brimble.localhost';

export type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'running' | 'failed';

export type Deployment = {
  id: string;
  source_type: 'git' | 'upload';
  source_url: string | null;
  image_tag: string | null;
  status: DeploymentStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
  url: string | null;
};

export type LogLine = {
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function listDeployments(): Promise<Deployment[]> {
  return apiFetch('/api/deployments');
}

export async function createDeployment(url: string): Promise<{ id: string; status: string }> {
  return apiFetch('/api/deployments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { type: 'git', url } }),
  });
}
