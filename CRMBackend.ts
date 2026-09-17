import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db, now } from './database.ts';

const router = Router();

function safeJson(value: any) {
  try { return JSON.parse(value); } catch { return value; }
}

function list(type: string) {
  const rows = db.query(`
    SELECT id, entity_type, data_json, status, created_at, updated_at
    FROM entities
    WHERE entity_type = ?
    ORDER BY updated_at DESC
  `).all(type) as any[];

  return rows.map(r => ({
    id: r.id,
    type: r.entity_type,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    ...safeJson(r.data_json || '{}')
  }));
}

function get(id: string) {
  const row = db.query(`
    SELECT id, entity_type, data_json, status, created_at, updated_at
    FROM entities
    WHERE id = ?
  `).get(id) as any;

  if (!row) return null;

  return {
    id: row.id,
    type: row.entity_type,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...safeJson(row.data_json || '{}')
  };
}

function save(type: string, body: any, id?: string) {
  const recordId = id || randomUUID();
  const timestamp = now();

  const data = { ...body };
  delete data.id;
  delete data.type;
  delete data.status;
  delete data.created_at;
  delete data.updated_at;

  const status = body.status || 'active';

  if (id) {
    db.query(`
      UPDATE entities
      SET data_json = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(data), status, timestamp, id);
  } else {
    db.query(`
      INSERT INTO entities
      (id, entity_type, data_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      recordId,
      type,
      JSON.stringify(data),
      status,
      timestamp,
      timestamp
    );
  }

  return get(recordId);
}

function remove(id: string) {
  db.query(`
    UPDATE entities
    SET status = 'archived', updated_at = ?
    WHERE id = ?
  `).run(now(), id);

  return get(id);
}

/* -----------------------------------------
   CRM SUMMARY
----------------------------------------- */

router.get('/summary', (_req, res) => {
  const types = [
    'enquiry',
    'client',
    'premises',
    'quote',
    'booking',
    'assessment',
    'document',
    'action',
    'certificate',
    'previsit',
    'message',
    'payment',
    'invoice'
  ];

  const counts: Record<string, number> = {};

  for (const type of types) {
    counts[type] = Number(
      (db.query(`
        SELECT COUNT(*) AS count
        FROM entities
        WHERE entity_type = ?
        AND status != 'archived'
      `).get(type) as any)?.count || 0
    );
  }

  res.json({
    success: true,
    counts,
    generated_at: now()
  });
});

/* -----------------------------------------
   GENERIC ENTITY API
----------------------------------------- */

router.get('/entities/:type', (req, res) => {
  res.json({
    success: true,
    data: list(req.params.type)
  });
});

router.get('/entity/:id', (req, res) => {
  const item = get(req.params.id);

  if (!item) {
    return res.status(404).json({
      success: false,
      error: 'Record not found'
    });
  }

  res.json({
    success: true,
    data: item
  });
});

router.post('/entities/:type', (req, res) => {
  const item = save(req.params.type, req.body || {});

  res.status(201).json({
    success: true,
    data: item
  });
});

router.put('/entity/:id', (req, res) => {
  const existing = get(req.params.id);

  if (!existing) {
    return res.status(404).json({
      success: false,
      error: 'Record not found'
    });
  }

  const item = save(existing.type, req.body || {}, req.params.id);

  res.json({
    success: true,
    data: item
  });
});

router.delete('/entity/:id', (req, res) => {
  const existing = get(req.params.id);

  if (!existing) {
    return res.status(404).json({
      success: false,
      error: 'Record not found'
    });
  }

  const item = remove(req.params.id);

  res.json({
    success: true,
    data: item
  });
});

/* -----------------------------------------
   SEARCH
----------------------------------------- */

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();

  if (!q) {
    return res.json({ success: true, data: [] });
  }

  const pattern = `%${q}%`;

  const rows = db.query(`
    SELECT id, entity_type, data_json, status, created_at, updated_at
    FROM entities
    WHERE status != 'archived'
    AND (
      data_json LIKE ?
      OR entity_type LIKE ?
    )
    ORDER BY updated_at DESC
    LIMIT 100
  `).all(pattern, pattern) as any[];

  res.json({
    success: true,
    data: rows.map(r => ({
      id: r.id,
      type: r.entity_type,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      ...safeJson(r.data_json || '{}')
    }))
  });
});

/* -----------------------------------------
   CLIENT / PREMISES RELATIONSHIP
----------------------------------------- */

router.get('/client/:id/full', (req, res) => {
  const client = get(req.params.id);

  if (!client) {
    return res.status(404).json({
      success: false,
      error: 'Client not found'
    });
  }

  const all = [
    'premises',
    'quote',
    'booking',
    'assessment',
    'document',
    'action',
    'certificate',
    'previsit',
    'message',
    'payment',
    'invoice'
  ].flatMap(type => list(type));

  const related = all.filter(item =>
    item.client_id === req.params.id ||
    item.clientId === req.params.id
  );

  res.json({
    success: true,
    client,
    related
  });
});

/* -----------------------------------------
   DASHBOARD ACTIVITY
----------------------------------------- */

router.get('/activity', (_req, res) => {
  const rows = db.query(`
    SELECT id, entity_type, data_json, status, created_at, updated_at
    FROM entities
    WHERE status != 'archived'
    ORDER BY updated_at DESC
    LIMIT 30
  `).all() as any[];

  res.json({
    success: true,
    data: rows.map(r => ({
      id: r.id,
      type: r.entity_type,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      ...safeJson(r.data_json || '{}')
    }))
  });
});

/* -----------------------------------------
   SETTINGS / WEBSITE CONTENT
----------------------------------------- */

router.get('/content', (_req, res) => {
  const rows = db.query(`
    SELECT key, value_json, published, updated_at
    FROM content
    ORDER BY key
  `).all() as any[];

  res.json({
    success: true,
    data: rows.map(r => ({
      key: r.key,
      value: safeJson(r.value_json),
      published: r.published,
      updated_at: r.updated_at
    }))
  });
});

router.put('/content/:key', (req, res) => {
  const key = req.params.key;
  const value = req.body?.value ?? req.body;

  const exists = db.query(`
    SELECT key FROM content WHERE key = ?
  `).get(key);

  if (exists) {
    db.query(`
      UPDATE content
      SET value_json = ?, updated_at = ?
      WHERE key = ?
    `).run(
      JSON.stringify(value),
      now(),
      key
    );
  } else {
    db.query(`
      INSERT INTO content
      (key, value_json, published, updated_at)
      VALUES (?, ?, 1, ?)
    `).run(
      key,
      JSON.stringify(value),
      now()
    );
  }

  res.json({
    success: true,
    key,
    value
  });
});

export default router;
