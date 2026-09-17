import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { db } from './database.ts';

const router = Router();

function getStripe(): Stripe | null {
  const key =
    process.env.STRIPE_SECRET_KEY ||
    process.env.STRIPE_SECRET;

  if (!key) return null;

  return new Stripe(key);
}

function ensureStripeTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_checkouts (
      id TEXT PRIMARY KEY,
      invoice_id TEXT,
      quote_id TEXT,
      client_id TEXT,
      booking_id TEXT,
      stripe_session_id TEXT,
      stripe_payment_intent TEXT,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'gbp',
      status TEXT NOT NULL DEFAULT 'pending',
      checkout_url TEXT,
      created_at TEXT NOT NULL,
      paid_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stripe_events (
      id TEXT PRIMARY KEY,
      stripe_event_id TEXT UNIQUE,
      event_type TEXT,
      processed_at TEXT NOT NULL
    );
  `);
}

ensureStripeTables();

router.get('/status', (_req, res) => {
  const configured = Boolean(
    process.env.STRIPE_SECRET_KEY ||
    process.env.STRIPE_SECRET
  );

  res.json({
    configured,
    currency: 'GBP',
    mode: process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')
      ? 'live'
      : 'test'
  });
});

router.post('/checkout', async (req, res) => {
  try {
    const stripe = getStripe();

    if (!stripe) {
      return res.status(503).json({
        error: 'Stripe is not configured',
        message: 'Add STRIPE_SECRET_KEY to the environment before creating live checkout sessions.'
      });
    }

    const {
      invoiceId,
      quoteId,
      clientId,
      bookingId,
      amount,
      description,
      customerEmail,
      successUrl,
      cancelUrl
    } = req.body;

    const numericAmount = Math.round(Number(amount));

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: 'A valid amount in pounds is required'
      });
    }

    const origin =
      req.headers.origin ||
      `${req.protocol}://${req.get('host')}`;

    const success =
      successUrl ||
      `${origin}/client?payment=success&invoice=${encodeURIComponent(invoiceId || '')}`;

    const cancel =
      cancelUrl ||
      `${origin}/client?payment=cancelled&invoice=${encodeURIComponent(invoiceId || '')}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: customerEmail || undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'gbp',
            unit_amount: Math.round(numericAmount * 100),
            product_data: {
              name: description || 'Aurelius Fire Risk Assessment'
            }
          }
        }
      ],
      metadata: {
        invoiceId: invoiceId || '',
        quoteId: quoteId || '',
        clientId: clientId || '',
        bookingId: bookingId || ''
      },
      success_url: success,
      cancel_url: cancel
    });

    const id = randomUUID();

    db.prepare(`
      INSERT INTO stripe_checkouts (
        id,
        invoice_id,
        quote_id,
        client_id,
        booking_id,
        stripe_session_id,
        amount,
        currency,
        status,
        checkout_url,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'gbp', 'pending', ?, ?)
    `).run(
      id,
      invoiceId || null,
      quoteId || null,
      clientId || null,
      bookingId || null,
      session.id,
      numericAmount,
      session.currency || 'gbp',
      session.url,
      new Date().toISOString()
    );

    res.json({
      ok: true,
      checkoutId: id,
      sessionId: session.id,
      checkoutUrl: session.url
    });
  } catch (error: any) {
    console.error('Stripe checkout error:', error);

    res.status(500).json({
      error: 'Unable to create Stripe checkout',
      message: error?.message || 'Stripe error'
    });
  }
});

router.get('/checkout/:id', (req, res) => {
  const row = db.prepare(`
    SELECT *
    FROM stripe_checkouts
    WHERE id = ?
  `).get(req.params.id);

  if (!row) {
    return res.status(404).json({
      error: 'Checkout not found'
    });
  }

  res.json(row);
});

router.post('/webhook', async (req, res) => {
  const stripe = getStripe();

  if (!stripe) {
    return res.status(503).send('Stripe not configured');
  }

  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).send('Missing Stripe signature');
  }

  const webhookSecret =
    process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return res.status(503).send('Stripe webhook secret not configured');
  }

  let event: Stripe.Event;

  try {
    const rawBody =
      Buffer.isBuffer(req.body)
        ? req.body
        : JSON.stringify(req.body);

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret
    );
  } catch (error: any) {
    console.error('Stripe webhook signature error:', error);
    return res.status(400).send('Invalid webhook signature');
  }

  const existing = db.prepare(`
    SELECT id
    FROM stripe_events
    WHERE stripe_event_id = ?
  `).get(event.id);

  if (existing) {
    return res.json({ received: true });
  }

  db.prepare(`
    INSERT INTO stripe_events (
      id,
      stripe_event_id,
      event_type,
      processed_at
    )
    VALUES (?, ?, ?, ?)
  `).run(
    randomUUID(),
    event.id,
    event.type,
    new Date().toISOString()
  );

  try {
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const session =
        event.data.object as Stripe.Checkout.Session;

      const checkout: any = db.prepare(`
        SELECT *
        FROM stripe_checkouts
        WHERE stripe_session_id = ?
      `).get(session.id);

      if (checkout) {
        const paidAt = new Date().toISOString();

        db.prepare(`
          UPDATE stripe_checkouts
          SET
            status = 'paid',
            stripe_payment_intent = ?,
            paid_at = ?
          WHERE id = ?
        `).run(
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : null,
          paidAt,
          checkout.id
        );

        if (checkout.invoice_id) {
          db.prepare(`
            UPDATE entities
            SET
              data = json_set(
                data,
                '$.status', 'Paid',
                '$.paymentStatus', 'Paid',
                '$.paidAt', ?
              ),
              updated_at = ?
            WHERE id = ?
          `).run(
            paidAt,
            paidAt,
            checkout.invoice_id
          );
        }

        if (checkout.booking_id) {
          db.prepare(`
            UPDATE entities
            SET
              data = json_set(
                data,
                '$.paymentStatus', 'Paid',
                '$.paymentReceived', 1
              ),
              updated_at = ?
            WHERE id = ?
          `).run(
            paidAt,
            checkout.booking_id
          );
        }
      }
    }

    if (
      event.type === 'checkout.session.expired'
    ) {
      const session =
        event.data.object as Stripe.Checkout.Session;

      db.prepare(`
        UPDATE stripe_checkouts
        SET status = 'expired'
        WHERE stripe_session_id = ?
      `).run(session.id);
    }
  } catch (error) {
    console.error('Stripe event processing error:', error);
  }

  res.json({ received: true });
});

router.post('/mark-paid/:checkoutId', (req, res) => {
  const checkout: any = db.prepare(`
    SELECT *
    FROM stripe_checkouts
    WHERE id = ?
  `).get(req.params.checkoutId);

  if (!checkout) {
    return res.status(404).json({
      error: 'Checkout not found'
    });
  }

  const paidAt = new Date().toISOString();

  db.prepare(`
    UPDATE stripe_checkouts
    SET status = 'paid',
        paid_at = ?
    WHERE id = ?
  `).run(paidAt, checkout.id);

  if (checkout.invoice_id) {
    db.prepare(`
      UPDATE entities
      SET
        data = json_set(
          data,
          '$.status', 'Paid',
          '$.paymentStatus', 'Paid',
          '$.paidAt', ?
        ),
        updated_at = ?
      WHERE id = ?
    `).run(
      paidAt,
      paidAt,
      checkout.invoice_id
    );
  }

  res.json({
    ok: true,
    status: 'paid'
  });
});

router.get('/payments', (_req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM stripe_checkouts
    ORDER BY created_at DESC
  `).all();

  res.json(rows);
});

router.get('/payments/summary', (_req, res) => {
  const total: any = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(amount), 0) AS value
    FROM stripe_checkouts
  `).get();

  const paid: any = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(amount), 0) AS value
    FROM stripe_checkouts
    WHERE status = 'paid'
  `).get();

  const pending: any = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(amount), 0) AS value
    FROM stripe_checkouts
    WHERE status = 'pending'
  `).get();

  res.json({
    total: total || { count: 0, value: 0 },
    paid: paid || { count: 0, value: 0 },
    pending: pending || { count: 0, value: 0 }
  });
});

export default router;
