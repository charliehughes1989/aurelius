import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, enqueueNotification, getEntity, listEntities, saveEntity, writeAudit } from './database.ts';
import { createUser, requireRoles } from './auth.ts';

const router = Router();
const entityNames = ['clients', 'premises', 'enquiries', 'quotes', 'quotations', 'bookings', 'booking_slots', 'payments', 'documents', 'actions', 'messages', 'jobs', 'sections', 'questions', 'users', 'pricing', 'services', 'faqs', 'terms_signatures'];
router.use(requireRoles('super_admin', 'admin', 'assessor'));

router.get('/quotes', (req, res) => {
  const status = String(req.query.status ?? 'all'); const search = String(req.query.search ?? '').toLowerCase();
  const quotes = listEntities('quotes', undefined, status).filter((quote) => !search || JSON.stringify(quote).toLowerCase().includes(search));
  res.json(quotes);
});

router.post('/quotes/:id/send', requireRoles('super_admin', 'admin'), (req, res) => {
  const quote = getEntity('quotes', String(req.params.id)); if (!quote) return res.status(404).json({ error: 'Quote not found' });
  const updated = saveEntity('quotes', { ...quote, status: 'sent', sentAt: new Date().toISOString(), version: (quote.version ?? 1) + 1 }, (req as any).user, 'quote_sent');
  enqueueNotification('quote_sent', quote.email, { quoteId: quote.id, quoteNumber: quote.quoteNumber });
  res.json(updated);
});
router.post('/quotes/:id/cancel', requireRoles('super_admin', 'admin'), (req, res) => {
  const quote = getEntity('quotes', String(req.params.id)); if (!quote) return res.status(404).json({ error: 'Quote not found' });
  res.json(saveEntity('quotes', { ...quote, status: 'cancelled', cancelledAt: new Date().toISOString(), version: (quote.version ?? 1) + 1 }, (req as any).user, 'quote_cancelled'));
});

router.post('/bookings/:id/cancel', requireRoles('super_admin', 'admin'), (req, res) => {
  const booking = getEntity('bookings', String(req.params.id)); if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const slot = getEntity('booking_slots', booking.slotId); if (slot) saveEntity('booking_slots', { ...slot, available: true }, (req as any).user, 'slot_released');
  res.json(saveEntity('bookings', { ...booking, status: 'cancelled', cancelledAt: new Date().toISOString() }, (req as any).user, 'booking_cancelled'));
});

router.post('/bookings/:id/reschedule', requireRoles('super_admin', 'admin'), (req, res) => {
  const booking = getEntity('bookings', String(req.params.id)); if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const nextSlot = getEntity('booking_slots', req.body?.slotId); if (!nextSlot || !nextSlot.available) return res.status(409).json({ error: 'New slot is unavailable' });
  const conflict = listEntities('bookings', undefined, 'all').find((item) => item.id !== booking.id && item.slotId === nextSlot.id && !['cancelled', 'no-show'].includes(item.status));
  if (conflict) return res.status(409).json({ error: 'New slot is already booked' });
  const oldSlot = getEntity('booking_slots', booking.slotId);
  const actor = (req as any).user;
  const transaction = db.transaction(() => {
    if (oldSlot) saveEntity('booking_slots', { ...oldSlot, available: true }, actor, 'slot_released_for_reschedule');
    saveEntity('booking_slots', { ...nextSlot, available: false }, actor, 'slot_claimed_for_reschedule');
    return saveEntity('bookings', { ...booking, slotId: nextSlot.id, startsAt: nextSlot.startsAt, endsAt: nextSlot.endsAt, status: 'rescheduled', version: (booking.version ?? 1) + 1, rescheduledAt: new Date().toISOString() }, actor, 'booking_rescheduled');
  });
  res.json(transaction());
});

router.post('/messages/:id/read', requireRoles('super_admin', 'admin', 'assessor'), (req, res) => {
  const message = getEntity('messages', String(req.params.id)); if (!message) return res.status(404).json({ error: 'Message not found' });
  res.json(saveEntity('messages', { ...message, readAt: new Date().toISOString(), readBy: (req as any).user.id }, (req as any).user, 'message_read'));
});

router.post('/documents/upload', requireRoles('super_admin', 'admin', 'assessor'), (req, res) => {
  const { fileName, mimeType, content, clientId, entityId, category, portalVisible } = req.body ?? {};
  if (!fileName || !mimeType || !content || !clientId || !entityId) return res.status(400).json({ error: 'fileName, mimeType, content, clientId, and entityId are required' });
  const buffer = Buffer.from(content, 'base64');
  const allowedTypes: Record<string, string[]> = { 'application/pdf': ['.pdf'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'], 'text/plain': ['.txt'] };
  if (!allowedTypes[mimeType] || !allowedTypes[mimeType].some((extension) => fileName.toLowerCase().endsWith(extension))) return res.status(400).json({ error: 'Unsupported document type' });
  if (buffer.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'File exceeds 20MB limit' });
  const uploadDir = path.join(process.cwd(), 'data', 'uploads'); fs.mkdirSync(uploadDir, { recursive: true });
  const storageName = `${crypto.randomUUID()}-${path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  fs.writeFileSync(path.join(uploadDir, storageName), buffer);
  res.status(201).json(saveEntity('documents', { clientId, entityId, fileName, mimeType, sizeBytes: buffer.length, storageName, category: category ?? 'other', portalVisible: portalVisible !== false, uploadedBy: (req as any).user.id }, (req as any).user, 'document_upload'));
});
router.get('/documents/:id/download', (req, res) => {
  const document = getEntity('documents', String(req.params.id));
  if (!document) return res.status(404).json({ error: 'Document not found' });
  writeAudit({ actorId: (req as any).user.id, actorRole: (req as any).user.role, action: 'document_download', entityType: 'document', entityId: document.id });
  res.download(path.join(process.cwd(), 'data', 'uploads', document.storageName), document.fileName);
});

router.post('/booking_slots', requireRoles('super_admin', 'admin'), (req, res) => {
  const { startsAt, endsAt } = req.body ?? {};
  if (!startsAt || !endsAt) return res.status(400).json({ error: 'startsAt and endsAt are required' });
  const start = new Date(startsAt); const end = new Date(endsAt); const max = new Date(Date.now() + 90 * 86400000);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start >= end || start < new Date() || start > max) return res.status(400).json({ error: 'Slot must be a valid future time within 90 days' });
  const weekday = start.getDay(); if (![0, 5, 6].includes(weekday)) return res.status(400).json({ error: 'Availability is limited to Friday evening, Saturday, and Sunday' });
  if (listEntities('booking_slots', undefined, 'all').some((slot) => slot.available && new Date(slot.startsAt) < end && new Date(slot.endsAt) > start)) return res.status(409).json({ error: 'Slot overlaps existing availability' });
  res.status(201).json(saveEntity('booking_slots', { startsAt, endsAt, available: true }, (req as any).user, 'availability_created'));
});

router.post('/users', requireRoles('super_admin', 'admin'), (req, res) => {
  const { email, password, role, displayName, clientId } = req.body ?? {};
  if (!email || !password || !role || !displayName) return res.status(400).json({ error: 'email, password, role, and displayName are required' });
  if (db.query('SELECT id FROM users WHERE email=?').get(String(email).toLowerCase().trim())) return res.status(409).json({ error: 'A user with this email already exists' });
  if (!['super_admin', 'admin', 'assessor', 'qa_reviewer', 'client_contact'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (role === 'client_contact' && !clientId) return res.status(400).json({ error: 'Client users require clientId' });
  res.status(201).json(createUser(email, password, role, displayName, clientId ?? null));
});

router.get('/content', requireRoles('super_admin', 'admin'), (_req, res) => {
  const rows = db.query('SELECT key,value_json,published,updated_at,updated_by FROM content ORDER BY key').all() as any[];
  res.json(Object.fromEntries(rows.map((row) => [row.key, { value: JSON.parse(row.value_json), published: !!row.published, updatedAt: row.updated_at, updatedBy: row.updated_by }])));
});

router.put('/content', requireRoles('super_admin', 'admin'), (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Content must be an object' });
  const user = (req as any).user;
  const timestamp = new Date().toISOString();
  if (req.body.aboutBiography && !req.body.about) req.body.about = req.body.aboutBiography;
  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(req.body)) db.query('INSERT INTO content (key,value_json,published,updated_at,updated_by) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,published=excluded.published,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run(key, JSON.stringify(value), 1, timestamp, user.id);
  });
  transaction();
  writeAudit({ actorId: user.id, actorRole: user.role, action: 'content_update', entityType: 'content', metadata: { keys: Object.keys(req.body) } });
  res.json({ ok: true });
});

router.post('/content/profile-photo', requireRoles('super_admin', 'admin'), (req, res) => {
  const { mimeType, content } = req.body ?? {};
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType) || typeof content !== 'string') return res.status(400).json({ error: 'A JPEG, PNG, or WebP image is required' });
  const buffer = Buffer.from(content, 'base64');
  if (buffer.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Profile photo exceeds 5MB' });
  const extension = mimeType.split('/')[1].replace('jpeg', 'jpg');
  const fileName = `profile-photo.${extension}`;
  fs.mkdirSync(path.join(process.cwd(), 'public', 'media'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'public', 'media', fileName), buffer);
  db.query('INSERT INTO content (key,value_json,published,updated_at,updated_by) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run('profilePhoto', JSON.stringify(`/media/${fileName}`), 1, new Date().toISOString(), (req as any).user.id);
  writeAudit({ actorId: (req as any).user.id, actorRole: (req as any).user.role, action: 'content_photo_upload', entityType: 'content', metadata: { fileName } });
  res.status(201).json({ url: `/media/${fileName}` });
});

router.delete('/content/profile-photo', requireRoles('super_admin', 'admin'), (_req, res) => {
  for (const extension of ['jpg', 'png', 'webp']) { const file = path.join(process.cwd(), 'public', 'media', `profile-photo.${extension}`); if (fs.existsSync(file)) fs.rmSync(file); }
  db.query('DELETE FROM content WHERE key=?').run('profilePhoto');
  res.json({ ok: true });
});

for (const name of entityNames) {
  const type = name === 'quotations' ? 'quotes' : name;
  router.get(`/${name}`, (req, res) => res.json(listEntities(type, undefined, String(req.query.status ?? 'active'))));
  router.post(`/${name}`, (req, res) => {
    if ((req as any).user.role === 'assessor' && !['jobs', 'documents', 'actions', 'messages'].includes(name)) return res.status(403).json({ error: 'Assessors cannot create this record' });
    res.status(201).json(saveEntity(type, { ...req.body, createdBy: (req as any).user.id }, (req as any).user, 'create'));
  });
  router.put(`/${name}/:id`, (req, res) => {
    const current = getEntity(type, String(req.params.id));
    if (!current) return res.status(404).json({ error: 'Record not found' });
    if ((req as any).user.role === 'assessor' && current.assessorId && current.assessorId !== (req as any).user.id) return res.status(403).json({ error: 'Record is assigned to another assessor' });
    res.json(saveEntity(type, { ...current, ...req.body, id: current.id, version: (current.version ?? 1) + 1 }, (req as any).user, 'update'));
  });
  router.post(`/${name}/:id/archive`, (req, res) => {
    const current = getEntity(type, String(req.params.id)); if (!current) return res.status(404).json({ error: 'Record not found' });
    res.json(saveEntity(type, { ...current, status: 'archived', archivedAt: new Date().toISOString() }, (req as any).user, 'archive'));
  });
  router.post(`/${name}/:id/restore`, (req, res) => {
    const current = getEntity(type, String(req.params.id)); if (!current) return res.status(404).json({ error: 'Record not found' });
    res.json(saveEntity(type, { ...current, status: 'active', archivedAt: null }, (req as any).user, 'restore'));
  });
  router.delete(`/${name}/:id`, requireRoles('super_admin', 'admin'), (req, res) => {
    if (req.query.confirm !== 'PERMANENTLY_DELETE') return res.status(400).json({ error: 'Explicit confirmation required' });
    const current = getEntity(type, String(req.params.id)); if (!current) return res.status(404).json({ error: 'Record not found' });
    db.query('DELETE FROM entities WHERE type=? AND id=?').run(type, String(req.params.id));
    writeAudit({ actorId: (req as any).user.id, actorRole: (req as any).user.role, action: 'permanent_delete', entityType: type, entityId: String(req.params.id), before: current });
    res.json({ ok: true });
  });
}

router.get('/audit-log', requireRoles('super_admin', 'admin'), (_req, res) => {
  const rows = db.query('SELECT * FROM audits ORDER BY timestamp DESC LIMIT 500').all() as any[];
  res.json(rows.map((row) => ({ ...row, before: row.before_json ? JSON.parse(row.before_json) : null, after: row.after_json ? JSON.parse(row.after_json) : null, metadata: JSON.parse(row.metadata_json) })));
});

router.get('/dashboard', (_req, res) => {
  const count = (type: string, status = 'active') => (db.query('SELECT COUNT(*) as count FROM entities WHERE type=? AND status=?').get(type, status) as any).count;
  const upcoming = db.query("SELECT COUNT(*) as count FROM entities WHERE type='bookings' AND status IN ('requested','confirmed')").get() as any;
  res.json({ counts: Object.fromEntries(entityNames.map((name) => { const type = name === 'quotations' ? 'quotes' : name; return [name, count(type)]; })), openEnquiries: count('enquiries'), outstandingQuotes: count('quotes', 'sent') + count('quotes', 'viewed'), acceptedQuotes: count('quotes', 'accepted'), upcomingBookings: upcoming.count, outstandingActions: count('actions', 'open') + count('actions', 'in_progress'), unreadMessages: (db.query("SELECT COUNT(*) as count FROM entities WHERE type='messages' AND status='active' AND json_extract(data,'$.readAt') IS NULL").get() as any).count, documentsAwaitingUpload: 0 });
});

export default router;
