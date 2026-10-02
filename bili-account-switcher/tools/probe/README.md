# 真引擎探针（Cookie 层）

单测用的是内存 mock，能证明**逻辑对不对**，证明不了**浏览器收不收**。这个探针补的
就是后半句：在真实 Chromium 里，让 `extension/src/lib/accounts.js` 亲自生成
`chrome.cookies.set / remove` 的入参，看引擎是否接受、写回去有没有走样。

```pwsh
node tools/probe/run.mjs
```

脚本会：

1. 把 `tools/probe/{manifest.json,sw.js}` 和**正在用的** `extension/src/lib/accounts.js`
   暂存到 `.tmp/probe-stage/`（拷的是产品代码本身，不是副本，所以不会和实现漂移）；
2. 起一个 headless 浏览器，用 `--load-extension` 加载这个暂存扩展；
3. 扩展先访问 `https://www.bilibili.com/` 让站点下发真实 Cookie（`buvid3` / `b_nut`），
   再用扩展来源请求 `/x/web-interface/nav`（未登录应为 `-101`）；
4. 对站点真实 Cookie 做一次**完整往返**：照原样读 → 全删 → 全写回 → 逐项比对属性；
5. 跑一遍**写入矩阵**（域/hostOnly × secure/非 × session/带过期，共 8 组），每组都验证
   "能被接受""读回无属性走样""能用自己的 details 删干净"；
6. 验证"过期时间设在过去"这条删除路径；
7. 清掉自己写进去的 Cookie，把报告 POST 回本地收集器，打印结论。

报告落在 `.tmp/probe-report.json`（含站点真实 Cookie 的属性，**不含任何凭据**）。
退出码 `0` = 全过；`1` = 有组合被拒或走样；本机没有 Edge/Chrome 时打印"跳过"并退出码 `0`。

## 探针查出来的两件事

- **干净状态下，8 种 Cookie 形状全部被引擎接受、读回无走样、且都能用同一份 details 删掉。**
  也就是说"写入形状不合法"不是切换失败的原因。
- **同一个 `(name, domain, path)` 已经存在、且旧的 scheme 绑定与新写入的组合冲突时，
  `chrome.cookies.set` 会抛 `Failed to parse or set cookie named "..."`。**
  所以删除一旦漏掉一个旧 Cookie，写入就可能被拒，身份就混在一起。
  `background.js` 为此做了三件事：删/写都在主 URL 失败后换一种 scheme 再试一次；
  写入前先把同名同路径的旧 Cookie 清掉；写完读回对不上时自动重做一遍。

`--enable-logging=stderr` 不在脚本里开着，需要看扩展控制台日志时自己加
`--enable-logging=stderr` 到 `run.mjs` 的启动参数，扩展的报错会以
`chrome-extension://<id>/sw.js` 形式出现在 stderr。
