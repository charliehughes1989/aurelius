import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const router = Router();

const root = process.cwd();
const uploadDir = path.join(root, 'public', 'uploads', 'documents');

fs.mkdirSync(uploadDir, { recursive: true });

function getDb() {
  const server = require('./Server.ts');
  return server.db;
}

function now() {
  return new Date().toISOString();
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function parse(value: any) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

/* -------------------------------------------------
   DOCUMENTS
------------------------------------------------- */

router.get('/documents', (req, res) => {
  const db = getDb();

  const clientId = String(req.query.clientId || '');
  const premisesId = String(req.query.premisesId || '');
  const assessmentId = String(req.query.assessmentId || '');

  let sql = `
    SELECT *
    FROM entities
    WHERE type = 'document'
  `;

  const params: any[] = [];

  if (clientId) {
    sql += ` AND json_extract(data, '$.clientId') = ?`;
    params.push(clientId);
  }

  if (premisesId) {
    sql += ` AND json_extract(data, '$.premisesId') = ?`;
    params.push(premisesId);
  }

  if (assessmentId) {
    sql += ` AND json_extract(data, '$.assessmentId') = ?`;
    params.push(assessmentId);
  }

  sql += ` ORDER BY created_at DESC`;

  const rows = db.prepare(sql).all(...params);

  res.json(rows.map((r: any) => ({
    id: r.id,
    ...parse(r.data)
  })));
});

router.get('/documents/:id', (req, res) => {
  const db = getDb();

  const row = db.prepare(`
    SELECT * FROM entities
    WHERE id = ? AND type = 'document'
  `).get(req.params.id) as any;

  if (!row) return res.status(404).json({ error: 'Document not found' });

  res.json({
    id: row.id,
    ...parse(row.data)
  });
});

router.post('/documents', (req, res) => {
  const db = getDb();

  const body = req.body || {};

  const id = body.id || randomUUID();

  const document = {
    id,
    clientId: body.clientId || '',
    premisesId: body.premisesId || '',
    assessmentId: body.assessmentId || '',
    name: body.name || body.title || 'Document',
    title: body.title || body.name || 'Document',
    type: body.type || 'Other',
    description: body.description || '',
    fileName: body.fileName || '',
    filePath: body.filePath || '',
    mimeType: body.mimeType || '',
    fileSize: body.fileSize || 0,
    status: body.status || 'Draft',
    releasedToClient: Boolean(body.releasedToClient),
    uploadedBy: body.uploadedBy || 'Assessor',
    uploadedAt: now(),
    updatedAt: now()
  };

  db.prepare(`
    INSERT INTO entities
      (id, type, data, created_at, updated_at)
    VALUES
      (?, 'document', ?, ?, ?)
  `).run(
    id,
    json(document),
    now(),
    now()
  );

  res.json({
    success: true,
    document
  });
});

router.put('/documents/:id', (req, res) => {
  const db = getDb();

  const existing = db.prepare(`
    SELECT * FROM entities
    WHERE id = ? AND type = 'document'
  `).get(req.params.id) as any;

  if (!existing) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const current = parse(existing.data);

  const updated = {
    ...current,
    ...req.body,
    id: existing.id,
    updatedAt: now()
  };

  db.prepare(`
    UPDATE entities
    SET data = ?, updated_at = ?
    WHERE id = ? AND type = 'document'
  `).run(
    json(updated),
    now(),
    req.params.id
  );

  res.json({
    success: true,
    document: updated
  });
});

router.delete('/documents/:id', (req, res) => {
  const db = getDb();

  const existing = db.prepare(`
    SELECT * FROM entities
    WHERE id = ? AND type = 'document'
  `).get(req.params.id) as any;

  if (!existing) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const data = parse(existing.data);

  if (data.filePath) {
    const safePath = path.resolve(root, data.filePath.replace(/^\/+/, ''));

    if (safePath.startsWith(path.resolve(uploadDir))) {
      try {
        fs.unlinkSync(safePath);
      } catch {}
    }
  }

  db.prepare(`
    DELETE FROM entities
    WHERE id = ? AND type = 'document'
  `).run(req.params.id);

  res.json({ success: true });
});

/* -------------------------------------------------
   FINAL FRA
------------------------------------------------- */

router.post('/fra/finalise', (req, res) => {
  const db = getDb();

  const body = req.body || {};

  const id = body.assessmentId || randomUUID();

  const assessment = {
    id,
    clientId: body.clientId || '',
    premisesId: body.premisesId || '',
    status: 'Completed',
    completed: true,
    completedAt: now(),
    finalReportUploaded: Boolean(body.finalReportUploaded),
    finalReportDocumentId: body.finalReportDocumentId || '',
    reportDate: body.reportDate || new Date().toISOString().slice(0, 10),
    assessor: body.assessor || 'Aurelius Fire Risk',
    updatedAt: now()
  };

  const existing = db.prepare(`
    SELECT * FROM entities
    WHERE id = ? AND type = 'assessment'
  `).get(id) as any;

  if (existing) {
    db.prepare(`
      UPDATE entities
      SET data = ?, updated_at = ?
      WHERE id = ? AND type = 'assessment'
    `).run(json(assessment), now(), id);
  } else {
    db.prepare(`
      INSERT INTO entities
        (id, type, data, created_at, updated_at)
      VALUES
        (?, 'assessment', ?, ?, ?)
    `).run(id, json(assessment), now(), now());
  }

  res.json({
    success: true,
    assessment
  });
});

/* -------------------------------------------------
   ACTIONS
------------------------------------------------- */

router.get('/actions', (req, res) => {
  const db = getDb();

  const clientId = String(req.query.clientId || '');
  const premisesId = String(req.query.premisesId || '');
  const assessmentId = String(req.query.assessmentId || '');

  let sql = `
    SELECT *
    FROM entities
    WHERE type = 'action'
  `;

  const params: any[] = [];

  if (clientId) {
    sql += ` AND json_extract(data, '$.clientId') = ?`;
    params.push(clientId);
  }

  if (premisesId) {
    sql += ` AND json_extract(data, '$.premisesId') = ?`;
    params.push(premisesId);
  }

  if (assessmentId) {
    sql += ` AND json_extract(data, '$.assessmentId') = ?`;
    params.push(assessmentId);
  }

  sql += ` ORDER BY
    CASE json_extract(data, '$.priority')
      WHEN 'High' THEN 1
      WHEN 'Medium' THEN 2
      WHEN 'Low' THEN 3
      ELSE 4
    END,
    created_at DESC
  `;

  const rows = db.prepare(sql).all(...params);

  res.json(rows.map((r: any) => ({
    id: r.id,
    ...parse(r.data)
  })));
});

router.get('/actions/:id', (req, res) => {
  const db = getDb();

  const row = db.prepare(`
    SELECT * FROM entities
    WHERE id = ? AND type = 'action'
  `).get(req.params.id) as any;

  if (!row) return res.status(404).json({ error: 'Action not found' });

  res.json({
    id: row.id,
    ...parse(row.data)
  });
});

router.post('/actions', (req, res) => {
  const db = getDb();
  const body = req.body || {};

  const id = body.id || randomUUID();

  const action = {
    id,
    clientId: body.clientId || '',
    premisesId: body.premisesId || '',
    assessmentId: body.assessmentId || '',
    title: body.title || 'Action required',
    description: body.description || '',
    recommendation: body.recommendation || body.description || '',
    priority: ['Low', 'Medium', 'High'].includes(body.priority)
      ? body.priority
      : 'Medium',
    timescale: ['0–1 months', '3 months', '6 months', '12 months'].includes(body.timescale)
      ? body.timescale
      : '3 months',
    status: ['Open', 'In Progress', 'Complete'].includes(body.status)
      ? body.status
      : 'Open',
    dueDate: body.dueDate || '',
    responsiblePerson: body.responsiblePerson || '',
    evidenceDocumentId: body.evidenceDocumentId || '',
    notes: body.notes || '',
    createdAt: now(),
    updatedAt: now(),
    completedAt: body.status === 'Complete' ? now() : ''
  };

  db.prepare(`
    INSERT INTO entities
      (id, type, data, created_at, updated_at)
    VALUES
      (?, 'action', ?, ?, ?)
  `).run(
    id,
    json(action),
    now(),
    now()
  );

  res.json({
    success: true,
    action
  });
});

router.put('/actions/:id', (req, res) => {
  const db = getDb();

  const existing = db.prepare(`
    SELECT * FROM entities
    WHERE id = ? AND type = 'action'
  `).get(req.params.id) as any;

  if (!existing) {
    return res.status(404).json({ error: 'Action not found' });
  }

  const current = parse(existing.data);

  const updated = {
    ...current,
    ...req.body,
    id: existing.id,
    updatedAt: now()
  };

  if (updated.status === 'Complete' && !updated.completedAt) {
    updated.completedAt = now();
  }

  if (updated.status !== 'Complete') {
    updated.completedAt = '';
  }

  db.prepare(`
    UPDATE entities
    SET data = ?, updated_at = ?
    WHERE id = ? AND type = 'action'
  `).run(
    json(updated),
    now(),
    req.params.id
  );

  res.json({
    success: true,
    action: updated
  });
});

router.delete('/actions/:id', (req, res) => {
  const db = getDb();

  db.prepare(`
    UPDATE entities
    SET data = json_set(data, '$.archived', 1, '$.archivedAt', ?),
        updated_at = ?
    WHERE id = ? AND type = 'action'
  `).run(
    now(),
    now(),
    req.params.id
  );

  res.json({ success: true });
});

/* -------------------------------------------------
   CLIENT RELEASED DOCUMENTS ONLY
------------------------------------------------- */

router.get('/client/:clientId/documents', (req, res) => {
  const db = getDb();

  const rows = db.prepare(`
    SELECT *
    FROM entities
    WHERE type = 'document'
      AND json_extract(data, '$.clientId') = ?
      AND (
        json_extract(data, '$.releasedToClient') = 1
        OR json_extract(data, '$.status') = 'Released'
      )
    ORDER BY created_at DESC
  `).all(req.params.clientId);

  res.json(rows.map((r: any) => ({
    id: r.id,
    ...parse(r.data)
  })));
});

router.get('/client/:clientId/actions', (req, res) => {
  const db = getDb();

  const rows = db.prepare(`
    SELECT *
    FROM entities
    WHERE type = 'action'
      AND json_extract(data, '$.clientId') = ?
      AND COALESCE(json_extract(data, '$.archived'), 0) = 0
    ORDER BY
      CASE json_extract(data, '$.priority')
        WHEN 'High' THEN 1
        WHEN 'Medium' THEN 2
        WHEN 'Low' THEN 3
        ELSE 4
      END,
      created_at DESC
  `).all(req.params.clientId);

  res.json(rows.map((r: any) => ({
    id: r.id,
    ...parse(r.data)
  })));
});

/* -------------------------------------------------
   SIMPLE REPORT / ACTION SUMMARY
------------------------------------------------- */

router.get('/summary', (_req, res) => {
  const db = getDb();

  const documents = db.prepare(`
    SELECT COUNT(*) as count
    FROM entities
    WHERE type = 'document'
  `).get() as any;

  const released = db.prepare(`
    SELECT COUNT(*) as count
    FROM entities
    WHERE type = 'document'
      AND (
        json_extract(data, '$.releasedToClient') = 1
        OR json_extract(data, '$.status') = 'Released'
      )
  `).get() as any;

  const actions = db.prepare(`
    SELECT COUNT(*) as count
    FROM entities
    WHERE type = 'action'
      AND COALESCE(json_extract(data, '$.archived'), 0) = 0
  `).get() as any;

  const open = db.prepare(`
    SELECT COUNT(*) as count
    FROM entities
    WHERE type = 'action'
      AND COALESCE(json_extract(data, '$.archived'), 0) = 0
      AND COALESCE(json_extract(data, '$.status'), 'Open') != 'Complete'
  `).get() as any;

  const high = db.prepare(`
    SELECT COUNT(*) as count
    FROM entities
    WHERE type = 'action'
      AND COALESCE(json_extract(data, '$.archived'), 0) = 0
      AND json_extract(data, '$.priority') = 'High'
      AND COALESCE(json_extract(data, '$.status'), 'Open') != 'Complete'
  `).get() as any;

  res.json({
    documents: documents?.count || 0,
    releasedDocuments: released?.count || 0,
    actions: actions?.count || 0,
    openActions: open?.count || 0,
    highPriorityActions: high?.count || 0
  });
});

export default router;
