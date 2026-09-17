import express from 'express';
import Stripe from 'stripe';
import { db, now, saveEntity, writeAudit } from './database.ts';
const router = express.Router();
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET;
  if (!key) return null;
  return new Stripe(key);
}
function ensureStripeTables(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_checkouts (id TEXT PRIMARY KEY, quote_id TEXT, client_id TEXT, stripe_session_id TEXT, stripe_payment_intent TEXT, amount INTEGER, currency TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, stripe_event_id TEXT UNIQUE, type TEXT, received_at TEXT);
    CREATE TABLE IF NOT EXISTS webhook_events (provider TEXT NOT NULL, event_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(provider, event_id));
  `);
}
ensureStripeTables();
export async function createCheckout(quote: Record<string,any>, clientId: string){
  const stripe=getStripe();
  if(!stripe) throw new Error('STRIPE_NOT_CONFIGURED');
  const session=await stripe.checkout.sessions.create({
    mode:'payment',
    line_items:[{price_data:{currency:'gbp', product_data:{name: quote.packageName || 'Fire Risk Assessment'}, unit_amount: Math.round(Number(quote.total)*100)}, quantity:1}],
    success_url: `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/portal?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.PUBLIC_APP_URL || 'http://localhost:3000'}/portal?payment=cancelled`,
    metadata:{quoteId: quote.id, clientId}
  });
  saveEntity('payments', {clientId, quoteId: quote.id, stripeSessionId: session.id, amount: quote.total, currency:'gbp', status:'pending'}, undefined, 'payment_checkout_created');
  db.prepare(`INSERT INTO stripe_checkouts (id, quote_id, client_id, stripe_session_id, amount, currency, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`).run(session.id, quote.id, clientId, session.id, Math.round(Number(quote.total)*100), 'gbp', 'pending', now(), now());
  return session;
}
export function handleStripeWebhook(rawBody: Buffer, signature: string | undefined){
  const stripe=getStripe();
  if(!stripe ||!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook configuration is incomplete');
  if(!signature) throw new Error('Missing Stripe signature');
  const event=stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  if(db.prepare('SELECT event_id FROM webhook_events WHERE provider=? AND event_id=?').get('stripe', event.id)) return event;
  db.prepare('INSERT INTO webhook_events (provider,event_id,received_at) VALUES (?,?,?)').run('stripe', event.id, now());
  try{ db.prepare('INSERT INTO stripe_events (id, stripe_event_id, type, received_at) VALUES (?,?,?,?)').run(event.id, event.id, event.type, now()); }catch{}
  const obj=event.data.object as any;
  const sessionId=obj.id;
  const status=event.type==='checkout.session.completed' || event.type==='payment_intent.succeeded'? 'paid' : event.type.includes('failed')? 'failed' : null;
  if(status){
    try{
      const row=db.prepare('SELECT data FROM entities WHERE type=? AND id IN (SELECT quote_id FROM stripe_checkouts WHERE stripe_session_id=?)').get('quotes', sessionId) as any;
      if(row){ const q=JSON.parse(row.data); saveEntity('payments', {...q, status, stripeEventId: event.id}, undefined, 'payment_webhook'); }
    }catch{}
    writeAudit({action:'stripe_webhook', entityType:'payment', entityId:event.id, metadata:{type:event.type, status}});
  }
  return event;
}
router.post('/create', async (req,res)=>{
  const stripe=getStripe();
  if(!stripe) return res.status(503).json({error:'Stripe is not configured', code:'STRIPE_NOT_CONFIGURED'});
  const {quoteId}=req.body||{};
  if(!quoteId) return res.status(400).json({error:'quoteId required'});
  const row=db.prepare('SELECT data FROM entities WHERE type=? AND id=?').get('quotes', quoteId) as any;
  if(!row) return res.status(404).json({error:'Quote not found'});
  const quote=JSON.parse(row.data);
  const session=await createCheckout(quote, quote.clientId);
  res.json({checkoutUrl: session.url, sessionId: session.id});
});
router.post('/webhook', express.raw({type:'application/json'}), async (req,res)=>{
  const stripe=getStripe();
  if(!stripe) return res.status(503).send('Stripe not configured');
  const sig=req.headers['stripe-signature'];
  const signature=Array.isArray(sig)? sig[0] : sig as string;
  if(!signature) return res.status(400).send('Missing Stripe signature');
  try{ handleStripeWebhook(req.body as Buffer, signature); res.json({received:true}); }
  catch(e:any){ res.status(400).send(`Webhook Error: ${e.message}`); }
});
export default router;
