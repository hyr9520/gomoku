/*
 * 联机五子棋 服务端 (零依赖)
 *
 * 运行: node server.js   [PORT=3000]
 * 功能: 静态页面 + WebSocket 对战服务 + /info 局域网地址查询
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ws = require('./ws.js');
const game = require('./game.js');

const PORT = Number(process.env.PORT) || 3000;
// 前端文件平铺在项目根目录 (index.html / style.css / *.js)
const PUBLIC_DIR = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    const bound = server.address();
    res.end(JSON.stringify({ ips: lanIPs(), port: bound ? bound.port : PORT, rooms: game.roomCount() }));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  // 静态资源
  const safe = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (!err && st.isFile()) {
      serveFile(res, filePath);
    } else if (!err && st.isDirectory()) {
      serveFile(res, path.join(filePath, 'index.html'));
    } else {
      // SPA 回退: /r/房间码 等路径交给前端处理
      if (path.extname(safe) === '') {
        serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      }
    }
  });
});

const conns = new Set();

server.on('upgrade', (req, socket) => {
  const conn = ws.accept(req, socket);
  if (!conn) return;
  conns.add(conn);
  conn.on('close', () => conns.delete(conn));
  game.handleConnection(conn);
});

// WebSocket 心跳: 每 25s 探测, 两轮无响应判定死连接
setInterval(() => {
  for (const conn of conns) {
    if (!conn.isAlive()) { try { conn.socket.destroy(); } catch (e) { } conns.delete(conn); continue; }
    conn.ping();
  }
}, 25 * 1000).unref();

// 房间清理
setInterval(() => game.gc(), 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const ips = lanIPs();
    console.log('');
    console.log('  五子棋 · 联机对战服务已启动');
    console.log('  ──────────────────────────────');
    console.log('  本机访问:   http://localhost:' + PORT);
    for (const ip of ips) {
      console.log('  局域网访问: http://' + ip + ':' + PORT + '   (同一 WiFi 下的手机可直接打开)');
    }
    if (ips.length === 0) console.log('  (未检测到局域网 IP, 外网访问需部署到公网服务器)');
    console.log('  ──────────────────────────────');
    console.log('  好友加入方式: 创建房间后, 把邀请链接通过微信发给好友');
    console.log('');
  });
}

process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e && e.message);
});

module.exports = { server, lanIPs };
