/*
 * 仅供本地预览：在普通标签页里顶掉 chrome.runtime，让 popup.js 能脱离扩展环境渲染。
 * 不参与打包（extension/ 目录里没有这个文件，tools/verify.mjs 会校验这一点）。
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const IDENTITY = [
  ["SESSDATA", ".bilibili.com", true],
  ["bili_jct", ".bilibili.com", true],
  ["DedeUserID", ".bilibili.com", false],
  ["DedeUserID__ckMd5", ".bilibili.com", false],
  ["sid", ".bilibili.com", false],
];

const stores = {
  夜航星: {
    id: "acc-1",
    mid: "39472118",
    uname: "夜航星",
    alias: "主号",
    face: "",
    level: 6,
    vip: true,
    cookieCount: 5,
    updatedAt: Date.now() - 40 * 1000,
  },
  碳酸氢钠不加冰: {
    id: "acc-2",
    mid: "118293",
    uname: "碳酸氢钠不加冰",
    face: "https://i0.hdslb.com/bfs/face/definitely-missing.png",
    level: 4,
    vip: false,
    cookieCount: 5,
    updatedAt: Date.now() - 19 * 3600 * 1000,
  },
  海边的卡夫卡: {
    id: "acc-3",
    mid: "77651234",
    uname: "海边的卡夫卡",
    face:
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="#2b7fff"/><circle cx="36" cy="28" r="12" fill="#fff"/><path d="M12 72c0-14 11-22 24-22s24 8 24 22z" fill="#fff"/></svg>',
      ),
    level: 5,
    vip: true,
    cookieCount: 5,
    updatedAt: Date.now() - 3 * 24 * 3600 * 1000,
  },
};

let accounts = Object.values(stores);
let settings = { switchDevice: false, autoSync: true, autoReload: true, showBadge: true };
let currentMid = "39472118";

// ?state=empty 看空态；?state=dead 看"凭据在服务端失效"的失败提示。
// 必须在数据层模拟：在页面里改 DOM 会被 popup.js 的首次 render() 覆盖。
const PREVIEW_STATE = new URLSearchParams(location.search).get("state");
const EMPTY = PREVIEW_STATE === "empty";
const DEAD = PREVIEW_STATE === "dead";

function listAccounts() {
  if (EMPTY) return [];
  return accounts.map((account) => ({ ...account, active: account.mid === currentMid }));
}

const liveFor = (mid) => {
  if (EMPTY) return { loggedIn: false };
  const account = accounts.find((a) => a.mid === mid);
  if (!account) return { loggedIn: false };
  return {
    loggedIn: true,
    mid: account.mid,
    uname: account.uname,
    face: account.face,
    level: account.level,
    vip: account.vip,
    vipLabel: account.vip ? "年度大会员" : "",
  };
};

window.chrome = {
  runtime: {
    getManifest: () => ({ version: "1.1.2-preview" }),
    async sendMessage(message) {
      await wait(140);
      switch (message.type) {
        case "state":
          return { ok: true, accounts: listAccounts(), live: liveFor(currentMid), settings, navError: null };
        case "switch": {
          if (DEAD) {
            return {
              ok: false,
              error:
                "切换失败：凭据写进去了，站内却仍是未登录（写入后读回，SESSDATA 的值对不上）。" +
                "最可能的原因是「海边的卡夫卡」的 SESSDATA 已在服务端失效 —— " +
                "保存它的时候如果点过网页上的「退出登录」，B 站会直接注销那个 Token。" +
                "请重新登录该账号后点「保存当前账号」把快照覆盖掉，换号请用「添加下一个账号」。" +
                "已回滚到切换前的账号。",
            };
          }
          currentMid = accounts.find((a) => a.id === message.id)?.mid ?? currentMid;
          const account = accounts.find((a) => a.id === message.id);
          return { ok: true, account, applied: IDENTITY.length, reloaded: 2, failed: [], live: liveFor(currentMid) };
        }
        case "save":
          return { ok: true, accounts: listAccounts(), saved: { name: "新保存的账号" } };
        case "park": {
          const account = accounts.find((a) => a.mid === currentMid);
          currentMid = null;
          return {
            ok: true,
            saved: account ? { name: account.alias || account.uname } : null,
            cleared: IDENTITY.length,
            reloaded: 2,
            failed: [],
          };
        }
        case "diagnose":
          return {
            ok: true,
            report: {
              扩展: "B站多账号切换 1.1.0",
              时间: new Date().toISOString(),
              设置: settings,
              站内身份: { code: 0, isLogin: true, mid: "39472118", uname: "夜航星" },
              浏览器里的B站Cookie: [
                { name: "SESSDATA", domain: ".bilibili.com", path: "/", secure: true, httpOnly: true, hostOnly: false, session: false, sameSite: "no_restriction", valueLen: 62, expiresAt: "2026-04-11T03:22:10.000Z" },
                { name: "bili_jct", domain: ".bilibili.com", path: "/", secure: false, httpOnly: false, hostOnly: false, session: false, sameSite: "unspecified", valueLen: 32, expiresAt: "2026-04-11T03:22:10.000Z" },
                { name: "DedeUserID", domain: ".bilibili.com", path: "/", secure: false, httpOnly: false, hostOnly: false, session: false, sameSite: "unspecified", valueLen: 8, expiresAt: "2026-04-11T03:22:10.000Z" },
                { name: "DedeUserID__ckMd5", domain: ".bilibili.com", path: "/", secure: false, httpOnly: false, hostOnly: false, session: false, sameSite: "unspecified", valueLen: 16, expiresAt: "2026-04-11T03:22:10.000Z" },
                { name: "sid", domain: ".bilibili.com", path: "/", secure: false, httpOnly: false, hostOnly: false, session: true, sameSite: "unspecified", valueLen: 8, expiresAt: "session" },
                { name: "buvid3", domain: ".bilibili.com", path: "/", secure: false, httpOnly: false, hostOnly: false, session: false, sameSite: "unspecified", valueLen: 37, expiresAt: "2026-12-01T00:00:00.000Z" },
              ],
              已存快照: accounts.map((a) => ({
                名称: a.alias || a.uname,
                mid: a.mid,
                更新于: new Date(a.updatedAt).toISOString(),
                cookies: ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"].map((name) => ({
                  name,
                  domain: ".bilibili.com",
                  path: "/",
                  secure: name === "SESSDATA",
                  httpOnly: name === "SESSDATA",
                  hostOnly: false,
                  session: name === "sid",
                  sameSite: name === "SESSDATA" ? "no_restriction" : "unspecified",
                  valueLen: name === "SESSDATA" ? 62 : 16,
                  expiresAt: name === "sid" ? "session" : "2026-04-11T03:22:10.000Z",
                })),
              })),
            },
          };
        case "settings":
          settings = { ...settings, ...message.patch };
          return { ok: true, settings };
        case "export":
          return { ok: true, count: accounts.length, payload: { accounts } };
        case "import":
          return { ok: true, added: 0, replaced: 1, warnings: ["已丢弃非 bilibili 域的 Cookie：session@.github.com"] };
        case "remove":
          accounts = accounts.filter((a) => a.id !== message.id);
          return { ok: true, removed: 1 };
        case "rename":
          return { ok: true, updated: {} };
        case "update":
          return { ok: true, updated: {} };
        default:
          return { ok: false, error: `预览模式未实现：${message.type}` };
      }
    },
  },
};

// 首屏先演一遍"有账号 + 已登录"，点几下也能看到真实交互
document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  if (status) status.textContent = "";
});
