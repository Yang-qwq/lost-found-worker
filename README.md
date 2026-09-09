# lost-found-worker

基于 [Cloudflare Workers](https://workers.cloudflare.com/) + [MDUI 2](https://mdui.org)（Material Design 3）的失物信息展示页面。失物属性全部通过 URL 查询参数传入，Worker 负责解析、校验、转义并渲染页面，无需任何后端存储或构建工具。

## 快速开始

```bash
npm install
npm run dev      # 本地 http://localhost:8787
npm run deploy   # 部署（需先 wrangler login）
```

## Favicon 静态文件

`/favicon.ico` 通过 Workers Static Assets 提供（`wrangler.jsonc` 的 `assets.directory` 指向 `public/`），请求由静态资源直接命中，不经过 Worker 代码。图标为 32x32 蓝色放大镜，可用 `npm run favicon` 从 `scripts/make-favicon.mjs` 重新生成（修改脚本中的配色/几何后重跑即可）。

## URL 参数

失物页路由：`GET /` 或 `GET /item`；链接生成页：`GET /gen`

| 参数 | 必填 | 上限 | 说明 |
|---|---|---|---|
| `name` | 是 | 100 字符 | 物品名称 |
| `image` | 否 | 2048 字符 | 物品照片 URL，仅允许 http/https，非法值自动丢弃 |
| `desc` | 否 | 500 字符 | 物品描述 |
| `contact` | 否 | 100 字符 | 联系方式，自动识别电话（tel:）或邮箱（mailto:） |
| `location` | 否 | 200 字符 | 地点，提供后显示「地图导航」按钮（跳转高德地图） |

示例：

```
/item?name=黑色钱包&image=https://example.com/wallet.jpg&desc=内有身份证&contact=13800138000&location=图书馆三楼
```

### 紧凑格式（/gen 自动生成）

上表长参数名为兼容保留；`/gen` 生成的链接自动取以下两种形式中更短的一种：

- **短参数名**：`/item?n=..&i=..&e=..&t=..&l=..`（对应 name/image/desc/contact/location），适合以 ASCII 为主的内容（如 image）
- **base64url**：`/item?d=<base64url(JSON)>`（JSON 键用 n/i/e/t/l），中文按 UTF-8 编码比百分号编码短约 3 倍，二维码点阵也更稀疏

服务端三种形式统一解码后再做同一套长度/协议校验；`d` 非法或超长（>16384 字符）返回 400。

## 页面功能

- 顶部应用栏 + 居中卡片式布局（图片卡片 + 属性卡片），移动端优先，自动适配深色模式
- 联系拾物人：根据 contact 自动生成 `tel:` / `mailto:` 链接
- 复制链接：一键复制当前 URL，snackbar 提示
- 地图导航：按 `location` 跳转高德地图搜索

## /gen 链接生成页

表单式生成符合上述参数规范的 `/item?...` 链接：

- 物品名称（必填）、照片链接、描述、联系方式、地点
- 客户端校验与服务端规则一致（必填、长度上限、图片仅 http/https），错误在对应字段下方红字提示
- 生成结果分三个选项卡：
  - **链接**：只读链接框、复制按钮（snackbar 提示）、预览按钮（新标签打开失物页）
  - **二维码**：本地生成（qrcode-generator，jsDelivr 加载），可下载 PNG 或移动端长按保存
  - **NFC 写入**：通过 WebNFC（`NDEFReader`）将链接以 URL 记录（`recordType: 'url'`）写入 NFC 标签；自动探测支持情况，不支持时显示说明（需 Chrome/Edge 移动端 + HTTPS）
- 失物页顶栏带「生成链接」入口（add_link 图标），生成页顶栏带返回按钮

## 安全

- 所有参数经 HTML 转义后注入模板，防止 XSS（`name=<script>` 仅作为文本显示）
- `image` 仅接受 http/https 协议
- 响应携带 CSP、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`
- 缺失必填参数返回 400，未知路由返回 404（均为 MDUI 样式错误页）

## CDN 说明

默认使用 jsDelivr（`https://cdn.jsdelivr.net/npm/mdui@2`），图标字体为 jsDelivr 上的 `material-icons` 包（Filled 变体，与 MDUI 2 默认 `icon` 属性匹配），与 mdui 同源、国内可访问。如需更换 CDN 或镜像，修改 `src/index.js` 顶部的 `CDN` 与 `ICON_CSS` 常量即可。
