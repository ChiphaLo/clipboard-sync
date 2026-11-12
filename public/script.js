import { createClipboardApp } from './clipboard-app.js';

const trustedToken = localStorage.getItem('token');
const temporaryToken = sessionStorage.getItem('token');
const token = temporaryToken || trustedToken;
const sessionMode = temporaryToken
  ? sessionStorage.getItem('sessionMode') || 'temp'
  : localStorage.getItem('sessionMode') || (trustedToken ? 'trusted' : null);

createClipboardApp({
  document,
  window,
  initialToken: token,
  initialSessionMode: sessionMode
}).start();
