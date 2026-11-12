import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function normalizeData(input = {}) {
  const data = input && typeof input === 'object' ? input : {};
  data.users = Array.isArray(data.users) ? data.users : [];
  data.clips = data.clips && typeof data.clips === 'object' ? data.clips : {};
  data.sessions = data.sessions && typeof data.sessions === 'object' ? data.sessions : {};
  for (const userId of Object.keys(data.clips)) {
    const clips = data.clips[userId] && typeof data.clips[userId] === 'object' ? data.clips[userId] : {};
    clips.texts = Array.isArray(clips.texts) ? clips.texts : [];
    clips.files = Array.isArray(clips.files) ? clips.files : [];
    clips.permanent = Array.isArray(clips.permanent) ? clips.permanent : [];
    data.clips[userId] = clips;
  }
  return data;
}

function clone(value) {
  return structuredClone(value);
}

export function createDataStore({ dataFile, fsImpl = fs, initialData } = {}) {
  if (!dataFile) throw new Error('dataFile is required');

  function load() {
    if (initialData !== undefined) return normalizeData(clone(initialData));
    if (!fsImpl.existsSync(dataFile)) return normalizeData({});
    return normalizeData(JSON.parse(fsImpl.readFileSync(dataFile, 'utf8')));
  }

  let currentData = load();

  function save(nextData) {
    const normalized = normalizeData(clone(nextData));
    const directory = path.dirname(dataFile);
    const temporary = path.join(directory, `.${path.basename(dataFile)}.${randomUUID()}.tmp`);
    try {
      fsImpl.writeFileSync(temporary, JSON.stringify(normalized, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      });
      fsImpl.renameSync(temporary, dataFile);
      if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(dataFile, 0o600);
    } catch (error) {
      try {
        if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
      } catch {}
      throw error;
    }
    return normalized;
  }

  function mutate(mutator) {
    const draft = clone(currentData);
    const result = mutator(draft);
    const persisted = save(draft);
    currentData = persisted;
    return result;
  }

  return {
    getData: () => currentData,
    load,
    mutate,
    save(nextData) {
      const persisted = save(nextData);
      currentData = persisted;
      return persisted;
    }
  };
}
