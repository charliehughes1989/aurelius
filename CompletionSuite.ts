import express from 'express';
import { db, id, now, parse, saveEntity, listEntities, getEntity, writeAudit, enqueueNotification } from './database.ts';
import { requireRoles } from './auth.ts';

const router = express.Router();
router.use(express.json({ limit: '10mb' }));

function user(req: any) {
  return req.user || {};
}

function actor(req: any) {
  const u = user(req);
  return { id: u.id || 'system', role: u.role || 'admin' };
}

function admin(req: any) {
  return ['admin', 'assessor', 'owner'].includes(user(req).role);
}

function ensureAdmin(req: any, res: any, next: any) {
  if (!admin(req)) return res.status(403).json({ error: 'Administrator access required' });
  next();
}

function clientScope(req: any, requested?: string) {
  const u = user(req);
  if (admin(req)) return requested || undefined;
  return u.clientId || requested;
}

function entity(type: string, data: any, req: any, action = 'create') {
  return saveEntity(type, data, actor(req), action);
}

function all(type: string, req: any, status = 'active') {
  const scope = clientScope(req);
  return listEntities(type, scope, status);
}

function one(type: string, entityId: string, req: any) {
  const scope = clientScope(req);
  return getEntity(type, entityId, scope);
}

function setting(key: string, fallback: any = null) {
  const row = db.query('SELECT value_json FROM content WHERE key=?').get(key) as any;
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

function setSetting(key: string, value: any, req: any, published = 1) {
  const timestamp = now();
  db.query(`
    INSERT INTO content(key,value_json,published,updated_at,updated_by)
    VALUES(?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET
      value_json=excluded.value_json,
      published=excluded.published,
      updated_at=excluded.updated_at,
      updated_by=excluded.updated_by
  `).run(key, JSON.stringify(value), published, timestamp, user(req).id || null);

  writeAudit({
    actorId: user(req).id,
    actorRole: user(req).role,
    action: 'content_update',
    entityType: 'content',
    entityId: key,
    after: value
  });

  return value;
}

/* ============================================================
   MASTER DASHBOARD
   ============================================================ */

router.get('/dashboard', ensureAdmin, (_req, res) => {
  const types = [
    'client',
    'premise',
    'enquiry',
    'quote',
    'booking',
    'assessment',
    'document',
    'action',
    'invoice',
    'message'
  ];

  const counts: Record<string, number> = {};

  for (const type of types) {
    counts[type] = listEntities(type, undefined, 'active').length;
  }

  const outstandingActions = listEntities('action')
    .filter((x: any) => !['complete', 'completed', 'closed'].includes(String(x.status || '').toLowerCase()))
    .length;

  const outstandingInvoices = listEntities('invoice')
    .filter((x: any) => !['paid', 'complete', 'completed'].includes(String(x.status || '').toLowerCase()))
    .length;

  const pendingQuotes = listEntities('quote')
    .filter((x: any) => ['pending', 'sent', 'awaiting_acceptance', 'awaiting-acceptance'].includes(String(x.status || '').toLowerCase()))
    .length;

  const recentActivity = (db.query(`
    SELECT id,timestamp,actor_id,actor_role,action,entity_type,entity_id
    FROM audits
    ORDER BY timestamp DESC
    LIMIT 50
  `).all() as any[]);

  res.json({
    success: true,
    counts,
    outstandingActions,
    outstandingInvoices,
    pendingQuotes,
    recentActivity
  });
});

/* ============================================================
   GLOBAL SEARCH
   ============================================================ */

router.get('/search', ensureAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();

  if (!q) return res.json({ results: [] });

  const types = [
    'client',
    'clients',
    'premise',
    'premises',
    'enquiry',
    'quote',
    'booking',
    'assessment',
    'document',
    'action',
    'invoice',
    'message'
  ];

  const results: any[] = [];

  for (const type of types) {
    for (const item of listEntities(type, undefined, 'all')) {
      const text = JSON.stringify(item).toLowerCase();

      if (
        text.includes(q) ||
        String(item.id || '').toLowerCase().includes(q) ||
        String(item.name || '').toLowerCase().includes(q) ||
        String(item.email || '').toLowerCase().includes(q)
      ) {
        results.push({
          type,
          id: item.id,
          name:
            item.name ||
            item.companyName ||
            item.clientName ||
            item.premiseName ||
            item.title ||
            item.email ||
            item.id,
          status: item.status,
          updatedAt: item.updatedAt
        });
      }
    }
  }

  res.json({
    results: results.slice(0, 100)
  });
});

/* ============================================================
   CLIENT 360
   ============================================================ */

router.get('/client/:clientId/360', (req, res) => {
  const clientId = clientScope(req, String(req.params.clientId));

  if (!clientId) return res.status(400).json({ error: 'Client ID required' });

  const client = getEntity('client', clientId) ||
    getEntity('clients', clientId);

  if (!client && !admin(req)) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const types = [
    'premise',
    'enquiry',
    'quote',
    'booking',
    'assessment',
    'document',
    'action',
    'invoice',
    'message',
    'certificate',
    'payment',
    'previsit',
    'terms',
    'onboarding'
  ];

  const data: Record<string, any[]> = {};

  for (const type of types) {
    data[type] = listEntities(type, clientId, 'all');
  }

  res.json({
    success: true,
    client,
    data
  });
});

/* ============================================================
   CLIENT PORTAL HOME
   ============================================================ */

router.get('/portal', (req, res) => {
  const clientId = clientScope(req);

  if (!clientId) {
    return res.status(400).json({ error: 'No client account is linked to this user' });
  }

  const client =
    getEntity('client', clientId) ||
    getEntity('clients', clientId);

  const data: Record<string, any[]> = {};

  for (const type of [
    'premise',
    'quote',
    'booking',
    'assessment',
    'document',
    'action',
    'invoice',
    'payment',
    'message',
    'certificate',
    'terms',
    'onboarding',
    'previsit'
  ]) {
    data[type] = listEntities(type, clientId, 'all');
  }

  res.json({
    success: true,
    client,
    user: {
      id: user(req).id,
      email: user(req).email,
      role: user(req).role,
      displayName: user(req).displayName,
      clientId
    },
    data
  });
});

/* ============================================================
   GENERIC CLIENT RECORD CREATION
   ============================================================ */

router.post('/client/:clientId/:type', (req, res) => {
  const clientId = clientScope(req, String(req.params.clientId));

  if (!clientId) return res.status(400).json({ error: 'Client ID required' });

  const allowed = [
    'premise',
    'enquiry',
    'quote',
    'booking',
    'assessment',
    'document',
    'action',
    'invoice',
    'message',
    'certificate',
    'payment',
    'previsit',
    'terms',
    'onboarding'
  ];

  const type = String(req.params.type);

  if (!allowed.includes(type)) {
    return res.status(400).json({ error: 'Unsupported record type' });
  }

  const record = {
    ...req.body,
    id: req.body?.id || id(),
    clientId,
    client_id: clientId,
    status: req.body?.status || 'active'
  };

  const saved = entity(type, record, req, 'create');

  res.json({
    success: true,
    record: saved
  });
});

/* ============================================================
   GENERIC ADMIN ENTITY UPDATE
   ============================================================ */

router.put('/record/:type/:id', ensureAdmin, (req, res) => {
  const type = String(req.params.type);
  const recordId = String(req.params.id);

  const existing = getEntity(type, recordId);

  if (!existing) {
    return res.status(404).json({ error: 'Record not found' });
  }

  const updated = entity(
    type,
    {
      ...existing,
      ...req.body,
      id: recordId,
      version: Number(existing.version || 1) + 1
    },
    req,
    'update'
  );

  res.json({
    success: true,
    record: updated
  });
});

/* ============================================================
   ARCHIVE / RESTORE / DELETE
   ============================================================ */

router.post('/record/:type/:id/archive', ensureAdmin, (req, res) => {
  const type = String(req.params.type);
  const recordId = String(req.params.id);
  const existing = getEntity(type, recordId);

  if (!existing) return res.status(404).json({ error: 'Record not found' });

  const updated = entity(
    type,
    { ...existing, status: 'archived' },
    req,
    'archive'
  );

  res.json({ success: true, record: updated });
});

router.post('/record/:type/:id/restore', ensureAdmin, (req, res) => {
  const type = String(req.params.type);
  const recordId = String(req.params.id);
  const existing = getEntity(type, recordId);

  if (!existing) return res.status(404).json({ error: 'Record not found' });

  const updated = entity(
    type,
    { ...existing, status: 'active' },
    req,
    'restore'
  );

  res.json({ success: true, record: updated });
});

/* ============================================================
   WEBSITE CONTENT / EDITOR
   ============================================================ */

router.get('/website', (_req, res) => {
  const defaults = {
    brand: {
      name: 'Aurelius Fire Risk',
      strapline: 'Professional fire risk assessments for UK businesses',
      phone: '',
      email: '',
      location: 'Wirral, Merseyside'
    },
    homepage: {
      headline: 'Fire risk assessments without the unnecessary complexity.',
      subheadline: 'Independent Type 1 fire risk assessments for non-sleeping commercial premises.',
      primaryButton: 'Request a quote',
      secondaryButton: 'View pricing'
    },
    about: {
      title: 'About Aurelius Fire Risk',
      body: '',
      photo: ''
    },
    pricing: {
      small: 345,
      standard: 495,
      larger: 695,
      complex: 995,
      currency: 'GBP',
      showVat: false
    },
    scope: {
      included: [
        'Non-sleeping commercial premises',
        'Type 1 / non-intrusive assessment',
        'Visual inspection of accessible areas',
        'Life-safety focused assessment',
        'Digital report and action register'
      ],
      excluded: [
        'Sleeping accommodation',
        'Intrusive compartmentation surveys',
        'Concealed void inspections',
        'Cladding investigations',
        'DSEAR assessments',
        'Emergency lighting lux testing',
        'Fire alarm audibility testing',
        'Property/business continuity risk'
      ]
    },
    availability: {
      days: ['Friday evening', 'Saturday', 'Sunday'],
      bookingWindowDays: 90,
      slotMinutes: 90
    },
    faqs: [],
    policies: {
      terms: '',
      privacy: '',
      cancellation: '',
      disclaimer: ''
    }
  };

  const website: any = {};

  for (const [key, fallback] of Object.entries(defaults)) {
    website[key] = setting(`website.${key}`, fallback);
  }

  res.json({
    success: true,
    website
  });
});

router.put('/website/:section', ensureAdmin, (req, res) => {
  const section = String(req.params.section);

  const allowed = [
    'brand',
    'homepage',
    'about',
    'pricing',
    'scope',
    'availability',
    'faqs',
    'policies'
  ];

  if (!allowed.includes(section)) {
    return res.status(400).json({ error: 'Invalid website section' });
  }

  const value = setSetting(`website.${section}`, req.body, req, 1);

  res.json({
    success: true,
    section,
    value
  });
});

/* ============================================================
   PRICING
   ============================================================ */

router.get('/pricing', (_req, res) => {
  res.json({
    success: true,
    pricing: setting('website.pricing', {
      small: 345,
      standard: 495,
      larger: 695,
      complex: 995,
      currency: 'GBP',
      showVat: false
    })
  });
});

router.put('/pricing', ensureAdmin, (req, res) => {
  const pricing = {
    small: Number(req.body.small ?? 345),
    standard: Number(req.body.standard ?? 495),
    larger: Number(req.body.larger ?? 695),
    complex: Number(req.body.complex ?? 995),
    currency: 'GBP',
    showVat: false
  };

  setSetting('website.pricing', pricing, req, 1);

  res.json({
    success: true,
    pricing
  });
});

/* ============================================================
   AVAILABILITY
   ============================================================ */

router.get('/availability', (_req, res) => {
  res.json({
    success: true,
    availability: setting('website.availability', {
      days: ['Friday evening', 'Saturday', 'Sunday'],
      bookingWindowDays: 90,
      slotMinutes: 90
    })
  });
});

router.put('/availability', ensureAdmin, (req, res) => {
  const value = {
    days: Array.isArray(req.body.days)
      ? req.body.days
      : ['Friday evening', 'Saturday', 'Sunday'],
    bookingWindowDays: Number(req.body.bookingWindowDays || 90),
    slotMinutes: Number(req.body.slotMinutes || 90),
    blockedDates: Array.isArray(req.body.blockedDates)
      ? req.body.blockedDates
      : [],
    customSlots: Array.isArray(req.body.customSlots)
      ? req.body.customSlots
      : []
  };

  setSetting('website.availability', value, req, 1);

  res.json({
    success: true,
    availability: value
  });
});

/* ============================================================
   QUOTES
   ============================================================ */

router.post('/quote/:quoteId/send', ensureAdmin, (req, res) => {
  const quote = getEntity('quote', String(req.params.quoteId));

  if (!quote) return res.status(404).json({ error: 'Quote not found' });

  const updated = entity(
    'quote',
    {
      ...quote,
      status: 'sent',
      sentAt: now(),
      quoteUrl: req.body.quoteUrl || quote.quoteUrl || ''
    },
    req,
    'quote_sent'
  );

  if (quote.clientId) {
    enqueueNotification(
      'quote_sent',
      quote.clientId,
      { quoteId: quote.id }
    );
  }

  res.json({
    success: true,
    quote: updated
  });
});

router.post('/quote/:quoteId/decline', (req, res) => {
  const quote = one('quote', String(req.params.quoteId), req);

  if (!quote) return res.status(404).json({ error: 'Quote not found' });

  const updated = entity(
    'quote',
    {
      ...quote,
      status: 'declined',
      declinedAt: now(),
      declineReason: req.body.reason || ''
    },
    req,
    'quote_declined'
  );

  res.json({
    success: true,
    quote: updated
  });
});

/* ============================================================
   BOOKINGS
   ============================================================ */

router.get('/bookings/calendar', ensureAdmin, (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');

  let bookings = listEntities('booking', undefined, 'all');

  if (from) {
    bookings = bookings.filter((x: any) =>
      String(x.startAt || x.date || x.start || '') >= from
    );
  }

  if (to) {
    bookings = bookings.filter((x: any) =>
      String(x.startAt || x.date || x.start || '') <= to
    );
  }

  res.json({
    success: true,
    bookings
  });
});

router.post('/booking/:bookingId/cancel', ensureAdmin, (req, res) => {
  const booking = getEntity('booking', String(req.params.bookingId));

  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const updated = entity(
    'booking',
    {
      ...booking,
      status: 'cancelled',
      cancelledAt: now(),
      cancellationReason: req.body.reason || ''
    },
    req,
    'booking_cancelled'
  );

  res.json({
    success: true,
    booking: updated
  });
});

router.post('/booking/:bookingId/complete', ensureAdmin, (req, res) => {
  const booking = getEntity('booking', String(req.params.bookingId));

  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const updated = entity(
    'booking',
    {
      ...booking,
      status: 'completed',
      completedAt: now()
    },
    req,
    'booking_completed'
  );

  res.json({
    success: true,
    booking: updated
  });
});

/* ============================================================
   DOCUMENTS
   ============================================================ */

router.get('/documents', (req, res) => {
  const documents = all('document', req, 'all');

  res.json({
    success: true,
    documents
  });
});

router.post('/document', ensureAdmin, (req, res) => {
  const document = entity(
    'document',
    {
      ...req.body,
      id: req.body?.id || id(),
      status: req.body?.status || 'active',
      visibility: req.body?.visibility || 'client',
      uploadedAt: now()
    },
    req,
    'document_upload'
  );

  res.json({
    success: true,
    document
  });
});

router.put('/document/:documentId', ensureAdmin, (req, res) => {
  const existing = getEntity('document', String(req.params.documentId));

  if (!existing) return res.status(404).json({ error: 'Document not found' });

  const document = entity(
    'document',
    {
      ...existing,
      ...req.body,
      id: existing.id,
      updatedAt: now()
    },
    req,
    'document_update'
  );

  res.json({
    success: true,
    document
  });
});

/* ============================================================
   ACTIONS
   ============================================================ */

router.post('/action', ensureAdmin, (req, res) => {
  const action = entity(
    'action',
    {
      ...req.body,
      id: req.body?.id || id(),
      status: req.body?.status || 'open',
      priority: req.body?.priority || 'medium',
      timescale: req.body?.timescale || '3 months',
      createdAt: now()
    },
    req,
    'action_create'
  );

  res.json({
    success: true,
    action
  });
});

router.put('/action/:actionId', (req, res) => {
  const action = one('action', String(req.params.actionId), req);

  if (!action) return res.status(404).json({ error: 'Action not found' });

  const updated = entity(
    'action',
    {
      ...action,
      ...req.body,
      id: action.id,
      updatedAt: now()
    },
    req,
    'action_update'
  );

  res.json({
    success: true,
    action: updated
  });
});

router.post('/action/:actionId/complete', (req, res) => {
  const action = one('action', String(req.params.actionId), req);

  if (!action) return res.status(404).json({ error: 'Action not found' });

  const updated = entity(
    'action',
    {
      ...action,
      status: 'completed',
      completedAt: now(),
      completedBy: user(req).id
    },
    req,
    'action_complete'
  );

  res.json({
    success: true,
    action: updated
  });
});

/* ============================================================
   MESSAGES
   ============================================================ */

router.post('/message', (req, res) => {
  const clientId = clientScope(req, req.body?.clientId);

  if (!clientId) return res.status(400).json({ error: 'Client ID required' });

  const message = entity(
    'message',
    {
      ...req.body,
      id: id(),
      clientId,
      senderId: user(req).id,
      senderRole: user(req).role,
      sentAt: now(),
      status: 'unread'
    },
    req,
    'message_send'
  );

  res.json({
    success: true,
    message
  });
});

router.get('/messages/:clientId', (req, res) => {
  const clientId = clientScope(req, String(req.params.clientId));

  if (!clientId) return res.status(403).json({ error: 'Access denied' });

  res.json({
    success: true,
    messages: listEntities('message', clientId, 'all')
  });
});

router.post('/message/:messageId/read', (req, res) => {
  const message = one('message', String(req.params.messageId), req);

  if (!message) return res.status(404).json({ error: 'Message not found' });

  const updated = entity(
    'message',
    {
      ...message,
      status: 'read',
      readAt: now()
    },
    req,
    'message_read'
  );

  res.json({
    success: true,
    message: updated
  });
});

/* ============================================================
   INVOICES / PAYMENTS
   ============================================================ */

router.post('/invoice', ensureAdmin, (req, res) => {
  const invoice = entity(
    'invoice',
    {
      ...req.body,
      id: req.body?.id || id(),
      invoiceNumber:
        req.body?.invoiceNumber ||
        `AR-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`,
      status: req.body?.status || 'unpaid',
      issuedAt: now()
    },
    req,
    'invoice_create'
  );

  res.json({
    success: true,
    invoice
  });
});

router.post('/invoice/:invoiceId/paid', ensureAdmin, (req, res) => {
  const invoice = getEntity('invoice', String(req.params.invoiceId));

  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  const updated = entity(
    'invoice',
    {
      ...invoice,
      status: 'paid',
      paidAt: now(),
      paymentReference: req.body.reference || ''
    },
    req,
    'invoice_paid'
  );

  if (invoice.clientId) {
    entity(
      'payment',
      {
        id: id(),
        clientId: invoice.clientId,
        invoiceId: invoice.id,
        amount: invoice.total || invoice.amount || 0,
        status: 'paid',
        paidAt: now(),
        reference: req.body.reference || ''
      },
      req,
      'payment_recorded'
    );
  }

  res.json({
    success: true,
    invoice: updated
  });
});

/* ============================================================
   PRE-VISIT
   ============================================================ */

router.get('/previsit/:clientId', (req, res) => {
  const clientId = clientScope(req, String(req.params.clientId));

  if (!clientId) return res.status(403).json({ error: 'Access denied' });

  const records = listEntities('previsit', clientId, 'all');

  res.json({
    success: true,
    previsit: records
  });
});

router.put('/previsit/:clientId', (req, res) => {
  const clientId = clientScope(req, String(req.params.clientId));

  if (!clientId) return res.status(403).json({ error: 'Access denied' });

  const existing = listEntities('previsit', clientId, 'all')[0];

  const record = entity(
    'previsit',
    {
      ...(existing || {}),
      ...req.body,
      id: existing?.id || id(),
      clientId,
      updatedAt: now()
    },
    req,
    existing ? 'previsit_update' : 'previsit_create'
  );

  res.json({
    success: true,
    previsit: record
  });
});

/* ============================================================
   TERMS / POLICIES
   ============================================================ */

router.get('/policies', (_req, res) => {
  res.json({
    success: true,
    policies: setting('website.policies', {
      terms: '',
      privacy: '',
      cancellation: '',
      disclaimer: ''
    })
  });
});

router.put('/policies', ensureAdmin, (req, res) => {
  const policies = {
    terms: String(req.body.terms || ''),
    privacy: String(req.body.privacy || ''),
    cancellation: String(req.body.cancellation || ''),
    disclaimer: String(req.body.disclaimer || '')
  };

  setSetting('website.policies', policies, req, 1);

  res.json({
    success: true,
    policies
  });
});

router.post('/client/:clientId/terms/sign', (req, res) => {
  const clientId = clientScope(req, String(req.params.clientId));

  if (!clientId) return res.status(403).json({ error: 'Access denied' });

  const terms = entity(
    'terms',
    {
      ...req.body,
      id: req.body?.id || id(),
      clientId,
      signed: true,
      signedAt: now(),
      signedBy: user(req).displayName || user(req).email,
      signerUserId: user(req).id
    },
    req,
    'terms_signed'
  );

  res.json({
    success: true,
    terms
  });
});

/* ============================================================
   ONBOARDING
   ============================================================ */

router.get('/onboarding/:clientId', (req, res) => {
  const clientId = clientScope(req, String(req.params.clientId));

  if (!clientId) return res.status(403).json({ error: 'Access denied' });

  res.json({
    success: true,
    onboarding: listEntities('onboarding', clientId, 'all'),
    premises: listEntities('premise', clientId, 'all')
  });
});

router.put('/onboarding/:clientId', (req, res) => {
  const clientId = clientScope(req, String(req.params.clientId));

  if (!clientId) return res.status(403).json({ error: 'Access denied' });

  const existing = listEntities('onboarding', clientId, 'all')[0];

  const onboarding = entity(
    'onboarding',
    {
      ...(existing || {}),
      ...req.body,
      id: existing?.id || id(),
      clientId,
      updatedAt: now()
    },
    req,
    existing ? 'onboarding_update' : 'onboarding_create'
  );

  res.json({
    success: true,
    onboarding
  });
});

/* ============================================================
   USERS / CLIENT ACCOUNTS
   ============================================================ */

router.get('/users', ensureAdmin, (_req, res) => {
  const users = db.query(`
    SELECT id,email,role,display_name as displayName,client_id as clientId,active,created_at as createdAt,updated_at as updatedAt
    FROM users
    ORDER BY created_at DESC
  `).all();

  res.json({
    success: true,
    users
  });
});

router.put('/user/:id', ensureAdmin, (req, res) => {
  const userId = String(req.params.id);

  const existing = db.query('SELECT * FROM users WHERE id=?').get(userId) as any;

  if (!existing) return res.status(404).json({ error: 'User not found' });

  const email = String(req.body.email ?? existing.email).toLowerCase().trim();
  const role = String(req.body.role ?? existing.role);
  const displayName = String(req.body.displayName ?? existing.display_name);
  const active = req.body.active === undefined
    ? existing.active
    : (req.body.active ? 1 : 0);

  db.query(`
    UPDATE users
    SET email=?,role=?,display_name=?,active=?,updated_at=?
    WHERE id=?
  `).run(email, role, displayName, active, now(), userId);

  writeAudit({
    actorId: user(req).id,
    actorRole: user(req).role,
    action: 'user_update',
    entityType: 'user',
    entityId: userId,
    after: { email, role, displayName, active }
  });

  res.json({
    success: true
  });
});

/* ============================================================
   AUDIT LOG
   ============================================================ */

router.get('/audit', ensureAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);

  const rows = db.query(`
    SELECT *
    FROM audits
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit);

  res.json({
    success: true,
    audits: rows
  });
});

/* ============================================================
   SETTINGS
   ============================================================ */

router.get('/settings', ensureAdmin, (_req, res) => {
  const rows = db.query(`
    SELECT key,value_json,published,updated_at,updated_by
    FROM content
    ORDER BY key
  `).all() as any[];

  res.json({
    success: true,
    settings: rows.map((row: any) => ({
      ...row,
      value: (() => {
        try { return JSON.parse(row.value_json); }
        catch { return row.value_json; }
      })()
    }))
  });
});

router.put('/settings/:key', ensureAdmin, (req, res) => {
  const key = String(req.params.key);

  setSetting(
    key,
    req.body.value === undefined ? req.body : req.body.value,
    req,
    req.body.published === false ? 0 : 1
  );

  res.json({
    success: true
  });
});

/* ============================================================
   HEALTH / VERSION
   ============================================================ */

router.get('/health', (_req, res) => {
  res.json({
    success: true,
    application: 'Aurelius Fire Risk',
    suite: 'complete',
    version: '2026.09',
    database: 'connected',
    timestamp: now()
  });
});

export default router;
