type AuditLogEntry = {
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  timestamp: string;
};

const auditLog: AuditLogEntry[] = [];

export function logAudit(input: {
  entityType: string;
  entityId: string;
  action: string;
  actorId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}) {
  const entry: AuditLogEntry = {
    ...input,
    actorId: input.actorId ?? 'admin',
    timestamp: new Date().toISOString(),
  };

  auditLog.push(entry);
  console.log(`[AUDIT] ${entry.action} ${entry.entityType}:${entry.entityId} by ${entry.actorId}`);
  return entry;
}

export function getAuditLog() {
  return auditLog;
}

export default logAudit;
