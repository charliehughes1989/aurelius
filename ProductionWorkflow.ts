import { Router } from 'express';
import { randomUUID } from 'crypto';
import {
  getEntity,
  listEntities,
  saveEntity,
  now,
  enqueueNotification
} from './database.ts';
import { currentUser } from './auth.ts';

const router = Router();

function actor(req: any) {
  try {
    return currentUser(req) || {};
  } catch {
    return {};
  }
}

function id(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function body(req: any) {
  return req.body || {};
}

function json(value: any) {
  return JSON.stringify(value ?? {});
}

function parseEntity(entity: any) {
  if (!entity) return null;
  if (typeof entity.data === 'string') {
    try {
      return { ...entity, data: JSON.parse(entity.data) };
    } catch {
      return entity;
    }
  }
  return entity;
}

function entities(type: string, clientId?: string) {
  return listEntities(type, clientId).map(parseEntity);
}

/* ---------------------------------------------------------
   MASTER WORKFLOW SUMMARY
--------------------------------------------------------- */

router.get('/summary', (req, res) => {
  const user = actor(req);

  const clients = entities('client');
  const premises = entities('premise');
  const enquiries = entities('enquiry');
  const quotes = entities('quote');
  const bookings = entities('booking');
  const assessments = entities('assessment');
  const invoices = entities('invoice');
  const actions = entities('action');
  const documents = entities('document');
  const messages = entities('message');
  const accounts = entities('client_account');

  const openActions = actions.filter((x: any) =>
    !['complete', 'completed', 'closed'].includes(
      String(x?.data?.status || x?.status || '').toLowerCase()
    )
  );

  const unpaidInvoices = invoices.filter((x: any) =>
    !['paid', 'complete', 'completed'].includes(
      String(x?.data?.status || x?.status || '').toLowerCase()
    )
  );

  const upcomingBookings = bookings.filter((x: any) => {
    const d = x?.data?.date || x?.data?.start || x?.data?.datetime;
    return d ? new Date(d).getTime() >= Date.now() : true;
  });

  res.json({
    ok: true,
    counts: {
      clients: clients.length,
      premises: premises.length,
      enquiries: enquiries.length,
      quotes: quotes.length,
      bookings: bookings.length,
      upcomingBookings: upcomingBookings.length,
      assessments: assessments.length,
      invoices: invoices.length,
      unpaidInvoices: unpaidInvoices.length,
      openActions: openActions.length,
      documents: documents.length,
      messages: messages.length,
      portalAccounts: accounts.length
    },
    recent: {
      enquiries: enquiries.slice(-10).reverse(),
      quotes: quotes.slice(-10).reverse(),
      bookings: bookings.slice(-10).reverse(),
      invoices: invoices.slice(-10).reverse(),
      actions: actions.slice(-10).reverse()
    },
    actor: {
      id: user?.id || null,
      role: user?.role || null,
      email: user?.email || null
    }
  });
});

/* ---------------------------------------------------------
   CLIENT 360
--------------------------------------------------------- */

router.get('/client/:clientId/360', (req, res) => {
  const clientId = String(req.params.clientId);

  const client = parseEntity(getEntity('client', clientId));

  if (!client) {
    return res.status(404).json({ ok: false, error: 'Client not found' });
  }

  res.json({
    ok: true,
    client,
    premises: entities('premise', clientId),
    enquiries: entities('enquiry', clientId),
    quotes: entities('quote', clientId),
    bookings: entities('booking', clientId),
    assessments: entities('assessment', clientId),
    documents: entities('document', clientId),
    actions: entities('action', clientId),
    invoices: entities('invoice', clientId),
    payments: entities('payment', clientId),
    messages: entities('message', clientId),
    certificates: entities('certificate', clientId),
    terms: entities('terms_signature', clientId),
    onboarding: entities('onboarding', clientId),
    account: entities('client_account', clientId)[0] || null
  });
});

/* ---------------------------------------------------------
   CLIENT WORKFLOW STATUS
--------------------------------------------------------- */

router.get('/client/:clientId/status', (req, res) => {
  const clientId = String(req.params.clientId);

  const enquiries = entities('enquiry', clientId);
  const quotes = entities('quote', clientId);
  const bookings = entities('booking', clientId);
  const terms = entities('terms_signature', clientId);
  const onboarding = entities('onboarding', clientId);
  const invoices = entities('invoice', clientId);
  const documents = entities('document', clientId);
  const actions = entities('action', clientId);

  const latestQuote = quotes[quotes.length - 1];
  const latestBooking = bookings[bookings.length - 1];
  const latestInvoice = invoices[invoices.length - 1];

  const signedTerms = terms.some((x: any) =>
    ['signed', 'accepted', 'complete', 'completed'].includes(
      String(x?.data?.status || '').toLowerCase()
    )
  );

  const completedOnboarding = onboarding.some((x: any) =>
    ['complete', 'completed', 'submitted'].includes(
      String(x?.data?.status || '').toLowerCase()
    )
  );

  const paid = invoices.some((x: any) =>
    ['paid', 'complete', 'completed'].includes(
      String(x?.data?.status || '').toLowerCase()
    )
  );

  const finalReport = documents.some((x: any) => {
    const d = x?.data || {};
    return (
      d.document_type === 'final_fra' ||
      d.type === 'final_fra' ||
      d.category === 'final_fra' ||
      String(d.name || '').toLowerCase().includes('final fra')
    );
  });

  let stage = 'new_enquiry';

  if (enquiries.length) stage = 'enquiry';
  if (latestQuote) stage = 'quote_sent';

  if (
    latestQuote &&
    ['accepted', 'approved', 'accepted_by_client'].includes(
      String(latestQuote?.data?.status || '').toLowerCase()
    )
  ) {
    stage = 'quote_accepted';
  }

  if (completedOnboarding) stage = 'onboarding_complete';
  if (signedTerms) stage = 'terms_signed';
  if (latestBooking) stage = 'booked';
  if (paid) stage = 'paid';
  if (finalReport) stage = 'report_issued';

  res.json({
    ok: true,
    clientId,
    stage,
    checklist: {
      enquiry: enquiries.length > 0,
      quote: !!latestQuote,
      quoteAccepted:
        !!latestQuote &&
        ['accepted', 'approved', 'accepted_by_client'].includes(
          String(latestQuote?.data?.status || '').toLowerCase()
        ),
      onboarding: completedOnboarding,
      termsSigned: signedTerms,
      booking: !!latestBooking,
      payment: paid,
      finalReport
    },
    totals: {
      documents: documents.length,
      actions: actions.length,
      enquiries: enquiries.length,
      quotes: quotes.length,
      bookings: bookings.length,
      invoices: invoices.length
    }
  });
});

/* ---------------------------------------------------------
   QUOTE ACCEPTANCE
--------------------------------------------------------- */

router.post('/quote/:quoteId/accept', (req, res) => {
  const quoteId = String(req.params.quoteId);
  const quote = parseEntity(getEntity('quote', quoteId));

  if (!quote) {
    return res.status(404).json({ ok: false, error: 'Quote not found' });
  }

  const d = quote.data || {};
  const clientId =
    d.client_id ||
    d.clientId ||
    quote.client_id ||
    req.body?.client_id;

  const updatedQuote = {
    ...d,
    status: 'accepted',
    accepted: true,
    accepted_at: now(),
    accepted_by: actor(req)?.id || 'client',
    client_id: clientId
  };

  saveEntity(
    'quote',
    {
      id: quoteId,
      client_id: clientId,
      status: 'active',
      data: json(updatedQuote)
    },
    actor(req)?.id || null,
    'quote_accepted'
  );

  const invoiceId = id('inv');

  const existingInvoices = entities('invoice', clientId);
  const existing = existingInvoices.find(
    (x: any) =>
      x?.data?.quote_id === quoteId ||
      x?.data?.quoteId === quoteId
  );

  let invoice = existing;

  if (!invoice) {
    invoice = {
      id: invoiceId,
      type: 'invoice',
      client_id: clientId,
      status: 'active',
      data: json({
        client_id: clientId,
        quote_id: quoteId,
        invoice_number: `AR-${Date.now()}`,
        description: d.description || 'Fire Risk Assessment',
        amount: Number(d.total || d.amount || d.price || 0),
        currency: 'GBP',
        status: 'unpaid',
        created_at: now(),
        due_at: now()
      })
    };

    saveEntity(
      'invoice',
      invoice,
      actor(req)?.id || null,
      'invoice_created'
    );
  }

  if (clientId) {
    enqueueNotification({
      type: 'quote_accepted',
      recipient_id: clientId,
      entity_type: 'quote',
      entity_id: quoteId,
      payload: {
        quoteId,
        invoiceId: invoice.id
      }
    });
  }

  res.json({
    ok: true,
    quote: parseEntity({
      ...quote,
      data: updatedQuote
    }),
    invoice: parseEntity(invoice),
    next: [
      'complete onboarding',
      'sign terms',
      'choose booking slot',
      'complete payment'
    ]
  });
});

/* ---------------------------------------------------------
   TERMS / POLICY ASSIGNMENT
--------------------------------------------------------- */

router.post('/client/:clientId/terms/assign', (req, res) => {
  const clientId = String(req.params.clientId);
  const b = body(req);

  const record = {
    id: id('terms'),
    client_id: clientId,
    status: 'active',
    data: json({
      client_id: clientId,
      title: b.title || 'Aurelius Fire Risk Client Engagement Terms',
      version: b.version || '1.0',
      document_url: b.document_url || null,
      assigned_at: now(),
      status: 'assigned',
      required: true
    })
  };

  saveEntity(
    'terms_assignment',
    record,
    actor(req)?.id || null,
    'terms_assigned'
  );

  res.json({ ok: true, terms: parseEntity(record) });
});

router.post('/client/:clientId/terms/sign', (req, res) => {
  const clientId = String(req.params.clientId);
  const b = body(req);

  const signature = {
    id: id('terms_signature'),
    client_id: clientId,
    status: 'active',
    data: json({
      client_id: clientId,
      signer_name: b.signer_name || b.name || '',
      signer_email: b.signer_email || b.email || '',
      signature: b.signature || b.signer_name || '',
      version: b.version || '1.0',
      signed_at: now(),
      status: 'signed',
      ip: req.ip || null
    })
  };

  saveEntity(
    'terms_signature',
    signature,
    actor(req)?.id || null,
    'terms_signed'
  );

  res.json({ ok: true, signature: parseEntity(signature) });
});

/* ---------------------------------------------------------
   ONBOARDING
--------------------------------------------------------- */

router.post('/client/:clientId/onboarding/complete', (req, res) => {
  const clientId = String(req.params.clientId);

  const record = {
    id: id('onboarding'),
    client_id: clientId,
    status: 'active',
    data: json({
      client_id: clientId,
      ...body(req),
      status: 'completed',
      completed_at: now()
    })
  };

  saveEntity(
    'onboarding',
    record,
    actor(req)?.id || null,
    'onboarding_completed'
  );

  res.json({ ok: true, onboarding: parseEntity(record) });
});

/* ---------------------------------------------------------
   BOOKING SLOTS
   Friday evening + weekends, maximum 90 days.
--------------------------------------------------------- */

router.get('/availability', (_req, res) => {
  const slots: any[] = [];
  const start = new Date();

  for (let i = 0; i <= 90; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);

    const day = d.getDay();

    if (day === 5 || day === 6 || day === 0) {
      const times =
        day === 5
          ? ['17:30', '18:30', '19:30']
          : ['09:00', '10:30', '12:00', '13:30', '15:00'];

      for (const time of times) {
        slots.push({
          date: d.toISOString().slice(0, 10),
          time,
          day: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day],
          available: true
        });
      }
    }
  }

  const bookings = entities('booking');

  const occupied = new Set(
    bookings.map((b: any) => {
      const d = b?.data || {};
      return `${d.date || ''}|${d.time || ''}`;
    })
  );

  res.json({
    ok: true,
    slots: slots.map(s => ({
      ...s,
      available: !occupied.has(`${s.date}|${s.time}`)
    }))
  });
});

router.post('/client/:clientId/book', (req, res) => {
  const clientId = String(req.params.clientId);
  const b = body(req);

  if (!b.date || !b.time) {
    return res.status(400).json({
      ok: false,
      error: 'Booking date and time are required'
    });
  }

  const selected = new Date(`${b.date}T${b.time}:00`);
  const day = selected.getDay();

  if (![0, 5, 6].includes(day)) {
    return res.status(400).json({
      ok: false,
      error: 'Aurelius availability is Friday evening and weekends only'
    });
  }

  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 90);

  if (selected > maxDate) {
    return res.status(400).json({
      ok: false,
      error: 'Bookings are limited to 90 days ahead'
    });
  }

  const existing = entities('booking').find((x: any) => {
    const d = x?.data || {};
    return d.date === b.date && d.time === b.time;
  });

  if (existing) {
    return res.status(409).json({
      ok: false,
      error: 'That slot has already been booked'
    });
  }

  const booking = {
    id: id('booking'),
    client_id: clientId,
    status: 'active',
    data: json({
      client_id: clientId,
      premise_id: b.premise_id || null,
      date: b.date,
      time: b.time,
      duration_minutes: Number(b.duration_minutes || 90),
      status: 'confirmed',
      booking_type: 'fire_risk_assessment',
      created_at: now()
    })
  };

  saveEntity(
    'booking',
    booking,
    actor(req)?.id || null,
    'booking_created'
  );

  enqueueNotification({
    type: 'booking_confirmed',
    recipient_id: clientId,
    entity_type: 'booking',
    entity_id: booking.id,
    payload: parseEntity(booking)
  });

  res.json({
    ok: true,
    booking: parseEntity(booking)
  });
});

/* ---------------------------------------------------------
   PAYMENT / INVOICE STATUS
--------------------------------------------------------- */

router.post('/invoice/:invoiceId/mark-paid', (req, res) => {
  const invoiceId = String(req.params.invoiceId);
  const invoice = parseEntity(getEntity('invoice', invoiceId));

  if (!invoice) {
    return res.status(404).json({
      ok: false,
      error: 'Invoice not found'
    });
  }

  const d = {
    ...(invoice.data || {}),
    status: 'paid',
    paid: true,
    paid_at: now(),
    payment_method: body(req).payment_method || 'manual'
  };

  saveEntity(
    'invoice',
    {
      id: invoiceId,
      client_id: invoice.client_id || d.client_id,
      status: 'active',
      data: json(d)
    },
    actor(req)?.id || null,
    'invoice_paid'
  );

  const payment = {
    id: id('payment'),
    client_id: invoice.client_id || d.client_id,
    status: 'active',
    data: json({
      client_id: invoice.client_id || d.client_id,
      invoice_id: invoiceId,
      amount: d.amount || 0,
      currency: 'GBP',
      status: 'paid',
      paid_at: now(),
      method: d.payment_method
    })
  };

  saveEntity(
    'payment',
    payment,
    actor(req)?.id || null,
    'payment_recorded'
  );

  res.json({
    ok: true,
    invoice: parseEntity({
      ...invoice,
      data: d
    }),
    payment: parseEntity(payment)
  });
});

/* ---------------------------------------------------------
   FINAL FRA DOCUMENT
--------------------------------------------------------- */

router.post('/client/:clientId/final-report', (req, res) => {
  const clientId = String(req.params.clientId);
  const b = body(req);

  const document = {
    id: id('document'),
    client_id: clientId,
    status: 'active',
    data: json({
      client_id: clientId,
      premise_id: b.premise_id || null,
      name: b.name || 'Final Fire Risk Assessment',
      document_type: 'final_fra',
      category: 'final_fra',
      file_url: b.file_url || null,
      filename: b.filename || null,
      uploaded_at: now(),
      uploaded_by: actor(req)?.id || null,
      visible_to_client: true,
      assessment_type: 'Type 1 / non-intrusive',
      scope:
        'Life-safety focused assessment of accessible areas only. Concealed voids, concealed compartmentation, cladding, DSEAR, alarm sound levels, emergency-light lux, property/business continuity are outside the stated scope unless specifically agreed.'
    })
  };

  saveEntity(
    'document',
    document,
    actor(req)?.id || null,
    'final_report_uploaded'
  );

  res.json({
    ok: true,
    document: parseEntity(document)
  });
});

/* ---------------------------------------------------------
   ACTION REGISTER
--------------------------------------------------------- */

router.post('/client/:clientId/action', (req, res) => {
  const clientId = String(req.params.clientId);
  const b = body(req);

  const priority = ['low', 'medium', 'high'].includes(
    String(b.priority || '').toLowerCase()
  )
    ? String(b.priority).toLowerCase()
    : 'medium';

  const timescale = ['0-1', '3', '6', '12'].includes(
    String(b.timescale || '')
  )
    ? String(b.timescale)
    : '3';

  const action = {
    id: id('action'),
    client_id: clientId,
    status: 'active',
    data: json({
      client_id: clientId,
      premise_id: b.premise_id || null,
      title: b.title || 'Action required',
      description: b.description || '',
      priority,
      risk_rating: priority,
      timescale,
      status: 'open',
      owner: b.owner || '',
      due_date: b.due_date || null,
      created_at: now(),
      client_visible: true
    })
  };

  saveEntity(
    'action',
    action,
    actor(req)?.id || null,
    'action_created'
  );

  res.json({ ok: true, action: parseEntity(action) });
});

router.post('/action/:actionId/complete', (req, res) => {
  const actionId = String(req.params.actionId);
  const action = parseEntity(getEntity('action', actionId));

  if (!action) {
    return res.status(404).json({
      ok: false,
      error: 'Action not found'
    });
  }

  const d = {
    ...(action.data || {}),
    status: 'completed',
    completed_at: now(),
    completed_by: actor(req)?.id || null,
    completion_note: body(req).completion_note || ''
  };

  saveEntity(
    'action',
    {
      id: actionId,
      client_id: action.client_id || d.client_id,
      status: 'active',
      data: json(d)
    },
    actor(req)?.id || null,
    'action_completed'
  );

  res.json({
    ok: true,
    action: parseEntity({
      ...action,
      data: d
    })
  });
});

/* ---------------------------------------------------------
   MESSAGING
--------------------------------------------------------- */

router.post('/client/:clientId/message', (req, res) => {
  const clientId = String(req.params.clientId);
  const b = body(req);

  if (!b.message || !String(b.message).trim()) {
    return res.status(400).json({
      ok: false,
      error: 'Message is required'
    });
  }

  const message = {
    id: id('message'),
    client_id: clientId,
    status: 'active',
    data: json({
      client_id: clientId,
      subject: b.subject || 'Aurelius Fire Risk',
      message: String(b.message).trim(),
      sender_id: actor(req)?.id || null,
      sender_role: actor(req)?.role || 'user',
      created_at: now(),
      read: false
    })
  };

  saveEntity(
    'message',
    message,
    actor(req)?.id || null,
    'message_sent'
  );

  res.json({
    ok: true,
    message: parseEntity(message)
  });
});

/* ---------------------------------------------------------
   GLOBAL SEARCH
--------------------------------------------------------- */

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();

  if (!q) {
    return res.json({ ok: true, results: [] });
  }

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
    'payment',
    'message'
  ];

  const results: any[] = [];

  for (const type of types) {
    for (const item of entities(type)) {
      const d = item?.data || {};

      const haystack = JSON.stringify({
        id: item.id,
        type,
        ...d
      }).toLowerCase();

      if (haystack.includes(q)) {
        results.push({
          type,
          id: item.id,
          client_id: item.client_id || d.client_id || null,
          data: d
        });
      }

      if (results.length >= 100) break;
    }

    if (results.length >= 100) break;
  }

  res.json({
    ok: true,
    query: q,
    results
  });
});

export default router;
