// Minimal Chrome DevTools Protocol client.
//
// Node 20 has no global WebSocket and this repo has no dependencies to spare,
// so this speaks just enough of RFC 6455 to drive a headless browser: one
// upgrade, masked text frames out, unmasked text frames in. No fragmentation,
// no extensions, no compression — which is all `Runtime.evaluate` needs.

import crypto from 'node:crypto';
import net from 'node:net';

function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode

  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3];

  return Buffer.concat([header, mask, masked]);
}

/** Returns null until the buffer holds a whole frame. */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;

  const slice = buffer.subarray(offset, offset + length);
  let payload = slice;
  if (mask) {
    payload = Buffer.from(slice);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }

  return { opcode, payload, size: offset + length };
}

async function openSocket(url, timeoutMs) {
  const target = new URL(url);
  const socket = net.connect({ host: target.hostname, port: Number(target.port) || 80 });
  socket.setNoDelay(true);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket handshake timed out: ${url}`)), timeoutMs);

    const fail = (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.once('error', fail);
    socket.once('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });

    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;

      socket.off('data', onData);
      socket.off('error', fail);
      clearTimeout(timer);

      const status = head.subarray(0, end).toString('latin1').split('\r\n')[0];
      if (!status.includes('101')) {
        socket.destroy();
        reject(new Error(`websocket handshake failed: ${status}`));
        return;
      }

      resolve({ socket, rest: head.subarray(end + 4) });
    };

    socket.on('data', onData);
  });
}

export class Cdp {
  #socket;
  #buffer;
  #id = 1;
  #pending = new Map();

  constructor(socket, rest) {
    this.#socket = socket;
    this.#buffer = rest ?? Buffer.alloc(0);

    socket.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('devtools socket closed')));

    this.#drain();
  }

  /** Connect to a page target at `ws://host:port/devtools/page/<id>`. */
  static async connect(wsUrl, timeoutMs = 10000) {
    const { socket, rest } = await openSocket(wsUrl, timeoutMs);
    return new Cdp(socket, rest);
  }

  request(method, params = {}) {
    const id = this.#id++;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(encodeFrame(message));
    });
  }

  /** Run an expression in the page and return its value. */
  async evaluate(expression) {
    const result = await this.request('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description ?? detail.text ?? 'evaluate failed');
    }

    return result.result?.value;
  }

  close() {
    this.#socket.destroy();
  }

  #fail(error) {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  #drain() {
    for (;;) {
      const frame = decodeFrame(this.#buffer);
      if (!frame) return;

      this.#buffer = this.#buffer.subarray(frame.size);

      if (frame.opcode === 0x9) {
        this.#socket.write(encodeFrame(frame.payload.toString('utf8'), 0x0a)); // ping → pong
        continue;
      }
      if (frame.opcode !== 0x1) continue;

      let message;
      try {
        message = JSON.parse(frame.payload.toString('utf8'));
      } catch {
        continue;
      }

      const entry = message.id === undefined ? undefined : this.#pending.get(message.id);
      if (!entry) continue;

      this.#pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  }
}
