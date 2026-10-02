/**
 * Service worker：所有涉及 cookie 读写与网络请求的操作都集中在这里。
 * popup 只发消息，不直接碰 cookie —— 这样切换逻辑只有一份实现。
 */
import {
  COOKIE_DOMAIN,
  FAILURE_KEY,
  SETTINGS_KEY,
  STORAGE_KEY,
  buildExport,
  cookieKey,
  cookieToRemoveDetails,
  cookieToSetDetails,
  createAccount,
  describeNav,
  displayName,
  findAccountByMid,
  normalizeSettings,
  packCookie,
  parseImport,
  scopedCookies,
} from "./lib/accounts.js";

const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const BILI_TABS = ["*://*.bilibili.com/*", "*://bilibili.com/*"];
const BADGE_COLOR = "#FB7299";
const BADGE_MIN_INTERVAL_MS = 5000;

let switching = false;
let lastBadgeAt = 0;

/* ---------------------------------------------------------------- 存储 */

async function getAccounts() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(raw[STORAGE_KEY]) ? raw[STORAGE_KEY] : [];
}

async function setAccounts(accounts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: accounts });
}

async function getSettings() {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(raw[SETTINGS_KEY]);
}

/**
 * 上一次切换失败留下的记录。
 *
 * 切换失败几乎只有一个原因：那家的 SESSDATA 已在 B 站服务端失效，而这件事
 * 客户端无法凭自己修好。把它记下来，账号行上直接标出来，比让人反复试要好。
 */
async function getFailure() {
  const raw = await chrome.storage.local.get(FAILURE_KEY);
  const f = raw[FAILURE_KEY];
  if (!f || typeof f !== "object" || typeof f.mid !== "string" || typeof f.at !== "number") return null;
  return { mid: f.mid, at: f.at, kind: f.kind === "revoked" ? "revoked" : "identity" };
}

async function setFailure(mid, kind) {
  await chrome.storage.local.set({ [FAILURE_KEY]: { mid: String(mid), at: Date.now(), kind } });
}

/** 只有"这一次成功/刷新的是同一家"时才清掉标记。 */
async function clearFailure(mid) {
  const cur = await getFailure();
  if (!cur) return;
  if (mid !== undefined && cur.mid !== String(mid)) return;
  await chrome.storage.local.remove(FAILURE_KEY);
}

/* ------------------------------------------------------------ 站内接口 */

/** nav 是判定"当前是谁"的最权威来源：仅凭 Cookie（SESSDATA）。 */
async function fetchNav() {
  try {
    const res = await fetch(NAV_URL, { credentials: "include", cache: "no-store" });
    if (!res.ok) return { info: null, code: null, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { info: describeNav(json?.data), code: json?.code ?? null, error: null };
  } catch (err) {
    return { info: null, code: null, error: err?.message || String(err) };
  }
}

async function readLiveScopedCookies(settings) {
  const all = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
  return scopedCookies(all, settings);
}

/** 同一个 Cookie 换另一种 scheme 的 URL —— 实测见到 set/remove 会按 scheme 绑定。 */
function alternateUrl(url) {
  return url.startsWith("https:") ? url.replace(/^https:/, "http:") : url.replace(/^http:/, "https:");
}

/** 删掉一个 Cookie。主 URL 没命中就换 scheme 再试，避免漏删。 */
async function removeOne(cookie) {
  const details = cookieToRemoveDetails(cookie);
  try {
    if (await chrome.cookies.remove(details)) return true;
  } catch {
    /* 落到下面的备选 URL */
  }
  try {
    return !!(await chrome.cookies.remove({ ...details, url: alternateUrl(details.url) }));
  } catch {
    return false;
  }
}

/**
 * 写入一个 Cookie。
 *
 * 实测发现：当同一个 (name, domain, path) 已经存在、且旧的 binding 与本次的
 * scheme/secure 组合冲突时，chrome.cookies.set 会直接抛
 * "Failed to parse or set cookie named X"。所以先尝试把同名同路径的清掉，
 * 再写；主 URL 被拒就换 scheme 再试一次。
 */
async function writeOne(cookie) {
  const details = cookieToSetDetails(cookie);
  const existing = (await chrome.cookies.getAll({ domain: COOKIE_DOMAIN })).filter(
    (c) => cookieKey(c) === cookieKey(cookie),
  );
  for (const old of existing) await removeOne(old);

  try {
    if (await chrome.cookies.set(details)) return true;
  } catch {
    /* 落到下面的备选 URL */
  }
  try {
    return !!(await chrome.cookies.set({ ...details, url: alternateUrl(details.url) }));
  } catch {
    return false;
  }
}

/** 删掉这些 Cookie，返回没删成功的名字。 */
async function removeCookies(cookies) {
  const failed = [];
  for (const cookie of cookies) {
    if (!(await removeOne(cookie))) failed.push(cookie.name);
  }
  return failed;
}

/** 写入这些 Cookie，返回被拒绝的名字。 */
async function writeCookies(cookies) {
  const failed = [];
  for (const cookie of cookies) {
    if (!(await writeOne(cookie))) failed.push(cookie.name);
  }
  return failed;
}

/**
 * 清空浏览器里的身份 Cookie。
 *
 * 只删本机凭据，**绝不**调用 B 站的退出登录接口（/login/exit/v2）——
 * 那个接口会在服务端注销 SESSDATA，等于把刚存下来的快照当场作废。
 */
async function clearLiveIdentity(settings) {
  const live = await readLiveScopedCookies(settings);
  return { live, failed: await removeCookies(live) };
}

function describeCookie(cookie) {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    hostOnly: !!cookie.hostOnly,
    session: !!cookie.session,
    sameSite: cookie.sameSite,
    valueLen: (cookie.value || "").length,
    expiresAt: cookie.session ? "session" : new Date(cookie.expirationDate * 1000).toISOString(),
  };
}

/** 把当前登录态打包成一条账号记录的数据。未登录返回 null。 */
async function captureCurrent() {
  const settings = await getSettings();
  const { info, error } = await fetchNav();
  if (error) throw new Error(`读取登录状态失败：${error}`);
  if (!info?.loggedIn) return null;
  const cookies = (await readLiveScopedCookies(settings)).map(packCookie);
  if (!cookies.length) return null;
  return { info, cookies };
}

/* ------------------------------------------------------------ 标签页/徽标 */

async function reloadBiliTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: BILI_TABS });
  } catch {
    return 0;
  }
  let reloaded = 0;
  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    try {
      // bypassCache：nav 结果可能躺在 HTTP 缓存里，硬刷新才能立刻看到新身份
      await chrome.tabs.reload(tab.id, { bypassCache: true });
      reloaded += 1;
    } catch {
      /* 标签页可能刚好被关掉，忽略 */
    }
  }
  return reloaded;
}

async function refreshBadge(info) {
  const now = Date.now();
  if (now - lastBadgeAt < BADGE_MIN_INTERVAL_MS) return;
  lastBadgeAt = now;
  const settings = await getSettings();
  if (!settings.showBadge) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  let text = "";
  if (info?.loggedIn) {
    const accounts = await getAccounts();
    const account = findAccountByMid(accounts, info.mid);
    text = Array.from(account ? displayName(account) : info.uname || "?")[0] || "";
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}

/* ---------------------------------------------------------------- 动作 */

/** 落盘一条账号记录：同 mid 覆盖快照，新 mid 追加。 */
async function storeAccount(captured) {
  const accounts = await getAccounts();
  const existing = findAccountByMid(accounts, captured.info.mid);
  const now = Date.now();
  if (existing) {
    existing.uname = captured.info.uname || existing.uname;
    existing.face = captured.info.face || existing.face;
    existing.level = captured.info.level;
    existing.vip = captured.info.vip;
    existing.cookies = captured.cookies;
    existing.updatedAt = now;
  } else {
    accounts.push(createAccount(captured.info, captured.cookies, now));
  }
  await setAccounts(accounts);
  return { accounts, account: existing || accounts.at(-1) };
}

async function saveCurrent() {
  const captured = await captureCurrent();
  if (!captured) throw new Error("当前未登录 B 站，先在网页上登录再保存。");
  const { accounts, account } = await storeAccount(captured);
  // 刚用这家真实的登录态覆盖了快照 —— 之前"凭据失效"的判断不再成立
  await clearFailure(captured.info.mid);
  await refreshBadge(captured.info);
  return { accounts, saved: describeAccount(account, captured.info.mid) };
}

/**
 * 「添加下一个账号」：先把当前账号存下来，然后只清掉浏览器里的凭据，
 * 让页面回到未登录状态，好在同一个浏览器里登录下一个账号。
 *
 * 这是本扩展唯一正确的换号方式：手动点网页上的「退出登录」会走 passport 的
 * /login/exit/v2，**在服务端注销该 SESSDATA**，刚存的快照立刻作废。
 */
async function parkCurrent() {
  const settings = await getSettings();
  const { info, error } = await fetchNav();
  if (error) throw new Error(`读取登录状态失败：${error}`);

  let saved = null;
  if (info?.loggedIn) saved = (await saveCurrent()).saved;

  const { live, failed } = await clearLiveIdentity(settings);
  const reloaded = settings.autoReload ? await reloadBiliTabs() : 0;
  lastBadgeAt = 0;
  await refreshBadge((await fetchNav()).info);
  return { saved, cleared: live.length - failed.length, reloaded, failed };
}

async function updateSnapshot(id, accounts) {
  const current = accounts.find((a) => a.id === id);
  if (!current) throw new Error("账号已不存在");
  const captured = await captureCurrent();
  if (!captured) return false;
  if (captured.info.mid !== String(current.mid)) return false;
  current.cookies = captured.cookies;
  current.uname = captured.info.uname || current.uname;
  current.face = captured.info.face || current.face;
  current.level = captured.info.level;
  current.vip = captured.info.vip;
  current.updatedAt = Date.now();
  return true;
}

/** 回滚：把切换前的现场写回去，别让用户停在"未登录"状态。 */
async function restoreLive(live, settings) {
  await removeCookies(await readLiveScopedCookies(settings));
  const failed = await writeCookies(live);
  if (settings.autoReload) await reloadBiliTabs();
  return failed.length === 0;
}

function explainSwitchFailure({ after, target, removeFailed, writeFailed, mismatched, rolledBack, retried }) {
  const details = [];
  if (removeFailed.length) details.push(`旧凭据有 ${removeFailed.length} 项没删掉（${removeFailed.join("、")}）`);
  if (writeFailed.length) details.push(`新凭据有 ${writeFailed.length} 项被拒绝（${writeFailed.join("、")}）`);
  if (mismatched.length) details.push(`写入后读回，${mismatched.join("、")} 的值对不上`);
  if (retried && !details.length) details.push("重做一遍仍然没有生效");
  const why = details.length ? `（${details.join("；")}）` : "";
  const tail = rolledBack ? "已回滚到切换前的账号。" : "回滚也没成功，请手动切回原来的账号。";
  if (!after?.loggedIn) {
    return (
      `切换失败：凭据写进去了，站内却仍是未登录${why}。` +
      `最可能的原因是「${displayName(target)}」的 SESSDATA 已在服务端失效 —— ` +
      `保存它的时候如果点过网页上的「退出登录」，B 站会直接注销那个 Token。` +
      `请重新登录该账号后点「保存当前账号」把快照覆盖掉，换号请用「添加下一个账号」。${tail}`
    );
  }
  return `切换失败：写完后站内身份是「${after.uname || after.mid}」，不是「${displayName(target)}」${why}。${tail}`;
}

async function switchTo(id) {
  if (switching) throw new Error("上一次切换还没结束，稍等片刻再试。");
  switching = true;
  try {
    const settings = await getSettings();
    // 每次切换都重新读盘：popup 可能刚改过设置或账号列表
    const accounts = await getAccounts();
    const target = accounts.find((a) => a.id === id);
    if (!target) throw new Error("账号已不存在，刷新一下列表。");

    // 1) 记下现场：现在是谁、罐里有哪些身份 Cookie。验证失败时要靠它回滚。
    const { info: before } = await fetchNav();
    const live = await readLiveScopedCookies(settings);
    const liveAccount = before?.loggedIn ? findAccountByMid(accounts, before.mid) : null;

    // 2) 离开前刷新"正在用的那个账号"的快照 —— SESSDATA 会轮换，
    //    不刷新的话下次切回来可能已经失效。刷新对象必须是当前登录的账号，
    //    不是列表里碰巧排在前面别的账号。
    if (settings.autoSync && liveAccount && liveAccount.id !== id) {
      try {
        if (await updateSnapshot(liveAccount.id, accounts)) await setAccounts(accounts);
      } catch {
        /* 刷新快照失败不该阻断切换本身 */
      }
    }

    // 3) 先清干净旧身份，再写入新身份。
    let removeFailed = await removeCookies(live);
    let writeFailed = await writeCookies(target.cookies);

    // 4) 刷新页面，然后**验证真的换过去了** —— "写入没报错"不等于"登录成功了"。
    const reloaded = settings.autoReload ? await reloadBiliTabs() : 0;
    const mismatchedNames = (want, got) =>
      want
        .filter((w) => !got.some((g) => cookieKey(g) === cookieKey(w) && g.value === w.value))
        .map((c) => c.name);
    const becameTarget = (info) => !!info?.loggedIn && String(info.mid) === String(target.mid);

    let { info: after } = await fetchNav();
    let afterCookies = await readLiveScopedCookies(settings);
    let mismatched = mismatchedNames(target.cookies, afterCookies);

    // 4b) 对不上就重做一次：把罐里剩下的身份 Cookie 再清一遍，然后重写。
    //     实测 Cookie 会按 scheme 绑定，漏删一个旧的就会让写入被拒、身份混在一起。
    let retried = false;
    if (mismatched.length || !becameTarget(after)) {
      retried = true;
      removeFailed = await removeCookies(await readLiveScopedCookies(settings));
      writeFailed = await writeCookies(target.cookies);
      if (settings.autoReload) await reloadBiliTabs();
      after = (await fetchNav()).info;
      afterCookies = await readLiveScopedCookies(settings);
      mismatched = mismatchedNames(target.cookies, afterCookies);
    }

    if (!becameTarget(after)) {
      const rolledBack = await restoreLive(live, settings);
      // 记下来：客户端自己修不了这个，界面需要直接说出来
      await setFailure(target.mid, after?.loggedIn ? "identity" : "revoked");
      lastBadgeAt = 0;
      await refreshBadge((await fetchNav()).info);
      throw new Error(
        explainSwitchFailure({
          after,
          target,
          removeFailed,
          writeFailed,
          mismatched,
          rolledBack,
          retried,
        }),
      );
    }

    await clearFailure(target.mid);
    lastBadgeAt = 0;
    await refreshBadge(after);
    return {
      ok: removeFailed.length === 0 && writeFailed.length === 0,
      account: describeAccount(target),
      applied: target.cookies.length,
      reloaded,
      retried,
      failed: [
        ...removeFailed.map((name) => `删除 ${name} 未命中`),
        ...writeFailed.map((name) => `写入 ${name} 被拒绝`),
      ],
      live: after,
    };
  } finally {
    switching = false;
  }
}

function describeAccount(account, midOverride) {
  if (!account) return null;
  return {
    id: account.id,
    mid: midOverride ?? account.mid,
    name: displayName(account),
    uname: account.uname,
    face: account.face,
    level: account.level,
    vip: account.vip,
    cookieCount: account.cookies?.length ?? 0,
    updatedAt: account.updatedAt,
  };
}

/* ---------------------------------------------------------------- 消息路由 */

const handlers = {
  async state() {
    const [accounts, settings, nav, failure] = await Promise.all([
      getAccounts(),
      getSettings(),
      fetchNav(),
      getFailure(),
    ]);
    const live = nav.info;
    return {
      settings,
      live,
      navError: nav.error,
      failure,
      accounts: accounts.map((a) => ({
        ...describeAccount(a),
        active: !!live?.loggedIn && String(a.mid) === live.mid,
        rejected: failure?.mid === String(a.mid),
      })),
      total: accounts.length,
    };
  },

  async save() {
    const { accounts, saved } = await saveCurrent();
    return { accounts: accounts.map((a) => describeAccount(a)), saved };
  },

  /** 保存当前账号 + 清空本地登录态 + 刷新页面，为登录下一个账号做准备 */
  async park() {
    return parkCurrent();
  },

  /** 一键诊断：把判定"到底卡在哪一步"需要的事实原样吐出来 */
  async diagnose() {
    const [accounts, settings, nav, failure] = await Promise.all([
      getAccounts(),
      getSettings(),
      fetchNav(),
      getFailure(),
    ]);
    const liveCookies = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
    return {
      report: {
        扩展: `${chrome.runtime.getManifest().name} ${chrome.runtime.getManifest().version}`,
        时间: new Date().toISOString(),
        设置: settings,
        站内身份: nav.error
          ? { 错误: nav.error }
          : {
              code: nav.code,
              isLogin: !!nav.info?.loggedIn,
              mid: nav.info?.mid ?? null,
              uname: nav.info?.uname ?? null,
            },
        上次切换失败: failure
          ? { mid: failure.mid, 类型: failure.kind, 于: new Date(failure.at).toISOString() }
          : null,
        浏览器里的B站Cookie: liveCookies.map(describeCookie),
        已存快照: accounts.map((a) => ({
          名称: displayName(a),
          mid: a.mid,
          更新于: a.updatedAt ? new Date(a.updatedAt).toISOString() : null,
          cookies: (a.cookies || []).map(describeCookie),
        })),
      },
    };
  },

  async update({ id }) {
    const accounts = await getAccounts();
    const changed = await updateSnapshot(id, accounts);
    if (!changed) throw new Error("当前登录的不是这个账号，先切过去再更新快照。");
    await setAccounts(accounts);
    const { info } = await fetchNav();
    lastBadgeAt = 0;
    await refreshBadge(info);
    return { ok: true, updated: describeAccount(accounts.find((a) => a.id === id)) };
  },

  async switch({ id }) {
    return switchTo(id);
  },

  async rename({ id, alias }) {
    const accounts = await getAccounts();
    const account = accounts.find((a) => a.id === id);
    if (!account) throw new Error("账号已不存在");
    const trimmed = String(alias ?? "").trim();
    if (trimmed) account.alias = trimmed;
    else delete account.alias;
    account.updatedAt = Date.now();
    await setAccounts(accounts);
    lastBadgeAt = 0;
    await refreshBadge((await fetchNav()).info);
    return { ok: true, updated: describeAccount(account) };
  },

  async remove({ id }) {
    const accounts = await getAccounts();
    const next = accounts.filter((a) => a.id !== id);
    if (next.length === accounts.length) throw new Error("账号已不存在");
    await setAccounts(next);
    lastBadgeAt = 0;
    await refreshBadge((await fetchNav()).info);
    return { ok: true, removed: accounts.length - next.length };
  },

  async export() {
    const accounts = await getAccounts();
    return { ok: true, payload: buildExport(accounts), count: accounts.length };
  },

  async import({ payload }) {
    const { accounts: incoming, warnings } = parseImport(payload);
    if (!incoming.length) {
      throw new Error(warnings[0] || "文件里没有可用的账号记录");
    }
    const accounts = await getAccounts();
    let added = 0;
    let replaced = 0;
    for (const account of incoming) {
      const index = accounts.findIndex((a) => String(a.mid) === String(account.mid));
      if (index >= 0) {
        // 保留原有别名与创建时间，只覆盖 Cookie 快照
        accounts[index] = {
          ...account,
          id: accounts[index].id,
          createdAt: accounts[index].createdAt,
          ...(accounts[index].alias ? { alias: accounts[index].alias } : {}),
        };
        replaced += 1;
      } else {
        accounts.push(account);
        added += 1;
      }
    }
    await setAccounts(accounts);
    return { ok: true, added, replaced, warnings };
  },

  async settings({ patch }) {
    const settings = normalizeSettings({ ...(await getSettings()), ...(patch || {}) });
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    lastBadgeAt = 0;
    await refreshBadge((await fetchNav()).info);
    return { ok: true, settings };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `未知的消息类型：${message?.type}` });
    return false;
  }
  Promise.resolve()
    .then(() => handler(message))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // 异步回复
});

/* ---------------------------------------------------------------- 事件 */

chrome.runtime.onInstalled.addListener(() => {
  fetchNav().then(({ info }) => refreshBadge(info));
});

chrome.runtime.onStartup?.addListener(() => {
  fetchNav().then(({ info }) => refreshBadge(info));
});

// 标签页加载完成后顺手校准徽标（有时间节流，不会打爆接口）
chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo) => {
  if (changeInfo.status !== "complete" || switching) return;
  fetchNav().then(({ info }) => refreshBadge(info));
});
