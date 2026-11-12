import express from 'express';
import multer from 'multer';
import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DEFAULT_LIMITS, getItemCount, validateText } from './lib/clip-policy.js';
import { deleteClip, persistUploadedFile } from './lib/file-mutations.js';
import { inspectUpload } from './lib/upload-policy.js';
import { generatePreview } from './lib/preview-generator.js';
import { createChunkedUploadManager, sanitizeUploadName } from './lib/chunked-uploads.js';

const JSON_LIMIT = '64kb';
const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1);
  return `${Number((bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 1))} ${units[index]}`;
}

function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeLoginMode(mode) {
  return mode === 'trusted' || mode === 'permanent' ? 'trusted' : 'temp';
}

function sanitizeDeviceName(name) {
  return String(name || 'Unknown Device').replace(/[\r\n]/g, '').slice(0, 80);
}

function decodeFileName(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

function getFileStorageUsed(clips) {
  return [...clips.files, ...clips.permanent]
    .filter(item => item.type === 'file')
    .reduce((total, item) => total + (Number(item.size) || 0), 0);
}

function ensureUserClips(data, userId) {
  data.clips[userId] ??= { texts: [], files: [], permanent: [] };
  return data.clips[userId];
}

function jsonLimiter({ windowMs, max, error }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error })
  });
}

function findFile(store, userId, id) {
  const data = store.getData();
  const clips = ensureUserClips(data, userId);
  return [...clips.files, ...clips.permanent].find(item => item.id === id && item.type === 'file');
}

export function createApp({
  jwtSecret,
  store,
  uploadDir,
  publicDir,
  limits = {},
  limiterOptions = {},
  previewGenerator = generatePreview,
  fsImpl = fs,
  uploadManager
}) {
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  if (!store || !uploadDir || !publicDir) throw new Error('store, uploadDir and publicDir are required');

  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  const uploads = uploadManager || createChunkedUploadManager({
    stagingDir: path.join(uploadDir, '.staging'),
    uploadDir
  });
  const app = express();
  app.locals.uploadManager = uploads;
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'none'"],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'sameorigin' },
    hsts: false,
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use(express.json({ limit: JSON_LIMIT }));
  app.use(express.static(publicDir, { dotfiles: 'deny', fallthrough: true }));

  const loginLimiter = jsonLimiter({
    windowMs: limiterOptions.login?.windowMs ?? 15 * 60 * 1000,
    max: limiterOptions.login?.max ?? 10,
    error: '登录尝试过多'
  });
  const textLimiter = jsonLimiter({
    windowMs: limiterOptions.text?.windowMs ?? 60 * 1000,
    max: limiterOptions.text?.max ?? 60,
    error: '文本保存过于频繁'
  });
  const uploadLimiter = jsonLimiter({
    windowMs: limiterOptions.upload?.windowMs ?? 60 * 1000,
    max: limiterOptions.upload?.max ?? 20,
    error: '上传过于频繁'
  });
  const mutationLimiter = jsonLimiter({
    windowMs: limiterOptions.mutation?.windowMs ?? 60 * 1000,
    max: limiterOptions.mutation?.max ?? 120,
    error: '操作过于频繁'
  });
  const previewLimiter = jsonLimiter({
    windowMs: limiterOptions.preview?.windowMs ?? 60 * 1000,
    max: limiterOptions.preview?.max ?? 60,
    error: '预览请求过于频繁'
  });
  const uploadInitLimiter = jsonLimiter({
    windowMs: limiterOptions.uploadInit?.windowMs ?? 60 * 1000,
    max: limiterOptions.uploadInit?.max ?? 60,
    error: '上传过于频繁'
  });
  const uploadChunkLimiter = jsonLimiter({
    windowMs: limiterOptions.chunk?.windowMs ?? 60 * 1000,
    max: limiterOptions.chunk?.max ?? 1200,
    error: '上传请求过于频繁，请稍后重试'
  });
  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: effectiveLimits.maxFileBytes, files: 1, fields: 4, parts: 5 }
  });

  function verifyToken(req, res, next) {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return res.status(401).json({ error: '未授权' });
    try {
      const decoded = jwt.verify(authorization.slice(7), jwtSecret);
      const data = store.getData();
      const user = data.users.find(candidate => candidate.id === decoded.userId);
      const session = data.sessions?.[decoded.sid];
      if (!user) return res.status(401).json({ error: '用户不存在' });
      if (!session || session.revoked || session.userId !== decoded.userId) {
        return res.status(401).json({ error: '会话已失效' });
      }
      if (new Date(session.expiresAt).getTime() < Date.now()) {
        store.mutate(draft => { if (draft.sessions[decoded.sid]) draft.sessions[decoded.sid].revoked = true; });
        return res.status(401).json({ error: '会话已过期' });
      }
      const lastSeenAt = new Date(session.lastSeenAt).getTime();
      if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt > 5 * 60 * 1000) {
        store.mutate(draft => {
          if (draft.sessions[decoded.sid]) draft.sessions[decoded.sid].lastSeenAt = new Date().toISOString();
        });
      }
      req.userId = decoded.userId;
      req.sessionId = decoded.sid;
      req.sessionMode = session.mode;
      next();
    } catch (error) {
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: '令牌无效或已过期' });
      }
      next(error);
    }
  }

  function requireTrusted(req, res, next) {
    if (req.sessionMode !== 'trusted') return res.status(403).json({ error: '临时登录不允许执行此操作' });
    next();
  }

  app.post('/api/login', loginLimiter, (req, res, next) => {
    try {
      const { username, password, mode = 'temp', deviceName = 'Unknown Device' } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: '用户名或密码缺失' });
      const user = store.getData().users.find(candidate => candidate.username === username);
      if (!user || !bcryptjs.compareSync(password, user.password)) {
        return res.status(401).json({ error: '用户名或密码错误' });
      }
      const safeMode = normalizeLoginMode(mode);
      const ttlMs = safeMode === 'trusted' ? 30 * 24 * 60 * 60 * 1000 : 120 * 60 * 1000;
      const session = {
        id: randomUUID(),
        userId: user.id,
        mode: safeMode,
        deviceName: sanitizeDeviceName(deviceName),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        lastSeenAt: new Date().toISOString(),
        revoked: false
      };
      store.mutate(data => { data.sessions[session.id] = session; });
      const token = jwt.sign({ userId: user.id, sid: session.id, mode: safeMode }, jwtSecret, {
        expiresIn: safeMode === 'trusted' ? '30d' : '120m'
      });
      res.json({ token, userId: user.id, sessionId: session.id, mode: safeMode, expiresAt: session.expiresAt });
    } catch (error) { next(error); }
  });

  app.post('/api/logout', verifyToken, mutationLimiter, (req, res, next) => {
    try {
      store.mutate(data => { if (data.sessions[req.sessionId]) data.sessions[req.sessionId].revoked = true; });
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  app.get('/api/clips', verifyToken, (req, res) => {
    const clips = ensureUserClips(store.getData(), req.userId);
    res.json(clips);
  });

  function requireTrustedPermanentCreate(req, res, next) {
    if (toBool(req.body?.isPermanent) && req.sessionMode !== 'trusted') {
      if (req.file?.path) {
        try { fsImpl.unlinkSync(req.file.path); } catch {}
      }
      return res.status(403).json({ error: '临时登录不允许执行此操作' });
    }
    next();
  }

  app.post('/api/text', verifyToken, textLimiter, requireTrustedPermanentCreate, (req, res, next) => {
    try {
      const content = req.body?.content;
      const item = {
        id: randomUUID(),
        content,
        timestamp: new Date().toISOString(),
        type: 'text'
      };
      store.mutate(data => {
        const clips = ensureUserClips(data, req.userId);
        validateText(content, clips, effectiveLimits);
        clips[toBool(req.body?.isPermanent) ? 'permanent' : 'texts'].push(item);
      });
      res.json(item);
    } catch (error) { next(error); }
  });

  app.post('/api/file', verifyToken, uploadLimiter, upload.single('file'), requireTrustedPermanentCreate, (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: '文件缺失' });
    try {
      const inspection = inspectUpload(req.file.path, req.file.mimetype);
      if (!inspection.allowed) {
        fsImpl.unlinkSync(req.file.path);
        return res.status(415).json({ error: inspection.reason });
      }
      const clips = ensureUserClips(store.getData(), req.userId);
      if (getItemCount(clips) >= effectiveLimits.maxItems) {
        fsImpl.unlinkSync(req.file.path);
        return res.status(413).json({ error: '项目数量已达上限' });
      }
      if (getFileStorageUsed(clips) + req.file.size > effectiveLimits.maxFileStorageBytes) {
        fsImpl.unlinkSync(req.file.path);
        return res.status(413).json({ error: '用户存储空间已满' });
      }
      const item = {
        id: randomUUID(),
        originalName: decodeFileName(req.file.originalname),
        filename: req.file.filename,
        size: req.file.size,
        timestamp: new Date().toISOString(),
        type: 'file',
        detectedKind: inspection.detectedKind
      };
      persistUploadedFile({
        store,
        userId: req.userId,
        item,
        isPermanent: toBool(req.body?.isPermanent),
        uploadedPath: req.file.path,
        unlinkFile: file => fsImpl.unlinkSync(file)
      });
      res.json(item);
    } catch (error) {
      try { if (fsImpl.existsSync(req.file.path)) fsImpl.unlinkSync(req.file.path); } catch {}
      next(error);
    }
  });
  app.post('/api/upload/init', verifyToken, uploadInitLimiter, (req, res, next) => {
    try {
      const { name, size, mime, fingerprint, isPermanent } = req.body || {};
      const bytes = Number(size);
      if (!Number.isInteger(bytes) || bytes < 0) return res.status(400).json({ error: '文件大小无效' });
      if (bytes > effectiveLimits.maxFileBytes) {
        return res.status(413).json({ error: '文件大小超过限制（最大 ' + formatBytes(effectiveLimits.maxFileBytes) + '）' });
      }
      if (toBool(isPermanent) && req.sessionMode !== 'trusted') {
        return res.status(403).json({ error: '临时登录不允许执行此操作' });
      }
      const clips = ensureUserClips(store.getData(), req.userId);
      if (getItemCount(clips) >= effectiveLimits.maxItems) {
        return res.status(413).json({ error: '项目数量已达上限' });
      }
      if (getFileStorageUsed(clips) + bytes > effectiveLimits.maxFileStorageBytes) {
        return res.status(413).json({ error: '用户存储空间已满' });
      }
      const session = uploads.initSession({
        userId: req.userId,
        name,
        size: bytes,
        mime,
        fingerprint,
        isPermanent: toBool(isPermanent)
      });
      res.json({
        uploadId: session.id,
        received: session.received,
        size: session.size,
        resumed: session.received > 0,
        chunkSize: UPLOAD_CHUNK_SIZE,
        maxChunkSize: MAX_UPLOAD_CHUNK_SIZE
      });
    } catch (error) { next(error); }
  });

  app.get('/api/upload/:id', verifyToken, (req, res) => {
    const session = uploads.getSession(req.params.id, req.userId);
    if (!session) return res.status(404).json({ error: '上传会话不存在或已过期' });
    res.json({
      uploadId: session.id,
      received: session.received,
      size: session.size,
      name: session.name,
      chunkSize: UPLOAD_CHUNK_SIZE
    });
  });

  app.put('/api/upload/:id', verifyToken, uploadChunkLimiter, (req, res) => {
    const session = uploads.getSession(req.params.id, req.userId);
    if (!session) return res.status(404).json({ error: '上传会话不存在或已过期' });
    const offset = Number(req.headers['x-upload-offset'] ?? req.query.offset ?? '0');
    if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: '上传偏移量无效' });
    if (offset !== session.received) {
      return res.status(409).json({ error: '上传偏移量不匹配', received: session.received, size: session.size });
    }
    const remaining = session.size - offset;
    if (remaining <= 0) {
      return res.status(409).json({ error: '文件内容已接收完成', received: session.received, size: session.size });
    }
    const declaredLength = Number(req.headers['content-length']);
    const limit = Math.min(MAX_UPLOAD_CHUNK_SIZE, remaining);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      return res.status(413).json({ error: '单个分片不能超过 ' + formatBytes(limit), received: session.received });
    }
    uploads.appendChunk({
      session,
      offset,
      stream: req,
      maxBytes: limit,
      declaredBytes: Number.isFinite(declaredLength) ? declaredLength : undefined
    }).then(received => {
      if (!res.headersSent) res.json({ received, size: session.size });
    }).catch(error => {
      if (res.headersSent) return;
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) {
        console.error('分片上传失败:', error?.message || error);
        return res.status(500).json({ error: '分片写入失败，请重试', received: error?.received });
      }
      res.status(status).json({ error: error.message, received: error?.received, size: session.size });
    });
  });

  app.post('/api/upload/:id/complete', verifyToken, mutationLimiter, (req, res, next) => {
    const session = uploads.getSession(req.params.id, req.userId);
    if (!session) return res.status(404).json({ error: '上传会话不存在或已过期' });
    try {
      if (session.received !== session.size) {
        return res.status(409).json({
          error: '上传尚未完成（' + formatBytes(session.received) + '/' + formatBytes(session.size) + '）',
          received: session.received,
          size: session.size,
          completed: false
        });
      }
      if (session.isPermanent && req.sessionMode !== 'trusted') {
        uploads.discardSession(session.id, req.userId);
        return res.status(403).json({ error: '临时登录不允许执行此操作' });
      }
      const clips = ensureUserClips(store.getData(), req.userId);
      if (getItemCount(clips) >= effectiveLimits.maxItems) {
        uploads.discardSession(session.id, req.userId);
        return res.status(413).json({ error: '项目数量已达上限' });
      }
      if (getFileStorageUsed(clips) + session.size > effectiveLimits.maxFileStorageBytes) {
        uploads.discardSession(session.id, req.userId);
        return res.status(413).json({ error: '用户存储空间已满' });
      }
      const inspection = inspectUpload(uploads.partPathFor(session.id), session.mime || 'application/octet-stream');
      if (!inspection.allowed) {
        uploads.discardSession(session.id, req.userId);
        return res.status(415).json({ error: inspection.reason });
      }
      const { filePath, filename } = uploads.finalizeSession(session);
      const item = {
        id: randomUUID(),
        originalName: sanitizeUploadName(session.name),
        filename,
        size: session.size,
        timestamp: new Date().toISOString(),
        type: 'file',
        detectedKind: inspection.detectedKind
      };
      persistUploadedFile({
        store,
        userId: req.userId,
        item,
        isPermanent: session.isPermanent,
        uploadedPath: filePath,
        unlinkFile: file => fsImpl.unlinkSync(file)
      });
      res.json(item);
    } catch (error) { next(error); }
  });

  app.delete('/api/upload/:id', verifyToken, mutationLimiter, (req, res, next) => {
    try {
      let removed = false;
      try {
        removed = uploads.discardSession(req.params.id, req.userId);
      } catch (error) {
        if (Number.isInteger(error?.status)) return res.status(error.status).json({ error: error.message });
        throw error;
      }
      res.json({ success: true, removed });
    } catch (error) { next(error); }
  });


  app.get('/api/file/:id/download', verifyToken, (req, res) => {
    const item = findFile(store, req.userId, req.params.id);
    if (!item) return res.status(404).json({ error: '文件未找到或不是可下载类型' });
    const filePath = path.join(uploadDir, path.basename(item.filename));
    if (!fsImpl.existsSync(filePath)) return res.status(404).json({ error: '文件已被删除' });
    res.set('X-Content-Type-Options', 'nosniff');
    res.download(filePath, item.originalName, { headers: { 'Content-Type': 'application/octet-stream' } });
  });

  app.get('/api/file/:id/preview', verifyToken, previewLimiter, async (req, res, next) => {
    try {
      const item = findFile(store, req.userId, req.params.id);
      if (!item) return res.status(404).json({ error: '文件未找到' });
      const filePath = path.join(uploadDir, path.basename(item.filename));
      if (!fsImpl.existsSync(filePath)) return res.status(404).json({ error: '文件已被删除' });
      const inspection = item.detectedKind
        ? { allowed: true, detectedKind: item.detectedKind }
        : inspectUpload(filePath, 'application/octet-stream');
      if (!['image', 'video'].includes(inspection.detectedKind)) {
        return res.status(415).json({ error: '此文件不支持预览' });
      }
      const preview = await previewGenerator({ inputPath: filePath, kind: inspection.detectedKind });
      res.set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff'
      });
      res.send(preview);
    } catch (error) { next(error); }
  });

  app.delete('/api/clip/:id', verifyToken, mutationLimiter, (req, res, next) => {
    try {
      deleteClip({
        store,
        userId: req.userId,
        clipId: req.params.id,
        sessionMode: req.sessionMode,
        uploadDir,
        unlinkFile: file => fsImpl.unlinkSync(file)
      });
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  app.post('/api/clip/:id/permanent', verifyToken, requireTrusted, mutationLimiter, (req, res, next) => {
    try {
      store.mutate(data => {
        const clips = ensureUserClips(data, req.userId);
        const item = clips.files.find(candidate => candidate.id === req.params.id)
          || clips.texts.find(candidate => candidate.id === req.params.id);
        if (!item) {
          const error = new Error('项目未找到');
          error.status = 404;
          throw error;
        }
        clips.files = clips.files.filter(candidate => candidate.id !== req.params.id);
        clips.texts = clips.texts.filter(candidate => candidate.id !== req.params.id);
        clips.permanent.push(item);
      });
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  app.get('/api/sessions', verifyToken, requireTrusted, (req, res) => {
    const sessions = Object.values(store.getData().sessions || {})
      .filter(session => session.userId === req.userId && !session.revoked)
      .map(session => ({
        id: session.id,
        mode: session.mode,
        deviceName: session.deviceName,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        current: session.id === req.sessionId
      }))
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
    res.json(sessions);
  });

  app.delete('/api/session/:id', verifyToken, requireTrusted, mutationLimiter, (req, res, next) => {
    try {
      store.mutate(data => {
        const session = data.sessions?.[req.params.id];
        if (!session || session.userId !== req.userId) {
          const error = new Error('会话不存在');
          error.status = 404;
          throw error;
        }
        session.revoked = true;
      });
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: '请求体过大' });
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件大小超过限制（最大 ' + formatBytes(effectiveLimits.maxFileBytes) + '）' });
      return res.status(400).json({ error: `上传请求无效（${error.code}）` });
    }
    if (error?.status && Number.isInteger(error.status)) return res.status(error.status).json({ error: error.message });
    console.error('服务器错误:', error?.message || error);
    res.status(500).json({ error: '服务器内部错误' });
  });

  return app;
}

export function initializeDefaultUser({ store, username, password }) {
  if (!username || !password) return false;
  if (store.getData().users.some(user => user.username === username)) return false;
  const user = { id: randomUUID(), username, password: bcryptjs.hashSync(password, 12) };
  store.mutate(data => {
    data.users.push(user);
    data.clips[user.id] = { texts: [], files: [], permanent: [] };
  });
  return true;
}

export function cleanupExpiredData({ store, uploadDir, fsImpl = fs, now = Date.now() }) {
  const removedFiles = [];
  const changed = store.mutate(data => {
    let didChange = false;
    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    for (const clips of Object.values(data.clips)) {
      clips.texts = clips.texts.filter(item => {
        const expired = now - new Date(item.timestamp).getTime() > retentionMs;
        didChange ||= expired;
        return !expired;
      });
      clips.files = clips.files.filter(item => {
        const expired = now - new Date(item.timestamp).getTime() > retentionMs;
        if (expired) removedFiles.push(item.filename);
        didChange ||= expired;
        return !expired;
      });
    }
    for (const [id, session] of Object.entries(data.sessions || {})) {
      if (session.revoked || new Date(session.expiresAt).getTime() < now) {
        delete data.sessions[id];
        didChange = true;
      }
    }
    return didChange;
  });
  if (!changed) return false;
  for (const filename of removedFiles) {
    try { fsImpl.unlinkSync(path.join(uploadDir, path.basename(filename))); } catch {}
  }
  return true;
}
