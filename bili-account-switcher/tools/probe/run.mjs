#!/usr/bin/env node
/**
 * 真引擎探针：在真实 Chromium 里验证 Cookie 层的细节。
 *
 * 为什么要它：mock 单测能证明"逻辑对不对"，但证明不了"浏览器收不收"。
 * 这个脚本把 tools/probe/sw.js 和真实的 extension/src/lib/accounts.js 暂存到
 * .tmp/probe-stage/，用 --load-extension 起一个 headless 浏览器，让探针把结果
 * POST 回本地收集器，然后打印结论。
 *
 *   node tools/probe/run.mjs
 *
 * 退出码：0 = 全部通过；1 = 有组合被拒/丢失/属性走样；0 且打印"跳过"= 本机没有 Edge/Chrome。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const stage = join(root, ".tmp", "probe-stage");
const profile = join(root, ".tmp", "probe-profile");
const outFile = join(root, ".tmp", "probe-report.json");
const PORT = 8124;
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 90000);

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function findBrowser() {
  return BROWSERS.find((p) => existsSync(p)) || null;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已经退了 */
    }
  }
}

async function stageExtension() {
  await rm(stage, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
  await rm(outFile, { force: true });
  await mkdir(join(stage, "lib"), { recursive: true });
  await cp(join(here, "manifest.json"), join(stage, "manifest.json"));
  await cp(join(here, "sw.js"), join(stage, "sw.js"));
  // 关键：拷的是正在用的那一份库，不是副本，避免探针和产品代码漂移
  await cp(join(root, "extension", "src", "lib", "accounts.js"), join(stage, "lib", "accounts.js"));
}

async function collect(browser) {
  let resolveReport;
  const reported = new Promise((r) => {
    resolveReport = r;
  });

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("ok");
      resolveReport(body);
    });
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  const child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--load-extension=${stage}`,
      `--disable-extensions-except=${stage}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const timer = setTimeout(() => resolveReport(null), TIMEOUT_MS);
  const body = await reported;
  clearTimeout(timer);
  server.close();
  killTree(child.pid);
  return body;
}

function summarize(report) {
  const lines = [];
  let bad = 0;

  lines.push(`引擎：${report.engine}`);
  for (const s of report.steps) {
    lines.push(s.ok ? `  · ${s.label}：${JSON.stringify(s.result)}` : `  ✖ ${s.label}：${s.error}`);
    if (!s.ok) bad += 1;
  }

  const rt = report.fullRoundTrip;
  if (rt?.ok) {
    const r = rt.result;
    const clean = r.写回报错.length === 0 && r.丢失.length === 0 && r.属性走样.length === 0 && r.删除后剩余 === 0;
    lines.push(
      `站点真实 Cookie 往返：原始 ${r.原始} 条 → 删除后剩余 ${r.删除后剩余} → 写回报错 ${r.写回报错.length} → 丢失 ${r.丢失.length} → 属性走样 ${r.属性走样.length}`,
    );
    if (!clean) {
      bad += 1;
      lines.push(`  ✖ ${JSON.stringify(r, null, 2)}`);
    }
  } else {
    bad += 1;
    lines.push(`✖ 全量往返没跑完：${rt?.error ?? "没有结果"}`);
  }

  let accepted = 0;
  let removable = 0;
  for (const m of report.matrix) {
    const okWrite = m.结果 === "接受" && (m.属性差异?.length ?? 1) === 0;
    const okRemove = m.删除 === "命中" && m.删除后仍在 === false;
    if (okWrite) accepted += 1;
    if (okRemove) removable += 1;
    if (!okWrite || !okRemove) {
      bad += 1;
      lines.push(`  ✖ ${m.组合} → 写：${m.结果}，删除：${m.删除}，删除后仍在：${m.删除后仍在}，差异：${JSON.stringify(m.属性差异)}`);
    }
  }
  lines.push(`写入矩阵：${accepted}/${report.matrix.length} 接受且无属性走样，${removable}/${report.matrix.length} 能用自己的 details 删干净`);

  const del = report.deleteByPastExpiry;
  if (del?.ok) {
    lines.push(`按过期时间删除：${del.result.结果}，删除后仍在：${del.result.删除后仍在}`);
    if (del.result.删除后仍在) bad += 1;
  } else {
    bad += 1;
    lines.push(`✖ 按过期时间删除没跑完：${del?.error ?? "没有结果"}`);
  }

  for (const n of report.notes) lines.push(`  · ${n}`);
  if (report.crashed) {
    bad += 1;
    lines.push(`✖ 探针自己崩了：${report.crashed}`);
  }
  return { lines, bad };
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log("没找到 Edge/Chrome，跳过真引擎探针（Cookie 层仍有 mock 单测覆盖）。");
    return 0;
  }
  await stageExtension();

  const body = await collect(browser);
  if (!body) {
    console.log(`✖ ${TIMEOUT_MS}ms 内没收到探针报告，可能这个浏览器不支持 --load-extension 或跑不起扩展。`);
    return 1;
  }

  await writeFile(outFile, body, "utf8");
  const report = JSON.parse(body);
  const { lines, bad } = summarize(report);
  for (const line of lines) console.log(line);
  console.log(bad === 0 ? `真引擎探针通过。完整报告：${outFile}` : `真引擎探针有 ${bad} 处异常。完整报告：${outFile}`);
  return bad === 0 ? 0 : 1;
}

process.exitCode = await main();
