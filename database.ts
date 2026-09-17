import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
export const db = new Database(path.join(dataDir, 'aurelius.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, display_name TEXT NOT NULL, client_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS entities (type TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', client_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(type, id));
  CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, actor_id TEXT, actor_role TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, before_json TEXT, after_json TEXT, metadata_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE IF NOT EXISTS content (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT);
  CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, event TEXT NOT NULL, recipient TEXT, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', provider_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS webhook_events (provider TEXT NOT NULL, event_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(provider, event_id));
`);

export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export const parse = <T>(value: string): T => JSON.parse(value) as T;
export const json = (value: unknown) => JSON.stringify(value);
export function enqueueNotification(event: string, recipient: string | undefined, payload: unknown) {
  const timestamp = now();
  db.query('INSERT INTO notifications (id,event,recipient,payload_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id(), event, recipient ?? null, json(payload), 'queued', timestamp, timestamp);
}

export function writeAudit(input: { actorId?: string; actorRole?: string; action: string; entityType: string; entityId?: string; before?: unknown; after?: unknown; metadata?: unknown }) {
  db.query('INSERT INTO audits (id,timestamp,actor_id,actor_role,action,entity_type,entity_id,before_json,after_json,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id(), now(), input.actorId ?? null, input.actorRole ?? null, input.action, input.entityType, input.entityId ?? null, input.before === undefined ? null : json(input.before), input.after === undefined ? null : json(input.after), json(input.metadata ?? {}));
}

export function saveEntity(type: string, value: Record<string, any>, actor?: { id: string; role: string }, action = 'create') {
  const timestamp = now();
  const record: Record<string, any> = { id: value.id ?? id(), status: value.status ?? 'active', version: value.version ?? 1, createdAt: value.createdAt ?? timestamp, updatedAt: timestamp, ...value };
  if (type === 'clients' && !record.clientId) record.clientId = record.id;
  const previousRow = db.query('SELECT data FROM entities WHERE type=? AND id=?').get(type, record.id) as { data: string } | null;
  db.query('INSERT INTO entities (type,id,status,client_id,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(type,id) DO UPDATE SET status=excluded.status,client_id=excluded.client_id,data=excluded.data,updated_at=excluded.updated_at').run(type, record.id, record.status, record.clientId ?? null, json(record), record.createdAt, timestamp);
  writeAudit({ actorId: actor?.id, actorRole: actor?.role, action, entityType: type, entityId: record.id, before: previousRow ? parse(previousRow.data) : undefined, after: record });
  return record;
}

export function listEntities(type: string, clientId?: string, status = 'active') {
  const clauses = ['type=?']; const args: any[] = [type];
  if (clientId) { clauses.push('client_id=?'); args.push(clientId); }
  if (status !== 'all') { clauses.push('status=?'); args.push(status); }
  return (db.query(`SELECT data FROM entities WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`).all(...args) as { data: string }[]).map((row) => parse<Record<string, any>>(row.data));
}

export function getEntity(type: string, entityId: string, clientId?: string) {
  const row = db.query(`SELECT data FROM entities WHERE type=? AND id=?${clientId ? ' AND client_id=?' : ''}`).get(...(clientId ? [type, entityId, clientId] : [type, entityId])) as { data: string } | null;
  return row ? parse<Record<string, any>>(row.data) : null;
}