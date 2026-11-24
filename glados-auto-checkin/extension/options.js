// ============================================================================
// 文件名：options.js  (type: module)
// 作用：设置页逻辑 —— 全局设置、账号增删改、每账号状态/日历、日志展示
// ============================================================================
import { SITE_LIST, getAdapter, normalizeCookie, getTodayString } from "./sites.js";

const $ = (id) => document.getElementById(id);

// ---------- 初始化 ----------
document.addEventListener("DOMContentLoaded", async () => {
  buildSuffixOptions();
  await loadSettings();
  bindEvents();
  await renderAccounts();
  await renderGlobalHistory();
});

// 后缀预设下拉：选择后自动填充 Base URL，也可手动改
function buildSuffixOptions() {
  const glados = SITE_LIST.find((s) => s.id === "glados") || { knownBaseUrls: [], defaultBaseUrl: "https://glados.cloud" };
  const sel = $("suffixSelect");
  const presets = glados.knownBaseUrls || ["https://glados.cloud"];
  presets.forEach((url) => {
    const opt = document.createElement("option");
    opt.value = url;
    opt.textContent = url.replace(/^https?:\/\//, "");
    sel.appendChild(opt);
  });
  // 自定义选项
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "自定义…";
  sel.appendChild(custom);

  $("accBaseUrl").value = glados.defaultBaseUrl || presets[0] || "";
  sel.addEventListener("change", () => {
    if (sel.value !== "__custom__") {
      $("accBaseUrl").value = sel.value;
    } else {
      $("accBaseUrl").focus();
    }
  });
  // 手动改 Base URL 时，若匹配预设则回选预设，否则选自定义
  $("accBaseUrl").addEventListener("input", () => {
    const v = $("accBaseUrl").value.trim().replace(/\/+$/, "");
    if (presets.includes(v)) sel.value = v;
    else sel.value = "__custom__";
  });
}

async function loadSettings() {
  const data = await chrome.storage.local.get({ notifyEnabled: true, accounts: [] });
  $("notifyToggle").checked = data.notifyEnabled;
  return data;
}

function bindEvents() {
  $("saveSettings").addEventListener("click", async () => {
    const notifyEnabled = $("notifyToggle").checked;
    await chrome.storage.local.set({ notifyEnabled });
    chrome.runtime.sendMessage({ action: "rescheduleAlarm" });
    $("addHint").textContent = "✅ 全局设置已保存";
    setTimeout(() => ($("addHint").textContent = ""), 2500);
  });

  $("testAll").addEventListener("click", async () => {
    const accounts = (await chrome.storage.local.get({ accounts: [] })).accounts;
    if (!accounts.length) {
      $("addHint").textContent = "请先添加账号";
      return;
    }
    $("testAll").disabled = true;
    $("testAll").textContent = "⏳ 正在为全部账号签到…";
    chrome.runtime.sendMessage({ action: "forceCheckInAll" });
    setTimeout(async () => {
      $("testAll").disabled = false;
      $("testAll").textContent = "手动测试全部账号";
      await renderAccounts();
      await renderGlobalHistory();
    }, Math.min(accounts.length * 6000 + 3000, 60000));
  });

  $("addAccBtn").addEventListener("click", addAccount);
}

// ---------- 添加账号 ----------
async function addAccount() {
  const name = $("accName").value.trim();
  const baseUrl = $("accBaseUrl").value.trim();
  const cookieRaw = $("accCookie").value;
  const cookie = normalizeCookie(cookieRaw);

  if (!name) return hint("请填写账号备注名");
  if (!baseUrl) return hint("请填写站点地址");
  if (!cookie) return hint("请粘贴 Cookie");
  try {
    new URL(baseUrl);
  } catch (e) {
    return hint("站点地址格式不正确，应以 https:// 开头");
  }

  const account = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `acc_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    site: "glados",
    name,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    cookie,
    enabled: true,
    useNativeFallback: $("accNative").checked,
    lastCheckInDate: "",
    lastResult: "",
    logs: [],
  };

  const data = await chrome.storage.local.get({ accounts: [] });
  data.accounts.push(account);
  await chrome.storage.local.set({ accounts: data.accounts });
  // 账号变化 -> 让后台按最新域名刷新请求头伪装规则
  chrome.runtime.sendMessage({ action: "refreshHeaderRules" });

  // 清空表单
  $("accName").value = "";
  $("accCookie").value = "";
  $("accNative").checked = false;
  hint("✅ 账号已添加");
  await renderAccounts();
}

function hint(msg) {
  $("addHint").textContent = msg;
  setTimeout(() => ($("addHint").textContent = ""), 2500);
}

// ---------- 渲染账号列表 ----------
async function renderAccounts() {
  const data = await chrome.storage.local.get({ accounts: [] });
  const list = $("accList");
  list.innerHTML = "";
  $("accCount").textContent = data.accounts.length;

  if (!data.accounts.length) {
    list.innerHTML = '<div class="empty">还没有账号，请在上方添加。</div>';
    return;
  }

  for (const acc of data.accounts) {
    list.appendChild(buildAccountCard(acc));
  }
}

function buildAccountCard(acc) {
  const siteName = (SITE_LIST.find((s) => s.id === acc.site) || {}).name || acc.site;
  const card = document.createElement("div");
  card.className = "acc";

  const checkedToday = acc.lastCheckInDate === getTodayString();

  const head = document.createElement("div");
  head.className = "acc-head";
  head.innerHTML = `
    <div class="acc-title">
      ${escapeHtml(acc.name)}
      <span class="pill">${escapeHtml(siteName)}</span>
      <span class="pill">${escapeHtml(acc.baseUrl)}</span>
      <span class="pill ${acc.enabled === false ? "off" : "on"}">${acc.enabled === false ? "已停用" : "已启用"}</span>
      <span class="pill ${checkedToday ? "on" : ""}">${checkedToday ? "今日已签" : "今日未签"}</span>
    </div>`;

  const actions = document.createElement("div");
  actions.className = "btn-row";
  actions.innerHTML = `
    <button data-act="test" style="padding:5px 10px;">测试签到</button>
    <button data-act="points" style="padding:5px 10px;">刷新积分</button>
    <button data-act="toggle" style="padding:5px 10px;">${acc.enabled === false ? "启用" : "停用"}</button>
    <button data-act="del" class="danger" style="padding:5px 10px;">删除</button>`;
  head.appendChild(actions);

  const stats = document.createElement("div");
  stats.className = "acc-stats";
  stats.innerHTML = `
    <span>最近结果：<b style="color:var(--muted);font-family:inherit;">${escapeHtml(acc.lastResult || "暂无")}</b></span>
    <span>最近签到日期：<b>${escapeHtml(acc.lastCheckInDate || "-")}</b></span>
    <span class="pts-info" style="color:var(--accent2);"></span>`;

  card.appendChild(head);
  card.appendChild(stats);

  // 30 天日历（点击“刷新积分”后填充）
  const cal = document.createElement("div");
  cal.className = "acc-cal";
  cal.style.display = "none";
  card.appendChild(cal);

  // 日志
  const logs = document.createElement("div");
  logs.className = "acc-logs";
  if (acc.logs && acc.logs.length) {
    logs.innerHTML = acc.logs
      .slice(0, 8)
      .map((l) => `<div>[${escapeHtml(l.time)}] ${escapeHtml(l.result)}</div>`)
      .join("");
  } else {
    logs.innerHTML = '<div style="border:none;">暂无日志</div>';
  }
  card.appendChild(logs);

  // 事件绑定
  actions.querySelector('[data-act="test"]').addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "⏳ 签到中…";
    chrome.runtime.sendMessage({ action: "forceCheckInOne", id: acc.id });
    setTimeout(async () => {
      await renderAccounts();
      await renderGlobalHistory();
    }, 9000);
  });

  // 刷新积分 / 日历
  actions.querySelector('[data-act="points"]').addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "⏳ 读取中…";
    chrome.runtime.sendMessage({ action: "fetchPoints", id: acc.id }, (res) => {
      btn.disabled = false;
      btn.textContent = "刷新积分";
      const ptsInfo = stats.querySelector(".pts-info");
      if (!res) {
        ptsInfo.textContent = "状态：无响应";
        return;
      }
      if (!res.ok) {
        ptsInfo.textContent = `状态：${res.notLoggedIn ? "未登录/失效" : res.message || "读取失败"}`;
        ptsInfo.style.color = "var(--danger)";
        return;
      }
      ptsInfo.textContent = `积分：${res.points} · 连续：${res.streak} 天`;
      ptsInfo.style.color = "var(--accent2)";
      renderCalendar(cal, res.checkinMap || {});
    });
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "刷新积分";
    }, 12000);
  });

  actions.querySelector('[data-act="toggle"]').addEventListener("click", async () => {    const data = await chrome.storage.local.get({ accounts: [] });
    data.accounts = data.accounts.map((a) =>
      a.id === acc.id ? { ...a, enabled: a.enabled === false ? true : false } : a
    );
    await chrome.storage.local.set({ accounts: data.accounts });
    await renderAccounts();
  });

  actions.querySelector('[data-act="del"]').addEventListener("click", async () => {
    if (!confirm(`确定删除账号「${acc.name}」吗？`)) return;
    const data = await chrome.storage.local.get({ accounts: [] });
    data.accounts = data.accounts.filter((a) => a.id !== acc.id);
    await chrome.storage.local.set({ accounts: data.accounts });
    chrome.runtime.sendMessage({ action: "refreshHeaderRules" });
    await renderAccounts();
  });

  return card;
}

// ---------- 30 天签到日历 ----------
function renderCalendar(container, checkinMap) {
  container.style.display = "block";
  const grid = document.createElement("div");
  grid.className = "cal-grid";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const checked = Object.prototype.hasOwnProperty.call(checkinMap, key);
    const pts = checkinMap[key] || 0;
    const cell = document.createElement("div");
    cell.className = "cal-cell" + (checked ? " checked" : "") + (i === 0 ? " today" : "");
    cell.title = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}：${checked ? "已签到 +" + pts : "未签到"}`;
    cell.innerHTML = `<span class="cal-date">${d.getMonth() + 1}/${d.getDate()}</span><span class="cal-pts">${checked ? "+" + pts : "-"}</span>`;
    grid.appendChild(cell);
  }
  container.innerHTML = "";
  container.appendChild(grid);
}

// ---------- 全局历史 ----------
async function renderGlobalHistory() {
  const data = await chrome.storage.local.get({ history: [] });
  const el = $("globalHistory");
  if (!data.history.length) {
    el.innerHTML = '<div style="border:none;">暂无签到日志</div>';
    return;
  }
  el.innerHTML = data.history
    .map((h) => `<div>[${escapeHtml(h.time)}] ${escapeHtml(h.result)}</div>`)
    .join("");
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
