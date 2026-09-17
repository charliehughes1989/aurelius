import { Router } from 'express';
import {
  getEntity,
  listEntities,
  saveEntity,
  writeAudit,
  now
} from './database.ts';

const router = Router();

function uid(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
}

function bodyData(req: any) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

/*
 * Client portal deliberately uses the existing entities table.
 * No database schema changes are required.
 */

router.get('/dashboard', (req, res) => {
  try {
    const user: any = (req as any).user || {};
    const clientId =
      user.client_id ||
      user.clientId ||
      user.entity_id ||
      user.entityId ||
      (user.role !== 'client' ? req.query.client_id : undefined);

    if (!clientId) {
      return res.status(400).json({
        error: 'No client account is associated with this session.'
      });
    }

    const client = getEntity('client', clientId);
    const premises = listEntities('premise', clientId);
    const quotes = listEntities('quote', clientId);
    const bookings = listEntities('booking', clientId);
    const assessments = listEntities('assessment', clientId);
    const documents = listEntities('document', clientId);
    const actions = listEntities('action', clientId);
    const invoices = listEntities('invoice', clientId);
    const payments = listEntities('payment', clientId);
    const messages = listEntities('message', clientId);
    const previsit = listEntities('previsit', clientId);

    return res.json({
      client,
      premises,
      quotes,
      bookings,
      assessments,
      documents,
      actions,
      invoices,
      payments,
      messages,
      previsit
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Unable to load client dashboard'
    });
  }
});

router.get('/records/:type', (req, res) => {
  try {
    const user: any = (req as any).user || {};
    const clientId =
      user.client_id ||
      user.clientId ||
      user.entity_id ||
      user.entityId ||
      (user.role !== 'client' ? req.query.client_id : undefined);

    if (!clientId) {
      return res.status(400).json({ error: 'No client account associated.' });
    }

    const allowed = [
      'client',
      'premise',
      'quote',
      'booking',
      'assessment',
      'document',
      'action',
      'invoice',
      'payment',
      'message',
      'previsit',
      'certificate'
    ];

    if (!allowed.includes(req.params.type)) {
      return res.status(400).json({ error: 'Invalid record type.' });
    }

    return res.json({
      items: listEntities(req.params.type, clientId)
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Unable to load records'
    });
  }
});

router.post('/onboarding', (req, res) => {
  try {
    const user: any = (req as any).user || {};
    const data = bodyData(req);

    const clientId =
      user.client_id ||
      user.clientId ||
      user.entity_id ||
      user.entityId ||
      (user.role !== 'client' ? data.client_id : undefined);

    if (!clientId) {
      return res.status(400).json({ error: 'Client account not identified.' });
    }

    const premiseId =
      data.premise_id ||
      uid('premise');

    const premise = {
      id: premiseId,
      client_id: clientId,
      name: data.premises_name || data.name || '',
      address: data.address || '',
      postcode: data.postcode || '',
      floors: data.floors || '',
      size: data.size || '',
      occupancy: data.occupancy || '',
      exits: data.exits || '',
      doors: data.doors || '',
      construction: data.construction || '',
      fire_alarm: data.fire_alarm || '',
      detection: data.detection || '',
      emergency_lighting: data.emergency_lighting || '',
      extinguishers: data.extinguishers || '',
      certificates: data.certificates || '',
      notes: data.notes || '',
      onboarding_status: 'submitted',
      submitted_at: now()
    };

    saveEntity('premise', premise, user.id || 'client', 'client_onboarding');

    writeAudit({
      actorId: user.id || 'client',
      actorRole: user.role || 'client',
      action: 'client_onboarding',
      entityType: 'premise',
      entityId: premiseId,
      after: premise
    });

    return res.json({
      success: true,
      premise
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Unable to save onboarding'
    });
  }
});

router.post('/quote/:id/accept', (req, res) => {
  try {
    const quote = getEntity('quote', req.params.id);

    if (!quote) {
      return res.status(404).json({ error: 'Quote not found.' });
    }

    const existing: any = quote.data || quote;
    const updated = {
      ...existing,
      status: 'accepted',
      accepted_at: now(),
      accepted_by:
        (req as any).user?.id ||
        (req as any).user?.email ||
        'client'
    };

    saveEntity(
      'quote',
      updated,
      (req as any).user?.id || 'client',
      'quote_accepted'
    );

    return res.json({
      success: true,
      quote: updated
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Unable to accept quote'
    });
  }
});

router.post('/terms/sign', (req, res) => {
  try {
    const user: any = (req as any).user || {};
    const data = bodyData(req);

    const clientId =
      user.client_id ||
      user.clientId ||
      user.entity_id ||
      user.entityId ||
      (user.role !== 'client' ? data.client_id : undefined);

    if (!clientId) {
      return res.status(400).json({ error: 'Client not identified.' });
    }

    const record = {
      id: uid('terms'),
      client_id: clientId,
      policy_id: data.policy_id || '',
      policy_name: data.policy_name || 'Client Engagement Terms',
      version: data.version || '1.0',
      signer_name: data.signer_name || user.name || '',
      signer_email: data.signer_email || user.email || '',
      signature: data.signature || '',
      signed_at: now(),
      status: 'signed'
    };

    saveEntity(
      'signed_term',
      record,
      user.id || 'client',
      'terms_signed'
    );

    return res.json({
      success: true,
      signed: record
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Unable to record signature'
    });
  }
});

router.post('/message', (req, res) => {
  try {
    const user: any = (req as any).user || {};
    const data = bodyData(req);

    const clientId =
      user.client_id ||
      user.clientId ||
      user.entity_id ||
      user.entityId ||
      (user.role !== 'client' ? data.client_id : undefined);

    if (!clientId) {
      return res.status(400).json({ error: 'Client not identified.' });
    }

    const message = {
      id: uid('message'),
      client_id: clientId,
      subject: data.subject || 'Client message',
      message: data.message || '',
      direction: 'client_to_assessor',
      status: 'unread',
      created_at: now()
    };

    saveEntity(
      'message',
      message,
      user.id || 'client',
      'client_message'
    );

    return res.json({
      success: true,
      message
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Unable to send message'
    });
  }
});

router.post('/action/:id/complete', (req, res) => {
  try {
    const action = getEntity('action', req.params.id);

    if (!action) {
      return res.status(404).json({ error: 'Action not found.' });
    }

    const existing: any = action.data || action;

    const updated = {
      ...existing,
      status: 'completed',
      completed_at: now(),
      completed_by:
        (req as any).user?.id ||
        (req as any).user?.email ||
        'client',
      completion_note: bodyData(req).note || ''
    };

    saveEntity(
      'action',
      updated,
      (req as any).user?.id || 'client',
      'client_action_completed'
    );

    return res.json({
      success: true,
      action: updated
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Unable to complete action'
    });
  }
});

export default router;
