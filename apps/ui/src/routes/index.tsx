import { useQuery } from '@tanstack/react-query';
import { healthCheck } from '../lib/api';

export function IndexPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['health'],
    queryFn: healthCheck,
  });

  return (
    <div style={{ fontFamily: 'monospace', padding: '2rem' }}>
      <h1>Brimble</h1>
      <h2>API Status</h2>
      {isLoading && <p>Checking...</p>}
      {error && <p style={{ color: 'red' }}>Error: {String(error)}</p>}
      {data && <pre>{JSON.stringify(data, null, 2)}</pre>}
    </div>
  );
}
