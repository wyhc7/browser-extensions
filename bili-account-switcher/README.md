# B站多账号切换

一个浏览器扩展（Manifest V3）：在 bilibili.com 上保存多个账号的登录态，点一下就在它们之间切换，不用登出重登、不用再过一遍验证码。

```
extension/            ← 加载这个目录（扩展本体，无任何开发期文件）
  manifest.json
  src/
    background.js     service worker：cookie 读写、nav 探活、切换后校验与回滚
    popup.html/.css/.js
    lib/accounts.js   纯逻辑层（Cookie 属性往返、管辖范围、导入清洗），无 chrome.* 依赖
  icons/              16/48/128，由 tools/make-icons.mjs 生成
test/                 38 个用例（逻辑单测 + service worker 端到端）
tools/                图标生成、自检、本地预览、真引擎探针、真机端到端
  probe/              在真实 Chromium 里验证 Cookie 往返（mock 证明不了的那一半）
  e2e/                用你自己的 Edge + 真实登录态驱动真实 popup
```

**改完代码记得在扩展页点一次刷新**：Chromium 会缓存扩展 service worker 的脚本字节，不刷新的话浏览器还在跑旧代码，很容易误判成"改了没用"（`tools/e2e/` 里专门清了这个缓存）。

## 安装

Chrome / Edge 都用同一套「加载已解压的扩展程序」：

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）。
2. 打开右上角的**开发者模式**。
3. 点**加载已解压的扩展程序**，选中本仓库的 `extension/` 目录。

不需要构建步骤。改完代码在扩展页点一下刷新即可。

## 用法

1. 在 B 站网页登录第一个账号 → 点扩展图标 → **保存当前账号**。
2. 点**添加下一个账号** → 页面回到未登录 → 在同一个浏览器里登录第二个账号 → 再点**保存当前账号**。
3. 之后点列表里那一行就切过去了。
4. 行尾 **⋯** 里是：更新快照 / 改名 / 删除。

扩展不注册任何键盘快捷键，也不会在页面上注入任何东西 —— 只有你点扩展图标 + 点账号行这两个动作会触发切换。

## 换账号时绝对不要点网页上的「退出登录」

这是最容易踩、而且踩了以后看起来像"扩展坏了"的坑。

B 站的退出登录走的是 `POST https://passport.bilibili.com/login/exit/v2`，它不只是清掉浏览器里的 Cookie —— 官方接口文档写得很清楚：

> 验证登录成功后会使用 `set-cookie` 字段清空以下 cookie 项：`DedeUserID` `DedeUserID__ckMd5` `SESSDATA` `bili_jct`，
> **并在服务器注销该登录 Token (SESSDATA)，该 Token 即失效**

也就是说：如果你用「保存甲 → 点退出登录 → 登录乙 → 保存乙」这个流程，甲那份快照里的 SESSDATA **在服务端已经被注销了**。之后切回甲，Cookie 是写进去了，但服务端不认，页面还是未登录 —— 症状就是"能保存账号，但切换没有用"。

**「添加下一个账号」就是为这件事做的**：它先把当前账号存下来，然后**只删掉浏览器本地的身份 Cookie**（不调任何注销接口），页面刷新成未登录，你再去登录下一个账号。服务端的会话没有被碰过，两份快照都是活的，来回切都有效。

1.1.0 起，切换完成后扩展会**重新调用 nav 校验一次身份**：

- 校验通过 → 报成功。
- 校验发现"写进去了但还是未登录" → 直接告诉你原因，并**自动回滚**到切换前的账号，不会把你扔在未登录状态。
- 校验发现身份是另一个账号，或读回的 Cookie 值不一致 → 一并说明是哪几项对不上。

**如果你之前用"退出登录"的方式存过账号**，那些快照需要重建：登录那个账号 → 点「保存当前账号」覆盖掉旧快照即可。

1.1.2 起，失败会被**记住并标在账号行上**：切换失败后那一行的边框变成虚线，并显示「上次切过来失败：B 站已拒绝这份登录凭据」，展开 ⋯ 里给出修法。重新登录并「保存当前账号」覆盖快照后，标记自动消失。诊断报告里也会多出 `上次切换失败` 一项。

## 故障排查

点右下角**诊断**，会把判定卡点所需的事实原样列出来（Cookie 只报长度、不报内容）：

| 看哪一项 | 说明 |
| --- | --- |
| `站内身份.code` | `0` 表示已登录；`-101` 表示未登录（即凭据不被服务端接受） |
| `浏览器里的B站Cookie` | 切换后这里应该出现目标账号那 5 项；缺哪个就是哪个没写进去 |
| `已存快照` | 每个账号存了哪几项、什么时候更新的。太久没更新的快照可能已被 B 站轮换掉 |
| `上次切换失败` | 哪一家的凭据被 B 站拒绝了、什么时候拒的。非空就是这家需要重新登录覆盖快照 |
| `设置` | `autoSync` 关掉的话，切走前不会刷新当前账号的快照，更容易切回来时已失效 |

把这份报告贴给能看代码的人，就能直接定位到是"没写进去"还是"服务端不认"。

### 一次真实的定位过程（同一台机器、同一份代码）

用 `tools/e2e/drive.mjs` 在本机 Edge + 真实登录态上跑，两个已存账号的结果是：

| 账号 | 切换后 nav | 结论 |
| --- | --- | --- |
| 甲（快照 07:40 保存后没再更新过） | `code: -101`，仍是未登录 | **这份 SESSDATA 已被服务端拒绝**，属客户端无法修复的情形 |
| 乙（快照 08:35 更新过） | `code: 0`，`isLogin: true` | 切换成功，站内身份确实变成了乙 |

两者跑的是同一段切换代码，差别只在服务端认不认那份 SESSDATA。所以"切换没有用"当时并不是逻辑问题，而是目标账号的快照已经死了 —— 修法是重新登录甲、点「保存当前账号」覆盖快照（换号用「添加下一个账号」，别点网页上的「退出登录」）。

## 它到底换了什么

| Cookie | 用途 | 默认随账号切换 |
| --- | --- | --- |
| `SESSDATA` | 登录态本体 | 是 |
| `bili_jct` | 写操作的 CSRF token | 是 |
| `DedeUserID` / `DedeUserID__ckMd5` | 账号 mid 及其校验 | 是 |
| `sid` | 会话标识 | 是 |
| `buvid3` / `buvid4` / `buvid_fp` / `b_nut` / `b_lsid` / `_uuid` | 设备指纹 | 否（设置里可开"连设备指纹一起切换"） |
| 其余（`CURRENT_FNVAL`、`bp_video_offset_*` 等） | 站点偏好、播放进度 | 否，完全不碰 |

切换流程：读 `api.bilibili.com/x/web-interface/nav` 确认当前是谁 → 先刷新**正在使用的那个账号**的快照（SESSDATA 会轮换）→ 删掉 cookie 罐里所有身份 Cookie → 按原属性写回目标账号的凭据 → 硬刷新所有已打开的 B 站标签页 → 再读一次 nav 校验身份，不对就回滚并说明原因。

为什么默认不动 `buvid3` 这类设备指纹：它们不绑定账号，而短时间反复更换 buvid 更容易触发风控。想要更彻底的账号隔离时可以在设置里打开，代价是更容易被要求验证码。

## 为什么必须是扩展，而不是油猴脚本

- 页面 JS 只看得见非 HttpOnly 的 Cookie，而登录态里往往混着 HttpOnly 的；哪怕读得到，`document.cookie` 也**无法还原** `domain` / `path` / `secure` / `SameSite` / 过期时间这些决定登录态是否生效的属性。`chrome.cookies` 是唯一能完整读、并原样写回的手段。
- 说明一处未核实的细节：我无法在没有真实登录态的情况下确认 B 站是否给 `SESSDATA` 加了 `HttpOnly`，所以上面的论证建立在"完整属性还原"这一点上，而不是"它一定是 HttpOnly"。

## 安全与风控

- 快照存在 `chrome.storage.local`，只在本机、不入云。扩展唯一的网络请求是 `https://api.bilibili.com/x/web-interface/nav`，不把 Cookie 发往任何第三方。
- **导出的 JSON 就是明文登录凭据**，拿到它等于拿到你的账号。别丢进网盘、聊天记录或代码仓库。要在别的设备登录，用 B 站官方的"登录设备管理"更合适。
- 权限只要了 `cookies` + `storage` + `*://*.bilibili.com/*` 的 host 权限 —— 能读写的范围只有 B 站域下的 Cookie。`tools/verify.mjs` 会把这条当断言检查：多要一个权限就自检失败。
- 若风控被触发（验证码、短信校验），先停一会儿别继续切，并确认设备指纹切换是关着的。

## 已知限制

- 只作用于浏览器里的 bilibili.com 网页，与 App / PC 客户端无关。
- 只保存**已登录完成**的状态；扫码/验证码的中间态不保存。
- 凭据一旦被服务端注销（点了退出登录、改了密码、在别的设备把人踢下线），客户端无法复活它，只能重新登录再覆盖快照。
- 若 B 站改了登录 Cookie 的名字，需要同步改 `extension/src/lib/accounts.js` 里的 `IDENTITY_COOKIE_NAMES`（改完 `npm test` 会立刻告诉你有没有漏）。
- 不做跨设备同步。

## 开发

```bash
npm test            # 38 个用例：15 个纯逻辑 + 23 个 service worker 端到端
npm run icons       # 重新生成 16/48/128 图标（零依赖，手写 PNG + zlib）
npm run verify      # 交付前自检：manifest、权限白名单、引用完整性、目录卫生、PNG 结构、JS 语法

node tools/probe/run.mjs   # 真引擎探针：在真实 Chromium 里验证 Cookie 的写/读回/删除
node tools/e2e/drive.mjs   # 真机端到端：用你自己的 Edge + 真实登录态驱动真实 popup

# 把 extension/ 挪到别的目录之后，账号快照会"消失"（扩展 ID 随路径变，见下）。
# 这个工具按内容找到旧 ID 的存储目录，复制到新 ID 下；必须先完全退出浏览器。
node tools/migrate-storage.mjs           # 预览
node tools/migrate-storage.mjs --apply   # 执行（旧的存留不动，可退回去）

# 在普通浏览器里看弹窗（不需要装扩展）：先起静态服务，再打开
node tools/preview/serve.mjs 8123
# http://127.0.0.1:8123/tools/preview/              → 正常态
# 加 ?theme=dark → 暗色；加 &state=empty → 空态；加 &state=dead → 凭据失效的失败提示
```

### 关于扩展 ID：换目录 = 换扩展

解压加载的扩展没有签名，Chromium 用**扩展目录的绝对路径**派生 ID
（UTF-16LE → SHA-256 → 前 16 字节 → hex → 0-f 映射成 a-p，实现在 `tools/lib/extension-id.mjs`）。
而 `chrome.storage.local` 按扩展 ID 分目录存放，所以把 `extension/` 挪个地方，
浏览器就认为这是另一个扩展：**账号快照不会跟着走**。

这不是推测：`tools/e2e/drive.mjs` 每次运行都会把"按路径算出来的 ID"和"浏览器实际分配的 ID"
做一次断言比对，并已验证过本机一个已装扩展的 ID 与算法结果完全一致。搬家时用
`tools/migrate-storage.mjs` 把存储复制到新 ID 名下即可，不必重新登录。

`tools/probe/` 与 `tools/e2e/` 是两种不同层次的实证，各自补上 mock 证明不了的那一半：

- **probe**：把真实的 `accounts.js` 暂存成一个临时扩展，用 `--load-extension` 起真实 Chromium，
  对站点真实下发的 Cookie 做完整往返，并跑 8 组属性矩阵（域/hostOnly × secure × session）。
  结论：干净状态下 8/8 被接受、读回无属性走样、都能用同一份 details 删掉；而同一个
  (name, domain, path) 已存在且 scheme 绑定冲突时，`chrome.cookies.set` 会抛
  `Failed to parse or set cookie named "..."` —— 切换代码因此改成"删/写失败换一种 scheme
  重试、写入前先清同名同路径的旧 Cookie、写完读回对不上就重做一遍"。
- **e2e**：用你本机 Edge 的 profile **副本** + 真实登录态驱动真实 popup，打印真实状态行。
  就是它定位出"甲已死、乙正常"。跑完记得删 `.tmp`（副本里有真实凭据）。

`test/background.switch.test.mjs` 值得单独说一句：它把 `chrome.*` 换成内存实现（cookie 罐 / storage / 标签页 / 事件总线），用假的 `nav` 接口按"罐里当前的 `SESSDATA` 是谁"来回答身份，于是下面这些事都能被真正断言，而不是靠读代码推断：

- 切完 Cookie 之后到底变成了谁、上个账号的 `sid` 有没有清干净；
- SESSDATA 被 B 站轮换过之后，会不会把旧凭据存回去；
- 「添加下一个账号」全程只碰过 nav，没有调用任何注销接口；
- 凭据被服务端注销时，是否给出了可读的原因并回滚到原来的账号。

## 交付前的验证记录

| 手段 | 结果 |
| --- | --- |
| `npm test` | 38 / 38 通过 |
| `npm run verify` | 通过（权限白名单、引用完整性、目录卫生、3 个 PNG 结构、JS 语法） |
| 真引擎探针（`tools/probe/run.mjs`，真实 Chromium 154） | 通过：站点 Cookie 往返 0 错 0 丢失 0 走样，属性矩阵 8/8 |
| 真机端到端（`tools/e2e/drive.mjs`，你的 Edge + 真实登录态） | 账号乙切换成功（`nav code: 0`）；账号甲被服务端拒绝并被正确标注 |
| Chromium 校验（`msedge.exe --pack-extension`） | 退出码 0，manifest 被真实引擎接受 |
| 图标解码 | System.Drawing 独立读回 16×16 / 48×48 / 128×128 RGBA8 |
| 前端审计（`audit.mjs`） | CRITICAL 0 · WARN 0 |
| 文字对比度（页面内实测计算） | 浅色与暗色各 0 处低于 4.5:1（大字 3:1） |
| 暗色亮度量化（`measure.mjs`，裁到弹窗本体） | 中位亮度 18，落在 5–30 的暗场区间 |
| 浅色亮度量化 | 中位 255（白纸面）——该判定对"浅色单面板"不适用，理由是层次由 3px 硬描边与文字承载，见 STYLE.md |
