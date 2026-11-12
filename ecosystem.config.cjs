module.exports = {
  apps: [{
    name: 'clipboard-sync',
    script: './server.js',
    cwd: '/opt/clipboard-sync',
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: process.env.PORT || 35281,
      DATA_FILE: '/var/lib/clipboard-sync/data.json',
      UPLOAD_DIR: '/var/lib/clipboard-sync/uploads',
      MAX_FILE_BYTES: 1073741824,
      MAX_FILE_STORAGE_BYTES: 10737418240
    },
    autorestart: true,
    max_restarts: 3,
    min_uptime: '10s',
    max_memory_restart: '500M'
  }]
};
