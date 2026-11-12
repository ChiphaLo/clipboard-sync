import path from 'node:path';

export function resolveRuntimePaths(projectDir, env = process.env) {
  return {
    dataFile: path.resolve(env.DATA_FILE || path.join(projectDir, 'data.json')),
    uploadDir: path.resolve(env.UPLOAD_DIR || path.join(projectDir, 'uploads')),
    publicDir: path.resolve(path.join(projectDir, 'public'))
  };
}
