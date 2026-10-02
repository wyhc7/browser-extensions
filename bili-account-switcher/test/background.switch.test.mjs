/**
 * service worker 的端到端测试。
 *
 * 这里把 chrome.* 全部换成内存实现（cookie 罐 / storage / 标签页 / 事件总线），
 * 用假的 /x/web-interface/nav 按"罐里当前的 SESSDATA 是谁"来回答身份 ——
 * 于是"切完 cookie 之后我们到底变成了谁"这件事可以被真正断言，而不是靠读代码推断。
 *
 * 每个用例都重新 import 一次 background.js（加不同的 query，拿到全新的模块实例），
 * 避免模块级状态互相污染。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";

/** 罐里 SESSDATA → 这个 SESSDATA 代表谁（"-rotated" 后缀表示同一个人换了新凭据）。 */
const IDENTITY = {
  A: { mid: 111, uname: "账号甲", level: 5, vip: true },
  B: { mid: 222, uname: "账号乙", level: 3, vip: false },
  C: { mid: 333, uname: "账号丙", level: 6, vip: false },
};

function cookie(name, value, overrides = {}) {
  return {
    name,
    value,
    domain: ".bilibili.com",
    path: "/",
    secure: true,
    httpOnly: true,
    hostOnly: false,
    session: false,
    sameSite: "no_restriction",
    expirationDate: 2_000_000_000,
    storeId: "0",
    ...overrides,
  };
}

/** 一个账号的完整身份 Cookie 组 */
function accountCookies(tag, mid) {
  return [
    cookie("SESSDATA", tag),
    cookie("bili_jct", `jct-${mid}`, { httpOnly: false }),
    cookie("DedeUserID", String(mid), { httpOnly: false }),
    cookie("DedeUserID__ckMd5", `ck-${mid}`, { httpOnly: false, secure: false }),
    cookie("sid", `sid-${mid}`, { session: true, expirationDate: undefined }),
  ];
}

const DEVICE_COOKIE = cookie("buvid3", "DEVICE-FINGERPRINT");
const PREFS_COOKIE = cookie("CURRENT_FNVAL", "4048", { httpOnly: false, secure: false });

/**
 * 一台内存浏览器。
 *
 * 几个可调的行为开关，用来复现真实引擎里观察到的拒绝方式：
 *  - setThrowsOnHttp / removeFailsOnHttp：Chrome 的 Cookie 会按 scheme 绑定，
 *    URL 的 scheme 对不上时 set 会抛 "Failed to parse or set"、remove 会返回 null；
 *  - dropWrites：写进去但没生效（静默丢弃）。
 */
function createBrowser({
  jar = [],
  accounts = [],
  settings = {},
  setThrowsOnHttp = false,
  removeFailsOnHttp = false,
  dropWrites = 0,
} = {}) {
  const state = {
    jar: jar.map((c) => ({ ...c })),
    store: { accounts, settings },
    reloaded: [],
    badge: null,
    requests: [],
    revoked: new Set(),
    dropWrites,
    setCalls: 0,
    removeCalls: 0,
  };
  const listeners = { message: [], command: [] };

  const domainMatches = (cookieDomain, host) => {
    const bare = cookieDomain.replace(/^\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  };

  const api = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in state.store) out[key] = state.store[key];
          return out;
        },
        async set(patch) {
          Object.assign(state.store, patch);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete state.store[key];
        },
      },
    },
    cookies: {
      async getAll(query = {}) {
        const domain = query.domain;
        return state.jar
          .filter((c) => !domain || domainMatches(c.domain, domain.replace(/^\./, "")))
          .map((c) => ({ ...c }));
      },
      async set(details) {
        state.setCalls += 1;
        if (setThrowsOnHttp && String(details.url).startsWith("http:")) {
          throw new Error(`Failed to parse or set cookie named "${details.name}".`);
        }
        if (state.dropWrites > 0) {
          state.dropWrites -= 1;
          return null;
        }
        const url = new URL(details.url);
        const hostOnly = !details.domain;
        const domain = details.domain ?? url.hostname;
        const path = details.path ?? "/";
        const index = state.jar.findIndex(
          (c) => c.name === details.name && c.domain === domain && c.path === path,
        );
        const stored = {
          name: details.name,
          value: details.value,
          domain,
          path,
          secure: !!details.secure,
          httpOnly: !!details.httpOnly,
          hostOnly,
          session: typeof details.expirationDate !== "number",
          sameSite: details.sameSite,
          storeId: "0",
          ...(typeof details.expirationDate === "number"
            ? { expirationDate: details.expirationDate }
            : {}),
        };
        if (index >= 0) state.jar[index] = stored;
        else state.jar.push(stored);
        return stored;
      },
      async remove({ url, name }) {
        state.removeCalls += 1;
        if (removeFailsOnHttp && String(url).startsWith("http:")) return null;
        const parsed = new URL(url);
        const path = parsed.pathname || "/";
        const index = state.jar.findIndex(
          (c) =>
            c.name === name &&
            domainMatches(c.domain, parsed.hostname) &&
            (c.hostOnly ? c.domain === parsed.hostname : true) &&
            c.path === path,
        );
        if (index < 0) return null;
        const [removed] = state.jar.splice(index, 1);
        return { url, name: removed.name };
      },
    },
    action: {
      async setBadgeText({ text }) {
        state.badge = text;
      },
      async setBadgeBackgroundColor() {},
    },
    tabs: {
      async query() {
        return [{ id: 11 }, { id: 12 }];
      },
      async reload(id) {
        state.reloaded.push(id);
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getManifest: () => ({ name: "B站多账号切换", version: "1.2.0" }),
    },
  };

  // 假的 nav 接口：身份完全由罐里的 SESSDATA 决定，跟真站点行为一致
  async function fetchStub(url) {
    state.requests.push(url);
    if (url !== NAV_URL) throw new Error(`未预期的请求：${url}`);
    const sess = state.jar.find((c) => c.name === "SESSDATA")?.value;
    const ident = sess ? IDENTITY[String(sess).split("-")[0]] : null;
    // 被服务端注销的 Token（保存它时点过"退出登录"就会这样）
    if (!ident || state.revoked.has(sess)) {
      return { ok: true, json: async () => ({ code: -101, data: { isLogin: false } }) };
    }
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          isLogin: true,
          mid: ident.mid,
          uname: ident.uname,
          face: "https://i0.hdslb.com/bfs/face/x.jpg",
          level_info: { current_level: ident.level },
          vipStatus: ident.vip ? 1 : 0,
          vip_label: { text: "年度大会员" },
        },
      }),
    };
  }

  return { state, api, listeners, fetchStub };
}

let moduleCounter = 0;

/**
 * 装载一份真实的 background.js，返回可以驱动它的入口。
 *
 * 注意：background.js 里 `chrome` / `fetch` 是**调用时**才解析的全局，
 * 所以每次派发消息前都要把本用例的环境装回去，不能在 import 之后就还原。
 */
async function loadWorker(browser) {
  const install = () => {
    globalThis.chrome = browser.api;
    globalThis.fetch = browser.fetchStub;
  };

  install();
  const url = new URL("../extension/src/background.js", import.meta.url).href;
  await import(`${url}?case=${(moduleCounter += 1)}`);

  const listener = browser.listeners.message.at(-1);
  assert.ok(listener, "background.js 没有注册 onMessage 监听");

  return {
    /** 像 popup 一样发一条消息，拿到 sendResponse 的结果 */
    send(message) {
      install();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`消息 ${message.type} 没有响应`)), 3000);
        listener(message, {}, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      });
    },
    /** 等异步流程跑到满足条件为止 */
    async until(predicate, timeout = 1500) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return predicate();
    },
  };
}

/** 直接改罐子，模拟"用户在浏览器里退出登录 / 重新登录" */
function replaceJar(browser, cookies) {
  browser.state.jar = cookies.map((c) => ({ ...c }));
}

const readJar = (browser, name) =>
  browser.state.jar.filter((c) => c.name === name).map((c) => c.value).sort();

const rotateSessdata = (browser, value) => {
  browser.state.jar = browser.state.jar.map((c) =>
    c.name === "SESSDATA" ? { ...c, value } : c,
  );
};

test("保存 → 切换：cookie 罐被换成目标账号，且不留上一个账号的残渣", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111), DEVICE_COOKIE, PREFS_COOKIE] });
  const { send } = await loadWorker(browser);

  const saved = await send({ type: "save" });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.saved.name, "账号甲");
  assert.equal(browser.state.store.accounts.length, 1);
  assert.equal(browser.state.store.accounts[0].cookies.length, 5);
  // 设备指纹与播放器偏好不在管辖范围内，不占快照
  assert.equal(browser.state.store.accounts[0].cookies.some((c) => c.name === "buvid3"), false);

  // 用户退出登录、登进另一个账号
  replaceJar(browser, [...accountCookies("B", 222), DEVICE_COOKIE, PREFS_COOKIE]);
  const savedB = await send({ type: "save" });
  assert.equal(savedB.ok, true, savedB.error);
  assert.equal(browser.state.store.accounts.length, 2);

  const targetA = browser.state.store.accounts.find((a) => a.mid === "111");
  const result = await send({ type: "switch", id: targetA.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.applied, 5);
  assert.equal(result.reloaded, 2);
  assert.deepEqual(browser.state.reloaded, [11, 12]);

  // 罐子里现在只有一个账号的身份
  assert.deepEqual(readJar(browser, "SESSDATA"), ["A"]);
  assert.deepEqual(readJar(browser, "DedeUserID"), ["111"]);
  assert.deepEqual(readJar(browser, "bili_jct"), ["jct-111"]);
  assert.equal(browser.state.jar.some((c) => c.value === "sid-222"), false, "上个账号的 sid 没清干净");
  // 设备指纹与偏好原样保留
  assert.deepEqual(readJar(browser, "buvid3"), ["DEVICE-FINGERPRINT"]);
  assert.deepEqual(readJar(browser, "CURRENT_FNVAL"), ["4048"]);
  // 切完读到的身份就是目标账号
  assert.equal(result.live.mid, "111");
  assert.equal(result.live.uname, "账号甲");
  assert.equal(browser.state.badge, "账");
});

test("切走前自动刷新快照：SESSDATA 轮换过也不会把旧凭据存回去", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111), DEVICE_COOKIE] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });

  replaceJar(browser, [...accountCookies("B", 222), DEVICE_COOKIE]);
  await send({ type: "save" });

  // 用户还在账号乙上，B 站轮换了 SESSDATA
  rotateSessdata(browser, "B-rotated");

  const accountB = browser.state.store.accounts.find((a) => a.mid === "222");
  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  await send({ type: "switch", id: accountA.id });

  const storedB = browser.state.store.accounts.find((a) => a.id === accountB.id);
  assert.equal(
    storedB.cookies.find((c) => c.name === "SESSDATA").value,
    "B-rotated",
    "切走前没有刷新账号乙的快照",
  );

  // 切回账号乙时，写进去的就是轮换后的新凭据
  await send({ type: "switch", id: accountB.id });
  assert.deepEqual(readJar(browser, "SESSDATA"), ["B-rotated"]);
});

test("关掉 autoSync 就不该偷偷改动别人的快照", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111)], settings: { autoSync: false } });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222)]);
  await send({ type: "save" });
  rotateSessdata(browser, "B-rotated");

  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  await send({ type: "switch", id: accountA.id });

  const storedB = browser.state.store.accounts.find((a) => a.mid === "222");
  assert.equal(storedB.cookies.find((c) => c.name === "SESSDATA").value, "B");
});

test("设备指纹隔离：开启后才连 buvid3 一起换，切回去也对得上", async () => {
  const browser = createBrowser({
    jar: [...accountCookies("A", 111), DEVICE_COOKIE],
    settings: { switchDevice: true },
  });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  const accountA = browser.state.store.accounts[0];
  assert.equal(accountA.cookies.some((c) => c.name === "buvid3"), true);

  replaceJar(browser, [...accountCookies("B", 222), cookie("buvid3", "DEVICE-B")]);
  await send({ type: "save" });
  const accountB = browser.state.store.accounts.find((a) => a.mid === "222");

  await send({ type: "switch", id: accountA.id });
  assert.deepEqual(readJar(browser, "buvid3"), ["DEVICE-FINGERPRINT"], "没跟着账号换设备指纹");
  await send({ type: "switch", id: accountB.id });
  assert.deepEqual(readJar(browser, "buvid3"), ["DEVICE-B"]);
});

test("关掉 autoReload 就不刷新标签页", async () => {
  const browser = createBrowser({
    jar: [...accountCookies("A", 111)],
    settings: { autoReload: false },
  });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222)]);
  await send({ type: "save" });
  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  const result = await send({ type: "switch", id: accountA.id });
  assert.equal(result.reloaded, 0);
  assert.deepEqual(browser.state.reloaded, []);
});

test("未登录时保存给出可读的错误，而不是写进一个空账号", async () => {
  const browser = createBrowser({ jar: [PREFS_COOKIE] });
  const { send } = await loadWorker(browser);
  const result = await send({ type: "save" });
  assert.equal(result.ok, false);
  assert.match(result.error, /未登录/);
  assert.equal(browser.state.store.accounts.length, 0);
});

test("切换到不存在的账号 / 未知消息类型都会明确失败", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111)] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });

  const missing = await send({ type: "switch", id: "no-such-id" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /不存在/);

  const unknown = await send({ type: "wat" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /未知的消息类型/);
});

test("重复点击保存不会产生重复账号，只刷新快照", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111)] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  const first = browser.state.store.accounts[0].id;
  rotateSessdata(browser, "A-rotated");
  await send({ type: "save" });

  assert.equal(browser.state.store.accounts.length, 1);
  assert.equal(browser.state.store.accounts[0].id, first);
  assert.equal(
    browser.state.store.accounts[0].cookies.find((c) => c.name === "SESSDATA").value,
    "A-rotated",
  );
});

test("state 会标出哪一个是当前登录的账号", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111)] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222)]);
  await send({ type: "save" });

  const stateA = await send({ type: "state" });
  assert.equal(stateA.ok, true, stateA.error);
  assert.equal(stateA.accounts.length, 2);
  assert.equal(stateA.accounts.filter((a) => a.active).length, 1);
  assert.equal(stateA.accounts.find((a) => a.active).mid, "222");
  assert.equal(stateA.live.uname, "账号乙");
  assert.equal(stateA.settings.autoSync, true);
});

test("重命名、删除、导出、导入形成闭环", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111)] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  const id = browser.state.store.accounts[0].id;

  const renamed = await send({ type: "rename", id, alias: "工作号" });
  assert.equal(renamed.ok, true, renamed.error);
  assert.equal(renamed.updated.name, "工作号");

  const exported = await send({ type: "export" });
  assert.equal(exported.ok, true);
  assert.equal(exported.count, 1);
  assert.equal(exported.payload.accounts[0].alias, "工作号");

  // 导出的东西要能原样导回来
  const emptied = createBrowser({ jar: [...accountCookies("A", 111)] });
  const second = await loadWorker(emptied);
  const imported = await second.send({ type: "import", payload: exported.payload });
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.added, 1);
  assert.equal(emptied.state.store.accounts[0].alias, "工作号");

  // 重复导入同一个 mid：覆盖而不是堆叠，且保留已有的别名
  const reused = await second.send({ type: "import", payload: exported.payload });
  assert.equal(reused.replaced, 1);
  assert.equal(reused.added, 0);
  assert.equal(emptied.state.store.accounts.length, 1);

  const removed = await send({ type: "remove", id });
  assert.equal(removed.ok, true);
  assert.equal(browser.state.store.accounts.length, 0);
});

test("导入垃圾数据不会写坏 store", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111)] });
  const { send } = await loadWorker(browser);
  const result = await send({ type: "import", payload: { nope: true } });
  assert.equal(result.ok, false);
  assert.match(result.error, /accounts/);
  assert.deepEqual(browser.state.store.accounts, []);
});

test("不注册任何快捷键：manifest 里没有 commands，后台也不监听", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.commands, undefined, "manifest 里不该再有 commands");
  const source = await readFile(new URL("../extension/src/background.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /chrome\.commands/, "background.js 里不该再碰 chrome.commands");
});

test("设置写入后能读回来，并影响下一次快照的管辖范围", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111), DEVICE_COOKIE] });
  const { send } = await loadWorker(browser);
  const patched = await send({ type: "settings", patch: { switchDevice: true } });
  assert.equal(patched.ok, true, patched.error);
  assert.equal(patched.settings.switchDevice, true);
  assert.equal(patched.settings.autoSync, true);

  await send({ type: "save" });
  assert.equal(browser.state.store.accounts[0].cookies.some((c) => c.name === "buvid3"), true);

  const off = await send({ type: "settings", patch: { switchDevice: false, showBadge: false } });
  assert.equal(off.settings.switchDevice, false);
  assert.equal(off.settings.showBadge, false);
  assert.equal(browser.state.badge, "");
});

test("「添加下一个账号」只清本地凭据，也从不碰 B 站的退出接口", async () => {
  const browser = createBrowser({
    jar: [...accountCookies("A", 111), DEVICE_COOKIE, PREFS_COOKIE],
  });
  const { send } = await loadWorker(browser);

  const res = await send({ type: "park" });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.saved.name, "账号甲");
  assert.equal(res.cleared, 5);

  // 身份 Cookie 全清掉，页面回到未登录
  assert.deepEqual(readJar(browser, "SESSDATA"), []);
  assert.deepEqual(readJar(browser, "DedeUserID"), []);
  assert.deepEqual(readJar(browser, "bili_jct"), []);
  assert.deepEqual(readJar(browser, "sid"), []);
  // 设备指纹与站点偏好不属于身份，留着
  assert.deepEqual(readJar(browser, "buvid3"), ["DEVICE-FINGERPRINT"]);
  assert.deepEqual(readJar(browser, "CURRENT_FNVAL"), ["4048"]);

  // 快照仍然在；而且全程只请求过 nav —— 没有 /login/exit/v2 这种注销调用
  assert.equal(browser.state.store.accounts.length, 1);
  assert.deepEqual([...new Set(browser.state.requests)], [NAV_URL]);
  const after = await send({ type: "state" });
  assert.equal(after.live?.loggedIn, false);
});

test("凭据在服务端失效时：说清原因、自动回滚，不把人扔在未登录状态", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111), DEVICE_COOKIE] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222), DEVICE_COOKIE]);
  await send({ type: "save" });

  // 账号甲的 SESSDATA 被服务端注销了（保存它的时候点过网页上的「退出登录」）
  browser.state.revoked.add("A");

  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  const res = await send({ type: "switch", id: accountA.id });

  assert.equal(res.ok, false);
  assert.match(res.error, /服务端失效/);
  assert.match(res.error, /退出登录/);
  assert.match(res.error, /已回滚到切换前的账号/);

  // 回滚后浏览器里仍是账号乙，没被留在未登录状态
  assert.deepEqual(readJar(browser, "SESSDATA"), ["B"]);
  assert.deepEqual(readJar(browser, "DedeUserID"), ["222"]);
  assert.equal(browser.state.jar.some((c) => c.value === "A"), false);
});

test("切换前的自动刷新针对的是当前登录的那个账号（三个账号时不再刷错人）", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111)] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222)]);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("C", 333)]);
  await send({ type: "save" });

  // 当前登录的是账号丙，且它的 SESSDATA 刚被 B 站轮换
  rotateSessdata(browser, "C-rotated");

  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  await send({ type: "switch", id: accountA.id });

  const storedC = browser.state.store.accounts.find((a) => a.mid === "333");
  const storedB = browser.state.store.accounts.find((a) => a.mid === "222");
  assert.equal(
    storedC.cookies.find((c) => c.name === "SESSDATA").value,
    "C-rotated",
    "没有刷新当前登录的账号丙",
  );
  assert.equal(
    storedB.cookies.find((c) => c.name === "SESSDATA").value,
    "B",
    "刷错了对象：把没在登录的账号乙改了",
  );
});

test("诊断报告包含判定卡点所需的事实，且不泄露凭据内容", async () => {  const browser = createBrowser({ jar: [...accountCookies("A", 111), DEVICE_COOKIE] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });

  const res = await send({ type: "diagnose" });
  assert.equal(res.ok, true, res.error);
  const report = res.report;
  assert.equal(report.站内身份.isLogin, true);
  assert.equal(report.站内身份.mid, "111");

  const sessLive = report.浏览器里的B站Cookie.find((c) => c.name === "SESSDATA");
  assert.equal(sessLive.domain, ".bilibili.com");
  assert.equal(sessLive.hostOnly, false);
  assert.equal(sessLive.valueLen, 1);
  // 报告里只有长度，没有值本身
  assert.equal(JSON.stringify(report).includes('"A"'), false);

  const snap = report.已存快照[0];
  assert.equal(snap.名称, "账号甲");
  assert.equal(snap.cookies.length, 5);
  assert.equal(snap.cookies.some((c) => typeof c.valueLen === "number"), true);
});

test("引擎按 scheme 拒绝写入时，换一种 scheme 重试仍能切过去", async () => {
  // 复现真实引擎的行为：非 secure 的 Cookie 用 http:// 的 URL 去写会被拒
  const browser = createBrowser({
    jar: [...accountCookies("A", 111), DEVICE_COOKIE],
    setThrowsOnHttp: true,
  });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222), DEVICE_COOKIE]);
  await send({ type: "save" });

  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  const res = await send({ type: "switch", id: accountA.id });
  assert.equal(res.ok, true, res.error);

  // 五条身份 Cookie 一条不缺，而且没有留下同名重复
  assert.deepEqual(readJar(browser, "SESSDATA"), ["A"]);
  assert.deepEqual(readJar(browser, "bili_jct"), ["jct-111"]);
  assert.deepEqual(readJar(browser, "sid"), ["sid-111"]);
  assert.equal(browser.state.jar.filter((c) => c.name === "SESSDATA").length, 1);
  assert.equal(browser.state.jar.some((c) => c.value === "sid-222"), false);
});

test("删除被 scheme 挡住时，换一种 scheme 也要把旧身份清干净", async () => {
  const browser = createBrowser({
    jar: [...accountCookies("A", 111), DEVICE_COOKIE],
    removeFailsOnHttp: true,
  });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222), DEVICE_COOKIE]);
  await send({ type: "save" });

  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  const res = await send({ type: "switch", id: accountA.id });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(readJar(browser, "SESSDATA"), ["A"]);
  assert.equal(browser.state.jar.some((c) => c.value === "sid-222"), false, "旧账号凭据没清干净");
});

test("第一次写没生效时会自动重做一遍，而不是直接报失败", async () => {
  const browser = createBrowser({
    jar: [...accountCookies("A", 111), DEVICE_COOKIE],
    dropWrites: 5, // 第一次写入的 5 条全部静默丢弃
  });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222), DEVICE_COOKIE]);
  await send({ type: "save" });

  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  const res = await send({ type: "switch", id: accountA.id });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(readJar(browser, "SESSDATA"), ["A"]);
  assert.equal(res.live.mid, "111");
  // 重做过：写入次数明显多于一轮
  assert.equal(browser.state.setCalls > 5, true);
});

test("重做之后仍然被服务端拒绝时，给出的是凭据失效的结论", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111), DEVICE_COOKIE] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222), DEVICE_COOKIE]);
  await send({ type: "save" });
  browser.state.revoked.add("A");

  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  const res = await send({ type: "switch", id: accountA.id });
  assert.equal(res.ok, false);
  assert.match(res.error, /服务端失效/);
  assert.deepEqual(readJar(browser, "SESSDATA"), ["B"]);
});

test("切换失败会记下来，账号行据此标注「凭据已被拒绝」", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111), DEVICE_COOKIE] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222), DEVICE_COOKIE]);
  await send({ type: "save" });
  browser.state.revoked.add("A");

  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  await send({ type: "switch", id: accountA.id });

  const state1 = await send({ type: "state" });
  assert.equal(state1.failure?.mid, "111");
  assert.equal(state1.failure?.kind, "revoked");
  assert.equal(state1.accounts.find((a) => a.mid === "111").rejected, true);
  assert.equal(state1.accounts.find((a) => a.mid === "222").rejected, false);

  // 诊断报告里也要有这条结论
  const report = (await send({ type: "diagnose" })).report;
  assert.equal(report.上次切换失败?.mid, "111");

  // 重新登录并覆盖快照之后，标记要消失
  browser.state.revoked.delete("A");
  replaceJar(browser, [...accountCookies("A", 111), DEVICE_COOKIE]);
  await send({ type: "save" });
  const state2 = await send({ type: "state" });
  assert.equal(state2.failure, null);
  assert.equal(state2.accounts.find((a) => a.mid === "111").rejected, false);
});

test("切换成功会清掉这家之前的失败标记", async () => {
  const browser = createBrowser({ jar: [...accountCookies("A", 111), DEVICE_COOKIE] });
  const { send } = await loadWorker(browser);
  await send({ type: "save" });
  replaceJar(browser, [...accountCookies("B", 222), DEVICE_COOKIE]);
  await send({ type: "save" });

  // 先人为制造一次失败记录（A 被吊销），再解除吊销并切过去
  browser.state.revoked.add("A");
  const accountA = browser.state.store.accounts.find((a) => a.mid === "111");
  await send({ type: "switch", id: accountA.id });
  assert.equal((await send({ type: "state" })).failure?.mid, "111");

  browser.state.revoked.delete("A");
  const res = await send({ type: "switch", id: accountA.id });
  assert.equal(res.ok, true, res.error);
  assert.equal((await send({ type: "state" })).failure, null);
});
