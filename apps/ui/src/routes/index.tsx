import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  API_BASE,
  listDeployments,
  createDeployment,
  type Deployment,
  type DeploymentStatus,
  type LogLine,
} from '../lib/api';

// ─── status helpers ────────────────────────────────────────────────────────────

const DOT_COLOR: Record<DeploymentStatus, string> = {
  pending:   'bg-gray-400',
  building:  'bg-amber-400 animate-pulse',
  deploying: 'bg-blue-500 animate-pulse',
  running:   'bg-green-500',
  failed:    'bg-red-500',
};

const BADGE_CLASS: Record<DeploymentStatus, string> = {
  pending:   'bg-gray-100 text-gray-600',
  building:  'bg-amber-100 text-amber-700',
  deploying: 'bg-blue-100 text-blue-700',
  running:   'bg-green-100 text-green-700',
  failed:    'bg-red-100 text-red-700',
};

function StatusDot({ status }: { status: DeploymentStatus }) {
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${DOT_COLOR[status]}`} />;
}

// ─── Region A: submit form ─────────────────────────────────────────────────────

function DeployForm({ onDeployed }: { onDeployed: (id: string) => void }) {
  const [url, setUrl] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (gitUrl: string) => createDeployment(gitUrl),
    onSuccess: (data) => {
      setUrl('');
      setFieldError(null);
      void queryClient.invalidateQueries({ queryKey: ['deployments'] });
      onDeployed(data.id);
    },
    onError: (err) => {
      setFieldError(err instanceof Error ? err.message : 'Deployment failed');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setFieldError('Git URL is required');
      return;
    }
    setFieldError(null);
    mutation.mutate(trimmed);
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="flex gap-2 flex-wrap">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/you/your-app"
          className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
          disabled={mutation.isPending}
          aria-label="Git repository URL"
        />
        <button
          type="submit"
          disabled={mutation.isPending}
          className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {mutation.isPending ? 'Deploying…' : 'Deploy'}
        </button>
        <button
          type="button"
          disabled
          title="Upload support coming soon"
          className="px-4 py-2 bg-gray-100 text-gray-400 rounded text-sm font-medium cursor-not-allowed"
        >
          Upload (coming soon)
        </button>
      </div>
      {fieldError && (
        <p className="mt-2 text-red-600 text-sm">{fieldError}</p>
      )}
    </form>
  );
}

// ─── Region B: deployment list ─────────────────────────────────────────────────

function truncate(s: string | null, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function DeploymentRow({
  dep,
  selected,
  onSelect,
}: {
  dep: Deployment;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 flex items-center gap-2.5 min-w-0 ${
        selected ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'border-l-2 border-l-transparent'
      }`}
    >
      <StatusDot status={dep.status} />

      <span className="font-mono text-xs text-gray-500 shrink-0 w-24">{dep.id}</span>

      <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${BADGE_CLASS[dep.status]}`}>
        {dep.status}
      </span>

      <span className="font-mono text-xs text-gray-400 truncate flex-1 min-w-0">
        {truncate(dep.source_url, 55)}
      </span>

      {dep.url && (
        <a
          href={dep.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-xs text-blue-600 underline shrink-0 hover:text-blue-800"
        >
          open ↗
        </a>
      )}
    </button>
  );
}

function DeploymentList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { data: deployments = [], isLoading, error } = useQuery({
    queryKey: ['deployments'],
    queryFn: listDeployments,
    refetchInterval: 4_000,
  });

  if (isLoading) {
    return <div className="p-4 text-sm text-gray-400">Loading…</div>;
  }
  if (error) {
    return <div className="p-4 text-sm text-red-500">Error: {String(error)}</div>;
  }
  if (deployments.length === 0) {
    return (
      <div className="p-4 text-sm text-gray-400">
        No deployments yet. Submit a Git URL above.
      </div>
    );
  }

  return (
    <div>
      {deployments.map((dep) => (
        <DeploymentRow
          key={dep.id}
          dep={dep}
          selected={dep.id === selectedId}
          onSelect={() => onSelect(dep.id)}
        />
      ))}
    </div>
  );
}

// ─── Region C: log viewer ──────────────────────────────────────────────────────

const LINE_CLASS: Record<LogLine['stream'], string> = {
  system: 'border-l-2 border-gray-600 pl-2 text-gray-400 italic',
  stdout: 'border-l-2 border-transparent pl-2 text-green-100',
  stderr: 'border-l-2 border-red-500 pl-2 text-red-300',
};

type IndexedLine = LogLine & { _key: number };

function LogViewer({ deploymentId }: { deploymentId: string }) {
  const [lines, setLines] = useState<IndexedLine[]>([]);
  const [newCount, setNewCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const keyRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setNewCount(0);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottomRef.current) setNewCount(0);
  }, []);

  useEffect(() => {
    // Reset all state for the new deployment
    setLines([]);
    setNewCount(0);
    keyRef.current = 0;
    atBottomRef.current = true;

    const es = new EventSource(`${API_BASE}/api/deployments/${deploymentId}/logs/stream`);

    // On reconnect the server replays full history — clear to avoid duplication.
    es.onopen = () => {
      setLines([]);
      setNewCount(0);
      keyRef.current = 0;
    };

    es.onmessage = (e: MessageEvent) => {
      try {
        const line = JSON.parse(e.data as string) as LogLine;
        const _key = ++keyRef.current;
        setLines((prev) => [...prev, { ...line, _key }]);
        if (!atBottomRef.current) {
          setNewCount((c) => c + 1);
        }
      } catch { /* ignore malformed events */ }
    };

    // Server sends an 'end' event when the deployment reaches a terminal state.
    es.addEventListener('end', () => { es.close(); });

    return () => { es.close(); };
  }, [deploymentId]);

  // Auto-scroll when new lines arrive and user was already at bottom
  useEffect(() => {
    if (atBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      setNewCount(0);
    }
  }, [lines]);

  return (
    <div className="flex flex-col h-full relative bg-gray-900">
      <div className="px-3 py-2 border-b border-gray-700 text-xs text-gray-400 font-mono shrink-0">
        logs — {deploymentId}
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-5"
      >
        {lines.length === 0 && (
          <span className="text-gray-500">Connecting…</span>
        )}
        {lines.map(({ _key, ...line }) => (
          <div key={_key} className={LINE_CLASS[line.stream]}>
            {line.line || ' '}
          </div>
        ))}
      </div>

      {newCount > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 bg-blue-600 text-white text-xs px-3 py-1 rounded-full shadow-lg hover:bg-blue-700"
        >
          ↓ {newCount} new
        </button>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export function IndexPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-5 py-3 shrink-0 flex items-center gap-3">
        <span className="font-semibold text-gray-900">Brimble</span>
        <span className="text-gray-300 text-sm">deployment pipeline</span>
      </header>

      {/* Body: left panel + right log viewer */}
      <div className="flex flex-col lg:flex-row flex-1 min-h-0">

        {/* Left: form + list */}
        <div className="flex flex-col lg:w-[480px] lg:shrink-0 border-b lg:border-b-0 lg:border-r border-gray-200 bg-white min-h-0">

          {/* Region A */}
          <div className="p-4 border-b border-gray-100 shrink-0">
            <p className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wide">
              New deployment
            </p>
            <DeployForm onDeployed={(id) => setSelectedId(id)} />
          </div>

          {/* Region B */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide px-3 pt-3 pb-1">
              Deployments
            </p>
            <DeploymentList selectedId={selectedId} onSelect={setSelectedId} />
          </div>
        </div>

        {/* Right: Region C — logs */}
        <div className="flex-1 min-h-0 lg:min-h-full overflow-hidden" style={{ minHeight: '40vh' }}>
          {selectedId ? (
            <LogViewer key={selectedId} deploymentId={selectedId} />
          ) : (
            <div className="flex items-center justify-center h-full bg-gray-900">
              <span className="text-gray-500 text-sm font-mono">
                ← select a deployment to view logs
              </span>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
