import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, initializeDefaultUser } from '../app.js';
import { createDataStore } from '../lib/data-store.js';

async function startServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-sync-'));
  const uploadDir = path.join(root, 'uploads');
  fs.mkdirSync(uploadDir);
  const store = createDataStore({ dataFile: path.join(root, 'data.json') });
  initializeDefaultUser({ store, username: 'user', password: 'pass' });
  const app = createApp({ jwtSecret: 'x'.repeat(40), store, uploadDir, publicDir: path.resolve('public') });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(base, url, options = {}) {
  const response = await fetch(base + url, options);
  const body = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer();
  return { status: response.status, body };
}

async function login(base, mode) {
  const { status, body } = await call(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'user', password: 'pass', mode, deviceName: 'test' })
  });
  assert.equal(status, 200);
  return { authorization: `Bearer ${body.token}`, 'content-type': 'application/json' };
}

test('rejects unauthenticated and wrong-password requests', async t => {
  const base = await startServer(t);
  assert.equal((await call(base, '/api/clips')).status, 401);
  const wrong = await call(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'user', password: 'nope' })
  });
  assert.equal(wrong.status, 401);
});

test('saves text and round-trips a chunked upload', async t => {
  const base = await startServer(t);
  const headers = await login(base, 'trusted');
  const saved = await call(base, '/api/text', { method: 'POST', headers, body: JSON.stringify({ content: 'hello' }) });
  assert.equal(saved.status, 200);

  const payload = Buffer.from('plain text body\n'.repeat(1000));
  const init = await call(base, '/api/upload/init', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'note.txt', size: payload.length, mime: 'text/plain' })
  });
  assert.equal(init.status, 200);
  const chunk = await call(base, `/api/upload/${init.body.uploadId}`, {
    method: 'PUT',
    headers: { authorization: headers.authorization, 'x-upload-offset': '0' },
    body: payload
  });
  assert.equal(chunk.body.received, payload.length);
  const done = await call(base, `/api/upload/${init.body.uploadId}/complete`, { method: 'POST', headers, body: '{}' });
  assert.equal(done.status, 200);

  const clips = (await call(base, '/api/clips', { headers })).body;
  assert.equal(clips.texts.length, 1);
  assert.equal(clips.files.length, 1);

  const download = await call(base, `/api/file/${clips.files[0].id}/download`, { headers });
  assert.ok(Buffer.from(download.body).equals(payload));

  const removed = await call(base, `/api/clip/${clips.files[0].id}`, { method: 'DELETE', headers });
  assert.equal(removed.status, 200);
  assert.equal((await call(base, '/api/clips', { headers })).body.files.length, 0);
});

test('temporary sessions cannot create permanent items', async t => {
  const base = await startServer(t);
  const headers = await login(base, 'temp');
  const response = await call(base, '/api/text', {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: 'keep', isPermanent: true })
  });
  assert.equal(response.status, 403);
});

test('rejects executable uploads', async t => {
  const base = await startServer(t);
  const headers = await login(base, 'trusted');
  const form = new FormData();
  form.append('file', new Blob(['#!/bin/sh\necho hi\n']), 'run.sh');
  const response = await call(base, '/api/file', { method: 'POST', headers: { authorization: headers.authorization }, body: form });
  assert.equal(response.status, 415);
});
