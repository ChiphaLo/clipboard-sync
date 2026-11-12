import path from 'node:path';

export function persistUploadedFile({ store, userId, item, isPermanent, uploadedPath, unlinkFile }) {
  try {
    store.mutate(data => {
      const clips = data.clips[userId];
      clips[isPermanent ? 'permanent' : 'files'].push(item);
    });
    return item;
  } catch (error) {
    try { unlinkFile(uploadedPath); } catch {}
    throw error;
  }
}

export function deleteClip({ store, userId, clipId, sessionMode, uploadDir, unlinkFile }) {
  const item = store.mutate(data => {
    const clips = data.clips[userId];
    for (const category of ['texts', 'files', 'permanent']) {
      if (category === 'permanent' && sessionMode !== 'trusted') continue;
      const index = clips[category].findIndex(candidate => candidate.id === clipId);
      if (index !== -1) return clips[category].splice(index, 1)[0];
    }
    const error = new Error('项目未找到');
    error.status = 404;
    throw error;
  });

  if (item.type === 'file') {
    try { unlinkFile(path.join(uploadDir, path.basename(item.filename))); } catch (error) {
      console.error('orphaned upload after metadata deletion:', item.filename, error.message);
    }
  }
  return item;
}
