import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { db } from './database.ts';

const router = Router();

const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'documents');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `${randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not permitted'));
    }
  }
});

function ensureDocumentsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_documents (
      id TEXT PRIMARY KEY,
      document_id TEXT,
      client_id TEXT,
      premises_id TEXT,
      assessment_id TEXT,
      document_type TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Draft',
      released_to_client INTEGER NOT NULL DEFAULT 0,
      uploaded_at TEXT NOT NULL,
      released_at TEXT,
      notes TEXT
    )
  `);
}

ensureDocumentsTable();

router.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO file_documents (
        id,
        document_id,
        client_id,
        premises_id,
        assessment_id,
        document_type,
        original_name,
        stored_name,
        mime_type,
        file_size,
        status,
        released_to_client,
        uploaded_at,
        notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', 0, ?, ?)
    `).run(
      id,
      req.body.documentId || null,
      req.body.clientId || null,
      req.body.premisesId || null,
      req.body.assessmentId || null,
      req.body.documentType || 'Other',
      req.file.originalname,
      req.file.filename,
      req.file.mimetype,
      req.file.size,
      now,
      req.body.notes || ''
    );

    res.json({
      ok: true,
      id,
      filename: req.file.originalname,
      size: req.file.size
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

router.get('/', (req, res) => {
  const clientId = req.query.clientId as string | undefined;
  const releasedOnly = req.query.releasedOnly === 'true';

  let sql = `
    SELECT *
    FROM file_documents
  `;

  const params: any[] = [];
  const conditions: string[] = [];

  if (clientId) {
    conditions.push('client_id = ?');
    params.push(clientId);
  }

  if (releasedOnly) {
    conditions.push("released_to_client = 1");
  }

  if (conditions.length) {
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }

  sql += ' ORDER BY uploaded_at DESC';

  res.json(db.prepare(sql).all(...params));
});

router.get('/:id/download', (req, res) => {
  const row: any = db.prepare(`
    SELECT *
    FROM file_documents
    WHERE id = ?
  `).get(req.params.id);

  if (!row) {
    return res.status(404).json({ error: 'Document not found' });
  }

  if (row.released_to_client !== 1 && req.query.admin !== 'true') {
    return res.status(403).json({ error: 'Document not released' });
  }

  const filePath = path.join(uploadDir, row.stored_name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File missing from storage' });
  }

  res.download(filePath, row.original_name);
});

router.post('/:id/release', (req, res) => {
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE file_documents
    SET
      status = 'Released',
      released_to_client = 1,
      released_at = ?
    WHERE id = ?
  `).run(now, req.params.id);

  if (!result.changes) {
    return res.status(404).json({ error: 'Document not found' });
  }

  res.json({ ok: true });
});

router.post('/:id/unrelease', (req, res) => {
  const result = db.prepare(`
    UPDATE file_documents
    SET
      status = 'Draft',
      released_to_client = 0,
      released_at = NULL
    WHERE id = ?
  `).run(req.params.id);

  if (!result.changes) {
    return res.status(404).json({ error: 'Document not found' });
  }

  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const row: any = db.prepare(`
    SELECT *
    FROM file_documents
    WHERE id = ?
  `).get(req.params.id);

  if (!row) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const filePath = path.join(uploadDir, row.stored_name);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}

  db.prepare(`
    DELETE FROM file_documents
    WHERE id = ?
  `).run(req.params.id);

  res.json({ ok: true });
});

router.get('/summary', (_req, res) => {
  const total: any = db.prepare(`
    SELECT COUNT(*) AS count
    FROM file_documents
  `).get();

  const released: any = db.prepare(`
    SELECT COUNT(*) AS count
    FROM file_documents
    WHERE released_to_client = 1
  `).get();

  const drafts: any = db.prepare(`
    SELECT COUNT(*) AS count
    FROM file_documents
    WHERE released_to_client = 0
  `).get();

  res.json({
    total: total?.count || 0,
    released: released?.count || 0,
    drafts: drafts?.count || 0
  });
});

export default router;
