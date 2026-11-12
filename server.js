import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupExpiredData, createApp, initializeDefaultUser } from './app.js';
import { createDataStore } from './lib/data-store.js';
import { createChunkedUploadManager } from './lib/chunked-uploads.js';
import { quarantineOrphanedUploads, reportQuarantinedUploads } from './lib/orphan-uploads.js';
import { resolveRuntimePaths } from './lib/runtime-paths.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  console.error('JWT_SECRET 未设置或长度不足 32 个字符');
  process.exit(1);
}

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 35281);
const { dataFile, uploadDir, publicDir } = resolveRuntimePaths(directory);

fs.mkdirSync(path.dirname(dataFile), { recursive: true, mode: 0o700 });
fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 });

const store = createDataStore({ dataFile });
const uploadManager = createChunkedUploadManager({
  stagingDir: path.join(uploadDir, '.staging'),
  uploadDir
});
uploadManager.cleanupStale();
const quarantined = quarantineOrphanedUploads({
  store,
  uploadDir,
  quarantineDir: path.join(path.dirname(uploadDir), 'orphaned')
});
reportQuarantinedUploads(quarantined);
initializeDefaultUser({
  store,
  username: process.env.DEFAULT_USERNAME,
  password: process.env.DEFAULT_PASSWORD
});
cleanupExpiredData({ store, uploadDir });

function positiveNumberEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
const limits = {};
const limitEnvNames = ['maxFileBytes:MAX_FILE_BYTES', 'maxFileStorageBytes:MAX_FILE_STORAGE_BYTES', 'maxItems:MAX_ITEMS'];
for (const entry of limitEnvNames) {
  const [limitName, envName] = entry.split(':');
  const value = positiveNumberEnv(envName);
  if (value !== undefined) limits[limitName] = value;
}
const app = createApp({ jwtSecret, store, uploadDir, publicDir, limits, uploadManager });
const cleanupTimer = setInterval(() => {
  try { cleanupExpiredData({ store, uploadDir }); } catch (error) {
    console.error('定时清理失败:', error.message);
  }
  try { uploadManager.cleanupStale(); } catch (error) {
    console.error('上传缓存清理失败:', error.message);
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

const server = app.listen(port, host, () => {
  console.log(`服务启动: http://${host}:${port}`);
});
// 分片上传每个请求的 body 都很小，放开 Node 默认的整包接收超时；
// 长时间没有进度的会话由连接空闲超时和 Caddy 自身的超时兜底。
server.requestTimeout = 0;
server.headersTimeout = 70 * 1000;
server.keepAliveTimeout = 65 * 1000;
