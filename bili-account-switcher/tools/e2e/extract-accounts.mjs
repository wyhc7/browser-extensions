/**
 * 从扩展存储（LevelDB log）里把账号对象抠出来，脱敏成结构摘要。
 *
 * 只打印：mid、掩码昵称、每条 Cookie 的名字/值长度/过期时间/属性。
 * 绝不打印 Cookie 值本身。
 */
import { readFileSync } from "node:fs";

const raw = readFileSync(process.argv[2], "utf8");

/** 从 raw[i] 的 '{' 开始，按字符串规则找配对的 '}'，返回切片或 null。 */
function balancedSlice(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const accounts = new Map();
const seen = new Set();
for (let i = 0; i < raw.length; i += 1) {
  if (raw[i] !== "{") continue;
  const slice = balancedSlice(raw, i);
  if (!slice || slice.length > 200_000) continue;
  if (!slice.includes('"mid"') || !slice.includes('"cookies"')) continue;
  let obj;
  try {
    obj = JSON.parse(slice);
  } catch {
    continue;
  }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.cookies)) continue;
  const key = `${obj.mid}|${obj.cookies.length}|${obj.cookies.map((c) => c.value?.length).join(",")}|${obj.updatedAt}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (!accounts.has(obj.mid)) accounts.set(obj.mid, []);
  accounts.get(obj.mid).push(obj);
}

const mask = (s) => (!s ? "(空)" : `${Array.from(s)[0]}${"*".repeat(Math.max(1, Array.from(s).length - 1))}（${Array.from(s).length} 字）`);
const when = (t) => (typeof t !== "number" ? "(无)" : new Date(t * 1000).toISOString().slice(0, 16).replace("T", " "));
const ago = (t) => (typeof t !== "number" ? "" : t * 1000 < Date.now() ? `  ← 已过期 ${Math.round((Date.now() - t * 1000) / 86400000)} 天` : `  ← 还有 ${Math.round((t * 1000 - Date.now()) / 86400000)} 天`);

console.log(`不同账号（按 mid）：${accounts.size}`);
for (const [mid, list] of accounts) {
  console.log(`\n=== mid ${mid}（该 mid 的快照版本 ${list.length} 个）===`);
  const latest = list.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a));
  console.log(`昵称：${mask(latest.uname)}   等级：${latest.level}  VIP：${!!latest.vip}   face 长度：${String(latest.face ?? "").length}`);
  console.log(`保存于：${new Date(latest.createdAt ?? 0).toISOString().slice(0, 16).replace("T", " ")}   最后更新：${new Date(latest.updatedAt ?? 0).toISOString().slice(0, 16).replace("T", " ")}`);
  console.log(`Cookie ${latest.cookies.length} 条：`);
  for (const c of latest.cookies) {
    console.log(
      `  ${String(c.name).padEnd(20)} 值长 ${String(c.value ?? "").length}  ${c.session ? "会话 Cookie" : `过期 ${when(c.expirationDate)}${ago(c.expirationDate)}`}  secure=${!!c.secure} httpOnly=${!!c.httpOnly} sameSite=${c.sameSite} domain=${c.domain} hostOnly=${!!c.hostOnly}`,
    );
  }
  // 同 mid 的多个版本里，SESSDATA 是否变过
  const sessDataLens = new Set(list.map((a) => a.cookies.find((c) => c.name === "SESSDATA")?.value?.length));
  console.log(`该账号历史快照里 SESSDATA 的值长度集合：${[...sessDataLens].join(", ")}`);
}

// 两个账号的 SESSDATA 值是否其实是同一个
const sess = new Map();
for (const [mid, list] of accounts) {
  const latest = list.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a));
  const v = latest.cookies.find((c) => c.name === "SESSDATA")?.value ?? "";
  sess.set(mid, `${v.slice(0, 4)}…${v.slice(-4)}`);
}
console.log(`\n各账号 SESSDATA 首尾指纹（判断是否重复保存了同一个身份）：`);
for (const [mid, fp] of sess) console.log(`  ${mid} → ${fp}`);
