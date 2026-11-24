// ============================================================================
// 文件名：sites.js
// 作用：站点适配器注册表。每个站点定义为一组函数（登录检测 / 签到 / 积分与日历），
//       让 background.js 与 options.js 以统一方式处理任意站点。
// 新增站点：在 SITE_ADAPTERS 里加一个对象即可，无需改动其它文件的核心逻辑。
// ============================================================================

// ---------- 通用工具 ----------

// 把 "name=value; name2=value2" 形式的 Cookie 字符串解析为对象
export function parseCookieString(str) {
  const out = {};
  if (!str) return out;
  str.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  });
  return out;
}

// 规范化用户粘贴的 Cookie：允许用户直接粘贴整段（含 "Cookie:" 前缀）
export function normalizeCookie(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  // 去掉可能带的 "Cookie:" 前缀
  s = s.replace(/^cookie\s*:\s*/i, "");
  // 去掉换行
  s = s.replace(/[\r\n]+/g, " ");
  return s;
}

// 从 Cookie 字符串中读取某个键的值
export function getCookieValue(cookieStr, key) {
  return parseCookieString(cookieStr)[key];
}

// 人类可读的时间
export function nowString() {
  return new Date().toLocaleString();
}

// 本地今日日期字符串 "YYYY-MM-DD"
export function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 从 history 流水（[{time: 毫秒时间戳, business, change}]）里提取 { "Y-M-D": points } 的签到映射
export function buildCheckinMap(historyList) {
  const map = {};
  (historyList || []).forEach((item) => {
    const business = item.business || "";
    if (!/checkin/i.test(business)) return;
    const t = Number(item.time);
    if (!t) return;
    const d = new Date(t);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const pts = parseInt(item.change, 10);
    map[key] = isNaN(pts) ? 0 : pts;
  });
  return map;
}

// ============================================================================
// 站点适配器：GLaDOS（支持多个后缀 / 镜像域名）
// 常见后缀：glados.cloud / glados.rocks / glados.homes / glados.info / glados.one ...
// 不同后缀对应不同账号池，用户每个账号填入自己所属后缀的地址即可。
// ============================================================================
const gladosAdapter = {
  id: "glados",
  name: "GLaDOS",
  // 默认站点根地址（用户可自定义，用于区分不同域名/镜像）
  defaultBaseUrl: "https://glados.cloud",
  // 已知后缀预设（供设置页下拉快速选择，仍允许自定义输入）
  knownBaseUrls: [
    "https://glados.cloud",
    "https://glados.rocks",
    "https://glados.homes",
    "https://glados.info",
    "https://glados.one",
    "https://glados.xyz",
    "https://glados.network",
  ],
  // 该站点用于鉴权的 Cookie 名（会话）
  sessionCookieName: "koa:sess",

  // 由 baseUrl 推导各接口地址
  endpoints(baseUrl) {
    return {
      points: `${baseUrl}/api/user/points`,
      checkin: `${baseUrl}/api/user/checkin`,
      checkinPage: `${baseUrl}/console/checkin`,
      loginPage: `${baseUrl}/console/login`,
    };
  },

  // 生成带 Cookie 与拟真头的请求头（伪装成从官网页面内部发起）
  headers(baseUrl, cookie) {
    return {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Origin": baseUrl,
      "Referer": `${baseUrl}/console/checkin`,
      "Cookie": cookie,
    };
  },

  // 解析 points 接口响应 -> 标准化结构，供后台与设置页共用
  parsePointsResponse(data) {
    if (!data || data.code !== 0) {
      return { ok: false, notLoggedIn: true };
    }
    return {
      ok: true,
      points: Math.floor(Number(data.points) || 0),
      streak: data.streak !== undefined ? data.streak : 0,
      checkinMap: buildCheckinMap(data.history),
    };
  },

  // 解析 checkin 接口响应 -> { ok, message, points, alreadyChecked, needTurnstile }
  parseCheckinResponse(data) {
    if (!data) return { ok: false, message: "服务器无响应" };
    const message = data.message || data.reason || "签到完成";
    const lower = String(message).toLowerCase();
    // Cloudflare Turnstile 人机验证未过（纯 API 请求拿不到 token 必然出现）
    if (data.code === 5 || data.reason === "turnstile" || lower.includes("cloudflare") || lower.includes("turnstile")) {
      return {
        ok: false,
        needTurnstile: true,
        retryable: !!data.retryable,
        message: "需通过 Cloudflare 人机验证（Turnstile）：请用“真实页面点击”方式，或在浏览器中手动点一次",
      };
    }
    const alreadyChecked =
      lower.includes("repeat") ||
      lower.includes("tomorrow") ||
      lower.includes("already") ||
      message.includes("已签到");
    let pts = 0;
    if (data.points !== undefined && Number(data.points) > 0) {
      pts = Number(data.points);
    } else if (data.list && data.list.length > 0 && data.code === 0) {
      const c = parseInt(data.list[0].change, 10);
      if (!isNaN(c) && c > 0) pts = c;
    }
    // 从按钮文字如 "Checkin! Got 2 Points" / "签到成功 +5" 解析点数
    if (!pts) {
      const m = message.match(/(?:got|获得|\+)\s*([\d.]+)\s*(?:points?|点)?/i);
      if (m) {
        const v = Math.round(parseFloat(m[1]));
        if (!isNaN(v) && v > 0) pts = v;
      }
    }
    return { ok: data.code === 0 || alreadyChecked, message, points: pts, alreadyChecked };
  },
};

// 站点注册表（id -> adapter）——本版本仅保留 GLaDOS（多后缀）
export const SITE_ADAPTERS = {
  glados: gladosAdapter,
};

// 供 UI 下拉框使用的列表（含已知后缀预设）
export const SITE_LIST = Object.values(SITE_ADAPTERS).map((a) => ({
  id: a.id,
  name: a.name,
  defaultBaseUrl: a.defaultBaseUrl,
  knownBaseUrls: a.knownBaseUrls || [],
}));

export function getAdapter(siteId) {
  return SITE_ADAPTERS[siteId] || SITE_ADAPTERS.glados;
}
