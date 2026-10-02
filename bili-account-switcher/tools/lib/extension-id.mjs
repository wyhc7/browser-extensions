/**
 * 扩展 ID 的计算（纯函数，无副作用）。
 *
 * 解压加载（unpacked）的扩展没有签名，Chromium 用**扩展目录的绝对路径**派生 ID，
 * 所以同一份代码放在不同目录里就是两个不同的扩展 —— 连 `chrome.storage.local`
 * 都不共享（它按扩展 ID 分目录存）。搬家 = 换 ID = 丢快照，先把这句话记住。
 *
 * 算法（实测校准，非猜测）：
 *   1. 路径字符串按 UTF-16LE 编码（Windows 上的原生宽字符表示）；
 *   2. SHA-256，取前 16 字节，写成 32 个 hex 字符；
 *   3. 每个 hex 数字 0-f 映射成字母 a-p（Chromium 的 "mpdecimal"）。
 *
 * 校准方式：本机一个已装扩展的 ID 为 `bklijeajbfihlaejaeghfkhhlfnejmgd`，
 * 其目录路径按上式算出的前 32 字符与之逐字符相同；`tools/e2e/drive.mjs` 每次运行时
 * 还会把算出来的 ID 与浏览器真正分配的 ID 做一次断言比对。
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** 把路径算成 Chromium 风格的扩展 ID。 */
export function extensionIdForPath(path) {
  const absolute = resolve(path);
  return createHash("sha256")
    .update(Buffer.from(absolute, "utf16le"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

/** 从 `chrome-extension://<id>/...` 这类 URL 里取出 ID。 */
export function extensionIdFromUrl(url) {
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(String(url || ""));
  return match ? match[1] : null;
}
