/**
 * 脱敏解析用户真实扩展存储（LevelDB log）里的账号快照。
 *
 * 只打印：账号数、mid、掩码后的昵称、Cookie 名与值长度。
 * 绝不打印任何 Cookie 值 —— 那些是真实凭据。
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const raw = readFileSync(file, "utf8");

const mask = (s) => (s ? `${Array.from(s)[0]}${"*".repeat(Math.max(1, Array.from(s).length - 1))}（${Array.from(s).length} 字）` : "(空)");

const mids = [...raw.matchAll(/"mid":"(\d+)"/g)].map((m) => m[1]);
const unames = [...raw.matchAll(/"uname":"([^"]{0,60})"/g)].map((m) => m[1]);
const aliases = [...raw.matchAll(/"alias":"([^"]{0,60})"/g)].map((m) => m[1]);
const cookieRe = /"name":"(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|sid|buvid3|buvid4|buvid_fp|b_nut|b_lsid|_uuid)","value":"([^"]*)"/g;
const cookies = [...raw.matchAll(cookieRe)].map((m) => ({ name: m[1], len: m[2].length, hasSpecial: /[%*,]/.test(m[2]) }));

console.log(`账号数（按 mid 计）：${mids.length}`);
mids.forEach((mid, i) => {
  const alias = aliases[i];
  console.log(`  #${i + 1}  mid=${mid}  昵称=${mask(unames[i])}${alias !== undefined ? `  别名=${mask(alias)}` : ""}`);
});
console.log(`Cookie 记录：${cookies.length} 条`);
const byName = new Map();
for (const c of cookies) {
  const e = byName.get(c.name) || { n: 0, lens: [], special: 0 };
  e.n += 1;
  e.lens.push(c.len);
  if (c.hasSpecial) e.special += 1;
  byName.set(c.name, e);
}
for (const [name, e] of byName) {
  console.log(`  ${name.padEnd(20)} ${e.n} 条，值长度 ${e.lens.join("/")}${e.special ? `，其中 ${e.special} 条含 % * , 等特殊字符` : ""}`);
}
const settings = [...raw.matchAll(/"switchDevice":(true|false),"autoSync":(true|false),"autoReload":(true|false),"showBadge":(true|false)/g)];
console.log(`设置：${settings.length ? JSON.stringify({ switchDevice: settings[0][1] === "true", autoSync: settings[0][2] === "true", autoReload: settings[0][3] === "true", showBadge: settings[0][4] === "true" }) : "（没读到）"}`);
console.log(`存储里出现的其他关键词：${["exportedAt", "createdAt", "storage"].filter((k) => raw.includes(k)).join("、") || "无"}`);
