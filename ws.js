/*
 * 零依赖 WebSocket 服务端实现 (RFC 6455)
 *
 * 仅实现本游戏所需的能力: 文本帧收发、ping/pong 心跳、关闭握手、分片消息合并。
 * 用法:
 *   const http = require('http');
 *   const server = http.createServer(...);
 *   server.on('upgrade', (req, socket) => {
 *     const conn = ws.accept(req, socket);
 *     if (!conn) return;
 *     conn.on('message', str => ...);
 *     conn.on('close', () => ...);
 *     conn.send('hello');
 *   });
 */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20; // 1MB

const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BINARY = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this._buf = Buffer.alloc(0);
    this._fragOp = null;
    this._fragChunks = [];
    this._closed = false;
    this._alive = true; // 心跳: 发出 ping 后等待 pong/任何帧
    socket.on('data', (d) => this._onData(d));
    socket.on('error', () => this._teardown());
    socket.on('close', () => this._teardown());
    // 对端半关闭(FIN)即视为断开: WebSocket 没有有意义的半开状态
    socket.on('end', () => this._teardown());
    socket.setNoDelay(true);
  }

  _onData(chunk) {
    this._alive = true;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try {
      while (this._parseFrame()) { /* 逐帧解析直到缓冲不足 */ }
    } catch (e) {
      this.emit('error', e);
      this.close(1002);
    }
  }

  // 返回 true 表示解析了一帧; false 表示数据不足
  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    if (buf[0] & 0x70) throw new Error('rsv bits set'); // 未协商扩展
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD)) throw new Error('payload too large');
      len = Number(big); off = 10;
    }
    if (len > MAX_PAYLOAD) throw new Error('payload too large');
    const maskKey = masked ? 4 : 0;
    if (buf.length < off + maskKey + len) return false;

    let payload = buf.subarray(off + maskKey, off + maskKey + len);
    if (masked) {
      payload = Buffer.from(payload); // 拷贝以便去掩码
      const key = buf.subarray(off, off + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    }
    this._buf = buf.subarray(off + maskKey + len);

    switch (opcode) {
      case OP_TEXT:
      case OP_BINARY:
        if (this._fragOp !== null) throw new Error('unexpected new frame during fragmentation');
        if (fin) {
          if (opcode === OP_TEXT) this._emitText(payload);
        } else {
          this._fragOp = opcode;
          this._fragChunks = [payload];
        }
        break;
      case OP_CONT: {
        if (this._fragOp === null) throw new Error('continuation without start');
        this._fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragChunks);
          const op = this._fragOp;
          this._fragOp = null; this._fragChunks = [];
          if (op === OP_TEXT) this._emitText(full);
        }
        break;
      }
      case OP_CLOSE:
        this._sendFrame(OP_CLOSE, payload.subarray(0, 2));
        this._teardown();
        break;
      case OP_PING:
        this._sendFrame(OP_PONG, payload);
        break;
      case OP_PONG:
        break;
      default:
        throw new Error('unknown opcode ' + opcode);
    }
    return true;
  }

  _emitText(payload) {
    if (this._closed) return;
    this.emit('message', payload.toString('utf8'));
  }

  _sendFrame(opcode, payload) {
    if (this._closed || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch (e) {
      return false;
    }
  }

  send(str) {
    return this._sendFrame(OP_TEXT, Buffer.from(String(str), 'utf8'));
  }

  ping() {
    this._alive = false;
    this._sendFrame(OP_PING, Buffer.alloc(0));
  }

  // 两次心跳未响应视为死连接
  isAlive() { return this._alive; }

  close(code = 1000) {
    if (!this._closed) {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code, 0);
      this._sendFrame(OP_CLOSE, b);
    }
    // 给对端一点时间收到 close 帧后销毁
    const s = this.socket;
    setTimeout(() => { try { s.destroy(); } catch (e) {} }, 50);
    this._teardown();
  }

  _teardown() {
    if (this._closed) return;
    this._closed = true;
    try { this.socket.destroy(); } catch (e) {}
    this.emit('close');
  }

  get isOpen() { return !this._closed; }
}

// 处理 HTTP Upgrade 请求, 成功返回 WSConnection, 失败返回 null
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = (req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const acceptKey = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey + '\r\n' +
    '\r\n'
  );
  return new WSConnection(socket);
}

module.exports = { accept, WSConnection };
