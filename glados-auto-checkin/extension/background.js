// ============================================================================
// 文件名：background.js  (Service Worker, type: module)
// 作用：多站点 · 多账号自动签到引擎。
//   - 每个账号独立保存 {site, name, baseUrl, cookie}，互不干扰
//   - 每天在随机的「分钟/秒」静默为【所有账号】逐一签到
//   - 用账号自己的 Cookie 发请求，因此同一站点可并存多个账号
//   - GLaDOS 额外支持「原生页面点击」兜底（应对 Cloudflare）
// ============================================================================
import {
  getAdapter,
  getTodayString,
  normalizeCookie,
  nowString,
} from "./sites.js";

// ---------- 全局常量 ----------
const ALARM_INSPECT = "msInspectAlarm"; // 每小时巡检（处理跨天不关浏览器的场景）
const MAX_HISTORY = 200; // 全局历史最多保留条数
const MAX_ACCOUNT_LOG = 30; // 每账号日志最多保留条数

// 存储中的账号结构示例：
// {
//   id: "uuid",
//   site: "glados",
//   name: "账号A",
//   baseUrl: "https://glados.cloud",
//   cookie: "koa:sess=...",
//   enabled: true,
//   lastCheckInDate: "2026-11-15",
//   lastResult: "...",
//   logs: [{time, result}]
// }
// 全局设置：
// { notifyEnabled: true, accounts: [...] }   （每天首次打开浏览器时自动签到，无需固定时间）

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 读取 / 保存 ----------
async function getSettings() {
  const data = await chrome.storage.local.get({
    notifyEnabled: true,
    accounts: [],
  });
  if (!Array.isArray(data.accounts)) data.accounts = [];
  return data;
}

async function saveAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
}

// 全局历史（跨账号汇总，读起来方便）
async function saveHistory(msg) {
  const data = await chrome.storage.local.get({ history: [] });
  const rec = { time: nowString(), result: msg };
  const list = [rec, ...data.history].slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ history: list });
}

// 给单账号追加日志
function pushAccountLog(account, result) {
  if (!account.logs) account.logs = [];
  account.logs.unshift({ time: nowString(), result });
  account.logs = account.logs.slice(0, MAX_ACCOUNT_LOG);
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title,
      message: message || "",
    });
  } catch (e) {
    console.warn("通知失败:", e);
  }
}

// ============================================================================
// 请求头伪装规则（declarativeNetRequest）
// 说明：GLaDOS 有多个后缀域名（glados.cloud / .rocks / .homes / .info ...）。
// 这里按【所有账号实际用到的域名】动态生成 Origin/Referer 伪装规则，逐个后缀覆盖，
// 不再写死 glados.cloud。每次新增/修改账号后调用 refreshHeaderRules。
// ============================================================================
function collectHosts(accounts) {
  const hosts = new Set();
  for (const acc of accounts || []) {
    try {
      if (acc.baseUrl) hosts.add(new URL(acc.baseUrl).hostname);
    } catch (e) {}
  }
  // 兜底：至少覆盖主域名
  if (hosts.size === 0) hosts.add("glados.cloud");
  return Array.from(hosts);
}

async function ensureHeaderRules(accounts) {
  try {
    // 传入账号则据此生成；未传则从存储读取
    let list = accounts;
    if (!list) {
      const d = await chrome.storage.local.get({ accounts: [] });
      list = d.accounts;
    }
    const hosts = collectHosts(list);

    // 每个域名一条规则（id 从 1 开始递增）
    const rules = hosts.map((host, i) => ({
      id: i + 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin", operation: "set", value: `https://${host}` },
          { header: "Referer", operation: "set", value: `https://${host}/console/checkin` },
        ],
      },
      condition: {
        urlFilter: `||${host}/api/user/`,
        resourceTypes: ["xmlhttprequest", "other"],
      },
    }));

    // 清理旧的动态规则，再写入新的（动态规则上限 5000 条，足够）
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: rules,
    });
    console.log(`[伪装规则] 已为 ${hosts.length} 个域名生成请求头伪装:`, hosts.join(", "));
  } catch (e) {
    console.error("[伪装规则] 配置失败:", e);
  }
}

// ============================================================================
// Cookie 注入工具
// 说明：浏览器 fetch 无法手动设置 Cookie 请求头（属禁止头，会被丢弃）。
// 因此在【同一个会话】内，先把该账号的 Cookie 用 chrome.cookies.set 写入浏览器，
// 再用 credentials:"include" 发请求；请求结束后清理，保证账号间互不污染。
// 由于所有账号是【串行】执行的，不存在并发冲突。
// ============================================================================
async function applyAccountCookies(baseUrl, cookieStr) {
  const host = new URL(baseUrl).hostname;
  const pairs = normalizeCookie(cookieStr).split(";").map((s) => s.trim()).filter(Boolean);
  const applied = [];
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) continue;
    try {
      // 先删除同域同路径同名 cookie，避免残留
      const existing = await chrome.cookies.getAll({ domain: host, name });
      for (const c of existing) {
        await chrome.cookies.remove({ url: `${baseUrl}${c.path || "/"}`, name: c.name }).catch(() => {});
      }
      await chrome.cookies.set({ url: baseUrl, name, value, domain: host, path: "/", secure: baseUrl.startsWith("https"), sameSite: "lax" });
      applied.push(name);
    } catch (e) {
      console.warn("写入 Cookie 失败:", name, e);
    }
  }
  return applied;
}

async function clearAppliedCookies(baseUrl, names) {
  for (const name of names) {
    try {
      await chrome.cookies.remove({ url: baseUrl + "/", name });
    } catch (e) {}
  }
}

// ============================================================================
// 单账号签到：Cookie 直连 API（主路径）
// ============================================================================
async function checkinAccountByApi(account) {
  const adapter = getAdapter(account.site);
  const baseUrl = (account.baseUrl || adapter.defaultBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("未填写站点地址");
  const cookie = normalizeCookie(account.cookie);
  if (!cookie) throw new Error("未配置 Cookie");

  const ep = adapter.endpoints(baseUrl, account.extra || {});
  const headers = adapter.headers(baseUrl, cookie, account.extra || {});
  // 注意：Cookie 请求头无法直接设置，改由浏览器 cookie 罐注入 + credentials:include 携带
  delete headers["Cookie"];

  let applied = [];
  try {
    applied = await applyAccountCookies(baseUrl, cookie);

    // GLaDOS 新版签到接口为 POST /api/user/checkin（GET 会 405）。
    // 但纯 API POST 会被 Cloudflare Turnstile 拦截（code:5），故此处仅作探测/兜底；
    // 真正可用的签到走 checkinGladosNative 的“真实页面点击”。
    const resp = await fetch(ep.checkin, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers),
      credentials: "include", // 携带上面注入的账号 Cookie
      redirect: "follow",
    }).catch((e) => {
      throw new Error(`网络请求失败: ${e.message}`);
    });

    if (resp.status === 401 || resp.status === 403 || resp.status === 405) {
      return { ok: false, notLoggedIn: resp.status !== 405, message: `接口返回 ${resp.status}` };
    }
    if (resp.redirected || /\/login|\/auth/i.test(resp.url || "")) {
      return { ok: false, notLoggedIn: true, message: "被重定向到登录页，Cookie 失效" };
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      return { ok: false, notLoggedIn: true, message: "返回非 JSON（可能未登录或站点不兼容）" };
    }

    return adapter.parseCheckinResponse(data);
  } finally {
    await clearAppliedCookies(baseUrl, applied);
  }
}

// ============================================================================
// GLaDOS 原生页面点击兜底（当 Cookie 直连失败且需要过 Cloudflare 时）
// 原理：用 chrome.cookies 把账号 Cookie 注入当前浏览器、打开真实页面点 .ckb。
// 注意：此方式要求该账号的会话能注入到浏览器（会临时占用该站点登录态），
// 因此仅在账号勾选 useNativeFallback 时调用。
// ============================================================================
async function checkinGladosNative(account) {
  const baseUrl = (account.baseUrl || "https://glados.cloud").replace(/\/+$/, "");
  const pageUrl = `${baseUrl}/console/checkin`;
  const host = new URL(baseUrl).hostname;
  let tabId = null;
  // 备份该域现有 Cookie（可能是用户自己的登录态），签到后恢复，避免污染浏览器会话
  let backup = [];
  try {
    backup = await chrome.cookies.getAll({ domain: host }).catch(() => []);
  } catch (e) {}

  try {
    // 注入 Cookie 到浏览器。GLaDOS 新 Cookie 形如 gld:sess / gld:accts（含 .sig 签名），
    // 名字带冒号、值带特殊字符，必须原样写入；域名用 host（不带前导点）以匹配 hostOnly。
    const cookie = normalizeCookie(account.cookie);
    const pairs = cookie.split(";").map((s) => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) continue;
      // 删除同域同名旧 cookie，避免冲突
      const existing = await chrome.cookies.getAll({ domain: host }).catch(() => []);
      for (const c of existing) {
        if (c.name === name) {
          await chrome.cookies.remove({ url: `${baseUrl}${c.path || "/"}`, name: c.name }).catch(() => {});
        }
      }
      await chrome.cookies
        .set({ url: baseUrl, name, value, domain: host, path: "/", secure: true, sameSite: "lax" })
        .catch((e) => console.warn("注入 Cookie 失败:", name, e));
    }

    const tab = await chrome.tabs.create({ url: pageUrl, active: false });
    tabId = tab.id;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (t && t.status === "complete") break;
    }

    // 主世界注入可见性伪装 + 结果旁听
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
          Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
        } catch (e) {}
        window.__msCheckinResult = null;
        if (!window.__msHooked) {
          window.__msHooked = true;
          const rawOpen = XMLHttpRequest.prototype.open;
          const rawSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function (m, u, ...rest) {
            this._reqUrl = u;
            return rawOpen.call(this, m, u, ...rest);
          };
          XMLHttpRequest.prototype.send = function (...args) {
            this.addEventListener("load", function () {
              try {
                if (this._reqUrl && this._reqUrl.includes("/user/checkin") && !this._reqUrl.includes("/challenge")) {
                  window.__msCheckinResult = JSON.parse(this.responseText);
                }
              } catch (e) {}
            });
            return rawSend.apply(this, args);
          };
        }
      },
    });

    await sleep(Math.floor(Math.random() * 2000) + 4000);

    const clickRes = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        const s = (ms) => new Promise((r) => setTimeout(r, ms));
        if (/login|authenticate/.test(location.pathname)) return { notLoggedIn: true };

        // 新版 GLaDOS 已无 button.ckb，改为多策略查找签到按钮
        function findCheckinButton() {
          // 策略1：旧版 .ckb
          const legacy = document.querySelector("button.ckb, .ckb");
          if (legacy) return legacy;
          // 策略2：按文字匹配，排除 "Need xx more" / "Get" 之类
          const btns = Array.from(document.querySelectorAll("button, a, [role=button], div[onclick]"));
          const pick = btns.find((b) => {
            const t = (b.innerText || b.textContent || "").trim();
            if (!/checkin|check-in|签到|打卡/i.test(t)) return false;
            if (/need\s*\d+\s*more|get\s*more|buy|purchase|upgrade/i.test(t)) return false;
            // 排除包含金额/购买语义的
            if (/more/i.test(t) && /\d/.test(t)) return false;
            return true;
          });
          return pick || null;
        }

        let btn = findCheckinButton();
        for (let w = 0; w < 10 && !btn; w++) {
          await s(500);
          btn = findCheckinButton();
        }
        if (!btn) {
          // 返回页面上所有按钮文字，便于调试
          const all = Array.from(document.querySelectorAll("button")).map((b) => (b.innerText || "").trim()).filter(Boolean);
          return { buttonNotFound: true, buttons: all };
        }

        const btnText = (btn.innerText || "").trim();
        if (btn.classList.contains("is-done") || btn.disabled) {
          return { success: true, data: { code: 1, message: "Checkin Repeats! Please Try Tomorrow (今日已签到)" } };
        }
        // 若按钮文字本身已是“已完成/今日已签”之类
        if (/已签|checked|done|completed/i.test(btnText)) {
          return { success: true, data: { code: 1, message: "今日已签到：" + btnText } };
        }

        ["mouseover", "mouseenter", "mousedown", "mouseup", "click"].forEach((type) => {
          btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        });
        try { btn.click(); } catch (e) {}

        for (let i = 0; i < 20; i++) {
          await s(500);
          if (window.__msCheckinResult) return { success: true, data: window.__msCheckinResult };
          if (btn.classList.contains("is-done")) {
            return { success: true, data: { code: 0, message: (btn.innerText || "").trim() || "CheckIn! Get Points" } };
          }
        }
        // 超时但页面可能已变化，尝试再读一次按钮文字
        const nowText = (btn.innerText || "").trim();
        if (/已签|checked|done|\+/i.test(nowText)) {
          return { success: true, data: { code: 0, message: nowText } };
        }
        return { success: false, error: "点击后等待服务器响应超时", buttons: [btnText] };
      },
    });

    const r = clickRes && clickRes[0] ? clickRes[0].result : null;
    if (!r) return { ok: false, message: "原生点击无返回" };
    if (r.notLoggedIn) return { ok: false, notLoggedIn: true, message: "原生页面被重定向到登录页" };
    if (r.buttonNotFound) return { ok: false, message: "未找到签到按钮" };
    if (!r.success) return { ok: false, message: r.error || "原生点击失败" };
    const adapter = getAdapter(account.site);
    return adapter.parseCheckinResponse(r.data);
  } finally {
    await sleep(500);
    if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {}
    }
    // 恢复用户原有 Cookie（清除注入的账号 Cookie，还原备份）
    try {
      const nowCookies = await chrome.cookies.getAll({ domain: host }).catch(() => []);
      for (const c of nowCookies) {
        await chrome.cookies.remove({ url: `${baseUrl}${c.path || "/"}`, name: c.name }).catch(() => {});
      }
      for (const c of backup) {
        const scheme = c.secure ? "https" : "http";
        const rest = { name: c.name, value: c.value, path: c.path || "/", secure: !!c.secure };
        if (c.domain && c.domain.startsWith(".")) rest.domain = c.domain;
        if (c.sameSite) rest.sameSite = c.sameSite;
        if (c.expirationDate) rest.expirationDate = c.expirationDate;
        if (c.httpOnly) rest.httpOnly = true;
        await chrome.cookies.set(Object.assign({ url: `${scheme}://${host}${c.path || "/"}` }, rest)).catch(() => {});
      }
    } catch (e) {
      console.warn("恢复 Cookie 失败:", e);
    }
  }
}

// ============================================================================
// 单账号签到总入口
// 策略（新版 GLaDOS 实测）：
//   裸 fetch 调 /api/user/checkin 会稳定返回 {"code":-2,"message":"没有权限"}，
//   即使 Cookie 有效。唯一可靠方式 = 打开真实页面、由官网 React 自己发请求并点按钮。
//   因此：GLaDOS 以【原生页面点击】为主路径；裸 API 仅用于“已登录探测/兜底”。
// ============================================================================
async function runAccount(account, { manual = false } = {}) {
  const tag = `[${account.site}] ${account.name}`;
  let result;

  if (account.site === "glados") {
    // 主路径：原生页面点击
    try {
      result = await checkinGladosNative(account);
    } catch (e) {
      result = { ok: false, message: e.message };
    }
    // 原生点击若明确“未登录”，直接判定；否则若失败，再试一次裸 API 看是否能通（少数环境）
    if (!result || !result.ok) {
      if (result && result.notLoggedIn) {
        // 保持未登录判定
      } else {
        try {
          const apiRes = await checkinAccountByApi(account);
          if (apiRes && (apiRes.ok || apiRes.alreadyChecked || apiRes.notLoggedIn)) result = apiRes;
        } catch (e) {}
      }
    }
  } else {
    // 其它站点：API 直连
    try {
      result = await checkinAccountByApi(account);
    } catch (e) {
      result = { ok: false, message: e.message };
    }
  }

  result = result || { ok: false, message: "签到无返回" };

  // 组装结果文案
  let msg;
  if (result.notLoggedIn) {
    msg = `⚠️ 未登录 / Cookie 失效：${result.message || ""}`;
  } else if (result.ok) {
    msg = result.message || "签到完成";
    if (result.points) msg += ` (本次获得: +${result.points} 点)`;
  } else {
    msg = `⚠️ ${result.message || "签到失败"}`;
  }

  const prefix = manual ? "[手动] " : "[自动] ";
  await saveHistory(`${prefix}${tag} → ${msg}`);
  pushAccountLog(account, msg);
  account.lastResult = msg;

  // 仅当成功且非“未登录”时记录今日已签
  if (result.ok && !result.notLoggedIn && !manual) {
    account.lastCheckInDate = getTodayString();
  }
  return result;
}

// ============================================================================
// 为所有启用账号执行一次签到
// ============================================================================
async function runAllAccounts({ manual = false } = {}) {
  const settings = await getSettings();
  const accounts = settings.accounts.filter((a) => a.enabled !== false && a.cookie);
  if (accounts.length === 0) {
    if (manual) notify("签到助手", "没有可执行的账号（请先在设置里添加并填写 Cookie）");
    return;
  }

  const today = getTodayString();
  let successCount = 0;
  let failCount = 0;

  for (const acc of accounts) {
    if (!manual && acc.lastCheckInDate === today) {
      console.log(`跳过 ${acc.name}：今日已签到`);
      continue;
    }
    const res = await runAccount(acc, { manual });
    if (res.ok) successCount++;
    else failCount++;
    // 账号之间随机停顿，降低风控
    await sleep(Math.floor(Math.random() * 3000) + 1000);
  }

  // 写回账号状态
  const latest = await getSettings();
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  latest.accounts = latest.accounts.map((a) => (byId[a.id] ? { ...a, ...byId[a.id] } : a));
  await saveAccounts(latest.accounts);

  if (!manual && settings.notifyEnabled !== false) {
    notify(
      "多站点签到完成",
      `成功 ${successCount} 个，失败 ${failCount} 个（共 ${accounts.length} 个账号）`
    );
  }
}

// ============================================================================
// 每日首次执行：浏览器启动（或跨天巡检）时，若今日尚未签到则立即签到
// 不再按固定时间/随机延迟调度；
// ============================================================================
async function runIfNeededToday(reason) {
  await ensureHeaderRules();
  const settings = await getSettings();
  const today = getTodayString();

  const accounts = settings.accounts.filter((a) => a.enabled !== false && a.cookie);
  const pending = accounts.filter((a) => a.lastCheckInDate !== today);
  if (pending.length === 0) {
    console.log(`[${reason}] 今日所有账号均已签到，跳过。`);
    return;
  }

  console.log(`[${reason}] 今日还有 ${pending.length} 个账号未签到，开始执行...`);

  // 等网络稳定几秒（浏览器刚启动时）
  await sleep(Math.floor(Math.random() * 4000) + 3000);
  await runAllAccounts({ manual: false });
  await chrome.storage.local.set({ lastAutoRunDate: today });
}

// ============================================================================
// 拉取单账号积分 / 签到日历
// GLaDOS：裸 API 不可用，改为打开真实页面，旁听官网自己请求 points 的结果再解析
// ============================================================================
async function fetchAccountPoints(account) {
  if (account.site === "glados") {
    return fetchGladosPointsNative(account);
  }
  const adapter = getAdapter(account.site);
  const baseUrl = (account.baseUrl || adapter.defaultBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, message: "未填写站点地址" };
  const cookie = normalizeCookie(account.cookie || "");
  if (!cookie) return { ok: false, message: "未配置 Cookie" };
  const ep = adapter.endpoints(baseUrl, account.extra || {});
  if (!ep.points) return { ok: false, message: "该站点未配置积分接口" };

  const headers = adapter.headers(baseUrl, cookie, account.extra || {});
  delete headers["Cookie"];
  let applied = [];
  try {
    applied = await applyAccountCookies(baseUrl, cookie);
    const resp = await fetch(ep.points, { method: "GET", headers, credentials: "include", redirect: "follow" });
    if (resp.status === 401 || resp.status === 403 || resp.redirected) {
      return { ok: false, notLoggedIn: true, message: "未登录或 Cookie 失效" };
    }
    const data = await resp.json().catch(() => null);
    if (!data) return { ok: false, notLoggedIn: true, message: "返回非 JSON" };
    return adapter.parsePointsResponse(data);
  } catch (e) {
    return { ok: false, message: `请求失败: ${e.message}` };
  } finally {
    await clearAppliedCookies(baseUrl, applied);
  }
}

// 通过真实页面读取 GLaDOS 积分（打开 console 页，注入 Cookie，抓取官网自己的 points 响应）
async function fetchGladosPointsNative(account) {
  const baseUrl = (account.baseUrl || "https://glados.cloud").replace(/\/+$/, "");
  const pageUrl = `${baseUrl}/console/checkin`;
  const host = new URL(baseUrl).hostname;
  const adapter = getAdapter("glados");
  let tabId = null;
  let backup = await chrome.cookies.getAll({ domain: host }).catch(() => []);

  try {
    const cookie = normalizeCookie(account.cookie || "");
    if (!cookie) return { ok: false, message: "未配置 Cookie" };
    const pairs = cookie.split(";").map((s) => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) continue;
      const existing = await chrome.cookies.getAll({ domain: host }).catch(() => []);
      for (const c of existing) {
        if (c.name === name) await chrome.cookies.remove({ url: `${baseUrl}${c.path || "/"}`, name: c.name }).catch(() => {});
      }
      await chrome.cookies.set({ url: baseUrl, name, value, domain: host, path: "/", secure: true, sameSite: "lax" }).catch(() => {});
    }

    const tab = await chrome.tabs.create({ url: pageUrl, active: false });
    tabId = tab.id;
    // 先注入旁听器（等页面开始加载即可注入）
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (t && t.status === "complete") break;
    }

    const readRes = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        // 直接在当前（已登录）页面请求 points，官网页面环境可被服务端接受
        try {
          const r = await fetch("/api/user/points", {
            method: "GET",
            credentials: "include",
            headers: { "Accept": "application/json, text/plain, */*" },
          });
          const data = await r.json();
          return { ok: true, data };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    });

    const rr = readRes && readRes[0] ? readRes[0].result : null;
    if (!rr || !rr.ok) return { ok: false, message: "页面读取失败" };
    const parsed = adapter.parsePointsResponse(rr.data);
    // 若 code===-2 说明该 Cookie 在该域名下无效/未登录
    if (!parsed.ok) return { ok: false, notLoggedIn: true, message: "Cookie 无效或未登录（页面返回无权限）" };
    return parsed;
  } catch (e) {
    return { ok: false, message: `读取失败: ${e.message}` };
  } finally {
    if (tabId !== null) {
      try { await chrome.tabs.remove(tabId); } catch (e) {}
    }
    try {
      const nowCookies = await chrome.cookies.getAll({ domain: host }).catch(() => []);
      for (const c of nowCookies) await chrome.cookies.remove({ url: `${baseUrl}${c.path || "/"}`, name: c.name }).catch(() => {});
      for (const c of backup) {
        const scheme = c.secure ? "https" : "http";
        const rest = { name: c.name, value: c.value, path: c.path || "/", secure: !!c.secure };
        if (c.domain && c.domain.startsWith(".")) rest.domain = c.domain;
        if (c.sameSite) rest.sameSite = c.sameSite;
        if (c.expirationDate) rest.expirationDate = c.expirationDate;
        if (c.httpOnly) rest.httpOnly = true;
        await chrome.cookies.set(Object.assign({ url: `${scheme}://${host}${c.path || "/"}` }, rest)).catch(() => {});
      }
    } catch (e) {}
  }
}

// ============================================================================
// 生命周期
// ============================================================================
chrome.runtime.onInstalled.addListener(async () => {
  console.log("多站点签到助手已安装/更新");
  await ensureHeaderRules();
  // 每小时巡检一次：主要处理“浏览器跨天不关闭”时，第二天仍能自动签到的场景
  chrome.alarms.create(ALARM_INSPECT, { delayInMinutes: 1, periodInMinutes: 60 });
  runIfNeededToday("安装后");
});

// 浏览器启动 = 每天首次打开浏览器，立即检查并签到
chrome.runtime.onStartup.addListener(async () => {
  await ensureHeaderRules();
  runIfNeededToday("浏览器启动");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_INSPECT) {
    runIfNeededToday("定时巡检");
  }
});

// ============================================================================
// 消息通信
// ============================================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    switch (request.action) {
      case "forceCheckInAll": {
        sendResponse({ status: "processing" });
        await runAllAccounts({ manual: true });
        break;
      }
      case "forceCheckInOne": {
        const settings = await getSettings();
        const acc = settings.accounts.find((a) => a.id === request.id);
        sendResponse({ status: "processing" });
        if (acc) {
          await runAccount(acc, { manual: true });
          const latest = await getSettings();
          latest.accounts = latest.accounts.map((a) => (a.id === acc.id ? { ...a, ...acc } : a));
          await saveAccounts(latest.accounts);
        }
        break;
      }
      case "rescheduleAlarm": {
        // 账号变化后，按最新域名刷新请求头伪装规则
        await ensureHeaderRules();
        sendResponse({ status: "ok" });
        break;
      }
      case "refreshHeaderRules": {
        await ensureHeaderRules();
        sendResponse({ status: "ok" });
        break;
      }
      case "fetchPoints": {
        // 拉取单账号积分/日历（供设置页展示）
        try {
          const settings = await getSettings();
          const acc = settings.accounts.find((a) => a.id === request.id);
          if (!acc) {
            sendResponse({ ok: false, message: "账号不存在" });
            break;
          }
          const info = await fetchAccountPoints(acc);
          sendResponse(info);
        } catch (e) {
          sendResponse({ ok: false, message: e.message });
        }
        break;
      }
      default:
        sendResponse({ status: "unknown" });
    }
  })();
  return true; // 异步响应
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
