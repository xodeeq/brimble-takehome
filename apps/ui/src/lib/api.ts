export const API_BASE = 'http://api.brimble.localhost';

export async function healthCheck(): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/api/health`);
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json() as Promise<{ status: string }>;
}
