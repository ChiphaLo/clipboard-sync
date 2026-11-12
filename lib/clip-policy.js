export const DEFAULT_LIMITS = Object.freeze({
  maxTextBytes: 32 * 1024,
  maxTextStorageBytes: 4 * 1024 * 1024,
  maxItems: 2000,
  maxFileBytes: 1024 * 1024 * 1024,
  maxFileStorageBytes: 10 * 1024 * 1024 * 1024
});

function policyError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function categories(clips = {}) {
  return ['texts', 'files', 'permanent'].map(name => Array.isArray(clips[name]) ? clips[name] : []);
}

export function getTextBytes(clips = {}) {
  return categories(clips)
    .flat()
    .filter(item => item?.type === 'text')
    .reduce((total, item) => total + Buffer.byteLength(String(item.content ?? ''), 'utf8'), 0);
}

export function getItemCount(clips = {}) {
  return categories(clips).reduce((total, items) => total + items.length, 0);
}

export function validateText(content, clips = {}, limits = DEFAULT_LIMITS) {
  if (typeof content !== 'string' || !content.trim()) {
    throw policyError(400, '内容不能为空');
  }

  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > limits.maxTextBytes) {
    throw policyError(413, '文本超过 32 KB 限制');
  }
  if (getItemCount(clips) >= limits.maxItems) {
    throw policyError(413, '项目数量已达上限');
  }
  if (getTextBytes(clips) + bytes > limits.maxTextStorageBytes) {
    throw policyError(413, '文本存储空间已满');
  }

  return content;
}
