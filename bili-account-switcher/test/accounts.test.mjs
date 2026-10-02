/**
 * 纯逻辑层单测。跑法：npm test（即 node --test test/）
 *
 * 这里刻意只测不依赖 chrome.* 的部分 —— 也就是"切换账号"真正容易出错的地方：
 * Cookie 属性的往返、管辖范围、导入数据的清洗。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  COOKIE_DOMAIN,
  DEVICE_COOKIE_NAMES,
  IDENTITY_COOKIE_NAMES,
  SETTINGS_DEFAULTS,
  avatarInitial,
  buildExport,
  cookieKey,
  cookieToRemoveDetails,
  cookieToSetDetails,
  cookieUrl,
  createAccount,
  describeNav,
  displayName,
  findAccountByMid,
  isBilibiliDomain,
  normalizeSameSite,
  normalizeSettings,
  packCookie,
  parseImport,
  scopedCookies,
} from "../extension/src/lib/accounts.js";

/** 造一个形状与 chrome.cookies.Cookie 一致的测试对象。 */
function cookie(overrides = {}) {
  return {
    name: "SESSDATA",
    value: "abc%2Cdef",
    domain: ".bilibili.com",
    path: "/",
    secure: true,
    httpOnly: true,
    hostOnly: false,
    session: false,
    sameSite: "no_restriction",
    expirationDate: 1_800_000_000,
    storeId: "0",
    ...overrides,
  };
}

test("isBilibiliDomain：只认 bilibili.com 与其子域", () => {
  assert.equal(isBilibiliDomain(".bilibili.com"), true);
  assert.equal(isBilibiliDomain("bilibili.com"), true);
  assert.equal(isBilibiliDomain("WWW.BILIBILI.COM"), true);
  assert.equal(isBilibiliDomain("passport.bilibili.com"), true);
  assert.equal(isBilibiliDomain("notbilibili.com"), false);
  assert.equal(isBilibiliDomain("bilibili.com.evil.test"), false);
  assert.equal(isBilibiliDomain("bilibili.com.cn"), false);
  assert.equal(isBilibiliDomain(""), false);
  assert.equal(isBilibiliDomain(undefined), false);
});

test("scopedCookies：默认只管身份 Cookie，开启设备隔离后才带上指纹", () => {
  const jar = [
    cookie({ name: "SESSDATA" }),
    cookie({ name: "bili_jct" }),
    cookie({ name: "DedeUserID" }),
    cookie({ name: "DedeUserID__ckMd5" }),
    cookie({ name: "sid", session: true, expirationDate: undefined }),
    cookie({ name: "buvid3", domain: ".bilibili.com" }),
    cookie({ name: "b_nut" }),
    cookie({ name: "CURRENT_FNVAL", value: "4048" }),
    cookie({ name: "SESSDATA", domain: ".example.com" }),
  ];

  const byDefault = scopedCookies(jar, SETTINGS_DEFAULTS).map((c) => c.name);
  assert.deepEqual(byDefault, ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"]);

  const withDevice = scopedCookies(jar, { switchDevice: true }).map((c) => c.name);
  assert.equal(withDevice.includes("buvid3"), true);
  assert.equal(withDevice.includes("b_nut"), true);
  // 播放器偏好与别人家的同名 Cookie 永远不碰
  assert.equal(withDevice.includes("CURRENT_FNVAL"), false);
  assert.equal(byDefault.length, IDENTITY_COOKIE_NAMES.length);
  assert.equal(withDevice.length, IDENTITY_COOKIE_NAMES.length + 2);
});

test("packCookie：保留能决定登录态是否生效的全部属性", () => {
  const packed = packCookie(cookie());
  assert.deepEqual(Object.keys(packed).sort(), [
    "domain",
    "expirationDate",
    "hostOnly",
    "httpOnly",
    "name",
    "path",
    "sameSite",
    "secure",
    "session",
    "value",
  ]);
  assert.equal(packed.domain, ".bilibili.com");
  assert.equal(packed.httpOnly, true);
  assert.equal(packed.expirationDate, 1_800_000_000);

  // 会话 Cookie 不能凭空多出一个过期时间，否则它就不再随浏览器退出而消失
  const session = packCookie(cookie({ session: true, expirationDate: undefined }));
  assert.equal(session.session, true);
  assert.equal("expirationDate" in session, false);

  // 缺少 session 字段时以 expirationDate 为准
  const legacy = packCookie({ ...cookie({ session: undefined }) });
  assert.equal(legacy.session, false);
  assert.equal(packCookie({ ...cookie({ session: undefined, expirationDate: undefined }) }).session, true);
});

test("normalizeSameSite：未知值一律降级为 unspecified，不污染 Cookie 属性", () => {
  assert.equal(normalizeSameSite("lax"), "lax");
  assert.equal(normalizeSameSite("strict"), "strict");
  assert.equal(normalizeSameSite("no_restriction"), "no_restriction");
  assert.equal(normalizeSameSite("unspecified"), "unspecified");
  assert.equal(normalizeSameSite(undefined), "unspecified");
  assert.equal(normalizeSameSite("None"), "unspecified");
});

test("cookieUrl：hostOnly 与域 Cookie 分别生成能命中的 url", () => {
  assert.equal(cookieUrl(cookie()), "https://www.bilibili.com/");
  assert.equal(cookieUrl(cookie({ path: "/passport", domain: ".bilibili.com" })), "https://www.bilibili.com/passport");
  assert.equal(cookieUrl(cookie({ hostOnly: true, domain: "passport.bilibili.com" })), "https://passport.bilibili.com/");
  assert.equal(cookieUrl(cookie({ secure: false, hostOnly: true, domain: "www.bilibili.com" })), "http://www.bilibili.com/");
});

test("cookieToSetDetails：写回去的 Cookie 与原样一致", () => {
  const details = cookieToSetDetails(packCookie(cookie()));
  assert.equal(details.url, "https://www.bilibili.com/");
  assert.equal(details.domain, ".bilibili.com");
  assert.equal(details.name, "SESSDATA");
  assert.equal(details.value, "abc%2Cdef");
  assert.equal(details.secure, true);
  assert.equal(details.httpOnly, true);
  assert.equal(details.sameSite, "no_restriction");
  assert.equal(details.expirationDate, 1_800_000_000);

  // hostOnly 的 Cookie 不能带上 Domain，否则会变成跨子域共享的域 Cookie
  const hostOnly = cookieToSetDetails(packCookie(cookie({ hostOnly: true, domain: "passport.bilibili.com" })));
  assert.equal("domain" in hostOnly, false);
  assert.equal(hostOnly.url, "https://passport.bilibili.com/");

  // __Host- 前缀按规范也不允许带 Domain
  const hostPrefixed = cookieToSetDetails(
    packCookie(cookie({ name: "__Host-foo", hostOnly: false, domain: "bilibili.com" })),
  );
  assert.equal("domain" in hostPrefixed, false);

  // 会话 Cookie：不写 expirationDate
  const session = cookieToSetDetails(packCookie(cookie({ session: true, expirationDate: undefined })));
  assert.equal("expirationDate" in session, false);
});

test("cookieToRemoveDetails：url 必须带 path，否则删不掉同名 Cookie", () => {
  const details = cookieToRemoveDetails(cookie({ path: "/passport" }));
  assert.deepEqual(details, {
    url: "https://www.bilibili.com/passport",
    name: "SESSDATA",
    storeId: "0",
  });
  // 分区 Cookie（CHIPS）要带着 partitionKey 删，否则删不干净
  const partitioned = cookieToRemoveDetails(
    cookie({ partitionKey: { topLevelSite: "https://www.bilibili.com" } }),
  );
  assert.equal(partitioned.partitionKey.topLevelSite, "https://www.bilibili.com");
});

test("cookieKey：同名 Cookie 靠 domain + path 区分", () => {
  assert.equal(cookieKey(cookie()), "SESSDATA|.bilibili.com|/");
  assert.notEqual(cookieKey(cookie()), cookieKey(cookie({ hostOnly: true, domain: "www.bilibili.com" })));
});

test("describeNav：把 nav 响应归一成界面可用的形状", () => {
  assert.deepEqual(describeNav(undefined), { loggedIn: false });
  assert.deepEqual(describeNav({ isLogin: false }), { loggedIn: false });

  const info = describeNav({
    isLogin: true,
    mid: 123456,
    uname: "测试账号",
    face: "https://i0.hdslb.com/bfs/face/a.jpg",
    level_info: { current_level: 5 },
    vipStatus: 1,
    vip_label: { text: "年度大会员" },
  });
  assert.deepEqual(info, {
    loggedIn: true,
    mid: "123456",
    uname: "测试账号",
    face: "https://i0.hdslb.com/bfs/face/a.jpg",
    level: 5,
    vip: true,
    vipLabel: "年度大会员",
  });

  // 缺字段不能炸，也不能显示 undefined
  const sparse = describeNav({ isLogin: true, mid: 7 });
  assert.equal(sparse.uname, "UID 7");
  assert.equal(sparse.level, 0);
  assert.equal(sparse.vip, false);
  assert.equal(describeNav({ isLogin: true, mid: 8, vip: { status: 1 } }).vip, true);
});

test("findAccountByMid：mid 比较按字符串，0 / 空值不算账号", () => {
  const accounts = [{ mid: "123" }, { mid: "456" }];
  assert.equal(findAccountByMid(accounts, 123).mid, "123");
  assert.equal(findAccountByMid(accounts, "123").mid, "123");
  assert.equal(findAccountByMid(accounts, "999"), null);
  assert.equal(findAccountByMid(accounts, 0), null);
  assert.equal(findAccountByMid(accounts, undefined), null);
  assert.equal(findAccountByMid(undefined, 123), null);
});

test("normalizeSettings：只接受布尔值，未知键与脏数据一律忽略", () => {
  assert.deepEqual(normalizeSettings(undefined), SETTINGS_DEFAULTS);
  const merged = normalizeSettings({ autoReload: false, switchDevice: "yes", 注入: true, autoSync: true });
  assert.equal(merged.autoReload, false);
  assert.equal(merged.autoSync, true);
  assert.equal(merged.switchDevice, SETTINGS_DEFAULTS.switchDevice);
  assert.equal("注入" in merged, false);
});

test("显示名与首字：别名优先，CJK 与代理对都取完整首字符", () => {
  const account = createAccount(
    { mid: 1, uname: "夜航星", face: "", level: 3, vip: false },
    [packCookie(cookie())],
  );
  assert.equal(displayName(account), "夜航星");
  assert.equal(avatarInitial(account), "夜");
  account.alias = "小号";
  assert.equal(displayName(account), "小号");
  assert.equal(avatarInitial(account), "小");
  assert.equal(avatarInitial({ uname: "𝕏𝕪" }), "𝕏");
  assert.equal(avatarInitial({ uname: "" }), "B");

  assert.equal(account.mid, "1");
  assert.equal(account.cookies.length, 1);
  assert.equal(typeof account.id, "string");
});

test("parseImport：接受导出信封与裸数组，逐条清洗坏数据", () => {
  const good = {
    mid: 123,
    uname: "甲",
    alias: "大号",
    cookies: [cookie({ name: "SESSDATA" }), cookie({ name: "bili_jct" })],
  };
  const fromEnvelope = parseImport(buildExport([good]));
  assert.equal(fromEnvelope.accounts.length, 1);
  assert.equal(fromEnvelope.accounts[0].alias, "大号");
  assert.equal(fromEnvelope.accounts[0].mid, "123");
  assert.deepEqual(fromEnvelope.warnings, []);

  const fromArray = parseImport([good]);
  assert.equal(fromArray.accounts.length, 1);

  const fromMap = parseImport({ accounts: { a: good } });
  assert.equal(fromMap.accounts.length, 1);

  // 非 bilibili 域的 Cookie 必须被丢掉，否则等于允许往任意站点写凭据
  const hostile = parseImport([
    {
      mid: 999,
      cookies: [
        { name: "SESSDATA", value: "x", domain: ".bilibili.com", path: "/" },
        { name: "session", value: "y", domain: ".github.com", path: "/" },
      ],
    },
  ]);
  assert.equal(hostile.accounts[0].cookies.length, 1);
  assert.match(hostile.warnings.join("\n"), /非 bilibili 域/);

  const junk = parseImport([
    { mid: "abc", cookies: [cookie()] },
    { mid: 0, cookies: [cookie()] },
    { mid: 55, cookies: [] },
    { mid: 66, cookies: [{ name: "", domain: ".bilibili.com" }] },
    "字符串",
    null,
  ]);
  assert.equal(junk.accounts.length, 0);
  assert.equal(junk.warnings.length >= 4, true);

  // 同一 mid 去重
  const dupes = parseImport([{ mid: 5, cookies: [cookie()] }, { mid: "5", cookies: [cookie()] }]);
  assert.equal(dupes.accounts.length, 1);
  assert.match(dupes.warnings.join("\n"), /重复/);
});

test("parseImport：完全没有 accounts 字段时给出可解释的警告", () => {
  const res = parseImport({ hello: "world" });
  assert.deepEqual(res.accounts, []);
  assert.match(res.warnings[0], /accounts/);
});

test("buildExport：带上版本与导出时间，便于日后迁移", () => {
  const payload = buildExport([{ mid: "1", cookies: [] }], Date.parse("2026-01-02T03:04:05Z"));
  assert.equal(payload.app, "bili-account-switcher");
  assert.equal(payload.version, 1);
  assert.equal(payload.exportedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(COOKIE_DOMAIN, "bilibili.com");
  assert.equal(DEVICE_COOKIE_NAMES.includes("buvid3"), true);
});
