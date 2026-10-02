# 真机端到端测试（用你自己的 Edge + 你的真实登录态）

单测和探针都证明不了"在你机器上、用你的账号，到底能不能切"。这个脚本补的就是最后这一段：
**用你的 Edge 二进制、你 profile 的副本、你真实的 B 站登录凭据，跑一遍真实的 popup**。

```pwsh
node tools/e2e/drive.mjs
```

它做的事：

1. **准备 profile 副本**（只读你的原 profile，第一次跑时自动拷贝）：
   `Local State`、`Default\Preferences`、`Default\Secure Preferences`、
   `Default\Network\Cookies`（正在被 Edge 占用就跳过）、
   `Default\Local Extension Settings`（**你保存的账号快照**）、
   `Local Storage`、`Session Storage`。
   profile 副本里没有任何东西会写回你的原 profile。
2. **清掉副本里的代码缓存**（`Code Cache` / `Service Worker` / `GPUCache`）。
   不清的话 Chromium 会继续跑缓存的旧 service worker —— 改完源码现象不变，很容易
   误判成"改了没用"。
3. 用 `--load-extension=extension/` 起 headless Edge（默认 headless，`HEADLESS=0` 可看窗口），
   开 `--remote-debugging-port=9333`。
4. 用 CDP 打开 `chrome-extension://<扩展ID>/src/popup.html`，**点真实按钮**，读真实状态行。
5. 依次切到每个已存账号，打印：状态行、站内身份、账号行标注、诊断报告要点。

环境变量：`CDP_PORT`（默认 9333）、`HEADLESS=0`（看窗口）、`EXT_ID`（手工指定 profile 里
扩展的存储目录名；默认按当前源码路径算出 ID，找不到再按内容找，一般不用管）。

## 它会打印什么（一次真实运行的结果）

账号名在下面用 `account-a` / `account-b` 代替：

```
扩展 ID 与按路径算出的结果一致：khljcjfpkjpbcobmlbfoncieibbfbele
扩展版本：扩展 v1.2.0
页头状态：2 个账号 · 未登录
>>> 点击第 1 个账号「account-b」的切换
状态行：切换失败：凭据写进去了，站内却仍是未登录（重做一遍仍然没有生效）。最可能的原因是
       「account-b」的 SESSDATA 已在服务端失效 …… 已回滚到切换前的账号。
账号行标注：[{ "name": "account-b", "rejected": true, "warn": "上次切过来失败：B 站已拒绝这份登录凭据" }, …]
报告要点： "code": -101, "isLogin": false
>>> 点击第 2 个账号「account-a」的切换
状态行：已切换到「account-a」，写入 5 项凭据。
报告要点： "code": 0, "isLogin": true
```

结论：同一台机器、同一份代码，`account-a` 能切过去，`account-b` 不能 —— 差别只在服务端认不认
那份 SESSDATA。切换逻辑本身没有问题。（`account-b` 重新登录并「保存当前账号」覆盖快照之后就能切了。）

## 注意

- 副本里含**真实登录凭据**，跑完请删掉 `.tmp`（`Remove-Item -Recurse -Force .tmp`）。
- 脚本只操作副本：不修改你的 profile、不退出你的登录、不动你的扩展存储。
- 这一步会拿真实 SESSDATA 去问 B 站 `nav`，属于真实请求；不要反复高频跑。
- 顺便：脚本每次都会断言"按路径算出来的扩展 ID == 浏览器实际分配的 ID"，
  所以它同时是 `tools/lib/extension-id.mjs` 的实证测试。
