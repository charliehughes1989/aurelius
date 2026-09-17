import { Router } from 'express';
import {
  db,
  listEntities,
  getEntity,
  saveEntity,
  writeAudit,
  now
} from './database.ts';
import { requireRoles } from './auth.ts';

const router = Router();

/*
 * CRM BACKEND
 *
 * Uses the current Aurelius database schema:
 *
 * entities:
 *   type
 *   id
 *   status
 *   client_id
 *   data
 *   created_at
 *   updated_at
 *
 * Do NOT use entity_type or data_json here.
 */

router.use(requireRoles('super_admin', 'admin', 'assessor'));

const ENTITY_TYPES = [
  'enquiries',
  'clients',
  'premises',
  'quotes',
  'bookings',
  'assessments',
  'documents',
  'actions',
  'certificates',
  'previsit',
  'messages',
  'payments',
  'invoices',
  'jobs',
  'booking_slots',
  'services',
  'faqs',
  'pricing',
  'terms_signatures',
  'users'
];

function all(type: string) {
  return listEntities(type, undefined, 'all');
}

function active(type: string) {
  return listEntities(type, undefined, 'active');
}

function safeJson(value: any) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

/* ============================================================
   SUMMARY
============================================================ */

router.get('/summary', (_req, res) => {
  const counts: Record<string, number> = {};

  for (const type of ENTITY_TYPES) {
    counts[type] = active(type).length;
  }

  const enquiries = counts.enquiries || 0;
  const clients = counts.clients || 0;
  const quotes = counts.quotes || 0;
  const bookings = counts.bookings || 0;
  const assessments = counts.assessments || 0;
  const documents = counts.documents || 0;
  const actions = active('actions');
  const messages = active('messages');

  const outstandingActions = actions.filter(
    (item: any) =>
      ['open', 'in_progress', 'outstanding'].includes(
        String(item.status || '').toLowerCase()
      )
  ).length;

  const unreadMessages = messages.filter(
    (item: any) => !item.readAt
  ).length;

  const outstandingQuotes = active('quotes').filter(
    (item: any) =>
      ['sent', 'viewed', 'pending', 'awaiting_acceptance'].includes(
        String(item.status || '').toLowerCase()
      )
  ).length;

  const acceptedQuotes = active('quotes').filter(
    (item: any) =>
      ['accepted', 'approved'].includes(
        String(item.status || '').toLowerCase()
      )
  ).length;

  const upcomingBookings = active('bookings').filter(
    (item: any) =>
      ['requested', 'confirmed', 'rescheduled'].includes(
        String(item.status || '').toLowerCase()
      )
  ).length;

  res.json({
    success: true,
    counts,
    totals: {
      enquiries,
      clients,
      quotes,
      bookings,
      assessments,
      documents,
      actions: actions.length,
      messages: messages.length
    },
    openEnquiries: enquiries,
    outstandingQuotes,
    acceptedQuotes,
    upcomingBookings,
    outstandingActions,
    unreadMessages,
    documentsAwaitingUpload: 0,
    generated_at: now()
  });
});

/* ============================================================
   ENTITY LIST
============================================================ */

router.get('/entities/:type', (req, res) => {
  const type = String(req.params.type || '').trim();

  if (!type) {
    return res.status(400).json({
      success: false,
      error: 'Entity type is required'
    });
  }

  const status = String(req.query.status || 'active');

  const records = listEntities(
    type,
    undefined,
    status
  );

  res.json({
    success: true,
    data: records,
    count: records.length,
    type
  });
});

/* ============================================================
   SINGLE ENTITY
============================================================ */

router.get('/entity/:id', (req, res) => {
  const id = String(req.params.id);

  const record = findEntityById(id);

  if (!record) {
    return res.status(404).json({
      success: false,
      error: 'Record not found'
    });
  }

  res.json({
    success: true,
    data: record
  });
});

/* ============================================================
   CREATE
============================================================ */

router.post('/entities/:type', (req, res) => {
  const type = String(req.params.type);

  const record = saveEntity(
    type,
    {
      ...(req.body || {}),
      createdBy: (req as any).user?.id
    },
    (req as any).user,
    'create'
  );

  res.status(201).json({
    success: true,
    data: record
  });
});

/* ============================================================
   UPDATE
============================================================ */

router.put('/entity/:id', (req, res) => {
  const id = String(req.params.id);

  const existing = findEntityById(id);

  if (!existing) {
    return res.status(404).json({
      success: false,
      error: 'Record not found'
    });
  }

  const updated = saveEntity(
    existing.type,
    {
      ...existing,
      ...(req.body || {}),
      id: existing.id,
      version: Number(existing.version || 1) + 1
    },
    (req as any).user,
    'update'
  );

  res.json({
    success: true,
    data: updated
  });
});

/* ============================================================
   ARCHIVE
============================================================ */

router.delete('/entity/:id', requireRoles('super_admin', 'admin'), (req, res) => {
  const id = String(req.params.id);

  const existing = findEntityById(id);

  if (!existing) {
    return res.status(404).json({
      success: false,
      error: 'Record not found'
    });
  }

  const archived = saveEntity(
    existing.type,
    {
      ...existing,
      status: 'archived',
      archivedAt: new Date().toISOString()
    },
    (req as any).user,
    'archive'
  );

  res.json({
    success: true,
    data: archived
  });
});

/* ============================================================
   SEARCH
============================================================ */

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();

  if (!q) {
    return res.json({
      success: true,
      data: []
    });
  }

  const results: any[] = [];

  for (const type of ENTITY_TYPES) {
    const records = all(type);

    for (const record of records) {
      const haystack = JSON.stringify(record).toLowerCase();

      if (haystack.includes(q)) {
        results.push({
          ...record,
          entityType: type
        });
      }
    }
  }

  results.sort((a, b) => {
    const aa = String(a.updatedAt || a.updated_at || '');
    const bb = String(b.updatedAt || b.updated_at || '');
    return bb.localeCompare(aa);
  });

  res.json({
    success: true,
    data: results.slice(0, 100),
    count: Math.min(results.length, 100),
    totalMatches: results.length
  });
});

/* ============================================================
   CLIENT FULL RECORD
============================================================ */

router.get('/client/:id/full', (req, res) => {
  const clientId = String(req.params.id);

  const client = getEntity('clients', clientId);

  if (!client) {
    return res.status(404).json({
      success: false,
      error: 'Client not found'
    });
  }

  const related = (type: string) =>
    all(type).filter((item: any) =>
      item.clientId === clientId ||
      item.client_id === clientId ||
      item.customerId === clientId
    );

  res.json({
    success: true,
    data: {
      client,
      premises: related('premises'),
      enquiries: related('enquiries'),
      quotes: related('quotes'),
      bookings: related('bookings'),
      assessments: related('assessments'),
      documents: related('documents'),
      actions: related('actions'),
      certificates: related('certificates'),
      previsit: related('previsit'),
      messages: related('messages'),
      payments: related('payments'),
      invoices: related('invoices'),
      jobs: related('jobs')
    }
  });
});

/* ============================================================
   ACTIVITY
============================================================ */

router.get('/activity', requireRoles('super_admin', 'admin'), (_req, res) => {
  const rows = db
    .query(`
      SELECT
        id,
        timestamp,
        actor_id,
        actor_role,
        action,
        entity_type,
        entity_id,
        before_json,
        after_json,
        metadata_json
      FROM audits
      ORDER BY timestamp DESC
      LIMIT 250
    `)
    .all() as any[];

  res.json({
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: safeJson(row.before_json),
      after: safeJson(row.after_json),
      metadata: safeJson(row.metadata_json)
    }))
  });
});

/* ============================================================
   CONTENT
============================================================ */

router.get('/content', requireRoles('super_admin', 'admin'), (_req, res) => {
  const rows = db
    .query(`
      SELECT key, value_json, published, updated_at, updated_by
      FROM content
      ORDER BY key
    `)
    .all() as any[];

  const data: Record<string, any> = {};

  for (const row of rows) {
    data[row.key] = {
      value: safeJson(row.value_json),
      published: !!row.published,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by
    };
  }

  res.json({
    success: true,
    data
  });
});

/* ============================================================
   CONTENT UPDATE
============================================================ */

router.put('/content/:key', requireRoles('super_admin', 'admin'), (req, res) => {
  const key = String(req.params.key);

  const user = (req as any).user;

  db.query(`
    INSERT INTO content
      (key, value_json, published, updated_at, updated_by)
    VALUES
      (?, ?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      published = excluded.published,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(
    key,
    JSON.stringify(req.body?.value ?? req.body ?? null),
    new Date().toISOString(),
    user.id
  );

  writeAudit({
    actorId: user.id,
    actorRole: user.role,
    action: 'content_update',
    entityType: 'content',
    entityId: key,
    after: req.body
  });

  res.json({
    success: true,
    key
  });
});

/* ============================================================
   CONTENT BULK UPDATE
============================================================ */

router.put('/content', requireRoles('super_admin', 'admin'), (req, res) => {
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      error: 'Content must be an object'
    });
  }

  const user = (req as any).user;
  const timestamp = new Date().toISOString();

  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(body)) {
      db.query(`
        INSERT INTO content
          (key, value_json, published, updated_at, updated_by)
        VALUES
          (?, ?, 1, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          published = excluded.published,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(
        key,
        JSON.stringify(value),
        timestamp,
        user.id
      );
    }
  });

  transaction();

  writeAudit({
    actorId: user.id,
    actorRole: user.role,
    action: 'content_bulk_update',
    entityType: 'content',
    metadata: {
      keys: Object.keys(body)
    }
  });

  res.json({
    success: true,
    updated: Object.keys(body)
  });
});

/* ============================================================
   HELPER
============================================================ */

function findEntityById(id: string): any | null {
  for (const type of ENTITY_TYPES) {
    const record = getEntity(type, id);

    if (record) {
      return {
        ...record,
        type
      };
    }
  }

  /*
   * Fallback for records created by modules using other
   * entity types not currently listed above.
   */
  const row = db
    .query(`
      SELECT type, id, status, client_id, data, created_at, updated_at
      FROM entities
      WHERE id = ?
      LIMIT 1
    `)
    .get(id) as any;

  if (!row) return null;

  return {
    ...safeJson(row.data),
    id: row.id,
    type: row.type,
    status: row.status,
    clientId: row.client_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export default router;
