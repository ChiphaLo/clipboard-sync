import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function referencedUploads(data = {}) {
  const referenced = new Set();
  for (const clips of Object.values(data.clips || {})) {
    for (const item of [...(clips.files || []), ...(clips.permanent || [])]) {
      if (item?.type === 'file' && item.filename) referenced.add(path.basename(item.filename));
    }
  }
  return referenced;
}

export function quarantineOrphanedUploads({
  store,
  uploadDir,
  quarantineDir,
  fsImpl = fs,
  idGenerator = randomUUID
}) {
  const referenced = referencedUploads(store.getData());
  const entries = fsImpl.readdirSync(uploadDir, { withFileTypes: true });
  const orphaned = entries.filter(entry => entry.isFile() && !referenced.has(entry.name));
  if (!orphaned.length) return [];

  fsImpl.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(quarantineDir, 0o700);

  return orphaned.map(entry => {
    const sourcePath = path.join(uploadDir, entry.name);
    const quarantinePath = path.join(quarantineDir, `${idGenerator()}-${entry.name}`);
    fsImpl.renameSync(sourcePath, quarantinePath);
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(quarantinePath, 0o600);
    return { filename: entry.name, quarantinePath };
  });
}

export function reportQuarantinedUploads(quarantined, logger = console) {
  if (quarantined.length) logger.log(`已隔离 ${quarantined.length} 个孤立上传文件`);
}
