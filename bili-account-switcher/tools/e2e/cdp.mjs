/**
 * 极简 CDP 客户端（Node 自带 WebSocket，不引依赖）。
 *
 * 只做用得到的几件事：连上某个 target、发一条命令、等回包、求值一个表达式。
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function browserVersion(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 浏览器还没起来 */
    }
    await wait(300);
  }
  throw new Error(`${timeoutMs}ms 内连不上 127.0.0.1:${port} 的调试端口`);
}

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

/** 等某个 target 出现（按 URL 子串匹配）。 */
export async function waitForTarget(port, match, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const t of await listTargets(port)) {
      const hay = `${t.url || ""} ${t.title || ""}`;
      if (hay.includes(match)) return t;
    }
    await wait(400);
  }
  throw new Error(`没等到含有「${match}」的 target`);
}

/** 通过浏览器级 WebSocket 新建一个标签页，返回 targetId。 */
export async function createTarget(port, url) {
  const version = await browserVersion(port);
  const ws = await connect(version.webSocketDebuggerUrl);
  try {
    const { targetId } = await ws.send("Target.createTarget", { url });
    return targetId;
  } finally {
    ws.close();
  }
}

export async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", (e) => reject(new Error(`WS 连接失败：${e?.message || "error"}`)), { once: true });
  });

  let seq = 0;
  const pending = new Map();
  const listeners = [];

  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`));
      else resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });

  return {
    onEvent(fn) {
      listeners.push(fn);
    },
    send(method, params = {}) {
      seq += 1;
      const id = seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${method} 超时`));
          }
        }, 30_000);
      });
    },
    async evaluate(expression) {
      const res = await this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (res.exceptionDetails) {
        throw new Error(`求值出错：${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
      }
      return res.result?.value;
    },
    close() {
      try {
        socket.close();
      } catch {
        /* 已经关了 */
      }
    },
  };
}
