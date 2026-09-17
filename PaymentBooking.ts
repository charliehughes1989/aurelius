import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db, now } from './database.ts';

import { runClientAutomation } from './AutomationEngine.ts';
const router = Router();

function parse(value: any) {
  try { return JSON.parse(value); } catch { return value; }
}

function entity(id: string) {
  return db.query(`
    SELECT *
    FROM entities
    WHERE id = ?
  `).get(id) as any;
}

function create(type: string, data: any, status = 'active') {
  const id = randomUUID();
  const timestamp = now();

  db.query(`
    INSERT INTO entities
    (id, entity_type, data_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    type,
    JSON.stringify(data),
    status,
    timestamp,
    timestamp
  );

  return entity(id);
}

function update(id: string, data: any, status?: string) {
  const existing = entity(id);

  if (!existing) return null;

  const current = parse(existing.data_json || '{}');

  db.query(`
    UPDATE entities
    SET data_json = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify({
      ...current,
      ...data
    }),
    status || existing.status,
    now(),
    id
  );

  return entity(id);
}

/* ------------------------------------------
   CREATE INVOICE FROM QUOTE
------------------------------------------ */

router.post('/invoice/from-quote/:quoteId', (req, res) => {
  const quote = entity(req.params.quoteId);

  if (!quote || quote.entity_type !== 'quote') {
    return res.status(404).json({
      error: 'Quote not found'
    });
  }

  const q = parse(quote.data_json || '{}');

  const existing = db.query(`
    SELECT id, data_json
    FROM entities
    WHERE entity_type = 'invoice'
  `).all() as any[];

  const alreadyExists = existing.find(row => {
    const data = parse(row.data_json || '{}');
    return data.quote_id === req.params.quoteId;
  });

  if (alreadyExists) {
    return res.json({
      success: true,
      data: entity(alreadyExists.id)
    });
  }

  const invoiceNumber =
    'AF-' +
    new Date().getFullYear() +
    '-' +
    String(existing.length + 1).padStart(4, '0');

  const invoice = create(
    'invoice',
    {
      invoice_number: invoiceNumber,
      quote_id: req.params.quoteId,
      client_id: q.client_id || q.clientId || null,
      premises_id: q.premises_id || q.premisesId || null,
      client_name: q.client_name || q.clientName || '',
      company: q.company || '',
      description: q.service || 'Fire Risk Assessment',
      amount: Number(q.total || q.amount || q.price || 0),
      currency: 'GBP',
      issue_date: new Date().toISOString().slice(0, 10),
      due_date: req.body?.due_date || new Date().toISOString().slice(0, 10),
      status: 'unpaid'
    },
    'unpaid'
  );

  res.status(201).json({
    success: true,
    data: invoice
  });
});

/* ------------------------------------------
   MARK INVOICE PAID
------------------------------------------ */

router.post('/invoice/:id/paid', (req, res) => {
  const invoice = entity(req.params.id);

  if (!invoice || invoice.entity_type !== 'invoice') {
    return res.status(404).json({
      error: 'Invoice not found'
    });
  }

  const data = parse(invoice.data_json || '{}');

  const updated = update(
    req.params.id,
    {
      ...data,
      status: 'paid',
      paid_at: now(),
      payment_reference:
        req.body?.payment_reference ||
        'MANUAL'
    },
    'paid'
  );

  res.json({
    success: true,
    data: updated
  });
});

/* ------------------------------------------
   RECORD PAYMENT
------------------------------------------ */

router.post('/payment', (req, res) => {
  const {
    invoice_id,
    quote_id,
    client_id,
    amount,
    reference,
    method
  } = req.body || {};

  if (!amount) {
    return res.status(400).json({
      error: 'Payment amount is required'
    });
  }

  const payment = create(
    'payment',
    {
      invoice_id: invoice_id || null,
      quote_id: quote_id || null,
      client_id: client_id || null,
      amount: Number(amount),
      currency: 'GBP',
      reference: reference || '',
      method: method || 'manual',
      status: 'paid',
      paid_at: now()
    },
    'paid'
  );

  if (invoice_id) {
    update(
      invoice_id,
      {
        status: 'paid',
        paid_at: now(),
        payment_reference: reference || payment.id
      },
      'paid'
    );
  }

  res.status(201).json({
    success: true,
    data: payment
  });
});

/* ------------------------------------------
   ASSESSOR BOOKING LIST
------------------------------------------ */

router.get('/bookings', (_req, res) => {
  const rows = db.query(`
    SELECT *
    FROM entities
    WHERE entity_type = 'booking'
    AND status != 'archived'
    ORDER BY updated_at DESC
  `).all() as any[];

  res.json({
    success: true,
    data: rows.map(row => ({
      id: row.id,
      ...parse(row.data_json || '{}'),
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at
    }))
  });
});

/* ------------------------------------------
   APPROVE BOOKING
------------------------------------------ */

router.post('/booking/:id/approve', (req, res) => {
  const booking = entity(req.params.id);

  if (!booking || booking.entity_type !== 'booking') {
    return res.status(404).json({
      error: 'Booking not found'
    });
  }

  const data = parse(booking.data_json || '{}');

  const updated = update(
    req.params.id,
    {
      ...data,
      status: 'confirmed',
      confirmed_at: now(),
      confirmed_by: req.body?.user || 'Assessor'
    },
    'confirmed'
  );

  res.json({
    success: true,
    data: updated
  });
});

/* ------------------------------------------
   DECLINE BOOKING
------------------------------------------ */

router.post('/booking/:id/decline', (req, res) => {
  const booking = entity(req.params.id);

  if (!booking || booking.entity_type !== 'booking') {
    return res.status(404).json({
      error: 'Booking not found'
    });
  }

  const data = parse(booking.data_json || '{}');

  const updated = update(
    req.params.id,
    {
      ...data,
      status: 'declined',
      declined_at: now(),
      decline_reason: req.body?.reason || ''
    },
    'declined'
  );

  res.json({
    success: true,
    data: updated
  });
});

/* ------------------------------------------
   COMPLETE BOOKING
------------------------------------------ */

router.post('/booking/:id/complete', (req, res) => {
  const booking = entity(req.params.id);

  if (!booking || booking.entity_type !== 'booking') {
    return res.status(404).json({
      error: 'Booking not found'
    });
  }

  const data = parse(booking.data_json || '{}');

  const updated = update(
    req.params.id,
    {
      ...data,
      status: 'completed',
      completed_at: now(),
      completion_notes: req.body?.notes || ''
    },
    'completed'
  );

  res.json({
    success: true,
    data: updated
  });
});

/* ------------------------------------------
   RESCHEDULE
------------------------------------------ */

router.post('/booking/:id/reschedule', (req, res) => {
  const {
    date,
    time
  } = req.body || {};

  if (!date || !time) {
    return res.status(400).json({
      error: 'Date and time are required'
    });
  }

  const booking = entity(req.params.id);

  if (!booking || booking.entity_type !== 'booking') {
    return res.status(404).json({
      error: 'Booking not found'
    });
  }

  const data = parse(booking.data_json || '{}');

  const updated = update(
    req.params.id,
    {
      ...data,
      date,
      time,
      status: 'confirmed',
      rescheduled_at: now()
    },
    'confirmed'
  );

  res.json({
    success: true,
    data: updated
  });
});

export default router;
