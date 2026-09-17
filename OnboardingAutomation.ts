import { Router } from 'express';
import { randomUUID } from 'node:crypto';

const router = Router();

function getDb() {
  const server = require('./Server.ts');
  return server.db;
}

function now() {
  return new Date().toISOString();
}

function parse(value: any) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function saveEntity(type: string, data: any, id = randomUUID()) {
  const db = getDb();

  const existing = db.prepare(`
    SELECT id FROM entities WHERE id = ?
  `).get(id) as any;

  if (existing) {
    db.prepare(`
      UPDATE entities
      SET data = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(data),
      now(),
      id
    );
  } else {
    db.prepare(`
      INSERT INTO entities
        (id, type, data, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?)
    `).run(
      id,
      type,
      JSON.stringify(data),
      now(),
      now()
    );
  }

  return {
    id,
    ...data
  };
}

/* ======================================================
   CLIENT ONBOARDING
====================================================== */

router.get('/onboarding/:clientId', (req, res) => {
  const db = getDb();

  const row = db.prepare(`
    SELECT *
    FROM entities
    WHERE id = ?
      AND type = 'onboarding'
  `).get(req.params.clientId) as any;

  if (!row) {
    return res.json({
      clientId: req.params.clientId,
      status: 'Not Started',
      completed: false,
      data: {}
    });
  }

  res.json({
    clientId: req.params.clientId,
    status: parse(row.data).status || 'In Progress',
    completed: Boolean(parse(row.data).completed),
    data: parse(row.data)
  });
});

router.post('/onboarding/:clientId', (req, res) => {
  const body = req.body || {};

  const onboarding = {
    clientId: req.params.clientId,

    status: 'In Progress',
    completed: false,

    businessName: body.businessName || '',
    contactName: body.contactName || '',
    email: body.email || '',
    phone: body.phone || '',

    premisesName: body.premisesName || '',
    premisesAddress: body.premisesAddress || '',
    postcode: body.postcode || '',

    premisesType: body.premisesType || '',
    floors: body.floors || '',
    approximateArea: body.approximateArea || '',
    occupancy: body.occupancy || '',

    operatingHours: body.operatingHours || '',
    vulnerablePersons: body.vulnerablePersons || '',
    sleepingRisk: body.sleepingRisk || 'No',

    construction: body.construction || '',
    externalWalls: body.externalWalls || '',
    roof: body.roof || '',
    floorsConstruction: body.floorsConstruction || '',

    exits: body.exits || '',
    finalExits: body.finalExits || '',
    escapeStairs: body.escapeStairs || '',
    emergencyRoutes: body.emergencyRoutes || '',

    fireAlarm: body.fireAlarm || '',
    emergencyLighting: body.emergencyLighting || '',
    extinguishers: body.extinguishers || '',
    fireDoors: body.fireDoors || '',
    signage: body.signage || '',

    electricalInstallation: body.electricalInstallation || '',
    gasInstallation: body.gasInstallation || '',
    heating: body.heating || '',

    previousFra: body.previousFra || '',
    fireStrategy: body.fireStrategy || '',
    significantFindings: body.significantFindings || '',

    specialRisks: body.specialRisks || '',
    contractors: body.contractors || '',
    additionalInformation: body.additionalInformation || '',

    updatedAt: now()
  };

  const saved = saveEntity(
    'onboarding',
    onboarding,
    randomUUID()
  );

  res.json({
    success: true,
    onboarding: saved
  });
});

router.post('/onboarding/:clientId/complete', (req, res) => {
  const db = getDb();

  const row = db.prepare(`
    SELECT *
    FROM entities
    WHERE id = ?
      AND type = 'onboarding'
  `).get(req.params.clientId) as any;

  if (!row) {
    return res.status(404).json({
      error: 'Onboarding has not been started'
    });
  }

  const current = parse(row.data);

  const updated = {
    ...current,
    status: 'Complete',
    completed: true,
    completedAt: now(),
    updatedAt: now()
  };

  db.prepare(`
    UPDATE entities
    SET data = ?, updated_at = ?
    WHERE id = ?
      AND type = 'onboarding'
  `).run(
    JSON.stringify(updated),
    now(),
    req.params.clientId
  );

  createNotification(
    req.params.clientId,
    'Onboarding complete',
    'The client pre-visit onboarding form has been completed and is ready for review.',
    'onboarding'
  );

  res.json({
    success: true,
    onboarding: updated
  });
});

/* ======================================================
   PRE-VISIT CHECKLIST
====================================================== */

router.get('/previsit/:clientId', (req, res) => {
  const db = getDb();

  const row = db.prepare(`
    SELECT *
    FROM entities
    WHERE id = ?
      AND type = 'previsit'
  `).get(req.params.clientId) as any;

  if (!row) {
    return res.json({
      clientId: req.params.clientId,
      status: 'Not Started',
      checklist: defaultChecklist()
    });
  }

  res.json({
    clientId: req.params.clientId,
    ...parse(row.data)
  });
});

router.post('/previsit/:clientId', (req, res) => {
  const body = req.body || {};

  const checklist = {
    ...defaultChecklist(),
    ...(body.checklist || {})
  };

  const data = {
    clientId: req.params.clientId,
    status: body.status || 'In Progress',
    checklist,
    notes: body.notes || '',
    reviewedBy: body.reviewedBy || '',
    reviewedAt: body.reviewedAt || '',
    updatedAt: now()
  };

  const saved = saveEntity(
    'previsit',
    data,
    randomUUID()
  );

  res.json({
    success: true,
    previsit: saved
  });
});

function defaultChecklist() {
  return {
    clientDetailsConfirmed: false,
    premisesAddressConfirmed: false,
    quoteAccepted: false,
    termsSigned: false,
    paymentConfirmed: false,
    bookingConfirmed: false,
    onboardingComplete: false,
    previousFRARequested: false,
    fireStrategyRequested: false,
    eicrRequested: false,
    gasCertificateRequested: false,
    fireAlarmCertificateRequested: false,
    emergencyLightingCertificateRequested: false,
    accessArrangementsConfirmed: false,
    responsiblePersonConfirmed: false,
    specialRisksReviewed: false,
    documentsReviewed: false
  };
}

/* ======================================================
   NOTIFICATIONS
====================================================== */

function createNotification(
  clientId: string,
  title: string,
  message: string,
  category = 'general'
) {
  const db = getDb();

  const id = randomUUID();

  const notification = {
    clientId,
    title,
    message,
    category,
    read: false,
    createdAt: now()
  };

  try {
    db.prepare(`
      INSERT INTO notifications
        (id, user_id, title, message, read, created_at)
      VALUES
        (?, ?, ?, ?, 0, ?)
    `).run(
      id,
      clientId,
      title,
      message,
      now()
    );
  } catch {
    /*
      Some existing builds may use a slightly different
      notification schema. Store a fallback entity so the
      event is never lost.
    */

    saveEntity(
      'notification',
      {
        ...notification,
        id
      },
      id
    );
  }

  return notification;
}

router.get('/notifications/:clientId', (req, res) => {
  const db = getDb();

  try {
    const rows = db.prepare(`
      SELECT *
      FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(req.params.clientId);

    return res.json(rows);
  } catch {
    const rows = db.prepare(`
      SELECT *
      FROM entities
      WHERE type = 'notification'
        AND json_extract(data, '$.clientId') = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(req.params.clientId);

    return res.json(rows.map((r: any) => ({
      id: r.id,
      ...parse(r.data)
    })));
  }
});

router.post('/notifications/:id/read', (req, res) => {
  const db = getDb();

  try {
    db.prepare(`
      UPDATE notifications
      SET read = 1
      WHERE id = ?
    `).run(req.params.id);
  } catch {}

  try {
    db.prepare(`
      UPDATE entities
      SET data = json_set(data, '$.read', 1),
          updated_at = ?
      WHERE id = ?
        AND type = 'notification'
    `).run(
      now(),
      req.params.id
    );
  } catch {}

  res.json({ success: true });
});

/* ======================================================
   AUTOMATED WORKFLOW EVENTS
====================================================== */

router.post('/workflow/quote-accepted', (req, res) => {
  const {
    clientId,
    quoteId
  } = req.body || {};

  createNotification(
    clientId || '',
    'Quote accepted',
    `Quote ${quoteId || ''} has been accepted. Please complete the engagement terms and onboarding information.`,
    'quote'
  );

  res.json({ success: true });
});

router.post('/workflow/terms-signed', (req, res) => {
  const {
    clientId
  } = req.body || {};

  createNotification(
    clientId || '',
    'Terms signed',
    'Your engagement terms have been signed. Please complete any remaining pre-visit information.',
    'terms'
  );

  res.json({ success: true });
});

router.post('/workflow/booking-requested', (req, res) => {
  const {
    clientId,
    date,
    time
  } = req.body || {};

  createNotification(
    clientId || '',
    'Booking request received',
    `Your booking request for ${date || 'the selected date'} at ${time || 'the selected time'} has been received.`,
    'booking'
  );

  res.json({ success: true });
});

router.post('/workflow/booking-confirmed', (req, res) => {
  const {
    clientId,
    date,
    time
  } = req.body || {};

  createNotification(
    clientId || '',
    'Assessment booking confirmed',
    `Your fire risk assessment is confirmed for ${date || 'the selected date'} at ${time || 'the selected time'}.`,
    'booking'
  );

  res.json({ success: true });
});

router.post('/workflow/report-released', (req, res) => {
  const {
    clientId
  } = req.body || {};

  createNotification(
    clientId || '',
    'Final fire risk assessment available',
    'Your final fire risk assessment has been released and is now available in your client portal.',
    'report'
  );

  res.json({ success: true });
});

router.post('/workflow/action-updated', (req, res) => {
  const {
    clientId,
    actionTitle,
    status
  } = req.body || {};

  createNotification(
    clientId || '',
    'Action updated',
    `${actionTitle || 'An action'} is now marked ${status || 'updated'}.`,
    'action'
  );

  res.json({ success: true });
});

/* ======================================================
   ADMIN MESSAGE CENTRE
====================================================== */

router.get('/messages', (req, res) => {
  const db = getDb();

  const clientId = String(req.query.clientId || '');

  let sql = `
    SELECT *
    FROM entities
    WHERE type = 'message'
  `;

  const params: any[] = [];

  if (clientId) {
    sql += ` AND json_extract(data, '$.clientId') = ?`;
    params.push(clientId);
  }

  sql += ` ORDER BY created_at DESC`;

  const rows = db.prepare(sql).all(...params);

  res.json(rows.map((r: any) => ({
    id: r.id,
    ...parse(r.data)
  })));
});

router.post('/messages', (req, res) => {
  const body = req.body || {};

  const message = {
    clientId: body.clientId || '',
    from: body.from || 'Aurelius Fire Risk',
    to: body.to || '',
    subject: body.subject || '',
    message: body.message || '',
    status: 'Sent',
    createdAt: now()
  };

  const saved = saveEntity('message', message);

  if (message.clientId) {
    createNotification(
      message.clientId,
      message.subject || 'New message from Aurelius',
      message.message,
      'message'
    );
  }

  res.json({
    success: true,
    message: saved
  });
});

/* ======================================================
   WEBSITE CONTENT EDITOR
====================================================== */

router.get('/website-content', (_req, res) => {
  const db = getDb();

  const rows = db.prepare(`
    SELECT *
    FROM content
    ORDER BY key
  `).all() as any[];

  res.json(rows.map(row => ({
    key: row.key,
    value: row.value
  })));
});

router.put('/website-content/:key', (req, res) => {
  const db = getDb();

  const key = req.params.key;
  const value = req.body?.value ?? '';

  const existing = db.prepare(`
    SELECT key FROM content WHERE key = ?
  `).get(key);

  if (existing) {
    db.prepare(`
      UPDATE content
      SET value = ?
      WHERE key = ?
    `).run(
      String(value),
      key
    );
  } else {
    db.prepare(`
      INSERT INTO content (key, value)
      VALUES (?, ?)
    `).run(
      key,
      String(value)
    );
  }

  res.json({
    success: true,
    key,
    value
  });
});

/* ======================================================
   WORKFLOW DASHBOARD
====================================================== */

router.get('/workflow-summary', (_req, res) => {
  const db = getDb();

  const count = (type: string, extra = '') => {
    try {
      const row = db.prepare(`
        SELECT COUNT(*) as count
        FROM entities
        WHERE type = ?
        ${extra}
      `).get(type) as any;

      return row?.count || 0;
    } catch {
      return 0;
    }
  };

  res.json({
    onboarding: count('onboarding'),
    completedOnboarding: count(
      'onboarding',
      `AND json_extract(data, '$.completed') = 1`
    ),
    previsit: count('previsit'),
    messages: count('message'),
    notifications: count('notification'),
    openActions: count(
      'action',
      `AND COALESCE(json_extract(data, '$.status'), 'Open') != 'Complete'
       AND COALESCE(json_extract(data, '$.archived'), 0) = 0`
    )
  });
});

export default router;
