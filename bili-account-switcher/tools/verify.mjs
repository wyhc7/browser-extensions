/**
 * 交付前自检：manifest 合法性、引用文件完整性、扩展目录卫生、PNG 结构、JS 语法。
 * 全部通过才返回 0。
 *
 *   node tools/verify.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EXT = resolve(ROOT, "extension");

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

/* ------------------------------------------------------------ manifest */

const manifestPath = join(EXT, "manifest.json");
if (!existsSync(manifestPath)) {
  fail("extension/manifest.json 不存在");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (manifest.manifest_version !== 3) fail("manifest_version 必须是 3");
if (!manifest.name || !manifest.version) fail("缺少 name 或 version");
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail(`version 格式不合法：${manifest.version}`);

const ALLOWED_PERMISSIONS = new Set(["cookies", "storage"]);
for (const permission of manifest.permissions ?? []) {
  if (!ALLOWED_PERMISSIONS.has(permission)) fail(`申请了意料之外的权限：${permission}`);
  else notes.push(`权限：${permission}`);
}
if (!(manifest.permissions ?? []).includes("cookies")) fail("没有 cookies 权限就无法读写登录态");

const HOST_RE = /^(\*|https?):\/\/(\*\.)?[^/*]+(\/.*)?$/;
for (const host of manifest.host_permissions ?? []) {
  if (!HOST_RE.test(host)) fail(`host_permissions 不是合法 match pattern：${host}`);
}
if (!(manifest.host_permissions ?? []).some((h) => h.includes("bilibili.com"))) {
  fail("host_permissions 未覆盖 bilibili.com");
}

/* --------------------------------------------------------- 引用完整性 */

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean);

for (const rel of new Set(referenced)) {
  const abs = join(EXT, rel);
  if (!existsSync(abs)) fail(`manifest 引用了不存在的文件：${rel}`);
  else notes.push(`引用正常：${rel}`);
}

const background = manifest.background?.service_worker;
if (background) {
  notes.push(`service worker type：${manifest.background.type ?? "(classic)"}`);
}

/* ---------------------------------------------------------- 目录卫生 */

// 扩展目录会被原样加载，不能混进开发期文件
for (const trash of ["package.json", "node_modules", "test", "tools", "STYLE.md"]) {
  if (existsSync(join(EXT, trash))) fail(`extension/ 里混进了开发期文件：${trash}`);
}

const popupHtml = manifest.action?.default_popup;
if (popupHtml) {
  const html = readFileSync(join(EXT, popupHtml), "utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const rel = match[1];
    if (/^(https?:)?\/\//.test(rel)) {
      fail(`popup 引用了外部资源（会给弹窗加网络依赖）：${rel}`);
      continue;
    }
    const abs = join(EXT, dirname(popupHtml), rel);
    if (!existsSync(abs)) fail(`popup 引用了不存在的文件：${rel}`);
  }
  if (/<script[^>]+src="[^"]+"[^>]*>\s*<\/script>/.test(html) === false) {
    fail("popup 没有引入脚本");
  }
}

/* --------------------------------------------------------------- PNG */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const rel of new Set(Object.values(manifest.icons ?? {}))) {
  const buf = readFileSync(join(EXT, rel));
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(`${rel} 不是 PNG（签名不对）`);
    continue;
  }
  let offset = 8;
  let header = null;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
      };
    }
    if (type === "IDAT") {
      try {
        inflateSync(data);
      } catch (err) {
        fail(`${rel} 的 IDAT 无法解压：${err.message}`);
      }
    }
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const expected = Number(rel.match(/(\d+)\.png$/)?.[1] ?? 0);
  if (!header) fail(`${rel} 缺少 IHDR`);
  else if (header.width !== expected || header.height !== expected) {
    fail(`${rel} 尺寸是 ${header.width}x${header.height}，应为 ${expected}x${expected}`);
  } else if (header.depth !== 8 || header.colorType !== 6) {
    fail(`${rel} 期望 8bit RGBA，实际 depth=${header.depth} colorType=${header.colorType}`);
  } else {
    notes.push(`图标正常：${rel} ${header.width}x${header.height} RGBA8`);
  }
}

/* ----------------------------------------------------------- JS 语法 */

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const abs = join(dir, entry);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

for (const abs of walk(EXT).filter((f) => f.endsWith(".js"))) {
  try {
    execFileSync(process.execPath, ["--check", abs], { stdio: "pipe" });
  } catch (err) {
    fail(`${relative(ROOT, abs)} 语法检查失败：${String(err.stderr || err.message).trim()}`);
  }
}
notes.push(`语法检查通过，共 ${walk(EXT).filter((f) => f.endsWith(".js")).length} 个 JS 文件`);

/* ------------------------------------------------------------- 输出 */

for (const note of notes) console.log(`  · ${note}`);
if (problems.length) {
  console.error("\n自检未通过：");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log("\n自检通过：extension/ 可以直接加载。");
