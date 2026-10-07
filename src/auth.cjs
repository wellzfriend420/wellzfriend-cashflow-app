'use strict';
const { randomBytes, createHash, scrypt, timingSafeEqual, randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('パスワードは12〜256文字で設定してください');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:32768:${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [, cost, salt, hash] = String(stored).split(':');
  if (!salt || !hash || cost !== '32768' || typeof password !== 'string' || password.length > 256) return false;
  const computed = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return same(computed.toString('hex'), hash);
}
async function createAdmin(store, username, password) {
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) throw new Error('ユーザー名は英数字など3〜40文字で設定してください');
  const hash = await passwordHash(password);
  return store.transaction(() => {
    if (store.db.prepare('SELECT count(*) n FROM users').get().n) throw new Error('管理者は登録済みです');
    const id = randomUUID();
    store.db.prepare("INSERT INTO users(id,username,passwordHash,role,createdAt) VALUES(?,?,?,'admin',?)").run(id, username, hash, new Date().toISOString());
    store.audit('operator', 'createAdmin', id);
    return id;
  });
}
async function createAuth(store, { secure = true, now = Date.now } = {}) {
  const fakeHash = await passwordHash(randomBytes(32).toString('hex'));
  const cookieName = secure ? '__Host-cashflow_session' : 'cashflow_local_session';
  let inFlight = 0;
  const cookie = (token, age = 28800) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  function limited(bucket, limit) {
    const time = now();
    return store.transaction(() => {
      store.db.prepare('DELETE FROM login_attempts WHERE windowStart<?').run(time - 900000);
      const row = store.db.prepare('SELECT * FROM login_attempts WHERE bucket=?').get(bucket);
      if (row && row.attempts >= limit) return true;
      store.db.prepare('INSERT INTO login_attempts(bucket,attempts,windowStart) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1').run(bucket, time);
      return false;
    });
  }
  function session(req, { touch = true } = {}) {
    const value = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
    const tokenHash = digest(value);
    const row = store.db.prepare('SELECT s.*,u.username,u.role FROM sessions s JOIN users u ON u.id=s.userId WHERE tokenHash=?').get(tokenHash);
    const time = now();
    if (!row || row.expiresAt <= time || row.lastSeen < time - 3600000) {
      if (row) store.db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(tokenHash);
      return null;
    }
    if (touch && row.lastSeen < time - 60000) store.db.prepare('UPDATE sessions SET lastSeen=? WHERE tokenHash=?').run(time, tokenHash);
    return row;
  }
  return {
    cookieName, cookie, session, csrf: (req, s) => same(req.headers['x-csrf-token'], s.csrf),
    async login(username, password, address) {
      const bucket = 'ip:' + digest(address || 'unknown');
      if (inFlight >= 2 || limited(bucket, 10) || limited('global', 30)) return { status: 429, error: 'ログイン試行が多いため、15分後にお試しください' };
      inFlight++;
      try {
        const row = typeof username === 'string' && username.length <= 40 ? store.db.prepare('SELECT * FROM users WHERE username=?').get(username) : null;
        const ok = await verifyPassword(password, row?.passwordHash || fakeHash);
        if (!ok || !row) return { status: 401, error: 'ユーザー名またはパスワードが違います' };
        const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex'), time = now();
        store.transaction(() => {
          store.db.prepare('DELETE FROM sessions WHERE expiresAt<? OR userId=?').run(time, row.id);
          store.db.prepare('DELETE FROM login_attempts WHERE bucket=?').run(bucket);
          store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(digest(token), row.id, csrf, time, time, time + 28800000);
          store.audit(row.id, 'login', row.id);
        });
        return { status: 200, token, csrf, username: row.username };
      } finally { inFlight--; }
    },
    logout(s) { store.db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(s.tokenHash); },
    async changePassword(s, currentPassword, newPassword) {
      if (inFlight >= 2 || limited('password:' + s.userId, 5)) throw new Error('変更の試行が多いため、15分後にお試しください');
      inFlight++;
      try {
      const row = store.db.prepare('SELECT passwordHash FROM users WHERE id=?').get(s.userId);
      if (!await verifyPassword(currentPassword, row.passwordHash)) throw new Error('現在のパスワードが違います');
      const hash = await passwordHash(newPassword);
      store.transaction(() => {
        store.db.prepare('UPDATE users SET passwordHash=? WHERE id=?').run(hash, s.userId);
        store.db.prepare('DELETE FROM sessions WHERE userId=?').run(s.userId);
        store.audit(s.userId, 'changePassword', s.userId);
      });
      } finally { inFlight--; }
    }
  };
}
module.exports = { createAuth, createAdmin, passwordHash, verifyPassword, digest };
