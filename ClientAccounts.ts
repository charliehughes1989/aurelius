import { Router } from 'express';
import crypto from 'crypto';
import {
  db,
  getEntity,
  listEntities,
  saveEntity,
  writeAudit,
  now
} from './database.ts';

const router = Router();

function uid(prefix: string) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
}

function hash(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function currentUser(req: any) {
  return req.user || {};
}

/*
 * This module deliberately stores the client relationship on the
 * existing user/entity structures rather than replacing the database.
 */

router.get('/client/:clientId/status', (req, res) => {
  try {
    const clientId = req.params.clientId;

    const rows = db.query(`
      SELECT id, email, name, role
      FROM users
      WHERE client_id = ?
      ORDER BY id
      LIMIT 1
    `).all(clientId) as any[];

    if (!rows.length) {
      return res.json({
        exists: false,
        client_id: clientId
      });
    }

    return res.json({
      exists: true,
      client_id: clientId,
      user: {
        id: rows[0].id,
        email: rows[0].email,
        name: rows[0].name,
        role: rows[0].role
      }
    });
  } catch (error: any) {
    /*
     * Some existing builds may not have client_id on users yet.
     * Fall back to entity-based account lookup.
     */
    try {
      const account = getEntity('client_account', req.params.clientId);

      if (!account) {
        return res.json({
          exists: false,
          client_id: req.params.clientId
        });
      }

      return res.json({
        exists: true,
        client_id: req.params.clientId,
        account
      });
    } catch {
      return res.status(500).json({
        error: error?.message || 'Unable to check client account'
      });
    }
  }
});

router.post('/client/:clientId/create', async (req, res) => {
  try {
    const clientId = req.params.clientId;
    const clientEntity = getEntity('client', clientId);

    if (!clientEntity) {
      return res.status(404).json({
        error: 'Client record not found.'
      });
    }

    const client: any = clientEntity.data || clientEntity;
    const body = req.body || {};

    const email =
      body.email ||
      client.email ||
      '';

    const name =
      body.name ||
      client.name ||
      client.contact_name ||
      '';

    if (!email) {
      return res.status(400).json({
        error: 'A client email address is required.'
      });
    }

    /*
     * First check the existing users table if available.
     */
    try {
      const existing = db.query(`
        SELECT id, email, name, role
        FROM users
        WHERE lower(email) = lower(?)
        LIMIT 1
      `).get(email) as any;

      if (existing) {
        try {
          db.query(`
            UPDATE users
            SET client_id = ?, role = 'client'
            WHERE id = ?
          `).run(clientId, existing.id);
        } catch {
          // Older schema may not yet contain client_id.
        }

        const account = {
          id: existing.id,
          client_id: clientId,
          email: existing.email,
          name: existing.name,
          role: 'client',
          status: 'active'
        };

        saveEntity(
          'client_account',
          account,
          currentUser(req).id || 'admin',
          'client_account_linked'
        );

        return res.json({
          success: true,
          existing: true,
          account
        });
      }
    } catch {
      // Continue using entity-based account storage.
    }

    const temporaryPassword = randomPassword();

    const account = {
      id: uid('client_account'),
      client_id: clientId,
      email,
      name,
      role: 'client',
      status: 'invited',
      temporary_password_hash: hash(temporaryPassword),
      must_change_password: true,
      created_at: now(),
      invited_at: now()
    };

    saveEntity(
      'client_account',
      account,
      currentUser(req).id || 'admin',
      'client_account_created'
    );

    /*
     * Update the CRM client so the relationship is visible in the CRM.
     */
    saveEntity(
      'client',
      {
        ...client,
        portal_account_id: account.id,
        portal_status: 'invited',
        portal_email: email
      },
      currentUser(req).id || 'admin',
      'portal_invited'
    );

    writeAudit({
      actorId: currentUser(req).id || null,
      actorRole: currentUser(req).role || 'admin',
      action: 'create',
      entityType: 'client_portal_invited',
      entityId: clientId,
      after: { email }
    });

    return res.json({
      success: true,
      existing: false,
      account: {
        id: account.id,
        client_id: clientId,
        email,
        name,
        role: 'client',
        status: 'invited'
      },
      temporary_password: temporaryPassword,
      message:
        'Client portal account created. The temporary password is shown once so it can be provided securely to the client.'
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Unable to create client account'
    });
  }
});

router.get('/client/:clientId/portal-summary', (req, res) => {
  try {
    const clientId = req.params.clientId;

    const client = getEntity('client', clientId);

    if (!client) {
      return res.status(404).json({
        error: 'Client not found.'
      });
    }

    return res.json({
      client,
      premises: listEntities('premise', clientId),
      quotes: listEntities('quote', clientId),
      bookings: listEntities('booking', clientId),
      assessments: listEntities('assessment', clientId),
      documents: listEntities('document', clientId),
      actions: listEntities('action', clientId),
      invoices: listEntities('invoice', clientId),
      payments: listEntities('payment', clientId),
      messages: listEntities('message', clientId),
      previsit: listEntities('previsit', clientId),
      certificates: listEntities('certificate', clientId),
      signed_terms: listEntities('signed_term', clientId)
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Unable to load client portal summary'
    });
  }
});

router.post('/client/:clientId/reset-invite', async (req, res) => {
  try {
    const clientId = req.params.clientId;
    const account = getEntity('client_account', clientId);

    if (!account) {
      return res.status(404).json({
        error: 'Client portal account does not exist.'
      });
    }

    const data: any = account.data || account;
    const temporaryPassword = randomPassword();

    const updated = {
      ...data,
      status: 'invited',
      temporary_password_hash: hash(temporaryPassword),
      must_change_password: true,
      invited_at: now()
    };

    saveEntity(
      'client_account',
      updated,
      currentUser(req).id || 'admin',
      'client_invite_reset'
    );

    return res.json({
      success: true,
      email: data.email,
      temporary_password: temporaryPassword
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Unable to reset invitation'
    });
  }
});

export default router;
