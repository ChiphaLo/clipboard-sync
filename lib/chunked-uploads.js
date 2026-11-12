import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

const META_EXTENSION = '.json';
const PART_EXTENSION = '.part';
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 180;
const SWEEP_INTERVAL_MS = 60 * 1000;

function uploadError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function safeIdentifier(value) {
  return String(value ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 64);
}

export function sanitizeUploadName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || '未命名文件').slice(0, MAX_NAME_LENGTH);
}

// Manages resumable chunked uploads. Chunks are appended to a staging file so a
// dropped connection only costs the current chunk instead of the whole transfer.
export function createChunkedUploadManager({
  stagingDir,
  uploadDir,
  ttlMs = DEFAULT_TTL_MS,
  fsImpl = fs,
  clock = () => Date.now(),
  idGenerator = randomUUID,
  logger = console
} = {}) {
  if (!stagingDir) throw new Error('stagingDir is required');

  fsImpl.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  const sessions = new Map();
  const activeWrites = new Set();
  let lastSweepAt = 0;

  const metaPathFor = id => path.join(stagingDir, `${id}${META_EXTENSION}`);
  const partPathFor = id => path.join(stagingDir, `${id}${PART_EXTENSION}`);

  function partSize(id) {
    try { return fsImpl.statSync(partPathFor(id)).size; } catch { return -1; }
  }

  function removeSessionFiles(id) {
    for (const file of [partPathFor(id), metaPathFor(id)]) {
      try { fsImpl.unlinkSync(file); } catch {}
    }
  }

  function persistMeta(session) {
    try {
      fsImpl.writeFileSync(metaPathFor(session.id), JSON.stringify(session), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      logger.error?.('上传会话元数据写入失败:', error?.message || error);
    }
  }

  function describe(session) {
    const received = Math.max(0, partSize(session.id));
    return {
      id: session.id,
      name: session.name,
      size: session.size,
      received,
      isPermanent: session.isPermanent,
      createdAt: session.createdAt
    };
  }

  function loadFromDisk() {
    let entries = [];
    try { entries = fsImpl.readdirSync(stagingDir); } catch { return 0; }
    let loaded = 0;
    for (const entry of entries) {
      if (!entry.endsWith(META_EXTENSION)) continue;
      const id = entry.slice(0, -META_EXTENSION.length);
      if (!safeIdentifier(id)) continue;
      try {
        const meta = JSON.parse(fsImpl.readFileSync(path.join(stagingDir, entry), 'utf8'));
        if (!meta?.userId || !Number.isInteger(meta.size) || meta.size < 0) throw new Error('invalid metadata');
        if (partSize(id) < 0) { removeSessionFiles(id); continue; }
        sessions.set(id, {
          id,
          userId: String(meta.userId),
          name: sanitizeUploadName(meta.name),
          size: meta.size,
          mime: String(meta.mime || '').slice(0, 120),
          isPermanent: Boolean(meta.isPermanent),
          fingerprint: meta.fingerprint ? String(meta.fingerprint).slice(0, 200) : null,
          createdAt: meta.createdAt || new Date(clock()).toISOString(),
          updatedAt: meta.updatedAt || meta.createdAt || new Date(clock()).toISOString()
        });
        loaded += 1;
      } catch {
        removeSessionFiles(id);
      }
    }
    return loaded;
  }

  function discardSession(id, userId) {
    const session = sessions.get(String(id));
    if (!session) return false;
    if (userId !== undefined && session.userId !== userId) return false;
    if (activeWrites.has(session.id)) throw uploadError(409, '该上传正在写入，请稍后重试');
    sessions.delete(session.id);
    removeSessionFiles(session.id);
    return true;
  }

  function sweepIfDue() {
    if (clock() - lastSweepAt < SWEEP_INTERVAL_MS) return 0;
    return cleanupStale();
  }

  function cleanupStale() {
    const now = clock();
    const retained = new Set();
    let removed = 0;
    for (const [id, session] of [...sessions]) {
      let mtime = 0;
      try { mtime = fsImpl.statSync(partPathFor(id)).mtimeMs; } catch { mtime = -1; }
      if (mtime < 0) { sessions.delete(id); removeSessionFiles(id); removed += 1; continue; }
      const createdAt = new Date(session.createdAt).getTime();
      const age = now - Math.max(mtime, Number.isFinite(createdAt) ? createdAt : now);
      if (age > ttlMs) { sessions.delete(id); removeSessionFiles(id); removed += 1; continue; }
      retained.add(id);
    }
    try {
      for (const entry of fsImpl.readdirSync(stagingDir)) {
        const id = entry.endsWith(META_EXTENSION)
          ? entry.slice(0, -META_EXTENSION.length)
          : entry.endsWith(PART_EXTENSION) ? entry.slice(0, -PART_EXTENSION.length) : null;
        if (!id || retained.has(id)) continue;
        const filePath = path.join(stagingDir, entry);
        let mtime = -1;
        try { mtime = fsImpl.statSync(filePath).mtimeMs; } catch { mtime = -1; }
        if (mtime >= 0 && now - mtime > ttlMs) { fsImpl.unlinkSync(filePath); removed += 1; }
      }
    } catch {}
    lastSweepAt = now;
    return removed;
  }

  function initSession({ userId, name, size, mime, fingerprint, isPermanent = false }) {
    if (!userId) throw new Error('userId is required');
    if (!Number.isInteger(size) || size < 0) throw uploadError(400, '文件大小无效');
    sweepIfDue();

    const normalizedFingerprint = fingerprint ? String(fingerprint).slice(0, 200) : null;
    if (normalizedFingerprint) {
      for (const session of sessions.values()) {
        if (session.userId !== userId || session.size !== size || session.fingerprint !== normalizedFingerprint) continue;
        if (partSize(session.id) < 0) { sessions.delete(session.id); removeSessionFiles(session.id); continue; }
        session.updatedAt = new Date(clock()).toISOString();
        persistMeta(session);
        return describe(session);
      }
    }

    const id = safeIdentifier(idGenerator()) || safeIdentifier(randomUUID());
    fsImpl.writeFileSync(partPathFor(id), '');
    if (typeof fsImpl.chmodSync === 'function') {
      try { fsImpl.chmodSync(partPathFor(id), 0o600); } catch {}
    }
    const now = new Date(clock()).toISOString();
    const session = {
      id,
      userId,
      name: sanitizeUploadName(name),
      size,
      mime: String(mime || '').slice(0, 120),
      isPermanent: Boolean(isPermanent),
      fingerprint: normalizedFingerprint,
      createdAt: now,
      updatedAt: now
    };
    sessions.set(id, session);
    persistMeta(session);
    return describe(session);
  }

  function getSession(id, userId) {
    const session = sessions.get(String(id));
    if (!session) return null;
    if (userId !== undefined && session.userId !== userId) return null;
    return describe(session);
  }

  // Streams one request body into the staging file at `offset`. Bytes are only
  // committed when they were written completely, so a broken connection leaves
  // the upload at a clean chunk boundary that the client can resume from.
  function appendChunk({ session, offset, stream, maxBytes, declaredBytes }) {
    return new Promise((resolve, reject) => {
      let descriptor;
      try {
        descriptor = fsImpl.openSync(partPathFor(session.id), 'r+');
      } catch {
        reject(uploadError(409, '上传会话已失效', { received: -1 }));
        return;
      }

      let written = 0;
      let settled = false;
      let closed = false;
      let truncated = false;

      const closeDescriptor = () => {
        if (closed) return;
        closed = true;
        try { fsImpl.closeSync(descriptor); } catch {}
      };
      const settle = (error, received) => {
        if (settled) return;
        settled = true;
        activeWrites.delete(session.id);
        closeDescriptor();
        if (error) reject(error); else resolve(received);
      };
      const abort = error => {
        if (settled) return;
        if (!truncated) {
          truncated = true;
          try { fsImpl.ftruncateSync(descriptor, offset + written); } catch {}
        }
        settle(error);
      };

      const sink = new Writable({
        write(chunk, encoding, callback) {
          if (written + chunk.length > maxBytes) {
            callback(uploadError(413, '分片超出允许大小', { received: offset + written }));
            return;
          }
          fsImpl.write(descriptor, chunk, 0, chunk.length, offset + written, (error, bytesWritten) => {
            if (error) { callback(error); return; }
            if (bytesWritten !== chunk.length) { callback(uploadError(500, '分片写入不完整')); return; }
            written += bytesWritten;
            callback();
          });
        }
      });

      sink.on('finish', () => {
        if (Number.isFinite(declaredBytes) && declaredBytes !== written) {
          abort(uploadError(400, '分片长度与声明不符', { received: offset + written }));
          return;
        }
        session.updatedAt = new Date(clock()).toISOString();
        settle(null, offset + written);
      });
      sink.on('error', error => abort(error));
      sink.on('close', () => {
        if (!settled) abort(uploadError(499, '客户端中断了上传', { received: offset + written }));
      });
      const onSourceAbort = () => {
        abort(uploadError(499, '客户端中断了上传', { received: offset + written }));
        sink.destroy();
      };
      stream.on('aborted', onSourceAbort);
      stream.on('error', onSourceAbort);

      activeWrites.add(session.id);
      stream.pipe(sink);
    });
  }

  function finalizeSession(session) {
    if (!uploadDir) throw new Error('uploadDir is required');
    const received = partSize(session.id);
    if (received !== session.size) {
      throw uploadError(409, '上传尚未完成', { received: Math.max(0, received) });
    }
    const filename = safeIdentifier(idGenerator());
    const destination = path.join(uploadDir, filename);
    fsImpl.renameSync(partPathFor(session.id), destination);
    try { fsImpl.unlinkSync(metaPathFor(session.id)); } catch {}
    sessions.delete(session.id);
    return { filePath: destination, filename };
  }

  loadFromDisk();

  return {
    initSession,
    getSession,
    appendChunk,
    finalizeSession,
    discardSession,
    cleanupStale,
    partPathFor,
    size: () => sessions.size
  };
}
