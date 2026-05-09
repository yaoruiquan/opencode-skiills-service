const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");

function httpJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      timeout: options.timeoutMs || 10_000,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout requesting ${url}`)));
    req.end();
  });
}

async function getPageWebSocket(browserBaseUrl) {
  const base = browserBaseUrl.replace(/\/+$/, "");
  let pages = await httpJson(`${base}/json/list`);
  let page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  if (!page) {
    try {
      page = await httpJson(`${base}/json/new?${encodeURIComponent("about:blank")}`);
    } catch {
      page = await httpJson(`${base}/json/new`, { method: "PUT" });
    }
  }
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`no page websocket from ${base}`);
  }
  return page.webSocketDebuggerUrl;
}

class WebSocketCdp {
  constructor(wsUrl) {
    this.wsUrl = new URL(wsUrl);
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const socket = net.createConnection({
        host: this.wsUrl.hostname,
        port: Number(this.wsUrl.port || 80),
      });
      this.socket = socket;
      let handshake = Buffer.alloc(0);
      const cleanup = () => {
        socket.off("data", onHandshakeData);
        socket.off("error", onError);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onHandshakeData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const marker = handshake.indexOf("\r\n\r\n");
        if (marker === -1) return;
        const header = handshake.slice(0, marker).toString("utf8");
        if (!/^HTTP\/1\.1 101/i.test(header)) {
          cleanup();
          reject(new Error(`websocket handshake failed: ${header.split("\r\n")[0]}`));
          return;
        }
        cleanup();
        const rest = handshake.slice(marker + 4);
        socket.on("data", (data) => this.onData(data));
        socket.on("error", (error) => this.rejectAll(error));
        socket.on("close", () => this.rejectAll(new Error("CDP websocket closed")));
        if (rest.length) this.onData(rest);
        resolve(this);
      };
      socket.on("error", onError);
      socket.on("data", onHandshakeData);
      socket.write([
        `GET ${this.wsUrl.pathname}${this.wsUrl.search} HTTP/1.1`,
        `Host: ${this.wsUrl.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
  }

  close() {
    this.socket?.destroy();
  }

  rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        length = high * 2 ** 32 + low;
        offset = 10;
      }
      const masked = Boolean(second & 0x80);
      const maskOffset = masked ? 4 : 0;
      const frameEnd = offset + maskOffset + length;
      if (this.buffer.length < frameEnd) return;
      let payload = this.buffer.slice(offset + maskOffset, frameEnd);
      if (masked) {
        const mask = this.buffer.slice(offset, offset + 4);
        payload = payload.map((byte, index) => byte ^ mask[index % 4]);
      }
      this.buffer = this.buffer.slice(frameEnd);
      if (opcode === 0x8) {
        this.rejectAll(new Error("CDP websocket closed"));
        return;
      }
      if (opcode !== 0x1) continue;
      this.onMessage(payload.toString("utf8"));
    }
  }

  onMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
    } else {
      pending.resolve(message.result || {});
    }
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
    const frame = encodeClientFrame(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(frame);
    });
  }

  async evaluate(expression, options = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: true,
      userGesture: true,
      timeout: options.timeoutMs || 30_000,
    }, options.timeoutMs || 30_000);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate exception");
    }
    return result.result?.value;
  }

  async evaluateFunction(functionSource, ...args) {
    const encodedArgs = args.map((arg) => JSON.stringify(arg)).join(",");
    return this.evaluate(`(${functionSource})(${encodedArgs})`);
  }
}

function encodeClientFrame(payload) {
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

async function connectToPage(browserBaseUrl) {
  const wsUrl = await getPageWebSocket(browserBaseUrl);
  const client = await new WebSocketCdp(wsUrl).connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("DOM.enable");
  return client;
}

module.exports = {
  WebSocketCdp,
  connectToPage,
  getPageWebSocket,
  httpJson,
};
