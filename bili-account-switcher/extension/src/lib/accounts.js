/**
 * 纯逻辑层：只接受普通对象、只返回普通对象，不接触任何 `chrome.*` API。
 * 这样同一份代码能被 service worker、popup 和 Node 单测共用。
 */

/** 承载"登录身份"的 Cookie —— 切换账号时被替换的就是这几个。 */
export const IDENTITY_COOKIE_NAMES = Object.freeze([
  "SESSDATA",
  "bili_jct",
  "DedeUserID",
  "DedeUserID__ckMd5",
  "sid",
]);

/**
 * 设备指纹类 Cookie。默认所有账号共用一份：短时间频繁更换 buvid 更容易触发风控，
 * 而这类字段本身不绑定账号。设置里可开启"连设备指纹一起切换"以做账号隔离。
 */
export const DEVICE_COOKIE_NAMES = Object.freeze([
  "buvid3",
  "buvid4",
  "buvid_fp",
  "b_nut",
  "b_lsid",
  "_uuid",
]);

export const COOKIE_DOMAIN = "bilibili.com";

export const STORAGE_KEY = "accounts";
export const SETTINGS_KEY = "settings";
/** 上一次切换失败记录：让界面能标出"这家的凭据已被 B 站拒绝"。 */
export const FAILURE_KEY = "lastFailure";
export const EXPORT_VERSION = 1;

export const SETTINGS_DEFAULTS = Object.freeze({
  /** 切换时连设备指纹 Cookie 一起换（默认关闭，见 DEVICE_COOKIE_NAMES 注释）。 */
  switchDevice: false,
  /** 切走之前先把当前账号的 Cookie 快照刷新一遍，避免 SESSDATA 轮换后快照过期。 */
  autoSync: true,
  /** 切换后自动刷新所有已打开的 B 站标签页。 */
  autoReload: true,
  /** 在扩展图标上显示当前账号首字。 */
  showBadge: true,
});

export function normalizeSettings(raw) {
  const out = { ...SETTINGS_DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      if (typeof raw[key] === "boolean") out[key] = raw[key];
    }
  }
  return out;
}

/** 属于 bilibili.com 或其子域。允许前导点（`.bilibili.com`）。 */
export function isBilibiliDomain(domain) {
  const d = String(domain ?? "").replace(/^\./, "").toLowerCase();
  return d === COOKIE_DOMAIN || d.endsWith(`.${COOKIE_DOMAIN}`);
}

export function scopeNames(settings) {
  const s = normalizeSettings(settings);
  return s.switchDevice
    ? [...IDENTITY_COOKIE_NAMES, ...DEVICE_COOKIE_NAMES]
    : [...IDENTITY_COOKIE_NAMES];
}

/** Cookie 的唯一标识：同名 Cookie 可以同时存在于不同 domain / path。 */
export function cookieKey(cookie) {
  return `${cookie.name}|${cookie.domain}|${cookie.path}`;
}

/** 挑出受切换管辖的 Cookie（身份类，或开启设备隔离后的身份类+指纹类）。 */
export function scopedCookies(cookies, settings) {
  const names = new Set(scopeNames(settings));
  return (Array.isArray(cookies) ? cookies : []).filter(
    (c) => c && names.has(c.name) && isBilibiliDomain(c.domain),
  );
}

export function normalizeSameSite(value) {
  return value === "lax" || value === "strict" || value === "no_restriction"
    ? value
    : "unspecified";
}

/**
 * 用 domain 推一个可用的 url：cookie 的 url 必须落在扩展的 host_permissions 内，
 * 且对于非 hostOnly Cookie，url 的 host 必须 domain-match 该 Cookie 的 domain。
 */
export function cookieUrl(cookie) {
  const bare = String(cookie.domain ?? "").replace(/^\./, "");
  const host = cookie.hostOnly ? bare : `www.${bare}`;
  const scheme = cookie.secure ? "https" : "http";
  return `${scheme}://${host}${cookie.path || "/"}`;
}

/** 把一个 chrome.cookies.Cookie 压缩成值得存盘的形状。 */
export function packCookie(cookie) {
  const session = cookie.session === true || typeof cookie.expirationDate !== "number";
  const packed = {
    name: String(cookie.name),
    value: String(cookie.value ?? ""),
    domain: String(cookie.domain),
    path: cookie.path || "/",
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    hostOnly: !!cookie.hostOnly,
    session,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
  if (!session) packed.expirationDate = cookie.expirationDate;
  // CHIPS（分区 Cookie）目前 B 站没用到，读到了就原样带着，避免删不干净。
  if (cookie.partitionKey && typeof cookie.partitionKey.topLevelSite === "string") {
    packed.partitionKey = { topLevelSite: cookie.partitionKey.topLevelSite };
  }
  return packed;
}

/** 还原成 chrome.cookies.set() 的入参，保证属性不走样。 */
export function cookieToSetDetails(cookie) {
  const details = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
  // __Host- 前缀的 Cookie 不允许带 Domain 属性；hostOnly 的 Cookie 同理。
  if (!cookie.hostOnly && !String(cookie.name).startsWith("__Host-")) {
    details.domain = cookie.domain;
  }
  if (!cookie.session && typeof cookie.expirationDate === "number") {
    details.expirationDate = cookie.expirationDate;
  }
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  return details;
}

/** 还原成 chrome.cookies.remove() 的入参：url 必须带上 path，否则匹配不到。 */
export function cookieToRemoveDetails(cookie) {
  const details = { url: cookieUrl(cookie), name: cookie.name };
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  if (cookie.storeId) details.storeId = cookie.storeId;
  return details;
}

/** 把 /x/web-interface/nav 的 data 归一化成界面用的形状。 */
export function describeNav(data) {
  if (!data || data.isLogin !== true) return { loggedIn: false };
  const mid = String(data.mid ?? "");
  return {
    loggedIn: true,
    mid,
    uname: data.uname || `UID ${mid}`,
    face: typeof data.face === "string" ? data.face : "",
    level: Number(data.level_info?.current_level ?? 0) || 0,
    vip: Number(data.vipStatus ?? data.vip?.status ?? 0) === 1,
    vipLabel: data.vip_label?.text || data.vip?.label?.text || "",
  };
}

export function findAccountByMid(accounts, mid) {
  const id = String(mid ?? "");
  if (!id || id === "0") return null;
  return (Array.isArray(accounts) ? accounts : []).find((a) => String(a.mid) === id) || null;
}

export function newId() {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `acc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createAccount(info, cookies, now = Date.now()) {
  return {
    id: newId(),
    mid: String(info.mid),
    uname: info.uname,
    face: info.face,
    level: info.level,
    vip: info.vip,
    cookies,
    createdAt: now,
    updatedAt: now,
  };
}

/** 界面展示名：用户改过就用别名，否则用昵称。 */
export function displayName(account) {
  return account?.alias || account?.uname || `UID ${account?.mid ?? "?"}`;
}

/** 头像加载失败时的兜底字符。没有昵称就退回品牌字母，而不是 "UID x" 的 U。 */
export function avatarInitial(account) {
  const name = String(account?.alias || account?.uname || "").trim();
  return name ? Array.from(name)[0].toUpperCase() : "B";
}

function sanitizeCookie(raw, warn) {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  const domain = String(raw.domain ?? "");
  if (!isBilibiliDomain(domain)) {
    warn(`已丢弃非 bilibili 域的 Cookie：${name}@${domain || "(空)"}`);
    return null;
  }
  return {
    name,
    value: String(raw.value ?? ""),
    domain,
    path: typeof raw.path === "string" && raw.path ? raw.path : "/",
    secure: !!raw.secure,
    httpOnly: !!raw.httpOnly,
    hostOnly: !!raw.hostOnly,
    session: raw.session === true || typeof raw.expirationDate !== "number",
    sameSite: normalizeSameSite(raw.sameSite),
    ...(typeof raw.expirationDate === "number" && raw.session !== true
      ? { expirationDate: raw.expirationDate }
      : {}),
  };
}

function sanitizeAccount(raw, warn) {
  if (!raw || typeof raw !== "object") return null;
  const mid = String(raw.mid ?? "").trim();
  if (!/^\d+$/.test(mid) || mid === "0") {
    warn("已丢弃缺少合法 mid 的账号记录");
    return null;
  }
  const cookies = (Array.isArray(raw.cookies) ? raw.cookies : [])
    .map((c) => sanitizeCookie(c, warn))
    .filter(Boolean);
  if (!cookies.length) {
    warn(`账号 ${mid} 没有任何可用的 Cookie，已丢弃`);
    return null;
  }
  const now = Date.now();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
    mid,
    uname: typeof raw.uname === "string" && raw.uname ? raw.uname : `UID ${mid}`,
    face: typeof raw.face === "string" ? raw.face : "",
    level: Number(raw.level ?? 0) || 0,
    vip: !!raw.vip,
    cookies,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    ...(typeof raw.alias === "string" && raw.alias.trim() ? { alias: raw.alias.trim() } : {}),
  };
}

/**
 * 解析导入文件：既接受本扩展的导出信封，也接受裸数组（hand-made 备份）。
 * 返回 { accounts, warnings }，不抛异常 —— 坏数据被逐条跳过并记录原因。
 */
export function parseImport(payload) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  let list;
  if (Array.isArray(payload)) list = payload;
  else if (payload && Array.isArray(payload.accounts)) list = payload.accounts;
  else if (payload && payload.accounts && typeof payload.accounts === "object") {
    list = Object.values(payload.accounts);
  } else {
    warn("文件里没有找到 accounts 数组");
    list = [];
  }
  const accounts = list.map((a) => sanitizeAccount(a, warn)).filter(Boolean);
  // 同一 mid 只保留最后一条
  const byMid = new Map();
  for (const a of accounts) byMid.set(a.mid, a);
  if (byMid.size !== accounts.length) warn("存在重复账号，已按 mid 去重");
  return { accounts: [...byMid.values()], warnings };
}

export function buildExport(accounts, now = Date.now()) {
  return {
    app: "bili-account-switcher",
    version: EXPORT_VERSION,
    exportedAt: new Date(now).toISOString(),
    accounts,
  };
}
