import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish, closeBus, type LogLine } from '../lib/logBus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'running' | 'failed';

export type Deployment = {
  id: string;
  source_type: 'git' | 'upload';
  source_url: string | null;
  source_ref: string | null;
  image_tag: string | null;
  status: DeploymentStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export type LogRow = {
  id: number;
  deployment_id: string;
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
};

let db!: Database.Database;
let stmts!: {
  insertDeployment: Database.Statement;
  updateStatus: Database.Statement;
  updateImageTag: Database.Statement;
  insertLog: Database.Statement;
  getDeployment: Database.Statement;
  listDeployments: Database.Statement;
  getLogs: Database.Statement;
};

export function initDb(): void {
  const dbPath = process.env.DB_PATH ?? '/data/brimble.db';
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  stmts = {
    insertDeployment: db.prepare(
      `INSERT INTO deployments (id, source_type, source_url, status, created_at, updated_at)
       VALUES (@id, @source_type, @source_url, 'pending', unixepoch(), unixepoch())`,
    ),
    updateStatus: db.prepare(
      `UPDATE deployments SET status = @status, error = @error, updated_at = unixepoch() WHERE id = @id`,
    ),
    updateImageTag: db.prepare(
      `UPDATE deployments SET image_tag = @image_tag, updated_at = unixepoch() WHERE id = @id`,
    ),
    insertLog: db.prepare(
      `INSERT INTO logs (deployment_id, ts, stream, line) VALUES (@deploymentId, @ts, @stream, @line)`,
    ),
    getDeployment: db.prepare(`SELECT * FROM deployments WHERE id = ?`),
    listDeployments: db.prepare(`SELECT * FROM deployments ORDER BY created_at DESC`),
    getLogs: db.prepare(`SELECT * FROM logs WHERE deployment_id = ? ORDER BY ts ASC`),
  };

  // After a server restart, repopulate closedDeployments so SSE subscribers for already-terminal
  // deployments terminate immediately instead of hanging with no future events.
  const terminalRows = db
    .prepare(`SELECT id FROM deployments WHERE status IN ('running', 'failed')`)
    .all() as { id: string }[];
  for (const row of terminalRows) {
    closeBus(row.id);
  }
}

export function insertDeployment(
  id: string,
  sourceType: 'git' | 'upload',
  sourceUrl: string | null,
): void {
  stmts.insertDeployment.run({ id, source_type: sourceType, source_url: sourceUrl });
}

export function setStatus(id: string, status: DeploymentStatus, error: string | null = null): void {
  stmts.updateStatus.run({ id, status, error });
  // Close the bus AFTER record() has been called for the final log line so subscribers see it.
  if (status === 'running' || status === 'failed') {
    closeBus(id);
  }
}

export function setImageTag(id: string, imageTag: string): void {
  stmts.updateImageTag.run({ id, image_tag: imageTag });
}

// Persist-then-emit, in that order (gotcha §2).
export function record(deploymentId: string, stream: LogLine['stream'], line: string): void {
  const entry: LogLine = { ts: Date.now(), stream, line };
  stmts.insertLog.run({ deploymentId, ...entry });
  publish(deploymentId, entry);
}

export function getDeployment(id: string): Deployment | undefined {
  return stmts.getDeployment.get(id) as Deployment | undefined;
}

export function listDeployments(): Deployment[] {
  return stmts.listDeployments.all() as Deployment[];
}

export function getLogs(deploymentId: string): LogRow[] {
  return stmts.getLogs.all(deploymentId) as LogRow[];
}

export function deleteDeployment(id: string): void {
  db.prepare('DELETE FROM logs WHERE deployment_id = ?').run(id);
  db.prepare('DELETE FROM deployments WHERE id = ?').run(id);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialised — call initDb() first');
  return db;
}
