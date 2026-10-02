/**
 * 用真实浏览器驱动真实 popup，跑一遍"切换账号"。
 *
 * - 浏览器：本机 Edge 二进制 + 你真实 profile 的**副本**（.tmp/edge-profile），
 *   扩展底座与你装的那份相同，你保存的账号快照会原样带过来；
 * - 扩展：直接用工作目录里的 extension/（被测的就是产品代码本身）；
 * - 操作：用 CDP 打开 popup 页面，点真实的按钮，读真实的状态行。
 *
 * 打印的都是界面文字，不含任何 Cookie 值。
 */
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserVersion, connect, createTarget, waitForTarget } from "./cdp.mjs";
import { extensionIdForPath, extensionIdFromUrl } from "../lib/extension-id.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const PORT = Number(process.env.CDP_PORT || 9333);
const EXT_DIR = join(root, "extension");
/** 当前源码放在哪个目录，就决定了这次加载出来的扩展 ID（解压扩展按路径派生 ID） */
const EXPECTED_ID = extensionIdForPath(EXT_DIR);
const PROFILE = join(root, ".tmp", "edge-profile");
const HEADLESS = process.env.HEADLESS !== "0";

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 准备 profile 副本：第一次跑时从你真实的 Edge profile 里拷一份必要的文件。
 *
 * 只拷登陆/扩展相关的那几样，不碰原 profile。正在被 Edge 占用的 Cookies 拷不到
 * 就跳过（本测试不需要它：没有实时登录态反而更能看清"把快照写进去后服务端认不认"）。
 */
function ensureProfile() {
  const srcRoot = join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data");
  if (!existsSync(srcRoot)) throw new Error(`找不到 Edge profile：${srcRoot}`);
  if (existsSync(join(PROFILE, "Local State"))) return;

  const files = [
    ["Local State", "Local State"],
    ["Default\\Preferences", "Default\\Preferences"],
    ["Default\\Secure Preferences", "Default\\Secure Preferences"],
    ["Default\\Network\\Cookies", "Default\\Network\\Cookies"],
  ];
  for (const [from, to] of files) {
    const src = join(srcRoot, from);
    const dst = join(PROFILE, to);
    if (!existsSync(src)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      console.log(`  profile → ${to}`);
    } catch (err) {
      console.log(`  [warn] 跳过 ${to}：${err.message}`);
    }
  }
  for (const sub of ["Local Extension Settings", "Local Storage", "Session Storage"]) {
    const src = join(srcRoot, "Default", sub);
    if (!existsSync(src)) continue;
    cpSync(src, join(PROFILE, "Default", sub), { recursive: true });
    console.log(`  profile → Default\\${sub}`);
  }
  console.log("profile 副本已就绪（只读原 profile，不修改它）。");
}

/**
 * 每轮开始前把 profile 副本收拾干净。
 *
 * 1) 从你真实的 profile 里重取扩展存储（上一轮被强杀的 Edge 会留下 LevelDB LOCK，
 *    导致 chrome.storage 不可用，现象是 popup 一直停在"读取中…"）；
 * 2) 删掉 Code Cache / Service Worker / GPUCache —— Chromium 会缓存扩展 service
 *    worker 的脚本字节，不删的话改了源码浏览器还在跑旧代码。
 */
function prepareProfile() {
  const src = findRealStorageDir();
  const dstDir = join(PROFILE, "Default", "Local Extension Settings", EXPECTED_ID);
  if (!src) {
    console.log("[warn] 在你真实的 profile 里没找到本扩展的存储（跳过重取，测试会以空账号列表开始）");
  } else {
    rmSync(dstDir, { recursive: true, force: true });
    mkdirSync(dstDir, { recursive: true });
    for (const name of readdirSync(src)) {
      const from = join(src, name);
      if (statSync(from).isFile()) copyFileSync(from, join(dstDir, name));
    }
    console.log(`已从原 profile 重取扩展存储（你保存的账号快照）：${src.replace(/^.*Local Extension Settings./, "")}`);
  }
  for (const dir of ["Code Cache", "Service Worker", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"]) {
    rmSync(join(PROFILE, "Default", dir), { recursive: true, force: true });
  }
  console.log("已清掉 profile 副本里的代码缓存（保证跑的是当前源码）。");
}

/**
 * 在你真实的 profile 里找出本扩展的存储目录。
 *
 * 扩展 ID 随目录路径变（见 tools/lib/extension-id.mjs），所以不能写死常量：
 * 先按"当前源码路径算出来的 ID"找，找不到就按内容找 —— 存储里存着账号快照，
 * 一定含有 `SESSDATA` 这个字符串。这样无论这份源码被放在哪个目录都能用。
 */
function findRealStorageDir() {
  const base = join(
    process.env.LOCALAPPDATA || "",
    "Microsoft",
    "Edge",
    "User Data",
    "Default",
    "Local Extension Settings",
  );
  const direct = join(base, process.env.EXT_ID || EXPECTED_ID);
  if (existsSync(direct)) return direct;
  if (!existsSync(base)) return null;
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const hit = readdirSync(dir).some((file) => {
        const p = join(dir, file);
        return statSync(p).isFile() && readFileSync(p, "latin1").includes("SESSDATA");
      });
      if (hit) return dir;
    } catch {
      /* 读不动就跳过（别的扩展的目录可能正被占用） */
    }
  }
  return null;
}

async function waitFor(fn, label, timeout = 25_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await wait(300);
  }
  throw new Error(`等不到「${label}」（最后看到：${JSON.stringify(last)}）`);
}

async function main() {
  if (!EDGE) throw new Error("没找到 Edge");
  ensureProfile();
  if (!existsSync(PROFILE)) throw new Error(`没有 profile 副本：${PROFILE}`);
  prepareProfile();

  const args = [
    ...(HEADLESS ? ["--headless=new"] : []),
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
  ];
  console.log(`启动：Edge ${HEADLESS ? "(headless)" : "(可见窗口)"}  profile=${PROFILE}`);
  const child = spawn(EDGE, [...args, "about:blank"], { stdio: "ignore" });

  let cdp;
  try {
    await browserVersion(PORT, 30_000);
    const sw = await waitForTarget(PORT, "src/background.js", 40_000);
    const actualId = extensionIdFromUrl(sw.url);
    console.log(`扩展 service worker 已加载：${sw.url}`);
    // 算法对不对，用浏览器自己分配的 ID 来判：这是"解压扩展 ID 由路径派生"的实证
    if (actualId !== EXPECTED_ID) {
      throw new Error(`算出来的扩展 ID 与浏览器分配的不一致：算出 ${EXPECTED_ID}，实际 ${actualId}`);
    }
    console.log(`扩展 ID 与按路径算出的结果一致：${actualId}`);

    // 把 service worker 的报错也接出来 —— 界面卡住时得知道是它出了什么事
    const swCdp = await connect(sw.webSocketDebuggerUrl);
    swCdp.onEvent((msg) => {
      if (msg.method === "Runtime.exceptionThrown") {
        console.log(`[SW 异常] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
      }
      if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
        console.log(`[SW ${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
      }
    });
    await swCdp.send("Runtime.enable");

    await createTarget(PORT, `chrome-extension://${actualId}/src/popup.html`);
    const page = await waitForTarget(PORT, "src/popup.html", 20_000);
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");

    const text = (sel) => cdp.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);

    // 先看启动时 popup 自己有没有报错，再直接问一次后台 —— 两者不一致就说明是启动竞态
    await wait(1800);
    console.log(`\npopup 启动状态行：${await text("#status")}`);
    const direct = await cdp.evaluate(
      `chrome.runtime.sendMessage({type:'state'}).then((r)=>'ok 账号数='+(r?.accounts?.length)+' 有设置='+(!!r?.settings)).catch((e)=>'ERR: '+(e?.message||e))`,
    );
    console.log(`直接问后台 state：${direct}`);

    await waitFor(async () => (await text("#count")) !== "读取中…", "popup 读到状态");
    console.log(`\n扩展版本：${await text("#version")}`);
    console.log(`页头状态：${await text("#count")}`);
    console.log(`站内身份：${await text("#live-name")}  |  ${await text("#live-meta")}`);

    const accounts = await cdp.evaluate(
      `[...document.querySelectorAll('.account')].map((a,i)=>({i, name:a.querySelector('.account__name')?.textContent, id:a.querySelector('[data-action="switch"]')?.dataset.id}))`,
    );
    console.log(`\n已保存账号 ${accounts.length} 个：`);
    for (const a of accounts) console.log(`  #${a.i + 1} ${a.name}`);

    const showReport = async (title) => {
      const report = await waitFor(async () => {
        const t = await text("#report");
        return t && t.includes("站内身份") ? t : null;
      }, "诊断报告");
      console.log(`\n===== ${title} =====\n${report}\n`);
      return report;
    };

    await cdp.evaluate(`document.getElementById('diagnose').click()`);
    await showReport("诊断报告（切换前）");

    for (const acc of accounts) {
      console.log(`\n>>> 点击第 ${acc.i + 1} 个账号「${acc.name}」的切换`);
      await cdp.evaluate(
        `[...document.querySelectorAll('.account')][${acc.i}].querySelector('[data-action="switch"]').click()`,
      );
      const status = await waitFor(async () => {
        const t = await text("#status");
        return t && /已切换|切换失败|项失败|未登录|回滚/.test(t) ? t : null;
      }, "切换结果", 45_000);
      console.log(`状态行：${status}`);
      console.log(`站内身份：${await text("#live-name")}  |  ${await text("#count")}`);

      // 账号行上的状态标：失败过的应该被标成「凭据已被拒绝」
      const rows = await cdp.evaluate(
        `[...document.querySelectorAll('.account')].map((a)=>({name:a.querySelector('.account__name')?.textContent, rejected:a.classList.contains('account--rejected'), warn:a.querySelector('.account__warn')?.textContent ?? null}))`,
      );
      console.log(`账号行标注：${JSON.stringify(rows, null, 2)}`);

      await cdp.evaluate(`document.getElementById('diagnose').click()`);
      await wait(600);
      const report = await text("#report");
      const line = String(report || "")
        .split("\n")
        .filter((l) => /code|isLogin|站内身份|浏览器里|上次切换失败/.test(l))
        .slice(0, 14)
        .join("\n");
      console.log(`报告要点：\n${line}`);
    }
  } finally {
    cdp?.close();
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

await main();
