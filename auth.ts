import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, id, now, writeAudit } from './database.ts';

export type User = { id: string; email: string; role: string; displayName: string; clientId: string | null };
const sessionCookie = 'aurelius_session';

export const ADMIN_ROLES = [
  'super_admin',
  'admin',
  'owner',
  'assessor'
];

export const CLIENT_ROLES = [
  'client'
];

export function isAdminRole(role: string | undefined) {
  return !!role && ADMIN_ROLES.includes(role);
}

export function isClientRole(role: string | undefined) {
  return !!role && CLIENT_ROLES.includes(role);
}

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const passwordHash = (value: string, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(value, salt, 64).toString('hex')}`;
const passwordMatches = (value: string, stored: string) => { const [salt, digest] = stored.split(':'); return !!salt && !!digest && crypto.timingSafeEqual(Buffer.from(digest, 'hex'), crypto.scryptSync(value, salt, 64)); };

export function createUser(email: string, password: string, role: string, displayName: string, clientId: string | null = null) {
  const user = { id: id(), email: email.toLowerCase().trim(), displayName, clientId, password_hash: passwordHash(password), created_at: now(), updated_at: now() };
  db.query('INSERT INTO users (id,email,password_hash,role,display_name,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(user.id, user.email, user.password_hash, role, displayName, clientId, user.created_at, user.updated_at);
  writeAudit({ actorId: user.id, actorRole: role, action: 'user_create', entityType: 'user', entityId: user.id, after: { id: user.id, email: user.email, role, displayName, clientId } });
  return { id: user.id, email: user.email, role, displayName, clientId };
}

export function login(email: string, password: string) {
  const row = db.query('SELECT * FROM users WHERE email=? AND active=1').get(email.toLowerCase().trim()) as any;
  if (!row || !passwordMatches(password, row.password_hash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  db.query('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').run(id(), row.id, hash(token), new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString(), now());
  const user = { id: row.id, email: row.email, role: row.role, displayName: row.display_name, clientId: row.client_id };
  writeAudit({ actorId: row.id, actorRole: row.role, action: 'login', entityType: 'auth', entityId: row.id });
  return { token, user };
}

export function clearSession(req: Request) { const token = req.cookies?.[sessionCookie]; if (token) db.query('DELETE FROM sessions WHERE token_hash=?').run(hash(token)); }
export function authRequired(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[sessionCookie];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const row = db.query('SELECT u.id,u.email,u.role,u.display_name as displayName,u.client_id as clientId FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(hash(token), now()) as User | null;
  if (!row) return res.status(401).json({ error: 'Session expired' });
  (req as any).user = row; next();
}
export function requireRoles(...roles: string[]) { return (req: Request, res: Response, next: NextFunction) => roles.includes((req as any).user?.role) ? next() : res.status(403).json({ error: 'Insufficient permission' }); }
export const setSession = (res: Response, token: string) => res.cookie(sessionCookie, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 12 });
export const removeSession = (res: Response) => res.clearCookie(sessionCookie);