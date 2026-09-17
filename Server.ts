import express from 'express';
import clientPortal from './ClientPortal.ts';
import clientAccounts from './ClientAccounts.ts';
import crmBackend from './CRMBackend.ts';
import clientJourney from './ClientJourney.ts';
import paymentBooking from './PaymentBooking.ts';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import adminRoutes from './Admin.ts';
import { authRequired, clearSession, createUser, login, removeSession, setSession } from './auth.ts';
import { db, enqueueNotification, getEntity, listEntities, now, saveEntity, writeAudit } from './database.ts';
import { createCheckout, handleStripeWebhook } from './stripe.ts';
import documentsActions from './DocumentsActions.ts';
import onboardingAutomation from './OnboardingAutomation.ts';
import fileUploads from './FileUploads.ts';
import stripeCheckout from './StripeCheckout.ts';
import aiWebsite from './AIWebsite.ts';
import aiControl from './AIControl.ts';
import productionWorkflow from './ProductionWorkflow.ts';

const app = express();
const publicDir = path.join(process.cwd(), 'public');
const uploadDir = path.join(process.cwd(), 'data', 'uploads');
fs.mkdirSync(publicDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
app.disable('x-powered-by');
app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'"); next(); });
const requestCounts = new Map<string, { count: number; resetAt: number }>();
app.use((req, res, next) => { if (!req.path.startsWith('/api/auth') && !req.path.startsWith('/api/public')) return next(); const key = `${req.ip}:${req.path}`; const current = requestCounts.get(key); const timestamp = Date.now(); if (!current || current.resetAt <= timestamp) requestCounts.set(key, { count: 1, resetAt: timestamp + 60_000 }); else { current.count += 1; if (current.count > 60) return res.status(429).json({ error: 'Too many requests. Try again shortly.' }); } next(); });
app.use(cors({ origin: process.env.PUBLIC_APP_URL || true, credentials: true }));
app.use((req, _res, next) => {
  const raw = req.headers.cookie ?? '';
  (req as any).cookies = Object.fromEntries(raw.split(';').filter(Boolean).map((part) => { const [key, ...value] = part.trim().split('='); return [key, decodeURIComponent(value.join('='))]; }));
  next();
});
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  try { handleStripeWebhook(req.body as Buffer, (Array.isArray(req.headers['stripe-signature']) ? req.headers['stripe-signature'][0] : req.headers['stripe-signature'])); res.json({ received: true }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid webhook' }); }
});
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, system: 'Aurelius Fire CRM', storage: 'sqlite' }));
app.post('/api/auth/setup', (req, res) => {
  if ((db.query('SELECT COUNT(*) as count FROM users').get() as any).count > 0) return res.status(409).json({ error: 'Initial setup has already been completed' });
  const { email, password, displayName } = req.body ?? {};
  if (!email || typeof password !== 'string' || password.length < 12 || !displayName) return res.status(400).json({ error: 'Email, displayName, and a password of at least 12 characters are required' });
  res.status(201).json({ user: createUser(email, password, 'super_admin', displayName), message: 'Administrator created. Sign in to continue.' });
});
app.post('/api/auth/login', (req, res) => {
  const result = login(req.body?.email ?? '', req.body?.password ?? '');
  if (!result) return res.status(401).json({ error: 'Invalid email or password' });
  setSession(res, result.token); res.json({ user: result.user });
});

app.get('/api/auth/status', (_req, res) => {
  try {
    const rows = db.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE role IN ('super_admin','assessor','admin') AND status = 'active'"
    ).get() as any;

    res.json({
      setupRequired: Number(rows?.count || 0) === 0
    });
  } catch (error) {
    res.json({ setupRequired: false });
  }
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ user: (req as any).user });
});

app.post('/api/auth/logout', (req, res) => {
  try {
    const token = req.cookies?.session;
    if (token) removeSession(token);
  } catch (_) {}

  clearSession(req);
  res.json({ ok: true });
});

app.post('/api/auth/logout', authRequired, (req, res) => { clearSession(req); writeAudit({ actorId: (req as any).user.id, actorRole: (req as any).user.role, action: 'logout', entityType: 'auth', entityId: (req as any).user.id }); removeSession(res); res.json({ ok: true }); });
app.get('/api/auth/me', authRequired, (req, res) => res.json({ user: (req as any).user }));

app.get('/api/public/content', (_req, res) => {
  const rows = db.query('SELECT key,value_json FROM content WHERE published=1').all() as { key: string; value_json: string }[];
  const content = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json)]));
  content.services = listEntities('services').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  content.faqs = listEntities('faqs').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  res.json({ content });
});
app.get('/api/public/pricing', (_req, res) => {
  const configured = listEntities('pricing', undefined, 'active').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  res.json({ packages: configured.length ? configured : [{ key: 'small', name: 'Small', price: 345, description: '', criteria: '', order: 1 }, { key: 'standard', name: 'Standard', price: 495, description: '', criteria: '', order: 2 }, { key: 'larger', name: 'Larger', price: 695, description: '', criteria: '', order: 3 }, { key: 'complex', name: 'Complex', price: 995, description: '', criteria: '', order: 4 }] });
});
app.get('/api/public/services', (_req, res) => res.json({ services: listEntities('services').sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) }));
app.get('/api/public/faqs', (_req, res) => res.json({ faqs: listEntities('faqs').sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) }));
app.post('/api/public/quotes', (req, res) => {
  const body = req.body ?? {};
  const sleepingAccommodation = body.sleepingAccommodation === true || body.sleepingAccommodation === 'true' || body.sleepingAccommodation === 'yes';
  const required = ['customerName', 'companyName', 'email', 'telephone', 'premisesAddress', 'postcode', 'premisesType', 'floors', 'approximateSize', 'occupancyInformation'];
  if (required.some((field) => body[field] === undefined || body[field] === '')) return res.status(400).json({ error: 'All required premises and contact fields must be completed' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return res.status(400).json({ error: 'A valid email address is required' });
  const packages = listEntities('pricing', undefined, 'active').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const defaultRules: Record<string, { maxFloors: number; maxSize: number }> = { small: { maxFloors: 1, maxSize: 150 }, standard: { maxFloors: 2, maxSize: 300 }, larger: { maxFloors: 4, maxSize: 750 }, complex: { maxFloors: Number.MAX_SAFE_INTEGER, maxSize: Number.MAX_SAFE_INTEGER } };
  const selected = packages.find((item) => { const rule = defaultRules[item.key] ?? { maxFloors: Number.MAX_SAFE_INTEGER, maxSize: Number.MAX_SAFE_INTEGER }; return Number(body.floors) <= Number(item.maxFloors ?? rule.maxFloors) && Number(body.approximateSize) <= Number(item.maxSize ?? rule.maxSize); }) ?? packages.at(-1) ?? { key: 'standard', name: 'Standard', price: 495 };
  const client = saveEntity('clients', { legalName: body.companyName, responsiblePerson: body.customerName, email: body.email, telephone: body.telephone, registeredAddress: { line1: body.premisesAddress, postcode: body.postcode }, source: 'website' });
  const premises = saveEntity('premises', { clientId: client.id, name: `${body.companyName} premises`, address: body.premisesAddress, postcode: body.postcode, premisesType: body.premisesType, floors: Number(body.floors), approximateSize: Number(body.approximateSize), occupancyInformation: body.occupancyInformation, sleepingAccommodation });
  const enquiry = saveEntity('enquiries', { clientId: client.id, premisesId: premises.id, customerName: body.customerName, companyName: body.companyName, email: body.email, telephone: body.telephone, status: 'active', source: 'website', service: 'fire risk assessment', additionalInformation: body.additionalInformation });
  const quote = saveEntity('quotes', { clientId: client.id, premisesId: premises.id, enquiryId: enquiry.id, quoteNumber: `AF-Q-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`, customerName: body.customerName, companyName: body.companyName, email: body.email, premises: { address: body.premisesAddress, postcode: body.postcode, type: body.premisesType, floors: Number(body.floors), approximateSize: Number(body.approximateSize), occupancyInformation: body.occupancyInformation, sleepingAccommodation }, packageKey: selected.key, packageName: selected.name, total: Number(selected.price), status: 'draft', expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(), termsVersion: 'current', publicToken: crypto.randomBytes(32).toString('hex') });
  enqueueNotification('quote_created', body.email, { quoteId: quote.id, quoteNumber: quote.quoteNumber });
  res.status(201).json({ id: quote.id, quoteNumber: quote.quoteNumber, estimatedPrice: quote.total, status: quote.status, quoteToken: quote.publicToken });
});
app.get('/api/public/quotes/:token', (req, res) => {
  const quote = listEntities('quotes', undefined, 'all').find((item) => item.publicToken === req.params.token);
  if (!quote || ['cancelled', 'expired'].includes(quote.status)) return res.status(404).json({ error: 'Quote not found or expired' });
  const viewed = quote.status === 'draft' ? saveEntity('quotes', { ...quote, status: 'viewed', version: (quote.version ?? 1) + 1, viewedAt: now() }, undefined, 'quote_viewed') : quote;
  res.json({ quote: viewed });
});
app.post('/api/public/quotes/:token/:decision', (req, res) => {
  if (!['accept', 'decline'].includes(req.params.decision)) return res.status(404).json({ error: 'Invalid quote decision' });
  const quote = listEntities('quotes', undefined, 'all').find((item) => item.publicToken === req.params.token);
  if (!quote || !['draft', 'viewed', 'sent'].includes(quote.status)) return res.status(409).json({ error: 'Quote is not available for this decision' });
  const status = req.params.decision === 'accept' ? 'accepted' : 'declined';
  const updated = saveEntity('quotes', { ...quote, status, version: (quote.version ?? 1) + 1, decisionAt: now(), decisionIp: req.ip }, undefined, `quote_${status}`);
  enqueueNotification(`quote_${status}`, quote.email, { quoteId: quote.id, quoteNumber: quote.quoteNumber });
  res.json({ quote: updated });
});
app.post('/api/public/enquiries', (req, res) => {
  const { name, email, phone, premises, service, message } = req.body ?? {};
  if (!name || !email || !premises || !service) return res.status(400).json({ error: 'Name, email, premises, and service are required' });
  const enquiry = saveEntity('enquiries', { name, email, phone, premises, service, message, source: 'website' });
  enqueueNotification('new_enquiry', email, { enquiryId: enquiry.id, name, service });
  res.status(201).json({ id: enquiry.id, message: 'Enquiry received. Aurelius Fire will be in touch.' });
});
app.get('/api/public/booking-availability', (req, res) => {
  const from = new Date(); const to = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const slots = listEntities('booking_slots').filter((slot) => {
    const date = new Date(slot.startsAt); return date >= from && date <= to && slot.available === true;
  });
  res.json({ slots, windowDays: 90 });
});

app.use('/api/admin', authRequired, adminRoutes);
app.use('/api/workflow', authRequired, productionWorkflow);
app.use('/api/client-portal', authRequired, clientPortal);
app.use('/api/client-accounts', authRequired, clientAccounts);
app.use('/api/ai', authRequired, aiControl);
const portal = express.Router();
portal.use(authRequired);
portal.use((req, res, next) => ['client_contact'].includes((req as any).user.role) ? next() : res.status(403).json({ error: 'Client portal access required' }));
portal.get('/dashboard', (req, res) => {
  const clientId = (req as any).user.clientId;
  res.json({ client: clientId ? getEntity('clients', clientId, clientId) : null, premises: listEntities('premises', clientId), quotes: listEntities('quotes', clientId), terms: listEntities('terms_signatures', clientId), bookings: listEntities('bookings', clientId), payments: listEntities('payments', clientId), documents: listEntities('documents', clientId), actions: listEntities('actions', clientId), messages: listEntities('messages', clientId) });
});
for (const entity of ['clients', 'premises', 'quotes', 'bookings', 'payments', 'documents', 'actions', 'messages']) portal.get(`/${entity}`, (req, res) => res.json(listEntities(entity, (req as any).user.clientId)));
portal.put('/profile', (req, res) => {
  const user = (req as any).user; const current = getEntity('clients', user.clientId, user.clientId);
  if (!current) return res.status(404).json({ error: 'Client profile not found' });
  res.json(saveEntity('clients', { ...current, ...req.body, id: current.id, clientId: user.clientId }, user, 'client_profile_update'));
});
portal.post('/quotes/:id/accept', (req, res) => {
  const user = (req as any).user; const quote = getEntity('quotes', req.params.id, user.clientId);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  res.json(saveEntity('quotes', { ...quote, status: 'accepted', version: (quote.version ?? 1) + 1, acceptedAt: now(), acceptedBy: user.id }, user, 'quote_acceptance'));
});
portal.post('/quotes/:id/decline', (req, res) => {
  const user = (req as any).user; const quote = getEntity('quotes', req.params.id, user.clientId);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  res.json(saveEntity('quotes', { ...quote, status: 'declined', version: (quote.version ?? 1) + 1, decisionAt: now() }, user, 'quote_declined'));
});
portal.post('/terms/sign', (req, res) => {
  const user = (req as any).user;
  if (!req.body?.termsVersion || !req.body?.signatureName || !req.body?.quoteId) return res.status(400).json({ error: 'quoteId, termsVersion, and signatureName are required' });
  const quote = getEntity('quotes', req.body.quoteId, user.clientId);
  if (!quote || quote.status !== 'accepted') return res.status(409).json({ error: 'Terms can only be signed for an accepted quote' });
  const signature = saveEntity('terms_signatures', { clientId: user.clientId, quoteId: quote.id, termsVersion: req.body.termsVersion, signatureName: req.body.signatureName, signedAt: now(), acceptanceStatus: 'signed', ipAddress: req.ip }, user, 'terms_signature');
  enqueueNotification('terms_completed', user.email, { quoteId: quote.id, termsId: signature.id });
  res.status(201).json(signature);
});
portal.post('/bookings', (req, res) => {
  const user = (req as any).user; const slot = getEntity('booking_slots', req.body?.slotId);
  if (!slot || !slot.available || new Date(slot.startsAt) < new Date() || new Date(slot.startsAt) > new Date(Date.now() + 90 * 86400000)) return res.status(409).json({ error: 'Booking slot is unavailable' });
  const existing = listEntities('bookings', undefined, 'all').find((booking) => booking.slotId === slot.id && !['cancelled', 'no-show'].includes(booking.status));
  if (existing) return res.status(409).json({ error: 'Booking slot is already taken' });
  saveEntity('booking_slots', { ...slot, available: false }, user, 'slot_booked');
  const booking = saveEntity('bookings', { clientId: user.clientId, slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, status: 'requested' }, user, 'booking_created');
  enqueueNotification('booking_created', user.email, { bookingId: booking.id });
  res.status(201).json(booking);
});
portal.post('/payments/checkout', async (req, res) => {
  const user = (req as any).user;
  const quote = getEntity('quotes', req.body?.quoteId, user.clientId);
  if (!quote || quote.status !== 'accepted') return res.status(409).json({ error: 'An accepted quote is required before payment' });
  if (!req.body?.termsId || !getEntity('terms_signatures', req.body.termsId, user.clientId)) return res.status(409).json({ error: 'Completed terms are required before payment' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured. No payment has been taken.', code: 'STRIPE_NOT_CONFIGURED' });
  try { const session = await createCheckout(quote, user.clientId); res.json({ checkoutUrl: session?.url, sessionId: session?.id, status: 'pending' }); }
  catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Stripe checkout could not be created' }); }
});
portal.put('/actions/:id', (req, res) => {
  const user = (req as any).user; const action = getEntity('actions', req.params.id, user.clientId);
  if (!action) return res.status(404).json({ error: 'Action not found' });
  res.json(saveEntity('actions', { ...action, status: req.body.status ?? action.status, version: (action.version ?? 1) + 1, clientUpdate: req.body.clientUpdate ?? action.clientUpdate }, user, 'action_update'));
});
portal.post('/messages', (req, res) => {
  const user = (req as any).user; if (!req.body.message) return res.status(400).json({ error: 'Message is required' });
  const message = saveEntity('messages', { ...req.body, clientId: user.clientId, senderId: user.id, senderRole: user.role }, user, 'message_create');
  enqueueNotification('new_message', user.email, { messageId: message.id });
  res.status(201).json(message);
});
portal.post('/messages/:id/reply', (req, res) => {
  const user = (req as any).user; const original = getEntity('messages', req.params.id, user.clientId);
  if (!original) return res.status(404).json({ error: 'Message not found' });
  if (!req.body?.message) return res.status(400).json({ error: 'Message is required' });
  res.status(201).json(saveEntity('messages', { clientId: user.clientId, subject: req.body.subject ?? `Re: ${original.subject ?? 'Message'}`, message: req.body.message, senderId: user.id, senderRole: user.role, replyTo: original.id, readAt: null }, user, 'message_reply'));
});
portal.post('/messages/:id/read', (req, res) => {
  const user = (req as any).user; const message = getEntity('messages', req.params.id, user.clientId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  res.json(saveEntity('messages', { ...message, readAt: new Date().toISOString(), readBy: user.id }, user, 'message_read'));
});
portal.post('/documents', (req, res) => {
  const user = (req as any).user; const { fileName, mimeType, content, entityId, category } = req.body ?? {};
  if (!fileName || !mimeType || !content || !entityId) return res.status(400).json({ error: 'fileName, mimeType, content, and entityId are required' });
  const allowedTypes: Record<string, string[]> = { 'application/pdf': ['.pdf'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'], 'text/plain': ['.txt'] };
  if (!allowedTypes[mimeType] || !allowedTypes[mimeType].some((extension) => fileName.toLowerCase().endsWith(extension))) return res.status(400).json({ error: 'Unsupported document type' });
  const buffer = Buffer.from(content, 'base64'); if (buffer.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'File exceeds 20MB limit' });
  const storageName = `${crypto.randomUUID()}-${path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  fs.writeFileSync(path.join(uploadDir, storageName), buffer);
  res.status(201).json(saveEntity('documents', { clientId: user.clientId, entityId, fileName, mimeType, sizeBytes: buffer.length, storageName, category: category ?? 'other', portalVisible: false, uploadedBy: user.id }, user, 'document_upload'));
});
portal.get('/documents/:id/download', (req, res) => {
  const user = (req as any).user; const document = getEntity('documents', req.params.id, user.clientId);
  if (!document || (!document.portalVisible && document.uploadedBy !== user.id)) return res.status(404).json({ error: 'Document not available' });
  writeAudit({ actorId: user.id, actorRole: user.role, action: 'document_download', entityType: 'document', entityId: document.id });
  res.download(path.join(uploadDir, document.storageName), document.fileName);
});
app.use('/api/portal', portal);
app.use('/api/admin/crm', crmBackend);
app.use('/api/website-studio', aiWebsite);
app.use('/api/client-journey', clientJourney);
app.use('/api/payment-booking', paymentBooking);
app.use('/api/documents-actions', documentsActions);
app.use('/api/file-uploads', fileUploads);
app.use('/api/stripe-checkout', stripeCheckout);
app.use('/api/onboarding-automation', onboardingAutomation);

app.get('/', (_req, res) => {
  let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  html = html.replaceAll('onclick="openBooking()"', 'onclick="location.href=\'/booking.html\'"').replaceAll('href="#terms"', 'href="/terms.html"').replaceAll('href="#privacy"', 'href="/privacy.html"').replaceAll('href="#cookies"', 'href="/cookies.html"').replaceAll('href="#about"', 'href="/about.html"');
  res.type('html').send(html);
});
app.get('/assessor', (_req, res) => {
  res.sendFile(path.join(publicDir, 'assessor.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});
app.get('/portal', (_req, res) => {
  const portalHtml = fs.readFileSync(path.join(publicDir, 'portal.html'), 'utf8');
  const controls = `<script>(function(){const wait=setInterval(async()=>{const dash=document.querySelector('#dashboard');if(!dash||dash.classList.contains('hidden'))return;clearInterval(wait);try{const [docs,msgs]=await Promise.all([fetch('/api/portal/documents',{credentials:'include'}).then(r=>r.json()),fetch('/api/portal/messages',{credentials:'include'}).then(r=>r.json())]);const panel=document.createElement('section');panel.className='grid';panel.style.marginTop='18px';panel.innerHTML='<article class="card"><h2>Secure documents</h2>'+((docs||[]).length?(docs||[]).map(d=>'<p><strong>'+String(d.fileName||'Document').replace(/[<>]/g,'')+'</strong><br><button class="btn" data-download="'+d.id+'">Download</button></p>').join(''):'<div class="empty">No documents available.</div>')+'</article><article class="card"><h2>Messages and replies</h2>'+((msgs||[]).length?(msgs||[]).map(m=>'<p><strong>'+String(m.subject||'Message').replace(/[<>]/g,'')+'</strong><br>'+String(m.message||'').replace(/[<>]/g,'')+'<br><button class="btn secondary" data-reply="'+m.id+'">Reply</button></p>').join(''):'<div class="empty">No messages.</div>')+'</article>';dash.appendChild(panel);panel.querySelectorAll('[data-download]').forEach(b=>b.onclick=async()=>{const r=await fetch('/api/portal/documents/'+b.dataset.download+'/download',{credentials:'include'});if(!r.ok)return alert('Document is not available.');const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='document';a.click();URL.revokeObjectURL(a.href)});panel.querySelectorAll('[data-reply]').forEach(b=>b.onclick=()=>{const text=prompt('Reply to this message');if(text)fetch('/api/portal/messages/'+b.dataset.reply+'/reply',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text})}).then(r=>{if(!r.ok)throw Error();alert('Reply sent.');location.reload()}).catch(()=>alert('Reply could not be sent.'))})}catch(e){console.error(e)}},250)})();</script>`;
  res.type('html').send(portalHtml.replace('</body>', controls + '</body>'));
});
app.get('/media/*', (_req, res) => res.status(404).json({ error: 'Media not found' }));
app.use(express.static(publicDir));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || /\.(ts|tsx|json|env|db|sqlite|map)$/.test(req.path) || /^\/(data|server|middleware|node_modules)\b/.test(req.path)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(publicDir, 'index.html'));
});

function migrateLegacyClients() {
  const count = (db.query('SELECT COUNT(*) as count FROM entities WHERE type=?').get('clients') as any).count;
  const legacyPath = path.join(process.cwd(), 'data', 'clients.json');
  if (count === 0 && fs.existsSync(legacyPath)) for (const record of JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as any[]) saveEntity('clients', { ...record, legalName: record.legalName ?? record.companyName, clientId: record.id });
  for (const row of db.query('SELECT id,data FROM entities WHERE type=? AND client_id IS NULL').all('clients') as { id: string; data: string }[]) saveEntity('clients', { ...JSON.parse(row.data), id: row.id, clientId: row.id }, undefined, 'ownership_repair');
}
migrateLegacyClients();
function ensureConfiguredRecords() {
  const pricing = [{ key: 'small', name: 'Small', price: 345, description: 'Suitable smaller premises assessment.', criteria: '', order: 1 }, { key: 'standard', name: 'Standard', price: 495, description: 'Standard commercial premises assessment.', criteria: '', order: 2 }, { key: 'larger', name: 'Larger', price: 695, description: 'Assessment for larger premises.', criteria: '', order: 3 }, { key: 'complex', name: 'Complex', price: 995, description: 'Assessment for complex premises.', criteria: '', order: 4 }];
  if (!listEntities('pricing', undefined, 'all').length) for (const packageRecord of pricing) saveEntity('pricing', packageRecord, undefined, 'configuration_seed');
  const services = [{ name: 'Fire risk assessments', description: 'Structured assessments aligned with RRFSO Article 9 and PAS 79 principles.', order: 1 }, { name: 'Practical compliance support', description: 'Clear priorities, evidence-led findings, and actions your team can understand.', order: 2 }, { name: 'Follow-up support', description: 'Document exchange, review support, and secure client portal access.', order: 3 }];
  if (!listEntities('services', undefined, 'all').length) for (const service of services) saveEntity('services', service, undefined, 'configuration_seed');
  const policies = { terms: 'Engagement terms will be confirmed before work begins.', privacy: 'Aurelius Fire uses submitted information to respond to enquiries and deliver services.', cookies: 'This website uses only the cookies required for secure sessions and essential operation.' };
  for (const [key, value] of Object.entries(policies)) if (!db.query('SELECT key FROM content WHERE key=?').get(key)) db.query('INSERT INTO content (key,value_json,published,updated_at) VALUES (?,?,1,?)').run(key, JSON.stringify(value), now());
}
ensureConfiguredRecords();

app.get('/client', (_req, res) => {
  res.sendFile(process.cwd() + '/public/client.html');
});


app.get('/booking-manager', (_req, res) => {
  res.sendFile(process.cwd() + '/public/booking-manager.html');
});


app.get('/documents-manager', (_req, res) => {
  res.sendFile(process.cwd() + '/public/documents-manager.html');
});


app.get('/onboarding-manager', (_req, res) => {
  res.sendFile(process.cwd() + '/public/onboarding-manager.html');
});


app.get('/workflow-manager', (_req, res) => {
  res.sendFile(process.cwd() + '/public/workflow-manager.html');
});


app.get('/privacy', (_req, res) => {
  res.sendFile(process.cwd() + '/public/privacy.html');
});

app.get('/terms', (_req, res) => {
  res.sendFile(process.cwd() + '/public/terms.html');
});

app.get('/cookies', (_req, res) => {
  res.sendFile(process.cwd() + '/public/cookies.html');
});

app.get('/contact', (_req, res) => {
  res.sendFile(process.cwd() + '/public/contact.html');
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Aurelius Fire',
    timestamp: new Date().toISOString()
  });
});

app.get('/website-studio', (_req, res) => {
  res.sendFile(process.cwd() + '/public/website-studio.html');
});

app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log(`Aurelius Fire running on http://localhost:${Number(process.env.PORT) || 3000}`));
export default app;
