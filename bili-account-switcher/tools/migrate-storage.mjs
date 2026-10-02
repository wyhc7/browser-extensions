/**
 * 扩展目录搬家之后，把 `chrome.storage.local` 里的账号快照搬到新扩展 ID 名下。
 *
 * 背景：解压加载的扩展，ID 是由**扩展目录的绝对路径**算出来的（见 tools/lib/extension-id.mjs），
 * 而 `chrome.storage.local` 按扩展 ID 分目录存放。所以只要把 extension/ 换个目录，
 * 浏览器就认为这是"另一个扩展"，你保存的账号快照不会跟着走 —— 看起来就像账号丢了。
 *
 * 这个工具按内容找到旧 ID 的存储目录，复制到新 ID 的存储目录下，**不删除**任何东西：
 * 旧目录原样保留，随时可以退回去。
 *
 * 用法（必须先完全退出浏览器，否则 LevelDB 被占用，写进去的数据会被覆盖）：
 *
 *   node tools/migrate-storage.mjs                 # 预览：只报告会做什么
 *   node tools/migrate-storage.mjs --apply         # 真正执行
 *   node tools/migrate-storage.mjs --apply --to <扩展ID>   # 手工指定目标 ID
 *
 * 环境变量：BROWSER=chrome|edge（默认 edge）、USER_DATA（默认按平台推断）、TARGET_ID。
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { extensionIdForPath } from "./lib/extension-id.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(here, "..", "extension");
const newId = process.env.TARGET_ID || extensionIdForPath(extDir);
const apply = process.argv.includes("--apply");

function defaultUserData() {
  if (process.env.USER_DATA) return process.env.USER_DATA;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    return process.env.BROWSER === "chrome"
      ? join(local, "Google", "Chrome", "User Data")
      : join(local, "Microsoft", "Edge", "User Data");
  }
  if (process.platform === "darwin") {
    const home = process.env.HOME || "";
    return join(
      home,
      "Library",
      "Application Support",
      process.env.BROWSER === "chrome" ? "Google/Chrome" : "Microsoft Edge",
    );
  }
  const home = process.env.HOME || "";
  return join(home, ".config", process.env.BROWSER === "chrome" ? "google-chrome" : "microsoft-edge");
}

/** 存储目录里的内容是否属于本扩展：账号快照一定含有 SESSDATA 这个字符串。 */
function looksLikeOurStorage(dir) {
  try {
    return readdirSync(dir).some((file) => {
      const p = join(dir, file);
      return statSync(p).isFile() && readFileSync(p, "latin1").includes("SESSDATA");
    });
  } catch {
    return false;
  }
}

function findStores(base) {
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((name) => ({
      id: name,
      dir: join(base, name),
      isDir: (() => {
        try {
          return statSync(join(base, name)).isDirectory();
        } catch {
          return false;
        }
      })(),
    }))
    .filter((e) => e.isDir && looksLikeOurStorage(e.dir));
}

const userData = defaultUserData();
const base = join(userData, "Default", "Local Extension Settings");
const target = join(base, newId);

console.log(`浏览器 profile：${userData}`);
console.log(`这份源码的扩展目录：${extDir}`);
console.log(`搬过去之后的扩展 ID：${newId}`);
console.log(`目标存储目录：${target}`);
console.log("");

if (!existsSync(userData)) {
  console.error(`找不到 profile 目录：${userData}（用 USER_DATA 环境变量指定）。`);
  process.exit(1);
}

const stores = findStores(base);
const source = stores.find((e) => e.id !== newId);

if (existsSync(join(target, "CURRENT")) && source && !apply) {
  console.log("目标目录里已经有数据了。若确认要用旧目录覆盖，再跑一次带 --apply（旧的会先备份成 .bak）。");
}

if (!source) {
  console.log(
    stores.length
      ? "只找到一个存储目录，且它就是目标 ID —— 已经没有要搬的东西了。"
      : "没有找到本扩展的存储目录：可能这份源码还没被加载过，或者账号一个都没保存。",
  );
  process.exit(0);
}

console.log(`源（旧）扩展 ID：${source.id}`);
console.log(`源目录：${source.dir}`);
console.log(`里面有 ${readdirSync(source.dir).length} 个文件。`);

if (!apply) {
  console.log("\n这是预览。确认浏览器已完全退出后，加 --apply 执行。");
  process.exit(0);
}

// 浏览器没退出就动 LevelDB，数据会被运行中的进程覆盖回去 —— 宁可不做
const lock = join(userData, "Default", "Network", "Cookies");
try {
  const handle = await import("node:fs").then((fs) => fs.openSync(lock, "r+"));
  (await import("node:fs")).closeSync(handle);
} catch (err) {
  if (String(err.message).includes("EBUSY") || String(err.message).includes("EPERM")) {
    console.error("浏览器还开着（profile 被占用）。完全退出浏览器后再跑一次。");
    process.exit(1);
  }
}

if (existsSync(target)) {
  const backup = `${target}.bak-${Date.now()}`;
  rmSync(backup, { recursive: true, force: true });
  mkdirSync(backup, { recursive: true });
  for (const name of readdirSync(target)) {
    const p = join(target, name);
    if (statSync(p).isFile()) copyFileSync(p, join(backup, name));
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`目标目录原有内容已备份到：${backup}`);
}
mkdirSync(target, { recursive: true });
for (const name of readdirSync(source.dir)) {
  const p = join(source.dir, name);
  if (statSync(p).isFile()) copyFileSync(p, join(target, name));
}
console.log(`\n已把 ${readdirSync(target).length} 个文件复制到新 ID 的存储目录。`);
console.log("旧目录没有动。打开浏览器、重开扩展弹窗，账号列表应该就回来了。");
