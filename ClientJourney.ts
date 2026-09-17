import { syncClientWorkflow, ensureWorkflow } from './AutomationEngine.ts';
import { Router } from 'express';
import { db, now } from './database.ts';

const router = Router();

function json(value: any) {
  try { return JSON.parse(value); } catch { return value; }
}

function getEntity(id: string) {
  return db.query(`
    SELECT id, entity_type, data_json, status, created_at, updated_at
    FROM entities
    WHERE id = ?
  `).get(id) as any;
}

function updateEntity(id: string, data: any, status?: string) {
  const existing = getEntity(id);

  if (!existing) return null;

  const current = json(existing.data_json || '{}');

  const merged = {
    ...current,
    ...data
  };

  db.query(`
    UPDATE entities
    SET data_json = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(merged),
    status || existing.status || 'active',
    now(),
    id
  );

  return getEntity(id);
}

/* ------------------------------------------
   ACCEPT QUOTE
------------------------------------------ */

router.post('/quote/:id/accept', (req, res) => {
  const quote = getEntity(req.params.id);

  if (!quote || quote.entity_type !== 'quote') {
    return res.status(404).json({
      error: 'Quote not found'
    });
  }

  const data = json(quote.data_json || '{}');

  const clientId = String(
    data.clientId ||
    data.client_id ||
    quote.client_id ||
    ''
  );

  const updated = updateEntity(
    req.params.id,
    {
      ...data,
      accepted: true,
      accepted_at: now(),
      accepted_by: req.body?.name || data.client_name || 'Client',
      next_step: 'terms'
    },
    'accepted'
  );

  try {
    if (clientId) {
      syncClientWorkflow(
        clientId,
        'accepted',
        undefined,
        'Quote accepted by client'
      );
    }
  } catch (_) {}

  res.json({
    success: true,
    data: updated
  });
});

/* ------------------------------------------
   TERMS
------------------------------------------ */

router.get('/terms', (_req, res) => {
  const row = db.query(`
    SELECT value_json
    FROM content
    WHERE key = 'terms'
  `).get() as any;

  let terms = row ? json(row.value_json) : null;

  if (!terms) {
    terms = `
AURELIUS FIRE – CLIENT ENGAGEMENT TERMS

1. Scope of Service

The service is a Type 1, non-intrusive visual fire risk assessment unless otherwise agreed in writing.

The assessment is limited to accessible areas that can be visually inspected without opening up, dismantling or disturbing the building or its systems.

2. Client Responsibilities

The responsible person remains responsible for fire safety arrangements at the premises and for implementing any recommendations arising from the assessment.

The client must provide reasonable access to the premises and relevant information reasonably requested before the assessment.

3. Limitations

The assessment does not constitute a survey of concealed construction, hidden voids, concealed compartmentation, structural condition, cladding systems, hazardous-area/DSEAR arrangements, emergency lighting lux measurements, fire alarm audibility measurements or business continuity arrangements unless specifically agreed.

4. Information

Information supplied by the client should be accurate and complete. Aurelius Fire is entitled to rely on information supplied unless there is reasonable cause to believe it is inaccurate.

5. Report

The completed report will be provided electronically through the client portal or another agreed method.

6. Actions

Recommendations are provided based on the conditions and information available at the time of assessment. Responsibility for completing actions remains with the responsible person.

7. Payment

Fees are payable in accordance with the quotation and invoice issued.

8. Cancellation

Appointments should be cancelled or rearranged with reasonable notice. Any applicable cancellation charges will be stated in the quotation or booking confirmation.

9. Agreement

Acceptance of the quotation and electronic signature of these terms confirms agreement to the engagement.
`;
  }

  res.json({
    success: true,
    terms
  });
});

/* ------------------------------------------
   SIGN TERMS
------------------------------------------ */

router.post('/terms/sign', (req, res) => {
  const {
    quote_id,
    client_name,
    signature,
    accepted
  } = req.body || {};

  if (!quote_id) {
    return res.status(400).json({
      error: 'Quote reference is required'
    });
  }

  if (!client_name) {
    return res.status(400).json({
      error: 'Name is required'
    });
  }

  if (!signature) {
    return res.status(400).json({
      error: 'Signature is required'
    });
  }

  if (!accepted) {
    return res.status(400).json({
      error: 'Terms must be accepted'
    });
  }

  const quote = getEntity(quote_id);

  if (!quote) {
    return res.status(404).json({
      error: 'Quote not found'
    });
  }

  const timestamp = now();

  const quoteForWorkflow = getEntity(quote_id);

  const quoteWorkflowData = quoteForWorkflow
    ? json(quoteForWorkflow.data_json || '{}')
    : {};

  const clientId = String(
    quoteWorkflowData.clientId ||
    quoteWorkflowData.client_id ||
    quoteForWorkflow?.client_id ||
    ''
  );

  const updated = updateEntity(
    quote_id,
    {
      terms_accepted: true,
      terms_signed: true,
      terms_signed_at: timestamp,
      terms_signed_by: client_name,
      electronic_signature: signature,
      next_step: 'booking'
    },
    'terms_signed'
  );

  try {
    if (clientId) {
      syncClientWorkflow(
        clientId,
        'onboarding',
        undefined,
        'Engagement terms signed'
      );
    }
  } catch (_) {}

  res.json({
    success: true,
    data: updated
  });
});

/* ------------------------------------------
   BOOKING REQUEST
------------------------------------------ */

router.post('/booking/request', (req, res) => {
  const {
    quote_id,
    date,
    time,
    notes
  } = req.body || {};

  if (!quote_id || !date || !time) {
    return res.status(400).json({
      error: 'Quote, date and time are required'
    });
  }

  const quote = getEntity(quote_id);

  if (!quote) {
    return res.status(404).json({
      error: 'Quote not found'
    });
  }

  const quoteData = json(quote.data_json || '{}');

  if (!quoteData.terms_signed) {
    return res.status(400).json({
      error: 'Engagement terms must be signed before booking'
    });
  }

  const id = crypto.randomUUID();
  const timestamp = now();

  const booking = {
    id,
    quote_id,
    client_id: quoteData.client_id || quoteData.clientId || null,
    premises_id: quoteData.premises_id || quoteData.premisesId || null,
    premises: quoteData.premises || quoteData.premises_name || '',
    date,
    time,
    notes: notes || '',
    status: 'requested',
    requested_at: timestamp
  };

  db.query(`
    INSERT INTO entities
    (id, entity_type, data_json, status, created_at, updated_at)
    VALUES (?, 'booking', ?, 'requested', ?, ?)
  `).run(
    id,
    JSON.stringify(booking),
    timestamp,
    timestamp
  );

  updateEntity(
    quote_id,
    {
      next_step: 'booking_requested',
      booking_requested_at: timestamp
    },
    'booking_requested'
  );

  res.status(201).json({
    success: true,
    data: booking
  });
});

/* ------------------------------------------
   BOOKING AVAILABILITY
------------------------------------------ */

router.get('/availability', (_req, res) => {
  const rows = db.query(`
    SELECT data_json
    FROM entities
    WHERE entity_type = 'booking'
    AND status != 'archived'
  `).all() as any[];

  const booked = rows.map(row => {
    const data = json(row.data_json || '{}');
    return {
      date: data.date,
      time: data.time
    };
  });

  /*
   * Aurelius availability:
   * Friday evening
   * Saturday
   * Sunday
   * Up to 90 days ahead
   */

  const available = [];

  const start = new Date();

  for (let i = 0; i <= 90; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);

    const day = d.getDay();

    if (day !== 5 && day !== 6 && day !== 0) continue;

    const date = d.toISOString().slice(0, 10);

    const times =
      day === 5
        ? ['17:30', '18:30', '19:30']
        : ['09:00', '10:30', '12:00', '13:30', '15:00', '16:30'];

    for (const time of times) {
      if (!booked.some(x => x.date === date && x.time === time)) {
        available.push({
          date,
          time
        });
      }
    }
  }

  res.json({
    success: true,
    data: available
  });
});

export default router;
