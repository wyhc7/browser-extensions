/**
 * 真引擎探针的 service worker。
 *
 * 回答的是 mock 单测回答不了的问题：chrome.cookies.set / remove 会不会接受
 * accounts.js 生成的 details，写回去的 Cookie 属性有没有走样。
 *
 * 任何一步都不允许中断 —— 出错也要把报告回传（POST 到本地收集器）。
 */
import { COOKIE_DOMAIN, cookieToRemoveDetails, cookieToSetDetails, packCookie } from "./lib/accounts.js";

const REPORT_URL = "http://127.0.0.1:8124/report";
const HOME_URL = "https://www.bilibili.com/";
const NAV = "https://api.bilibili.com/x/web-interface/nav";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body) {
  for (let i = 0; i < 10; i += 1) {
    try {
      const res = await fetch(REPORT_URL, { method: "POST", body });
      if (res.ok) return true;
    } catch {
      /* 收集器可能还没起来 */
    }
    await wait(600);
  }
  return false;
}

const all = () => chrome.cookies.getAll({ domain: COOKIE_DOMAIN });

const shape = (c) => ({
  name: c?.name,
  domain: c?.domain,
  path: c?.path,
  secure: !!c?.secure,
  httpOnly: !!c?.httpOnly,
  hostOnly: !!c?.hostOnly,
  session: !!c?.session,
  sameSite: c?.sameSite,
  expires: c?.session ? "session" : Math.round(c?.expirationDate ?? 0),
  valueLen: String(c?.value ?? "").length,
});

function diffShape(before, after) {
  const out = [];
  for (const key of ["domain", "path", "secure", "httpOnly", "hostOnly", "session", "sameSite", "expires", "valueLen"]) {
    if (before[key] !== after[key]) out.push(`${key}: ${JSON.stringify(before[key])} -> ${JSON.stringify(after[key])}`);
  }
  return out;
}

async function step(label, fn) {
  try {
    return { label, ok: true, result: await fn() };
  } catch (err) {
    return { label, ok: false, error: err?.message || String(err) };
  }
}

const base = () => ({
  value: "probe",
  domain: ".bilibili.com",
  path: "/",
  secure: false,
  httpOnly: false,
  hostOnly: false,
  session: false,
  sameSite: "unspecified",
  expirationDate: Math.floor(Date.now() / 1000) + 86400,
  storeId: "0",
});

/** 单个组合：写 → 读回比对 → 用自己的 details 删掉。 */
async function combo(label, raw, report) {
  const cookie = packCookie(raw);
  const details = cookieToSetDetails(cookie);
  const entry = {
    组合: label,
    url: details.url,
    带domain: details.domain ?? "(无 → hostOnly)",
    secure: !!details.secure,
    session: typeof details.expirationDate !== "number",
    结果: null,
    读回: null,
    删除: null,
    删除后仍在: null,
  };
  try {
    entry.结果 = (await chrome.cookies.set(details)) ? "接受" : "返回 null（被拒绝）";
  } catch (err) {
    entry.结果 = `抛异常：${err?.message || err}`;
  }
  const back = (await all()).find((c) => c.name === cookie.name) || null;
  entry.读回 = back ? shape(back) : null;
  entry.属性差异 = back ? diffShape(shape(cookie), shape(back)) : ["读不到这个 Cookie"];
  try {
    entry.删除 = (await chrome.cookies.remove(cookieToRemoveDetails(cookie))) ? "命中" : "返回 null";
  } catch (err) {
    entry.删除 = `抛异常：${err?.message || err}`;
  }
  entry.删除后仍在 = (await all()).some((c) => c.name === cookie.name);
  report.push(entry);
}

async function run() {
  const report = { engine: navigator.userAgent, steps: [], siteCookies: [], fullRoundTrip: null, matrix: [], deleteByPastExpiry: null, notes: [], crashed: null };

  try {
    report.steps.push(
      await step("加载 B 站首页（让站点下发真实 Cookie）", async () => {
        const res = await fetch(HOME_URL, { credentials: "include" });
        return res.status;
      }),
    );
    report.steps.push(
      await step("扩展来源的 nav 请求（未登录应为 -101）", async () => {
        const res = await fetch(NAV, { credentials: "include", cache: "no-store" });
        const json = await res.json();
        return { status: res.status, code: json?.code, isLogin: json?.data?.isLogin === true };
      }),
    );

    const site = await all();
    report.siteCookies = site.map(shape);

    // 全量往返：照原样读 → 全删 → 全写回 → 逐项比对（= 切换账号时对 Cookie 做的事）
    report.fullRoundTrip = await step("站点真实 Cookie 全量往返", async () => {
      const packed = site.map(packCookie);
      const removeErrors = [];
      for (const c of packed) {
        try {
          await chrome.cookies.remove(cookieToRemoveDetails(c));
        } catch (err) {
          removeErrors.push(`${c.name}: ${err?.message || err}`);
        }
      }
      const afterRemove = await all();
      const writeErrors = [];
      for (const c of packed) {
        try {
          if (!(await chrome.cookies.set(cookieToSetDetails(c)))) writeErrors.push(`${c.name}: 被拒绝`);
        } catch (err) {
          writeErrors.push(`${c.name}: ${err?.message || err}`);
        }
      }
      const afterWrite = await all();
      return {
        原始: site.length,
        删除报错: removeErrors,
        删除后剩余: afterRemove.length,
        写回报错: writeErrors,
        最终: afterWrite.length,
        丢失: site.filter((c) => !afterWrite.some((n) => n.name === c.name && n.path === c.path)).map((c) => `${c.name}@${c.domain}${c.path}`),
        属性走样: site
          .map((c) => {
            const back = afterWrite.find((n) => n.name === c.name && n.path === c.path);
            if (!back) return null;
            const d = diffShape(shape(c), shape(back));
            return d.length ? `${c.name}@${c.domain}${c.path}: ${d.join("; ")}` : null;
          })
          .filter(Boolean),
      };
    });

    // 写入矩阵：域名/hostOnly × secure/非 × session/带过期，各用独立 Cookie 名，互不干扰
    let n = 0;
    for (const hostOnly of [false, true]) {
      for (const secure of [false, true]) {
        for (const session of [false, true]) {
          n += 1;
          await combo(
            `#${n} ${hostOnly ? "hostOnly(www)" : "域(.bilibili.com)"} / ${secure ? "secure" : "非secure"} / ${session ? "session" : "带过期"}`,
            { ...base(), name: `probe${n}`, hostOnly, domain: hostOnly ? "www.bilibili.com" : ".bilibili.com", secure, session, ...(session ? { expirationDate: undefined } : {}) },
            report.matrix,
          );
        }
      }
    }

    // 用"过期时间设在过去"来删除，会不会抛？
    report.deleteByPastExpiry = await step("按过期时间删除（过期时间设在过去）", async () => {
      const live = packCookie({ ...base(), name: "probeDel" });
      await chrome.cookies.set(cookieToSetDetails(live));
      const past = packCookie({ ...base(), name: "probeDel", expirationDate: Math.floor(Date.now() / 1000) - 3600 });
      let how;
      try {
        const written = await chrome.cookies.set(cookieToSetDetails(past));
        how = written ? "接受（返回了 Cookie）" : "返回 null";
      } catch (err) {
        how = `抛异常：${err?.message || err}`;
      }
      return { 结果: how, 删除后仍在: (await all()).some((c) => c.name === "probeDel") };
    });
  } catch (err) {
    report.crashed = err?.message || String(err);
  }

  // 收尾：把探针自己写进去的东西清掉，别污染真实站点数据
  try {
    for (const c of await all()) {
      if (c.name.startsWith("probe")) await chrome.cookies.remove(cookieToRemoveDetails(packCookie(c)));
    }
    report.notes.push(`清理后剩余探针 Cookie：${(await all()).filter((c) => c.name.startsWith("probe")).length}`);
  } catch (err) {
    report.notes.push(`清理失败：${err?.message || err}`);
  }

  await post(JSON.stringify(report, null, 2));
}

const started = run();
chrome.runtime.onInstalled.addListener(() => started);
chrome.runtime.onStartup?.addListener(() => started);
