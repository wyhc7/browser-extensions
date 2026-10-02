/**
 * popup：只负责渲染与派发消息，所有 cookie 读写都在 service worker 里。
 * 账号昵称、别名一律走 textContent，不拼 HTML —— 昵称是外部输入。
 */
import { avatarInitial, displayName } from "./lib/accounts.js";

const els = {
  count: document.getElementById("count"),
  liveFace: document.getElementById("live-face"),
  liveName: document.getElementById("live-name"),
  liveMeta: document.getElementById("live-meta"),
  save: document.getElementById("save"),
  update: document.getElementById("update"),
  park: document.getElementById("park"),
  status: document.getElementById("status"),
  accounts: document.getElementById("accounts"),
  listCount: document.getElementById("list-count"),
  empty: document.getElementById("empty"),
  export: document.getElementById("export"),
  import: document.getElementById("import"),
  importFile: document.getElementById("import-file"),
  settingsToggle: document.getElementById("settings-toggle"),
  settings: document.getElementById("settings"),
  diagnose: document.getElementById("diagnose"),
  reportwrap: document.getElementById("reportwrap"),
  report: document.getElementById("report"),
  copyReport: document.getElementById("copy-report"),
  version: document.getElementById("version"),
};

const state = {
  accounts: [],
  live: null,
  navError: null,
  failure: null,
  settings: {},
  busy: false,
  editingId: null,
  pendingDeleteId: null,
};

let deleteTimer = 0;

/* ---------------------------------------------------------------- 工具 */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/** 头像：加载失败就退化成首字方块，不出现破图。 */
function fillFace(target, account, extraClass = "") {
  const initial = avatarInitial(account);
  const url = typeof account?.face === "string" ? account.face.trim() : "";
  target.className = `face ${extraClass}`.trim();
  target.replaceChildren();
  if (!url) {
    target.classList.add("face--initial");
    target.textContent = initial;
    return target;
  }
  target.append(
    el("img", {
      src: url.replace(/^http:/, "https:"),
      alt: "",
      width: extraClass ? 36 : 44,
      height: extraClass ? 36 : 44,
      referrerpolicy: "no-referrer",
      onerror: () => {
        target.classList.add("face--initial");
        target.textContent = initial;
      },
    }),
  );
  return target;
}

function faceNode(account, extraClass = "") {
  return fillFace(el("span"), account, extraClass);
}

function setStatus(message, kind = "info", stamp = false) {
  els.status.className = "status mono";
  els.status.textContent = message || "";
  if (!message) return;
  if (kind !== "info") els.status.classList.add(`status--${kind}`);
  if (stamp) els.status.classList.add("status--stamp");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 只读消息带退避重试。
 *
 * 实测过：service worker 冷启动时，popup 的第一条消息会被丢掉，界面就永远停在
 * "读取中…"。写操作（切换/保存）绝不重试 —— 重试等于重复执行，风险更大。
 */
async function sendWithRetry(message, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      lastError = err;
      await sleep(180 * (i + 1));
    }
  }
  throw lastError;
}

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra }).then((res) => {
    if (!res) throw new Error("后台没有响应，重新打开弹窗再试一次。");
    if (!res.ok) throw new Error(res.error || "操作失败");
    return res;
  });
}

function sendRead(type, extra = {}) {
  return sendWithRetry({ type, ...extra }).then((res) => {
    if (!res) throw new Error("后台没有响应，重新打开弹窗再试一次。");
    if (!res.ok) throw new Error(res.error || "操作失败");
    return res;
  });
}

/** 统一处理"进行中"态：锁住所有按钮 + 状态行给出加载反馈。 */
async function run(label, task) {
  if (state.busy) return;
  state.busy = true;
  const buttons = [...document.querySelectorAll("button")];
  for (const b of buttons) b.disabled = true;
  setStatus(label);
  try {
    await task();
  } catch (err) {
    setStatus(err?.message || String(err), "error");
  } finally {
    state.busy = false;
    for (const b of buttons) b.disabled = false;
    render();
  }
}

/* ---------------------------------------------------------------- 渲染 */

function renderLive() {
  const live = state.live;
  const active = state.accounts.find((a) => a.active) || null;

  els.liveFace.hidden = false;
  if (live?.loggedIn) {
    fillFace(els.liveFace, active || { uname: live.uname, face: live.face });
  } else {
    els.liveFace.className = "face face--initial";
    els.liveFace.replaceChildren();
    els.liveFace.textContent = "?";
  }

  if (!live?.loggedIn) {
    els.liveName.textContent = "未登录";
    els.liveMeta.textContent = state.navError
      ? `接口不可达：${state.navError}`
      : state.accounts.length
        ? "本地登录态已清空，可以在 B 站登录下一个账号"
        : "在 bilibili.com 登录后即可保存";
  } else {
    els.liveName.textContent = live.uname;
    const bits = [`UID ${live.mid}`, `LV${live.level}`];
    if (live.vip) bits.push(live.vipLabel || "大会员");
    bits.push(active ? "已保存" : "尚未保存");
    els.liveMeta.textContent = bits.join(" / ");
  }

  els.save.disabled = !live?.loggedIn;
  els.update.disabled = !live?.loggedIn || !active;
}

function actionButton(account, action, label, extra = {}) {
  const isActive = account.active;
  const props = {
    class: `btn btn--mini${extra.danger ? " btn--danger" : ""}`,
    type: "button",
    text: label,
    dataset: { action, id: account.id },
  };
  if (action === "update" && !isActive) {
    props.disabled = true;
    props.title = "只有当前登录的账号能更新快照，先切换过去";
  }
  if (action === "remove" && state.pendingDeleteId === account.id) {
    props.class = "btn btn--mini btn--danger";
    props.text = "确认删除";
  }
  return el("button", props);
}

/** 快照新鲜度：切走前会自动刷新，看不出新旧就没法判断要不要手动更新。 */
function relativeTime(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  return `${Math.round(hours / 24)} 天前更新`;
}

function renderAccount(account, index) {
  const item = el("li", {
    class: `account${account.active ? " account--active" : ""}${account.rejected ? " account--rejected" : ""}`,
    dataset: { id: account.id },
  });

  // 行内只留决策需要的信息，凭据条数这类技术细节放进 ⋯ 细节区
  const metaBits = [`UID ${account.mid}`, relativeTime(account.updatedAt)];

  // 整行就是主操作（切换）；次要操作收进 ⋯ 里，避免行内挤到换行
  const main = el(
    "button",
    {
      class: "account__main",
      type: "button",
      dataset: { action: "switch", id: account.id },
      title: account.active ? "当前已经是这个账号" : `切换到 ${displayName(account)}`,
      ...(account.active ? { disabled: true } : {}),
    },
    [
      el("span", { class: "account__order mono", text: String(index + 1).padStart(2, "0") }),
      faceNode(account, "account__face"),
      el("span", { class: "account__text" }, [
        el("span", { class: "account__name" }, [
          el("span", { text: displayName(account) }),
          // 起了备注名之后，真实昵称退成标签，否则就看不出这是谁
          account.alias && account.alias !== account.uname
            ? el("span", { class: "tag", text: account.uname })
            : null,
          account.vip ? el("span", { class: "tag", text: "大会员" }) : null,
        ]),
        el("span", { class: "account__meta mono", text: metaBits.filter(Boolean).join(" / ") }),
        // 上次切这家失败过：直接标出来，别让人反复点同一个按钮
        account.rejected
          ? el("span", { class: "account__warn", text: "上次切过来失败：B 站已拒绝这份登录凭据" })
          : null,
      ]),
    ],
  );

  const row = el("div", { class: "account__row" }, [
    main,
    el("button", {
      class: "btn btn--icon mono",
      type: "button",
      text: "⋯",
      "aria-label": `更多操作：${displayName(account)}`,
      "aria-expanded": state.editingId === account.id ? "true" : "false",
      dataset: { action: "menu", id: account.id },
    }),
  ]);
  item.append(row);

  const actionBar = () =>
    el("div", { class: "account__actions", hidden: !account.expanded }, [
      el("span", {
        class: "account__detail mono",
        text: `已保存 ${account.cookieCount} 项凭据${relativeTime(account.updatedAt) ? `，${relativeTime(account.updatedAt)}` : ""}`,
      }),
      account.rejected
        ? el("span", {
            class: "account__detail account__detail--warn",
            text: "修法：先「添加下一个账号」，用这个账号重新登录，再点「保存当前账号」覆盖这份快照。",
          })
        : null,
      actionButton(account, "update", "更新快照"),
      actionButton(account, "rename", "改名"),
      actionButton(account, "remove", "删除"),
    ]);

  if (state.editingId === account.id) {
    const input = el("input", {
      class: "rename__input",
      type: "text",
      value: account.alias || "",
      placeholder: account.uname,
      "aria-label": `给 ${displayName(account)} 起个备注名`,
      maxlength: 24,
      onkeydown: (event) => {
        if (event.key === "Enter") commitRename(account.id, input.value);
        if (event.key === "Escape") {
          state.editingId = null;
          render();
        }
      },
    });
    item.append(
      el("div", { class: "rename" }, [
        input,
        el("button", {
          class: "btn btn--mini",
          type: "button",
          text: "保存",
          dataset: { action: "rename-save", id: account.id },
        }),
        el("button", {
          class: "btn btn--mini",
          type: "button",
          text: "取消",
          dataset: { action: "rename-cancel" },
        }),
      ]),
    );
    queueMicrotask(() => input.focus());
  } else {
    item.append(actionBar());
  }

  return item;
}

function render() {
  const { accounts, live } = state;
  els.count.textContent = accounts.length
    ? `${accounts.length} 个账号 · ${live?.loggedIn ? "在线" : "未登录"}`
    : live?.loggedIn
      ? "未保存任何账号"
      : "未登录";
  els.listCount.textContent = String(accounts.length);
  els.empty.hidden = accounts.length > 0;
  els.version.textContent = `扩展 v${chrome.runtime.getManifest().version}`;

  els.accounts.replaceChildren(...accounts.map(renderAccount));
  renderLive();

  for (const input of els.settings.querySelectorAll("input[data-setting]")) {
    input.checked = !!state.settings[input.dataset.setting];
  }
  els.settingsToggle.setAttribute("aria-expanded", els.settings.hidden ? "false" : "true");
}

/* ---------------------------------------------------------------- 动作 */

async function refresh() {
  // 只读，允许重试：service worker 冷启动会丢掉第一条消息
  const res = await sendRead("state");
  state.accounts = res.accounts || [];
  state.live = res.live || null;
  state.navError = res.navError || null;
  state.settings = res.settings || {};
  state.failure = res.failure || null;
  if (state.pendingDeleteId && !state.accounts.some((a) => a.id === state.pendingDeleteId)) {
    state.pendingDeleteId = null;
  }
  render();
}

async function saveCurrent() {
  await run("正在读取当前登录态…", async () => {
    const res = await send("save");
    await refresh();
    setStatus(`已保存「${res.saved?.name ?? "当前账号"}」，共 ${state.accounts.length} 个账号。`, "ok", true);
  });
}

/**
 * 保存当前账号 → 只清掉本地凭据 → 刷新页面，让用户去登录下一个账号。
 * 这一步绝不会调 B 站的退出登录接口，所以已保存账号的服务端会话不受影响。
 */
async function parkCurrent() {
  await run("正在保存当前账号并清空本地登录态…", async () => {
    const res = await send("park");
    await refresh();
    const bits = [];
    if (res.saved) bits.push(`已保存「${res.saved.name}」`);
    bits.push(`清掉本地 ${res.cleared} 项凭据`);
    if (res.reloaded) bits.push(`刷新 ${res.reloaded} 个标签页`);
    const tail = res.failed?.length ? `；${res.failed.length} 项没清掉：${res.failed.join("、")}` : "";
    setStatus(`${bits.join("，")}${tail}。现在去 B 站登录下一个账号，登录后点「保存当前账号」。`, res.failed?.length ? "error" : "ok", !res.failed?.length);
  });
}

async function showReport() {
  await run("正在收集诊断信息…", async () => {
    const res = await sendRead("diagnose");
    els.report.textContent = JSON.stringify(res.report, null, 2);
    els.reportwrap.hidden = false;
    els.diagnose.setAttribute("aria-expanded", "true");
    setStatus("诊断报告已生成。重点看「站内身份」与「浏览器里的B站Cookie」。", "info");
  });
}

async function switchTo(id) {
  await run("正在切换身份并刷新标签页…", async () => {
    let res;
    try {
      res = await send("switch", { id });
    } catch (err) {
      // 失败也要刷新：后台已经把"这家凭据被拒"记下来了，界面得立刻标出来
      await refresh().catch(() => {});
      throw err;
    }
    await refresh();
    const parts = [`已切换到「${res.account?.name ?? id}」`, `写入 ${res.applied} 项凭据`];
    if (res.reloaded) parts.push(`刷新 ${res.reloaded} 个标签页`);
    if (res.retried) parts.push("第一次写入没生效，已自动重做");
    if (res.failed?.length) {
      setStatus(`${parts.join("，")}；但${res.failed.length} 项失败：${res.failed.join("；")}`, "error");
      return;
    }
    setStatus(`${parts.join("，")}。`, "ok", true);
  });
}

async function commitRename(id, alias) {
  await run("正在保存备注名…", async () => {
    await send("rename", { id, alias });
    state.editingId = null;
    await refresh();
    setStatus(alias.trim() ? `备注名已改为「${alias.trim()}」。` : "已清除备注名。", "ok");
  });
}

async function removeAccount(id) {
  if (state.pendingDeleteId !== id) {
    state.pendingDeleteId = id;
    state.accounts = state.accounts.map((a) => ({ ...a, expanded: a.id === id ? true : a.expanded }));
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => {
      state.pendingDeleteId = null;
      render();
    }, 4000);
    setStatus("再点一次「确认删除」才会真的删掉（只删本地快照，不影响 B 站账号）。", "info");
    render();
    return;
  }
  await run("正在删除…", async () => {
    state.pendingDeleteId = null;
    const res = await send("remove", { id });
    await refresh();
    setStatus(`已删除 ${res.removed} 个账号快照。`, "ok");
  });
}

async function exportAccounts() {
  await run("正在导出…", async () => {
    const res = await send("export");
    if (!res.count) throw new Error("还没有可导出的账号。");
    const blob = new Blob([JSON.stringify(res.payload, null, 2)], {
      type: "application/json",
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const link = el("a", {
      href: URL.createObjectURL(blob),
      download: `bili-accounts-${stamp}.json`,
    });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    setStatus(`已导出 ${res.count} 个账号。注意：该文件是明文登录凭据，别外传。`, "ok");
  });
}

async function importAccounts(file) {
  await run("正在导入…", async () => {
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("这不是合法的 JSON 文件。");
    }
    const res = await send("import", { payload });
    await refresh();
    const notes = [`新增 ${res.added} 个`, `覆盖 ${res.replaced} 个`];
    if (res.warnings?.length) notes.push(`跳过 ${res.warnings.length} 条异常数据`);
    setStatus(`导入完成：${notes.join("，")}。`, "ok", true);
  });
}

/* ---------------------------------------------------------------- 事件 */

els.save.addEventListener("click", saveCurrent);
els.park.addEventListener("click", parkCurrent);
els.diagnose.addEventListener("click", () => {
  if (!els.reportwrap.hidden && els.report.textContent) {
    els.reportwrap.hidden = true;
    els.diagnose.setAttribute("aria-expanded", "false");
    return;
  }
  showReport();
});
els.copyReport.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.report.textContent || "");
    setStatus("报告已复制到剪贴板。", "ok");
  } catch {
    setStatus("复制失败（剪贴板不可用），可以手动选中报告文本。", "error");
  }
});
els.update.addEventListener("click", () => {
  const active = state.accounts.find((a) => a.active);
  if (active) {
    run("正在刷新当前账号快照…", async () => {
      await send("update", { id: active.id });
      await refresh();
      setStatus("当前账号的快照已更新。", "ok", true);
    });
  }
});

els.accounts.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "switch") return void switchTo(id);
  if (action === "update") {
    return void run("正在刷新该账号快照…", async () => {
      await send("update", { id });
      await refresh();
      setStatus("快照已更新。", "ok", true);
    });
  }
  if (action === "rename") {
    state.editingId = id;
    return render();
  }
  if (action === "rename-save") {
    const input = els.accounts.querySelector(".rename__input");
    return void commitRename(id, input?.value ?? "");
  }
  if (action === "rename-cancel") {
    state.editingId = null;
    return render();
  }
  if (action === "remove") return void removeAccount(id);
  if (action === "menu") {
    state.accounts = state.accounts.map((a) => (a.id === id ? { ...a, expanded: !a.expanded } : a));
    return render();
  }
});

els.export.addEventListener("click", exportAccounts);
els.import.addEventListener("click", () => els.importFile.click());
els.importFile.addEventListener("change", () => {
  const file = els.importFile.files?.[0];
  if (file) importAccounts(file);
  els.importFile.value = "";
});

els.settingsToggle.addEventListener("click", () => {
  els.settings.hidden = !els.settings.hidden;
  els.settingsToggle.setAttribute("aria-expanded", els.settings.hidden ? "false" : "true");
  if (!els.settings.hidden) els.settings.querySelector("input")?.focus();
});

els.settings.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-setting]");
  if (!input) return;
  const key = input.dataset.setting;
  run("正在保存设置…", async () => {
    const res = await send("settings", { patch: { [key]: input.checked } });
    state.settings = res.settings;
    setStatus(
      key === "switchDevice" && res.settings.switchDevice
        ? "已开启设备指纹隔离：每次切换会连 buvid3/buvid4 一起换，注意风控。"
        : "设置已生效。",
      "ok",
    );
  });
});

refresh().catch((err) => {
  // 别把界面留在"读取中…"这种假象里
  els.count.textContent = "读取失败";
  els.liveName.textContent = "读取失败";
  els.liveMeta.textContent = "";
  setStatus(`${err?.message || String(err)}（重开弹窗再试一次）`, "error");
});
