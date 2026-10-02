/**
 * 看存储原文的邻域结构（凭据值一律掩码）。
 */
import { readFileSync } from "node:fs";

const raw = readFileSync(process.argv[2], "utf8");
const needle = process.argv[3] || '"mid":"';

const maskValues = (s) =>
  s.replace(/("(?:value|SESSDATA|bili_jct|DedeUserID)"\s*:\s*")([^"]{0,120})(")/g, (_, a, v, c) =>
    `${a}[${v.length} 字符已掩码]${c}`,
  );

let i = -1;
for (let n = 0; n < 3; n += 1) {
  i = raw.indexOf(needle, i + 1);
  if (i < 0) break;
  const start = Math.max(0, i - 220);
  const chunk = raw.slice(start, i + 520);
  console.log(`--- 第 ${n + 1} 处邻域（偏移 ${i}） ---`);
  console.log(maskValues(chunk).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "·"));
  console.log("");
}

// 看看 cookie 名是怎么存的
for (const name of ["SESSDATA", "bili_jct", "DedeUserID", "sid"]) {
  const hits = [...raw.matchAll(new RegExp(`.{0,60}${name}.{0,60}`, "g"))].slice(0, 2);
  console.log(`=== 含 ${name} 的片段 ${hits.length} 段 ===`);
  for (const h of hits) console.log(maskValues(h[0]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "·"));
}
