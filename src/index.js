/**
 * 失物信息 Cloudflare Worker
 *
 * 路由一览：
 *   GET / 或 /item   失物属性展示页（属性全部来自 URL 查询参数，服务端渲染；
 *                    支持长参数名、短参数名(n/i/e/t/l)及紧凑的 ?d=base64url(JSON)）
 *   GET /gen         链接生成页（表单 → /item?... 链接，含二维码 / WebNFC 写入）
 *   /favicon.ico     由 Workers Static Assets（public/）直出，不经过本文件
 *
 * 无构建步骤：页面 HTML 由模板字符串生成，前端依赖全部走 jsDelivr CDN加载。
 * 安全约定：所有用户输入插入 HTML 前必须经过 escapeHtml；image 仅允许 http/https。
 */

/** MDUI 2 组件库（CSS + 全局 JS，Web Components 写法） */
const CDN = 'https://cdn.jsdelivr.net/npm/mdui@2';
/** Material Icons 字体（Filled 变体）。注意：MDUI 的 icon="xxx" 不带 --outlined 等后缀时使用
 *  Filled，字体族名必须是 "Material Icons"，否则图标会退化为文字。 */
const ICON_CSS = 'https://cdn.jsdelivr.net/npm/material-icons@1.13.12/iconfont/material-icons.css';
/** 纯客户端二维码生成库（全局函数 qrcode），仅 /gen 页按需加载 */
const QR_JS = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

/** URL 参数白名单及各自的长度上限（服务端校验与 /gen 页客户端校验共用同一份定义） */
const LIMITS = {
  name: 100,
  image: 2048,
  desc: 500,
  contact: 100,
  location: 200,
};

/** 宽松电话判定：允许分隔符，用于决定 contact 走 tel: 还是 mailto: */
const PHONE_RE = /^[0-9+()\-.\s]{5,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 内容安全策略。CDN 域名由 CDN 常量推导，换 CDN 时 CSP 自动同步；
 * 内联脚本（复制/表单/QR/NFC 逻辑）依赖 'unsafe-inline'。
 */
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${CDN.split('/npm')[0]} 'unsafe-inline'`,
  `style-src 'unsafe-inline' ${CDN.split('/npm')[0]}`,
  `font-src ${CDN.split('/npm')[0]}`,
  'img-src https: http:',
  `connect-src ${CDN.split('/npm')[0]}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** HTML 转义，防 XSS。所有插入模板的用户输入都必须经过此函数 */
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

/**
 * 校验 URL 并只放行 http/https 协议（拦截 javascript: 等危险 scheme）。
 * @returns {string} 规范化后的 URL，非法则返回空串
 */
function safeHttpUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
  } catch {
    // 非法 URL，丢弃
  }
  return '';
}

/**
 * 根据联系方式内容生成可点击链接：电话 → tel:，邮箱 → mailto:，其余返回空串（只显示文本）。
 */
function contactHref(contact) {
  if (!contact) return '';
  if (PHONE_RE.test(contact)) return `tel:${contact.replace(/[^0-9+]/g, '')}`;
  if (EMAIL_RE.test(contact)) return `mailto:${contact}`;
  return '';
}

/** 紧凑表示：canonical 参数名 → 短键/JSON 键（明文短参数与 ?d= JSON 共用） */
const COMPACT_KEYS = { name: 'n', image: 'i', desc: 'e', contact: 't', location: 'l' };
/** ?d= 值的最大长度（base64 字符数），防止超长 URL 滥用 */
const D_MAX = 16384;

/**
 * 解码 ?d= 参数：base64url（可无 padding，也容忍标准 base64）→ UTF-8 JSON 对象。
 * @returns {object|null} 非法输入返回 null
 */
function decodeCompact(raw) {
  try {
    let b = raw.replace(/-/g, '+').replace(/_/g, '/');
    b += '='.repeat((4 - (b.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 解析 URL 查询参数为失物对象，并附带派生字段(contactHref / mapUrl)。
 * 参数来源三选一（优先级从高到低）：?d=base64url(JSON) > 长参数名 > 短参数名。
 * 解码后的字段仍统一走 LIMITS 校验与 safeHttpUrl，校验逻辑不因格式而分叉。
 * @param {URLSearchParams} sp
 * @returns {{item: object} | {errors: string[]}} 校验失败时返回 errors，调用方据此返回 400
 */
function parseItem(sp) {
  const errors = [];
  const item = {};

  const d = (sp.get('d') || '').trim();
  let src;
  if (d) {
    if (d.length > D_MAX) return { errors: ['参数 d 超过长度上限'] };
    const obj = decodeCompact(d);
    if (!obj) return { errors: ['参数 d 不是合法的 base64url JSON'] };
    src = (key) => {
      const v = obj[COMPACT_KEYS[key]];
      return typeof v === 'string' ? v.trim() : '';
    };
  } else {
    src = (key) => {
      const v = sp.get(key) ?? sp.get(COMPACT_KEYS[key]);
      return typeof v === 'string' ? v.trim() : '';
    };
  }

  for (const [key, max] of Object.entries(LIMITS)) {
    const value = src(key);
    if (value.length > max) errors.push(`参数 ${key} 超过 ${max} 字符上限`);
    item[key] = value;
  }
  if (!item.name) errors.push('缺少必填参数 name（物品名称）');
  item.image = item.image ? safeHttpUrl(item.image) : '';
  item.contactHref = contactHref(item.contact);
  item.mapUrl = item.location
    ? `https://uri.amap.com/search?keyword=${encodeURIComponent(item.location)}`
    : '';

  return errors.length ? { errors } : { item };
}

/** 全局页面样式（注入到 <style>，仅做布局微调，组件外观交给 MDUI） */
const PAGE_CSS = `
  body { margin: 0; }
  .page { max-width: 640px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
  .img-card { overflow: hidden; }
  .img-card img { display: block; width: 100%; max-height: 360px; object-fit: cover; }
  .card-body { padding: 16px 20px 8px; }
  .title-row { text-align: center; }
  .title-row h2 { margin: 0; font-size: 22px; font-weight: 500; word-break: break-all; }
  .desc { margin: 12px 0 0; line-height: 1.7; white-space: pre-wrap; word-break: break-word; color: var(--mdui-color-on-surface-variant); }
  .meta-list { margin: 8px -20px 0; }
  .error-wrap { text-align: center; padding: 48px 16px; }
  .error-wrap mdui-icon { font-size: 48px; color: var(--mdui-color-error); }
  .error-wrap p { color: var(--mdui-color-on-surface-variant); }
  a.plain { text-decoration: none; }
  .form { display: flex; flex-direction: column; gap: 12px; }
  .field { width: 100%; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .hint { margin: 0; color: var(--mdui-color-on-surface-variant); font-size: 14px; }
  mdui-tabs { width: 100%; }
  .tab-panel-body { padding-top: 12px; }
  .qr-box { display: flex; justify-content: center; padding: 12px 0; min-height: 60px; }
  .qr-box svg { width: 224px; height: 224px; }
  .qr-empty { color: var(--mdui-color-on-surface-variant); font-size: 14px; }
`;

/** 顶栏按钮片段（mdui-button-icon 本身不支持 href，用 <a> 包裹实现跳转） */
const GEN_TOP = '<a class="plain" href="/gen"><mdui-button-icon icon="add_link"></mdui-button-icon></a>';
const SHARE_TOP = '<mdui-button-icon icon="share" onclick="copyLink()"></mdui-button-icon>';
const BACK_TOP = '<a class="plain" href="/"><mdui-button-icon icon="arrow_back"></mdui-button-icon></a>';

/**
 * 公共 HTML 骨架：head（CDN/CSP 相关资源）+ 顶栏 + 内容 + 可选底栏 + 通用脚本。
 * @param {string} title    <title> 文本
 * @param {string} content  页面主体 HTML
 * @param {object} [opts]
 * @param {string} [opts.bottomBar]   底部应用栏内容（空则不渲染）
 * @param {string} [opts.barTitle]    顶栏标题
 * @param {string} [opts.topLeading]  顶栏左侧按钮
 * @param {string} [opts.topTrailing] 顶栏右侧按钮（默认：生成页入口 + 分享）
 * @param {string} [opts.extraScript] 追加到通用内联脚本之后的页面专属 JS
 * @param {string} [opts.headExtra]   追加到 <head> 的额外标签（如 QR 库）
 */
function layout(title, content, opts = {}) {
  const {
    bottomBar = '',
    barTitle = '失物信息',
    topLeading = '',
    topTrailing = GEN_TOP + SHARE_TOP,
    extraScript = '',
    headExtra = '',
  } = opts;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, shrink-to-fit=no">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="${CDN}/mdui.css">
<link rel="stylesheet" href="${ICON_CSS}">
<script src="${CDN}/mdui.global.js"></script>
${headExtra}
<style>${PAGE_CSS}</style>
</head>
<body>
<mdui-top-app-bar variant="center-aligned">
${topLeading}<mdui-top-app-bar-title>${escapeHtml(barTitle)}</mdui-top-app-bar-title><div style="flex-grow:1"></div>${topTrailing}
</mdui-top-app-bar>
${content}
${
  bottomBar
    ? `<mdui-bottom-app-bar>${bottomBar}</mdui-bottom-app-bar>`
    : ''
}
<script>
/* 通用剪贴板：优先异步 Clipboard API，失败/不可用时降级 execCommand */
function copyText(t, msg) {
  const done = () => mdui.snackbar({ message: msg });
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
  } else {
    fallbackCopy(t, done);
  }
}
function copyLink() { copyText(location.href, '链接已复制'); }
function fallbackCopy(t, cb) {
  const ta = document.createElement('textarea');
  ta.value = t;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); cb(); } catch (e) { /* ignore */ }
  ta.remove();
}
${extraScript}
</script>
</body>
</html>`;
}

/**
 * 渲染失物展示页：图片卡片（可选）+ 属性卡片 + 底部操作栏（联系/复制/地图导航）。
 * @param {object} item parseItem 产出的失物对象
 */
function renderPage(item) {
  const imageCard = item.image
    ? `<mdui-card class="img-card" variant="elevated"><img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}"></mdui-card>`
    : '';

  const desc = item.desc
    ? `<p class="desc">${escapeHtml(item.desc)}</p>`
    : '';

  const listItems = [];
  if (item.contact) {
    listItems.push(
      `<mdui-list-item nonclickable icon="contacts" headline="联系方式" description="${escapeHtml(item.contact)}"></mdui-list-item>`
    );
  }
  if (item.location) {
    listItems.push(
      `<mdui-list-item nonclickable icon="place" headline="地点" description="${escapeHtml(item.location)}"></mdui-list-item>`
    );
  }
  const list = listItems.length
    ? `<mdui-list class="meta-list">${listItems.join('')}</mdui-list>`
    : '';

  // 底部操作栏：按可用数据动态拼接，缺失的字段不渲染对应按钮
  const actions = [];
  if (item.contactHref) {
    const icon = item.contactHref.startsWith('tel:') ? 'call' : 'mail';
    actions.push(
      `<a class="plain" href="${escapeHtml(item.contactHref)}"><mdui-button variant="filled" icon="${icon}">联系拾物人</mdui-button></a>`
    );
  }
  actions.push(`<mdui-button variant="text" icon="share" onclick="copyLink()">复制链接</mdui-button>`);
  if (item.mapUrl) {
    actions.push(
      `<a class="plain" href="${escapeHtml(item.mapUrl)}" target="_blank" rel="noopener noreferrer"><mdui-button variant="text" icon="map">地图导航</mdui-button></a>`
    );
  }

  const content = `<div class="page">
${imageCard}
<mdui-card variant="elevated"><div class="card-body">
<div class="title-row"><h2>${escapeHtml(item.name)}</h2></div>
${desc}
${list}
</div></mdui-card>
</div>`;

  return layout(`${item.name} · 失物信息`, content, { bottomBar: actions.join('') });
}

/** 生成页表单字段映射：DOM id → URL 参数名（与服务端 LIMITS 保持一致） */
const GEN_FIELDS = [
  ['f-name', 'name'],
  ['f-image', 'image'],
  ['f-desc', 'desc'],
  ['f-contact', 'contact'],
  ['f-location', 'location'],
];

/**
 * 渲染链接生成页：上方表单，下方结果卡片（链接 / 二维码 / NFC 写入三个选项卡）。
 * 客户端校验规则与服务端 parseItem 保持一致（必填、长度、图片协议）。
 */
function renderGenPage() {
  const content = `<div class="page">
<mdui-card variant="elevated"><div class="card-body">
<p class="hint">填写失物信息，点击「生成链接」，将生成的链接发给他人即可展示失物页面。</p>
<div class="form">
<mdui-text-field id="f-name" class="field" variant="outlined" label="物品名称 *" icon="label" required maxlength="${LIMITS.name}" counter clearable></mdui-text-field>
<mdui-text-field id="f-image" class="field" variant="outlined" type="url" label="照片链接" icon="image" placeholder="https://..." helper="仅支持 http/https 图片地址，可留空" maxlength="${LIMITS.image}" clearable></mdui-text-field>
<mdui-text-field id="f-desc" class="field" variant="outlined" label="物品描述" icon="description" rows="3" autosize maxlength="${LIMITS.desc}" counter></mdui-text-field>
<mdui-text-field id="f-contact" class="field" variant="outlined" label="联系方式" icon="contacts" helper="手机号或邮箱，失物页会生成联系按钮，可留空" maxlength="${LIMITS.contact}" clearable></mdui-text-field>
<mdui-text-field id="f-location" class="field" variant="outlined" label="地点" icon="place" helper="填写后失物页会显示「地图导航」按钮，可留空" maxlength="${LIMITS.location}" clearable></mdui-text-field>
<mdui-button variant="filled" icon="link" onclick="generate()">生成链接</mdui-button>
</div>
</div></mdui-card>
<mdui-card variant="outlined"><div class="card-body">
<mdui-tabs value="tab-link" variant="secondary" full-width>
<mdui-tab value="tab-link" icon="link">链接</mdui-tab>
<mdui-tab value="tab-qr" icon="qr_code_2">二维码</mdui-tab>
<mdui-tab value="tab-nfc" icon="nfc">NFC 写入</mdui-tab>

<mdui-tab-panel slot="panel" value="tab-link"><div class="tab-panel-body form">
<mdui-text-field id="f-url" class="field" variant="outlined" label="生成的链接" icon="link" readonly></mdui-text-field>
<div class="actions">
<mdui-button id="btn-copy" variant="text" icon="content_copy" disabled onclick="copyUrl()">复制链接</mdui-button>
<a id="a-preview" class="plain" href="#" target="_blank" rel="noopener noreferrer" onclick="checkPreview(event)"><mdui-button id="btn-preview" variant="text" icon="open_in_new" disabled>预览页面</mdui-button></a>
</div>
</div></mdui-tab-panel>

<mdui-tab-panel slot="panel" value="tab-qr"><div class="tab-panel-body form">
<div class="qr-box"><div id="qr-box" class="qr-empty">生成链接后自动显示二维码</div></div>
<div class="actions">
<mdui-button id="btn-qr-download" variant="text" icon="download" disabled onclick="downloadQrPng()">下载 PNG</mdui-button>
</div>
<p class="hint">移动端也可长按上方二维码直接保存。</p>
</div></mdui-tab-panel>

<mdui-tab-panel slot="panel" value="tab-nfc"><div class="tab-panel-body form">
<p class="hint" id="nfc-support">检测 WebNFC 支持情况…</p>
<mdui-button id="btn-nfc" variant="filled" icon="nfc" disabled onclick="startNfcWrite()">写入链接到 NFC 标签</mdui-button>
<p class="hint" id="nfc-status"></p>
<p class="hint">需要 Chrome / Edge（移动端）并通过 HTTPS 访问。将含失物页链接的标签贴在物品上，拾得者用手机贴近即可打开本页。</p>
</div></mdui-tab-panel>
</mdui-tabs>
</div></mdui-card>
</div>`;

  const limitsJson = JSON.stringify(Object.fromEntries(GEN_FIELDS.map(([, k]) => [k, LIMITS[k]])));
  const fieldsJson = JSON.stringify(GEN_FIELDS);
  const keysJson = JSON.stringify(COMPACT_KEYS);

  // 页面专属 JS。LIMITS/FIELDS 由服务端注入，保证前后端校验单一来源。
  // 注意：模板内的 \\/ 会被转义为 \/，供内联正则 /^https?:\/\// 使用。
  const extraScript = `
const LIMITS = ${limitsJson};
const KEYS = ${keysJson};
const FIELDS = ${fieldsJson};
/** UTF-8 字符串 → base64url（去 padding），结果全为 URL 安全字符，无需再百分号编码 */
function b64url(s) {
  let bin = '';
  new TextEncoder().encode(s).forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}
/** 读取并清洗表单元值 */
function val(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || '').trim() : '';
}
/** 通过 setCustomValidity + reportValidity 在字段下方显示红色错误 */
function markInvalid(id, msg) {
  const el = document.getElementById(id);
  if (!el || !el.setCustomValidity) return;
  el.setCustomValidity(msg || '');
  el.reportValidity();
}
/** 校验表单 → 拼接 /item?... 链接 → 刷新三个选项卡的输出 */
function generate() {
  FIELDS.forEach(([id]) => {
    const el = document.getElementById(id);
    if (el) { el.setCustomValidity(''); el.reportValidity(); }
  });
  let bad = false;
  const name = val('f-name');
  if (!name) { markInvalid('f-name', '物品名称为必填项'); bad = true; }
  for (const [id, key] of FIELDS) {
    if (val(id).length > LIMITS[key]) {
      markInvalid(id, '不能超过 ' + LIMITS[key] + ' 个字符');
      bad = true;
    }
  }
  const image = val('f-image');
  if (image && !/^https?:\\/\\//i.test(image)) {
    markInvalid('f-image', '必须以 http:// 或 https:// 开头');
    bad = true;
  }
  if (bad) { mdui.snackbar({ message: '请先修正表单中的错误' }); return; }
  const vals = {};
  for (const [id, key] of FIELDS) {
    const v = val(id);
    if (v) vals[key] = v;
  }
  // 同时构造「短键明文」与「?d= base64url(JSON)」两种 URL，取更短的一个：
  // 中文多的字段 base64url 更短，纯 ASCII（如 image）则明文更短。
  const origin = location.origin;
  const plain = origin + '/item?' + Object.entries(vals)
    .map(([k, v]) => KEYS[k] + '=' + encodeURIComponent(v)).join('&');
  const compact = {};
  for (const [k, v] of Object.entries(vals)) compact[KEYS[k]] = v;
  const encoded = origin + '/item?d=' + b64url(JSON.stringify(compact));
  const url = plain.length <= encoded.length ? plain : encoded;
  currentUrl = url;
  document.getElementById('f-url').value = url;
  document.getElementById('btn-copy').disabled = false;
  document.getElementById('btn-preview').disabled = false;
  document.getElementById('a-preview').href = url;
  renderQr(url);
  mdui.snackbar({ message: '链接已生成' });
}
function copyUrl() {
  const v = document.getElementById('f-url').value;
  if (!v) { mdui.snackbar({ message: '请先生成链接' }); return; }
  copyText(v, '链接已复制');
}
function checkPreview(e) {
  if (!document.getElementById('f-url').value) {
    e.preventDefault();
    mdui.snackbar({ message: '请先生成链接' });
  }
}
let currentUrl = '';
let currentQr = null;
/** 用 qrcode-generator 生成响应式 SVG 内联渲染（typeNumber=0 自动选版本，纠错级别 M） */
function renderQr(url) {
  const box = document.getElementById('qr-box');
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    currentQr = qr;
    box.className = '';
    box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    document.getElementById('btn-qr-download').disabled = false;
  } catch (err) {
    currentQr = null;
    box.className = 'qr-empty';
    box.textContent = '二维码生成失败：' + err.message;
    document.getElementById('btn-qr-download').disabled = true;
  }
}
/** 逐模块绘制到离屏 canvas 导出 PNG（比序列化 SVG 兼容性更好） */
function downloadQrPng() {
  if (!currentQr) { mdui.snackbar({ message: '请先生成链接' }); return; }
  const n = currentQr.getModuleCount();
  const scale = 10;
  const margin = 4;
  const size = (n + margin * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (currentQr.isDark(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
  }
  const a = document.createElement('a');
  a.download = 'lost-item-qr.png';
  a.href = canvas.toDataURL('image/png');
  a.click();
}
/* ---------- WebNFC：进页面即探测能力，不支持则禁用按钮并说明条件 ---------- */
const nfcStatus = document.getElementById('nfc-status');
let nfcReader = null;
let nfcAbort = null;
if (!('NDEFReader' in window) || !window.isSecureContext) {
  document.getElementById('nfc-support').textContent =
    '当前浏览器或环境不支持 WebNFC（需要 Chrome / Edge 移动端，并通过 HTTPS 访问）。';
} else {
  document.getElementById('nfc-support').textContent = '当前环境支持 WebNFC，生成链接后即可写入。';
  document.getElementById('btn-nfc').disabled = false;
}
/**
 * 写入流程：scan() 必须在点击手势内同步调用（浏览器要求用户激活），
 * 检测到标签（reading 事件）后写入 url 记录（recordType 必须是 'url'，
 * 写成 'uri' 会被 write() 以 NotSupportedError 拒绝），
 * 成功后用 AbortController 停止扫描（abort() 已非标准写法）。
 */
async function startNfcWrite() {
  if (!currentUrl) { mdui.snackbar({ message: '请先生成链接' }); return; }
  try {
    nfcReader = new NDEFReader();
    nfcAbort = new AbortController();
    const scanning = nfcReader.scan({ signal: nfcAbort.signal });
    nfcReader.addEventListener('reading', () => {
      nfcStatus.textContent = '检测到标签，正在写入…';
      nfcReader.write({ records: [{ recordType: 'url', data: currentUrl }] })
        .then(() => {
          nfcStatus.textContent = '写入成功，标签已包含失物页链接。';
          mdui.snackbar({ message: 'NFC 写入成功' });
          if (nfcAbort) nfcAbort.abort();
        })
        .catch((err) => { nfcStatus.textContent = '写入失败：' + err.message; });
    });
    nfcReader.addEventListener('readingerror', () => {
      nfcStatus.textContent = '标签识别失败，请移开后重试。';
    });
    nfcStatus.textContent = '请将手机背面 NFC 区域贴近标签…';
    await scanning;
  } catch (err) {
    nfcStatus.textContent = '无法启动 NFC：' + err.message;
  }
}`;

  return layout('生成失物链接', content, {
    barTitle: '生成失物链接',
    topLeading: BACK_TOP,
    topTrailing: '',
    headExtra: `<script src="${QR_JS}"></script>`,
    extraScript,
  });
}

/** MDUI 风格的错误页（400 / 404 / 405 共用） */
function errorPage(message, status) {
  const titles = { 400: '参数错误', 404: '页面不存在', 405: '不支持的请求方法' };
  const content = `<div class="page"><mdui-card variant="outlined"><div class="error-wrap">
<mdui-icon name="error_outline"></mdui-icon>
<h2>${escapeHtml(titles[status] || '出错了')}</h2>
<p>${escapeHtml(message)}</p>
</div></mdui-card></div>`;
  return layout(titles[status] || '出错了', content, { barTitle: titles[status] || '出错了' });
}

/** 统一 HTML 响应：禁缓存 + 安全响应头 */
function html(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
    },
  });
}

export default {
  fetch(request) {
    const url = new URL(request.url);

    // 页面均为只读，写方法一律 405
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return html(errorPage('仅支持 GET 请求。', 405), 405);
    }
    // /gen 与别名 /generate（含尾斜杠）渲染链接生成页
    if (['/gen', '/gen/', '/generate', '/generate/'].includes(url.pathname)) {
      return html(renderGenPage(), 200);
    }
    // / 与 /item 渲染失物页，其余路径 404
    if (!['/', '/item', '/item/'].includes(url.pathname)) {
      return html(errorPage('未找到该路由。可用路由：/item（失物页，携带参数）、/gen（链接生成页）。', 404), 404);
    }

    // 参数校验失败返回 400 错误页，成功渲染失物页
    const result = parseItem(url.searchParams);
    if (result.errors) {
      return html(errorPage(result.errors.join('；'), 400), 400);
    }
    return html(renderPage(result.item), 200);
  },
};
