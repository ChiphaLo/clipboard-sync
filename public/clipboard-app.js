function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function detectedKind(item) {
  if (item.detectedKind) return item.detectedKind;
  const name = item.originalName || '';
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) return 'image';
  if (/\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(name)) return 'video';
  return null;
}

const UPLOAD_TUNING = {
  defaultChunkSize: 4 * 1024 * 1024,
  minChunkSize: 256 * 1024,
  maxAttempts: 6,
  stallTimeoutMs: 60 * 1000,
  retryBaseDelayMs: 800,
  retryMaxDelayMs: 10 * 1000
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function uploadDisplayName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\u0000-\\u001f\\u007f]/g, '')
    .replace(/[\\\\/]+/g, '_')
    .replace(/^\\.+/, '')
    .trim();
  return (cleaned || '未命名文件').slice(0, 180);
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return formatSize(bytesPerSecond) + '/s';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return Math.max(1, Math.round(seconds)) + ' 秒';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes + ' 分 ' + rest + ' 秒';
}

export function renderItemHtml(item, { permanent = false, sessionMode = 'temp' } = {}) {
  const id = escapeHtml(item.id);
  const trusted = sessionMode === 'trusted';
  const kind = item.type === 'file' ? detectedKind(item) : null;
  const preview = ['image', 'video'].includes(kind)
    ? `<img class="file-preview" data-preview-id="${id}" alt="${escapeHtml(item.originalName || '媒体预览')}" loading="lazy">`
    : '';
  const content = item.type === 'text'
    ? `<div class="text-preview-text">${escapeHtml(item.content)}</div>`
    : `${preview}<div class="file-name"><span class="file-name-text" title="${escapeHtml(item.originalName)}">${escapeHtml(item.originalName)}</span><span class="file-size">(${formatSize(item.size)})</span></div>`;
  const copy = item.type === 'text'
    ? `<button class="item-btn btn-copy" data-action="copy" data-id="${id}">复制</button>`
    : '';
  const copyImage = item.type === 'file' && kind === 'image'
    ? `<button class="item-btn btn-copy" data-action="copy-image" data-id="${id}">复制图片</button>`
    : '';
  const download = item.type === 'file'
    ? `<button class="item-btn btn-download" data-action="download" data-id="${id}" data-name="${escapeHtml(item.originalName)}">下载</button>`
    : '';
  const makePermanent = !permanent && trusted
    ? `<button class="item-btn btn-permanent" data-action="permanent" data-id="${id}">永久</button>`
    : '';
  const remove = !permanent || trusted
    ? `<button class="item-btn btn-delete" data-action="delete" data-id="${id}">删除</button>`
    : '';

  return `<article class="item${permanent ? ' permanent' : ''}">
    <div class="item-top">
      <div class="item-content${item.type === 'text' ? ' text-preview' : ''}">${content}</div>
      <time class="item-time">${formatTimestamp(item.timestamp)}</time>
    </div>
    <div class="item-actions">${copy}${copyImage}${download}${makePermanent}${remove}</div>
  </article>`;
}

export async function apiRequest(url, {
  token,
  fetchImpl = fetch,
  method = 'GET',
  headers = {},
  body,
  responseType = 'json'
} = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, { method, headers: requestHeaders, body });
  let payload;
  if (responseType === 'blob' && response.ok) payload = await response.blob();
  else payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function createPreviewManager({
  document,
  tokenProvider,
  fetchImpl = fetch,
  createObjectURL = URL.createObjectURL.bind(URL),
  revokeObjectURL = URL.revokeObjectURL.bind(URL),
  observerFactory,
  onUnauthorized = () => {},
  maxConcurrent = 3
}) {
  const objectUrls = new Map();
  const queue = [];
  const activeControllers = new Set();
  const idleResolvers = [];
  let active = 0;
  let generation = 0;
  let observer = null;

  function settleIdle() {
    if (active || queue.length) return;
    while (idleResolvers.length) idleResolvers.shift()();
  }

  async function load(element, queuedGeneration) {
    const controller = new AbortController();
    activeControllers.add(controller);
    try {
      const response = await fetchImpl(`/api/file/${encodeURIComponent(element.dataset.previewId)}/preview`, {
        headers: { Authorization: `Bearer ${tokenProvider()}` },
        signal: controller.signal
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(`preview HTTP ${response.status}`);
      const url = createObjectURL(await response.blob());
      if (queuedGeneration !== generation || !element.isConnected) {
        revokeObjectURL(url);
        return;
      }
      const oldUrl = objectUrls.get(element.dataset.previewId);
      if (oldUrl && oldUrl !== url) revokeObjectURL(oldUrl);
      objectUrls.set(element.dataset.previewId, url);
      element.src = url;
    } catch (error) {
      if (error.name !== 'AbortError' && element.isConnected) element.alt = '预览不可用';
    } finally {
      activeControllers.delete(controller);
    }
  }

  function drain() {
    while (active < maxConcurrent && queue.length) {
      const { element, queuedGeneration } = queue.shift();
      active += 1;
      load(element, queuedGeneration).finally(() => {
        active -= 1;
        drain();
        settleIdle();
      });
    }
    settleIdle();
  }

  function enqueue(element) {
    if (!element?.dataset.previewId) return;
    queue.push({ element, queuedGeneration: generation });
    drain();
  }

  function createObserver() {
    const callback = entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer?.unobserve(entry.target);
        enqueue(entry.target);
      }
    };
    if (observerFactory) return observerFactory(callback);
    const Observer = document.defaultView?.IntersectionObserver;
    return Observer ? new Observer(callback, { rootMargin: '200px' }) : null;
  }

  return {
    observeAll(elements) {
      observer ??= createObserver();
      for (const element of elements) {
        if (observer) observer.observe(element);
        else enqueue(element);
      }
    },
    idle() {
      if (!active && !queue.length) return Promise.resolve();
      return new Promise(resolve => idleResolvers.push(resolve));
    },
    reset() {
      generation += 1;
      observer?.disconnect();
      observer = null;
      queue.length = 0;
      for (const controller of activeControllers) controller.abort();
      for (const url of objectUrls.values()) revokeObjectURL(url);
      objectUrls.clear();
      settleIdle();
    }
  };
}

function clipboardFileName(file) {
  if (file.name) return file.name;
  const extensions = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov'
  };
  const extension = extensions[file.type] || 'bin';
  return `pasted-${Date.now()}.${extension}`;
}

function isEditableTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

export function createClipboardApp({
  document,
  window,
  fetchImpl = fetch,
  initialToken = null,
  initialSessionMode = null,
  sessionStorage = window?.sessionStorage,
  localStorage = window?.localStorage,
  confirmImpl = window?.confirm?.bind(window) || (() => true)
}) {
  const state = {
    token: initialToken,
    sessionMode: initialSessionMode,
    handlersInstalled: false,
    pasteInFlight: false,
    refreshTimer: null,
    textById: new Map(),
    clipsFingerprint: null,
    uploadControl: null
  };
  const app = {};
  const previewManager = createPreviewManager({
    document,
    tokenProvider: () => state.token,
    fetchImpl,
    onUnauthorized: () => app.handleAuthFailure('登录已失效，请重新登录')
  });

  function element(id) {
    return document.getElementById(id);
  }

  function showError(id, message = '') {
    const target = element(id);
    if (target) target.textContent = message;
  }

  function flashButton(button, ok) {
    if (!button) return;
    const original = button.dataset.originalText || button.textContent;
    button.dataset.originalText = original;
    button.textContent = ok ? '成功' : '失败';
    button.classList.toggle('action-ok', ok);
    button.classList.toggle('action-error', !ok);
    window.setTimeout(() => {
      button.textContent = original;
      button.classList.remove('action-ok', 'action-error');
    }, 1200);
  }

  function clearStoredAuth() {
    sessionStorage?.removeItem('token');
    sessionStorage?.removeItem('sessionMode');
    localStorage?.removeItem('token');
    localStorage?.removeItem('sessionMode');
  }

  async function request(url, options = {}) {
    try {
      return await apiRequest(url, { token: state.token, fetchImpl, ...options });
    } catch (error) {
      if (error.status === 401) app.handleAuthFailure('登录已失效，请重新登录');
      throw error;
    }
  }

  app.handleAuthFailure = message => {
    clearStoredAuth();
    state.token = null;
    if (state.uploadControl) {
      state.uploadControl.cancelled = true;
      try { state.uploadControl.abort?.(); } catch {}
    }
    state.sessionMode = null;
    state.clipsFingerprint = null;
    state.textById.clear();
    if (state.refreshTimer) window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    previewManager.reset();
    element('appView')?.classList.remove('active');
    element('loginForm')?.classList.add('active');
    showError('loginError', message);
  };

  app.login = async () => {
    const username = element('loginUsername').value;
    const password = element('loginPassword').value;
    const mode = document.querySelector('input[name="loginMode"]:checked')?.value || 'temp';
    if (!username || !password) {
      showError('loginError', '用户名或密码不能为空');
      return false;
    }
    try {
      const data = await apiRequest('/api/login', {
        fetchImpl,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, mode, deviceName: window.navigator.userAgent.slice(0, 80) })
      });
      state.token = data.token;
      state.sessionMode = data.mode;
      clearStoredAuth();
      const storage = data.mode === 'trusted' ? localStorage : sessionStorage;
      storage?.setItem('token', data.token);
      storage?.setItem('sessionMode', data.mode);
      showError('loginError');
      app.loadApp();
      return true;
    } catch (error) {
      showError('loginError', error.message || '登录失败');
      return false;
    }
  };

  app.renderClips = data => {
    if (![data.texts, data.files, data.permanent].every(Array.isArray)) {
      throw new Error('服务器返回的数据格式无效');
    }
    const fingerprint = JSON.stringify(data);
    if (fingerprint === state.clipsFingerprint) return false;
    state.clipsFingerprint = fingerprint;
    previewManager.reset();
    state.textById = new Map(
      [...data.texts, ...data.permanent]
        .filter(item => item.type === 'text')
        .map(item => [String(item.id), item.content])
    );
    const temporary = [...data.texts, ...data.files].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const permanent = [...data.permanent].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    element('tempList').innerHTML = temporary.length
      ? temporary.map(item => renderItemHtml(item, { sessionMode: state.sessionMode })).join('')
      : '<div class="empty">还没有临时项目</div>';
    element('permanentList').innerHTML = permanent.length
      ? permanent.map(item => renderItemHtml(item, { permanent: true, sessionMode: state.sessionMode })).join('')
      : '<div class="empty">还没有永久项目</div>';
    previewManager.observeAll(document.querySelectorAll('[data-preview-id]'));
    return true;
  };

  app.loadClips = async () => {
    if (!state.token) return false;
    try {
      app.renderClips(await request('/api/clips'));
      showError('uploadError');
      return true;
    } catch (error) {
      if (error.status !== 401) showError('uploadError', error.message || '加载失败');
      return false;
    }
  };

  app.addText = async pastedContent => {
    const input = element('textInput');
    const button = element('textSaveBtn');
    const fromPaste = typeof pastedContent === 'string';
    const content = fromPaste ? pastedContent : input.value;
    if (!content.trim()) {
      if (!fromPaste) flashButton(button, false);
      return false;
    }
    try {
      await request('/api/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, isPermanent: false })
      });
      if (!fromPaste) input.value = '';
      await app.loadClips();
      flashButton(button, true);
      return true;
    } catch (error) {
      if (error.status !== 401) showError('uploadError', error.message || '保存失败');
      flashButton(button, false);
      return false;
    }
  };

  function showUploadPanel(visible) {
    const panel = element('uploadPanel');
    if (panel) panel.hidden = !visible;
  }

  function setUploadPanelText(message) {
    const target = element('uploadPanelText');
    if (target) target.textContent = message;
  }

  function createUploadRow(file) {
    const container = element('uploadRows');
    if (!container) return null;
    const row = document.createElement('div');
    row.className = 'upload-row';
    const head = document.createElement('div');
    head.className = 'upload-row-head';
    const name = document.createElement('span');
    name.className = 'upload-row-name';
    name.textContent = file.name || '未命名文件';
    name.title = file.name || '';
    const sizeInfo = document.createElement('span');
    sizeInfo.className = 'upload-row-size';
    sizeInfo.textContent = formatSize(file.size);
    head.append(name, sizeInfo);
    const bar = document.createElement('div');
    bar.className = 'upload-bar';
    const fill = document.createElement('div');
    fill.className = 'upload-bar-fill';
    bar.append(fill);
    const status = document.createElement('div');
    status.className = 'upload-row-status';
    status.textContent = '准备上传…';
    row.append(head, bar, status);
    container.append(row);

    const samples = [];
    return {
      report(loaded) {
        const now = Date.now();
        samples.push({ now, loaded });
        while (samples.length > 2 && now - samples[0].now > 6000) samples.shift();
        const first = samples[0];
        const elapsed = Math.max((now - first.now) / 1000, 0.25);
        const speed = Math.max((loaded - first.loaded) / elapsed, 0);
        const percent = file.size > 0 ? Math.min(100, Math.round((loaded / file.size) * 100)) : 100;
        fill.style.width = percent + '%';
        const eta = speed > 0 ? formatDuration((file.size - loaded) / speed) : '';
        status.textContent = percent + '% · ' + formatSize(loaded) + ' / ' + formatSize(file.size)
          + (speed > 0 ? ' · ' + formatSpeed(speed) : '')
          + (eta ? ' · 剩余 ' + eta : '');
      },
      retry(attempt, message) {
        row.classList.remove('upload-row-resumed');
        row.classList.add('upload-row-retry');
        status.textContent = (message || '连接中断') + '，正在重试（' + attempt + '/' + UPLOAD_TUNING.maxAttempts + '）…';
      },
      resumed(received) {
        row.classList.add('upload-row-resumed');
        status.textContent = '已从 ' + formatSize(received) + ' 处继续上传';
      },
      finish() {
        row.classList.remove('upload-row-retry');
        row.classList.remove('upload-row-resumed');
        row.classList.add('upload-row-done');
        fill.style.width = '100%';
        status.textContent = '上传完成';
      },
      fail(message) {
        row.classList.remove('upload-row-retry');
        row.classList.remove('upload-row-resumed');
        row.classList.add('upload-row-error');
        status.textContent = message || '上传失败';
      },
      cancel() {
        row.classList.remove('upload-row-retry');
        row.classList.remove('upload-row-resumed');
        row.classList.add('upload-row-error');
        status.textContent = '已取消';
      }
    };
  }

  function uploadXhr({ url, method = 'PUT', body, headers = {}, onProgress, control, stallTimeoutMs = UPLOAD_TUNING.stallTimeoutMs }) {
    return new Promise((resolve, reject) => {
      const xhr = new window.XMLHttpRequest();
      let settled = false;
      let stallTimer = null;
      let stalled = false;

      const clearStallTimer = () => {
        if (stallTimer) window.clearTimeout(stallTimer);
        stallTimer = null;
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearStallTimer();
        if (control) control.detach();
        if (error) reject(error); else resolve(value);
      };
      const armStallTimer = () => {
        if (!stallTimeoutMs) return;
        clearStallTimer();
        stallTimer = window.setTimeout(() => {
          stalled = true;
          try { xhr.abort(); } catch {}
        }, stallTimeoutMs);
      };

      xhr.open(method, url, true);
      xhr.responseType = 'text';
      if (state.token) xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
      for (const [headerName, headerValue] of Object.entries(headers)) xhr.setRequestHeader(headerName, headerValue);

      xhr.upload?.addEventListener('progress', event => {
        if (!event.lengthComputable) return;
        armStallTimer();
        if (onProgress) onProgress(event.loaded, event.total);
      });
      xhr.addEventListener('load', () => {
        let payload = {};
        try { payload = JSON.parse(xhr.responseText || '{}') || {}; } catch {}
        if (xhr.status >= 200 && xhr.status < 300) { finish(null, payload); return; }
        if (xhr.status === 401) app.handleAuthFailure('登录已失效，请重新登录');
        const error = new Error(payload?.error || '请求失败（HTTP ' + xhr.status + '）');
        error.status = xhr.status;
        error.payload = payload;
        finish(error);
      });
      xhr.addEventListener('error', () => finish(Object.assign(new Error('网络连接中断'), { network: true })));
      xhr.addEventListener('timeout', () => finish(Object.assign(new Error('请求超时'), { network: true })));
      xhr.addEventListener('abort', () => {
        if (control?.cancelled) {
          finish(Object.assign(new Error('上传已取消'), { cancelled: true }));
          return;
        }
        finish(Object.assign(new Error(stalled ? '连接长时间无响应' : '上传中断'), { network: true, stalled }));
      });
      if (control) control.attach(xhr);
      armStallTimer();
      xhr.send(body);
    });
  }

  function uploadJson(url, { method = 'GET', body } = {}) {
    const headers = {};
    let payload = body;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return apiRequest(url, { token: state.token, fetchImpl, method, headers, body: payload, responseType: 'json' })
      .catch(error => {
        if (error.status === 401) app.handleAuthFailure('登录已失效，请重新登录');
        throw error;
      });
  }

  async function uploadFileResumable(file, row, { isPermanent, control, onProgress }) {
    const initPayload = {
      name: file.name || '未命名文件',
      size: file.size,
      mime: file.type || 'application/octet-stream',
      fingerprint: [file.name, file.size, file.lastModified || 0].join('|'),
      isPermanent: Boolean(isPermanent)
    };
    const session = await uploadJson('/api/upload/init', { method: 'POST', body: initPayload });
    let uploadId = session.uploadId;
    let received = Math.max(0, Number(session.received) || 0);
    row?.report?.(received);
    if (received > 0) row?.resumed?.(received);
    let chunkSize = Math.min(Number(session.chunkSize) || UPLOAD_TUNING.defaultChunkSize, UPLOAD_TUNING.defaultChunkSize);
    const maxChunkSize = Math.max(chunkSize, Math.min(Number(session.maxChunkSize) || chunkSize, UPLOAD_TUNING.defaultChunkSize * 2));
    let attempts = 0;
    let stableChunks = 0;
    let restarted = false;

    const completeUpload = async () => {
      try {
        return await uploadJson('/api/upload/' + encodeURIComponent(uploadId) + '/complete', { method: 'POST' });
      } catch (error) {
        if (error.status !== 404) throw error;
        const clips = await uploadJson('/api/clips').catch(() => null);
        const expectedName = uploadDisplayName(file.name);
        const alreadyStored = Boolean(clips) && [...(clips.files || []), ...(clips.permanent || [])]
          .some(item => item.type === 'file' && item.size === file.size && uploadDisplayName(item.originalName) === expectedName);
        if (alreadyStored) return null;
        throw error;
      }
    };

    while (received < file.size) {
      if (control.cancelled) throw Object.assign(new Error('上传已取消'), { cancelled: true });
      const end = Math.min(received + chunkSize, file.size);
      const chunk = file.slice(received, end);
      try {
        const result = await uploadXhr({
          url: '/api/upload/' + encodeURIComponent(uploadId),
          method: 'PUT',
          headers: { 'X-Upload-Offset': String(received), 'Content-Type': 'application/octet-stream' },
          body: chunk,
          control,
          onProgress: loaded => {
            const uploadedBytes = received + loaded;
            row?.report?.(uploadedBytes);
            if (onProgress) onProgress(uploadedBytes);
          }
        });
        const nextReceived = Number(result?.received);
        received = Number.isFinite(nextReceived) ? nextReceived : end;
        row?.report?.(received);
        attempts = 0;
        stableChunks += 1;
        if (stableChunks >= 3 && chunkSize < maxChunkSize) {
          chunkSize = Math.min(chunkSize * 2, maxChunkSize);
          stableChunks = 0;
        }
      } catch (error) {
        if (error.cancelled) throw error;
        const serverReceived = Number(error.payload?.received);
        if (error.status === 409 && Number.isFinite(serverReceived)) {
          received = Math.max(0, serverReceived);
          attempts += 1;
          if (attempts > UPLOAD_TUNING.maxAttempts) throw new Error('上传状态无法同步，请重新上传');
          await sleep(200);
          continue;
        }
        if (error.status === 404 && !restarted) {
          restarted = true;
          const restartedSession = await uploadJson('/api/upload/init', { method: 'POST', body: initPayload });
          uploadId = restartedSession.uploadId;
          received = Math.max(0, Number(restartedSession.received) || 0);
          attempts = 0;
          continue;
        }
        if (!(error.network || error.status === 408 || error.status === 429 || error.status >= 500)) throw error;
        attempts += 1;
        if (attempts > UPLOAD_TUNING.maxAttempts) {
          throw new Error('网络不稳定，已重试 ' + UPLOAD_TUNING.maxAttempts + ' 次仍未成功，请检查网络后重试');
        }
        row?.retry?.(attempts, error.stalled ? '连接无响应' : '网络中断');
        await sleep(Math.min(UPLOAD_TUNING.retryBaseDelayMs * (2 ** (attempts - 1)), UPLOAD_TUNING.retryMaxDelayMs) + Math.random() * 400);
        chunkSize = Math.max(UPLOAD_TUNING.minChunkSize, Math.floor(chunkSize / 2));
        stableChunks = 0;
        try {
          const status = await uploadJson('/api/upload/' + encodeURIComponent(uploadId), { method: 'GET' });
          received = Math.max(0, Number(status.received) || 0);
        } catch {}
      }
    }
    return completeUpload();
  }

  async function uploadFilesFallback(items, isPermanent, button) {
    let succeeded = true;
    for (let index = 0; index < items.length; index += 1) {
      button.textContent = '上传中 ' + (index + 1) + '/' + items.length;
      const form = new FormData();
      form.append('file', items[index]);
      form.append('isPermanent', String(Boolean(isPermanent)));
      try {
        await request('/api/file', { method: 'POST', body: form });
      } catch (error) {
        succeeded = false;
        if (error.status !== 401) showError('uploadError', error.message || '上传失败');
        break;
      }
    }
    return succeeded;
  }

  app.cancelUpload = () => {
    const control = state.uploadControl;
    if (!control || control.cancelled) return;
    control.cancelled = true;
    setUploadPanelText('正在取消上传…');
    if (control.abort) {
      try { control.abort(); } catch {}
    }
  };

  app.uploadFiles = async (files, isPermanent = false) => {
    const items = Array.from(files || []).filter(Boolean);
    if (!items.length) return false;
    const button = element('uploadBtn');
    button.disabled = true;
    showError('uploadError');
    const supportsProgress = typeof window?.XMLHttpRequest === 'function';
    const control = {
      cancelled: false,
      abort: null,
      attach(xhr) { control.abort = () => { try { xhr.abort(); } catch {} }; },
      detach() { control.abort = null; }
    };
    state.uploadControl = control;
    const totalBytes = items.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    let finishedBytes = 0;
    let completed = 0;
    let succeeded = true;
    let lastButtonUpdate = 0;
    const updateButton = loaded => {
      const overall = totalBytes > 0 ? Math.min(100, Math.round(((finishedBytes + loaded) / totalBytes) * 100)) : 100;
      button.textContent = (items.length > 1 ? '上传中 ' + (completed + 1) + '/' + items.length : '上传中') + ' · ' + overall + '%';
    };
    const updateButtonThrottled = loaded => {
      const now = Date.now();
      if (now - lastButtonUpdate < 300) return;
      lastButtonUpdate = now;
      updateButton(loaded);
    };
    try {
      if (supportsProgress) {
        const rows = element('uploadRows');
        if (rows) rows.textContent = '';
        showUploadPanel(true);
      }
      for (let index = 0; index < items.length; index += 1) {
        if (control.cancelled) { succeeded = false; break; }
        const file = items[index];
        updateButton(0);
        if (supportsProgress) {
          setUploadPanelText((items.length > 1 ? '正在上传 ' + (index + 1) + '/' + items.length + ' · ' : '正在上传 · ') + formatSize(totalBytes));
        }
        const row = supportsProgress ? createUploadRow(file) : null;
        try {
          if (supportsProgress) {
            await uploadFileResumable(file, row, { isPermanent, control, onProgress: updateButtonThrottled });
            row?.finish?.();
          } else if (!(await uploadFilesFallback([file], isPermanent, button))) {
            succeeded = false;
            break;
          }
          finishedBytes += Number(file.size) || 0;
          completed += 1;
          updateButton(0);
          if (state.token) await app.loadClips();
        } catch (error) {
          succeeded = false;
          if (error.cancelled) {
            row?.cancel?.();
            showError('uploadError', '已取消上传');
            break;
          }
          row?.fail?.(error.message || '上传失败');
          if (error.status !== 401) showError('uploadError', (file.name || '文件') + '：' + (error.message || '上传失败'));
          break;
        }
      }
      flashButton(button, succeeded && !control.cancelled);
    } finally {
      state.uploadControl = null;
      button.disabled = false;
      element('fileInput').value = '';
      window.setTimeout(() => { button.textContent = '上传文件'; }, 1300);
      if (succeeded && !control.cancelled) {
        window.setTimeout(() => showUploadPanel(false), 4000);
      }
    }
    return succeeded && !control.cancelled;
  };

  app.handlePaste = async event => {
    if (!state.token || state.pasteInFlight || isEditableTarget(event.target)) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files = Array.from(clipboard.files || []);
    const text = clipboard.getData('text/plain');
    if (!files.length && !text.trim()) return;
    event.preventDefault();
    state.pasteInFlight = true;
    try {
      if (files.length) {
        const namedFiles = files.map(file => file.name
          ? file
          : new File([file], clipboardFileName(file), { type: file.type, lastModified: file.lastModified }));
        await app.uploadFiles(namedFiles);
      } else {
        await app.addText(text);
      }
    } finally {
      state.pasteInFlight = false;
    }
  };

  async function copyImage(button) {
    if (!window.navigator.clipboard || !window.ClipboardItem) throw new Error('浏览器不支持复制图片');
    const pngPromise = request(`/api/file/${encodeURIComponent(button.dataset.id)}/download`, { responseType: 'blob' }).then(blob => new Promise((resolve, reject) => {
      const image = new window.Image();
      const url = window.URL.createObjectURL(blob);
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        window.URL.revokeObjectURL(url);
        canvas.toBlob(result => result ? resolve(result) : reject(new Error('图片转换失败')), 'image/png');
      };
      image.onerror = () => {
        window.URL.revokeObjectURL(url);
        reject(new Error('图片读取失败'));
      };
      image.src = url;
    }));
    await window.navigator.clipboard.write([new window.ClipboardItem({ 'image/png': pngPromise })]);
  }

  async function downloadFile(button) {
    const blob = await request(`/api/file/${encodeURIComponent(button.dataset.id)}/download`, { responseType: 'blob' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = button.dataset.name;
    anchor.click();
    window.URL.revokeObjectURL(url);
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    try {
      if (action === 'copy') await window.navigator.clipboard.writeText(state.textById.get(button.dataset.id) ?? '');
      else if (action === 'copy-image') await copyImage(button);
      else if (action === 'download') await downloadFile(button);
      else if (action === 'delete') {
        if (!confirmImpl('确定删除吗?')) return;
        await request(`/api/clip/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
        await app.loadClips();
      } else if (action === 'permanent') {
        await request(`/api/clip/${encodeURIComponent(button.dataset.id)}/permanent`, { method: 'POST' });
        await app.loadClips();
      }
      flashButton(button, true);
    } catch (error) {
      if (error.status !== 401) showError('uploadError', error.message || '操作失败');
      flashButton(button, false);
    }
  }

  function selectTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(button => {
      const active = button.dataset.tab === tabName;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    element('tempTab').classList.toggle('active', tabName === 'temp');
    element('permanentTab').classList.toggle('active', tabName === 'permanent');
    element('tempList').hidden = tabName !== 'temp';
    element('permanentList').hidden = tabName !== 'permanent';
  }

  function onClick(event) {
    const actionButton = event.target.closest('.item-btn');
    if (actionButton) {
      handleAction(actionButton);
      return;
    }
    if (event.target.closest('#textSaveBtn')) app.addText();
    else if (event.target.closest('#uploadBtn')) app.uploadFiles(element('fileInput').files);
    else if (event.target.closest('#uploadCancelBtn')) app.cancelUpload();
    else if (event.target.closest('#logoutBtn')) app.logout();
    else if (event.target.closest('.tab-btn')) selectTab(event.target.closest('.tab-btn').dataset.tab);
    else if (event.target.closest('#dropZone') && event.target !== element('fileInput')) element('fileInput').click();
  }

  function onDragOver(event) {
    event.preventDefault();
    document.body.classList.add('drag-over');
  }

  function onDragLeave(event) {
    event.preventDefault();
    if (!event.relatedTarget) document.body.classList.remove('drag-over');
  }

  function onDrop(event) {
    event.preventDefault();
    document.body.classList.remove('drag-over');
    if (event.dataTransfer?.files?.length) app.uploadFiles(event.dataTransfer.files);
  }

  function onFileChange(event) {
    if (event.target.files?.length) app.uploadFiles(event.target.files);
  }

  app.setupInputHandlers = () => {
    if (state.handlersInstalled) return;
    state.handlersInstalled = true;
    document.addEventListener('click', onClick);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    document.addEventListener('paste', app.handlePaste);
    element('fileInput')?.addEventListener('change', onFileChange);
    element('loginForm')?.addEventListener('submit', event => {
      event.preventDefault();
      app.login();
    });
  };

  app.loadApp = () => {
    element('loginForm').classList.remove('active');
    element('appView').classList.add('active');
    app.setupInputHandlers();
    app.loadClips();
    if (state.refreshTimer) window.clearInterval(state.refreshTimer);
    state.refreshTimer = window.setInterval(app.loadClips, 5000);
  };

  app.logout = async () => {
    if (!confirmImpl('确定退出吗?')) return;
    try { await request('/api/logout', { method: 'POST' }); } catch {}
    app.handleAuthFailure('');
    element('loginUsername').value = '';
    element('loginPassword').value = '';
  };

  app.start = () => {
    app.setupInputHandlers();
    if (state.token) app.loadApp();
  };
  app.previewManager = previewManager;
  app.state = state;
  return app;
}
