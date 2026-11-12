import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const TIMEOUT_MS = 15_000;

export function buildPreviewArgs(inputPath) {
  return [
    '-nostdin',
    '-v', 'error',
    '-protocol_whitelist', 'file,pipe',
    '-i', inputPath,
    '-vf', 'thumbnail,scale=640:-2:force_original_aspect_ratio=decrease,format=yuvj420p',
    '-frames:v', '1',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1'
  ];
}

function generatePreviewWorker({ inputPath, ffmpegPath = 'ffmpeg' }) {
  const args = buildPreviewArgs(inputPath);

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    let size = 0;
    let errorSize = 0;
    let settled = false;

    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('预览生成超时'));
    }, TIMEOUT_MS);

    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('预览输出过大'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (errorSize >= MAX_ERROR_BYTES) return;
      const remaining = MAX_ERROR_BYTES - errorSize;
      const retained = chunk.subarray(0, remaining);
      errors.push(retained);
      errorSize += retained.length;
    });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (settled) return;
      const output = Buffer.concat(chunks);
      if (code !== 0 || output.length === 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        finish(new Error(detail || '无法生成预览'));
        return;
      }
      finish(null, output);
    });
  });
}

export function createPreviewGenerator({ maxConcurrent = 2, maxQueued = 8, worker = generatePreviewWorker } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new TypeError('maxConcurrent must be a positive integer');
  }
  if (!Number.isInteger(maxQueued) || maxQueued < 0) {
    throw new TypeError('maxQueued must be a non-negative integer');
  }
  if (typeof worker !== 'function') throw new TypeError('worker must be a function');

  const queue = [];
  let active = 0;

  const drain = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const task = queue.shift();
      active += 1;
      Promise.resolve()
        .then(() => worker(task.options))
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return options => new Promise((resolve, reject) => {
    if (active >= maxConcurrent && queue.length >= maxQueued) {
      const error = new Error('预览服务繁忙，请稍后重试');
      error.status = 503;
      reject(error);
      return;
    }
    queue.push({ options, resolve, reject });
    drain();
  });
}

export const generatePreview = createPreviewGenerator();
