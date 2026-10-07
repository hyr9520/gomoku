// 巡天 · 太阳系互动图鉴 — 静态托管服务器（Render/通用 PaaS 兼容）
// 本地运行：node server.js（默认 8642）；托管平台自动注入 PORT
// 特性：gzip 压缩（实测 5.4MB→3.9MB，-28.6%）· ETag 协商缓存 · 安全响应头 · 路径越界防护
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const PORT = process.env.PORT || 8642;
const ROOT = path.normalize(__dirname + path.sep);   // 带尾分隔符：防同前缀兄弟目录越界

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
const COMPRESSIBLE = /^text\/|^application\/(json|javascript)/;

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { res.writeHead(400); res.end(); return; }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = 'W/"' + crypto.createHash('md5').update(data).digest('hex').slice(0, 16) + '"';

    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Vary': 'Accept-Encoding'
    };
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip && COMPRESSIBLE.test(type) && data.length > 1024) {
      headers['Content-Encoding'] = 'gzip';
      zlib.gzip(data, { level: 8 }, (e, buf) => {
        if (e) { delete headers['Content-Encoding']; res.writeHead(200, headers); res.end(data); return; }
        headers['Content-Length'] = buf.length;
        res.writeHead(200, headers);
        res.end(buf);
      });
    } else {
      headers['Content-Length'] = data.length;
      res.writeHead(200, headers);
      res.end(data);
    }
  });
}).listen(PORT, () => {
  console.log('巡天 Solar Atlas serving on port ' + PORT + '（gzip 开启）');
});
