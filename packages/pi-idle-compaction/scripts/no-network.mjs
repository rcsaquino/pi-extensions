// Test process preload only. Never loaded by the installed extension.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
let attempts = 0;
const forbidden = () => { attempts++; throw Error('Network forbidden during offline verification'); };
globalThis.fetch = async () => forbidden();
http.request = forbidden;
http.get = forbidden;
https.request = forbidden;
https.get = forbidden;
net.Socket.prototype.connect = forbidden;
process.on('exit', () => {
  if (attempts) { console.error(`Offline test attempted ${attempts} network operation(s)`); process.exitCode = 1; }
});
