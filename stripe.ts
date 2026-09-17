import Stripe from 'stripe';
import { db, getEntity, now, saveEntity, writeAudit } from './database.ts';

export function stripeClient() {
  return process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
}

export async function createCheckout(quote: Record<string, any>, clientId: string) {
  const stripe = stripeClient();
  if (!stripe) return null;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: quote.email,
    line_items: [{ price_data: { currency: 'gbp', product_data: { name: `Aurelius Fire ${quote.packageName ?? 'assessment'}` }, unit_amount: Math.round(Number(quote.total) * 100) }, quantity: 1 }],
    metadata: { quoteId: quote.id, clientId },
    success_url: `${process.env.PUBLIC_APP_URL ?? 'http://localhost:3000'}/portal?payment=pending`,
    cancel_url: `${process.env.PUBLIC_APP_URL ?? 'http://localhost:3000'}/portal?payment=cancelled`,
  });
  saveEntity('payments', { clientId, quoteId: quote.id, stripeSessionId: session.id, amount: quote.total, currency: 'gbp', status: 'pending' }, undefined, 'payment_checkout_created');
  writeAudit({ action: 'payment_checkout_created', entityType: 'payment', entityId: session.id, metadata: { quoteId: quote.id } });
  return session;
}

export function handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
  const stripe = stripeClient();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook configuration is incomplete');
  if (!signature) throw new Error('Missing Stripe signature');
  const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  if (db.query('SELECT event_id FROM webhook_events WHERE provider=? AND event_id=?').get('stripe', event.id)) return event;
  db.query('INSERT INTO webhook_events (provider,event_id,received_at) VALUES (?,?,?)').run('stripe', event.id, now());
  const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent;
  const metadata = object.metadata ?? {};
  const quote = metadata.quoteId ? getEntity('quotes', metadata.quoteId) : null;
  const payment = metadata.quoteId ? db.query("SELECT data FROM entities WHERE type='payments' AND json_extract(data,'$.quoteId')=? ORDER BY updated_at DESC LIMIT 1").get(metadata.quoteId) as { data: string } | null : null;
  const paymentRecord = payment ? JSON.parse(payment.data) : { id: event.id, clientId: metadata.clientId, quoteId: metadata.quoteId, amount: (object as any).amount_total ? (object as any).amount_total / 100 : undefined, currency: 'gbp' };
  const status = event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded' ? 'paid' : event.type.includes('failed') ? 'failed' : event.type === 'charge.refunded' ? 'refunded' : null;
  if (status) saveEntity('payments', { ...paymentRecord, status, stripeEventId: event.id, updatedAt: now() }, undefined, 'payment_webhook');
  if (quote && status) saveEntity('quotes', { ...quote, paymentStatus: status }, undefined, 'payment_status_updated');
  writeAudit({ action: 'stripe_webhook', entityType: 'payment', entityId: event.id, metadata: { type: event.type, status } });
  return event;
}