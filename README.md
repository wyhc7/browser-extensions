# browser-extensions

自己写的浏览器扩展，一个目录一个扩展。放一起是为了以后好找：不用为了一个小工具再开一个仓库。

| 扩展 | 作用 | 目录 | 状态 |
| --- | --- | --- | --- |
| B站多账号切换 | 保存多个 bilibili 账号的登录态，点一下切换，不用反复登出重登 | [`bili-account-switcher/`](bili-account-switcher/) | 可用，v1.2.0 |

## 怎么用

每个扩展都是**自包含**的：进去看它自己的 `README.md`。共同点是都只要浏览器原生能力，没有构建步骤 ——
在 `chrome://extensions`（Edge 是 `edge://extensions`）开开发者模式，**加载已解压的扩展程序**，
选中该扩展的 `extension/` 目录即可。

改完代码记得在扩展页点一次**刷新**：Chromium 会缓存扩展 service worker 的脚本字节，
不刷新的话浏览器还在跑旧代码。

## 目录约定

```
<扩展名>/
  README.md       这个扩展怎么用、怎么验证、有什么坑
  extension/      ← 加载这个目录。只放产品文件，不放测试与工具
  test/           node --test 用例
  tools/          自检、探针、端到端、预览等开发期脚本
  package.json    脚本入口（零依赖）
```

`extension/` 之外的文件永远不会被打进扩展，所以可以放心把验证工具和文档放在旁边。

## 跨扩展共用的东西

- `bili-account-switcher/tools/lib/extension-id.mjs` —— 按目录路径推算扩展 ID。
  解压加载的扩展，ID 由**扩展目录的绝对路径**派生（UTF-16LE → SHA-256 → 前 16 字节 →
  hex → 0-f 映射成 a-p），所以同一份代码换个目录就是另一个扩展，连 `chrome.storage.local`
  都不共享。搬家会"丢账号"，用 `bili-account-switcher/tools/migrate-storage.mjs` 把存储搬过去。

## 许可

MIT，见 [LICENSE](LICENSE)。
