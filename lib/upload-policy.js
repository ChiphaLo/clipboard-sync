import fs from 'node:fs';

const BLOCKED_MIME_TYPES = new Set([
  'application/x-bat',
  'application/x-executable',
  'application/x-msdos-program',
  'application/x-msdownload',
  'application/x-sh',
  'application/x-shellscript'
]);

function startsWith(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function ascii(buffer, start, length) {
  return buffer.subarray(start, start + length).toString('ascii');
}

function isExecutable(buffer) {
  const executableMagic = [
    [0x4d, 0x5a],
    [0x7f, 0x45, 0x4c, 0x46],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xfe, 0xed, 0xfa, 0xce],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca]
  ];
  return executableMagic.some(magic => startsWith(buffer, magic)) || ascii(buffer, 0, 2) === '#!';
}

function detectKind(buffer, clientMime) {
  if (ascii(buffer, 0, 6) === 'GIF87a' || ascii(buffer, 0, 6) === 'GIF89a') return 'image';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image';
  if (ascii(buffer, 0, 2) === 'BM') return 'image';
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP') return 'image';
  if (ascii(buffer, 4, 4) === 'ftyp') return 'video';
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'video';
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'AVI ') return 'video';
  if (clientMime?.startsWith('text/') || !buffer.includes(0)) return 'text';
  return 'binary';
}

export function inspectUpload(filePath, clientMime = 'application/octet-stream') {
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(4096);
  let bytesRead;
  try {
    bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const header = buffer.subarray(0, bytesRead);

  if (BLOCKED_MIME_TYPES.has(clientMime) || isExecutable(header)) {
    return {
      allowed: false,
      reason: '禁止上传可执行或脚本文件',
      detectedKind: 'executable'
    };
  }

  return {
    allowed: true,
    reason: null,
    detectedKind: detectKind(header, clientMime)
  };
}
