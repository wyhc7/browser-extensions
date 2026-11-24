# GLaDOS 多后缀 · 多账号自动签到助手

基于 [imnekosama/GLaDOS_AutoCheckin](https://github.com/imnekosama/GLaDOS_AutoCheckin) 二次开发。

在「仅支持 GLaDOS 单账号」的基础上重构，重点解决两件事：

1. **多账号**：同一后缀下可添加任意多个账号，每个账号使用**独立 Cookie**，互不干扰、可并行执行。
2. **多后缀**：GLaDOS 有多个域名后缀（`glados.cloud` / `glados.rocks` / `glados.homes` / `glados.info` / `glados.one` …），每个账号可填自己所属后缀的地址；请求头伪装规则会**按所有账号实际用到的后缀动态生成**。

---

## ✨ 相对原版的改动

| 能力 | 原版 | 本版本 |
| --- | --- | --- |
| 账号数量 | 每站 1 个（依赖浏览器登录态） | **任意多账号**，每账号独立 Cookie |
| 域名后缀 | 写死 `glados.cloud` | **支持多个 GLaDOS 后缀**，账号各自指定 + 预设下拉 |
| 签到方式 | 必须打开真实页面点 `.ckb` | 默认 Cookie 直连 API（静默）；可选原生点击兜底 |
| 请求头伪装 | 写死单域名规则 | 按所有账号域名**动态生成** Origin/Referer 规则 |
| 设置界面 | 单账号 | 账号增删改查、启停、单/全账号测试、刷新积分+30天日历、日志 |

## 🧠 核心设计

### 实测确认的新版 GLaDOS 行为（关键）
用真实账号实测得到两条硬事实，决定了技术方案：

1. **签到接口是 `POST /api/user/checkin`**（用 GET 会 405）。
2. **纯 API 请求会被 Cloudflare Turnstile 拦截**：返回 `{"code":5,"reason":"turnstile","message":"Cloudflare verification failed..."}`。而 **Cookie 本身是有效的**（同 Cookie 调 `/api/user/points` 返回 `code:0`）。

结论：**签到不能靠裸请求，必须"打开真实页面、点原生签到按钮"**——让页面里的 Turnstile 自动完成验证，官网 React 自己用 POST 发请求。这正是原项目 v1.5.1 的思路，本版本沿用并做了多账号/多后缀强化。

### 为什么用「独立 Cookie」实现多账号？
1. 每个账号单独保存该后缀站点的 Cookie（新版为 `gld:sess` / `gld:sess.sig` 等）；
2. 执行某账号时，用 `chrome.cookies` 把该账号 Cookie 注入浏览器 → 打开真实签到页 → 在主世界点击签到按钮 → 结束后**恢复原有 Cookie**；
3. 因此同后缀多个账号、跨后缀多个账号都能并存且互不污染（串行执行，每账号签到后还原备份）。

> 注意：浏览器 `fetch` 不能手动设置 `Cookie` / `Origin` / `Referer`（都是禁止头）。所以 Cookie 走 `chrome.cookies` 注入，Origin/Referer 走 declarativeNetRequest 动态规则（按账号域名生成）。

### 签到按钮定位（已实测命中）
新版页面签到按钮仍是 `<button class="ckb">Checkin</button>`；若改版，后备逻辑按文字匹配 `Checkin/签到` 并排除 `Need xx more`。签到成功表现为按钮文字变为 `Checkin! Got N Points` 且加 `is-done` 类，本版本据此解析点数。

### 适配器（`sites.js`）
`glados` 适配器内置了 `knownBaseUrls` 后缀预设，`endpoints()` 直接以账号的 `baseUrl` 拼接口，任意后缀均可。

## 🚀 安装
1. `chrome://extensions/` → 开发者模式 → 加载已解压的扩展程序 → 选本文件夹
2. 点扩展图标（或右键→选项）打开设置页

## 🛠 使用
### 获取 Cookie
1. 浏览器登录你账号所在**后缀**的站点（如 `glados.rocks`）；
2. F12 → Application → Cookies → 选该站点，复制 `koa:sess` 等键值；或直接复制任意请求的整段 `Cookie` 头。

### 添加与签到
1. 填备注名 → 下拉选后缀（或自定义 Base URL）→ 粘贴 Cookie → 添加账号；
2. 账号卡上点「刷新积分」验证 Cookie 有效、查看 30 天日历；
3. 点「测试签到」试跑。完成后**无需设定时间**——每天首次打开浏览器时会自动为所有启用账号签到。

### 多后缀多账号示例
- 账号A：`https://glados.cloud` + Cookie_A
- 账号B：`https://glados.rocks` + Cookie_B
- 账号C：`https://glados.cloud` + Cookie_C（同后缀第二个号，靠 Cookie 隔离）

## 📂 文件结构
- `manifest.json`：MV3 配置（`cookies` 权限、多站点 host 权限）
- `background.js`：多账号引擎、动态请求头伪装、每日首次启动自动签到、消息通信
- `sites.js`：GLaDOS 适配器 + 后缀预设 + 通用工具
- `options.html` / `options.js`：设置界面与账号管理
- `icon.png`、`README.md`

## 🔒 隐私
纯本地运行，Cookie 与日志仅存于 `chrome.storage.local`，不上传任何服务器。

## ⚖️ 许可
沿用原项目 MIT License。仅供学习交流。与原站点官方无任何隶属关系。
