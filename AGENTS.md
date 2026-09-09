# AGENTS.md

AI 编码代理在本仓库工作时的须知。

## 项目概述

失物招领页面：Cloudflare Worker（无构建步骤），失物属性全部从 URL 查询参数读取，服务端渲染 HTML；前端 UI 使用 MDUI 2（Web Components，全部经 jsDelivr CDN 加载）。

## 命令

| 任务 |命令 |
|---|---|
| 本地开发（http://localhost:8787） | `npm run dev` |
| 部署（需先 `wrangler login`） | `npm run deploy` |
| 重新生成 favicon | `npm run favicon` |

## 文件结构

```
src/index.js           唯一的 Worker 代码：路由 + 参数解析/校验/转义 + HTML 模板字符串 + 页内联 JS
public/favicon.ico     Workers Static Assets，/favicon.ico 直出（不经过 Worker 代码）
scripts/make-favicon.mjs  手写 ICO 二进制生成器（配色/几何在文件顶部常量，零依赖）
wrangler.jsonc         Worker 入口 + assets.directory（无 bindings/env）
```

## 路由

- `GET /`、`GET /item`（含尾斜杠）— 失物展示页（参数见 README）
- `GET /gen`、`/generate`（含尾斜杠）— 链接生成页（链接 / 二维码 / WebNFC 写入三选项卡）
- 其他路径 404；非 GET/HEAD 返回 405（均为 MDUI 样式错误页）

## 必须遵守的约定

1. **XSS**：任何用户输入插入 HTML 前必须过 `escapeHtml()`；URL 型输入必须经 `safeHttpUrl()`（仅允许 http/https）。
2. **单一校验来源**：参数白名单与长度上限只定义在 `src/index.js` 顶部的 `LIMITS`，短键/JSON 键映射只在 `COMPACT_KEYS` 定义（长名、短名、`?d=base64url(JSON)` 三种 URL 形式共用）。`d` 解码后与明文参数走同一套 `parseItem` 校验，勿在解码层加校验。`/gen` 页的客户端校验是把 `LIMITS`/`GEN_FIELDS`/`COMPACT_KEYS` 用 `JSON.stringify` 注入内联脚本实现的——不要另写一份常量。
3. **CSP 与 CDN 联动**：CSP 头只从 `CDN` 一个常量推导（取其 jsDelivr 源站）；`ICON_CSS`、`QR_JS` 是独立常量但必须与之同源，否则 CSP 静默拦截。新增/更换任何 CDN import 必须同步确认 `script-src`/`style-src`/`font-src` 覆盖到新域名。
4. **内联脚本转义**：`renderGenPage` 的 `extraScript` 是嵌在外层模板字符串里的模板字符串，内则正则需写成 `/^https?:\\/\\//i`（双层转义）。改动此区域后必须做语法检查（见验证）。
5. **MDUI 图标字体**：`icon="xxx"`（无后缀）= Filled 变体，字体族必须是 "Material Icons"。当前 `ICON_CSS` 指向 jsDelivr 的 `material-icons` 包；**不要**换成 `Material+Icons+Outlined`（字体族名不匹配，图标全部退化为文字）。
6. **WebNFC**：`NDEFReader.scan()` 必须在用户点击手势内**同步**调用，`startNfcWrite` 中先调 `scan()` 再 `await` 其他逻辑的写法是刻意的，勿"顺手重构"。链接记录的 `recordType` 只能是 `'url'`（NDEF 规范里的 "URI 记录" 在 Web NFC 中叫 `url`，写 `'uri'` 会被 `write()` 拒绝）；停止扫描用 `AbortController` 的 signal，不用已废弃的 `abort()`。
7. 未经用户明确要求不要 `git commit`。

## 验证方法（无测试框架、无 lint/typecheck/CI）

Node ≥18 自带 Response/Request 全局，可直接冒烟（fetch handler 不读 env/ctx，传空占位即可）：

```js
import worker from 'file:///.../src/index.js';
const res = await worker.fetch(new Request('http://localhost/gen'), {}, {});
```

- 结构/状态码：`/item?name=...`→200、缺 name→400、`/nope`→404、POST→405
- XSS：`'<script>alert(1)</script>'` 出现在响应中时必须以 `&lt;script&gt;` 形式存在
- 改内联脚本后：提取 `<script>...</script>` 内容跑 `node --check`
- 涉及真实运行时（静态资源、CSP 头）：后台启动 `wrangler dev`，curl 对照 `http://127.0.0.1:8787`，测完停进程（找 8787 端口占用 PID）
