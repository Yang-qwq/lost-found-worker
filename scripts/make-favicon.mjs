/**
 * 生成 public/favicon.ico —— 32x32 蓝色放大镜图标。
 *
 * 手写 ICO 二进制（无图像库依赖），结构：
 *   ICONDIR(6B) + ICONDIRENTRY(16B) + BITMAPINFOHEADER(40B) + XOR 像素(底行在上) + AND 掩码
 *
 * 用法（在仓库根目录）：node scripts/make-favicon.mjs  或  npm run favicon
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const SIZE = 32;
/** RGB 配色：镜圈 / 镜片（半透明）/ 手柄 */
const RING = [21, 101, 192];
const LENS = [187, 222, 251];
const HANDLE = [13, 71, 161];

/** 点到线段 (ax,ay)-(bx,by) 的距离，用于绘制手柄 */
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---- 逐像素绘制（以像素中心为采样点，圆心 (13,13)）----
const rgba = new Uint8Array(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = x + 0.5;
    const cy = y + 0.5;
    const d = Math.hypot(cx - 13, cy - 13);
    let a = 0;
    let rgb = RING;
    if (d >= 6.2 && d <= 9.2) { rgb = RING; a = 255; } // 镜圈圆环
    else if (d < 6.2) { rgb = LENS; a = 60; }          // 镜片半透明填充
    if (distSeg(cx, cy, 19.4, 19.4, 28, 28) <= 2.6) { rgb = HANDLE; a = 255; } // 45° 手柄
    const i = (y * SIZE + x) * 4;
    // BMP 通道顺序为 BGRA
    rgba[i] = rgb[2];
    rgba[i + 1] = rgb[1];
    rgba[i + 2] = rgb[0];
    rgba[i + 3] = a;
  }
}

// ---- 组装 BITMAPINFOHEADER + XOR 位图（BMP 行序自下而上，故需翻转）----
const xorSize = 40 + SIZE * SIZE * 4;
const xor = Buffer.alloc(xorSize);
xor.writeUInt32LE(40, 0);        // biSize
xor.writeInt32LE(SIZE, 4);       // biWidth
xor.writeInt32LE(SIZE * 2, 8);   // biHeight = 图像高 × 2（XOR + AND 两部分，ICO 规范要求）
xor.writeUInt16LE(1, 12);        // biPlanes
xor.writeUInt16LE(32, 14);       // biBitCount
for (let y = 0; y < SIZE; y++) {
  Buffer.from(rgba.buffer, (SIZE - 1 - y) * SIZE * 4, SIZE * 4).copy(xor, 40 + y * SIZE * 4);
}

// AND 掩码：1bpp 每行补齐 4 字节；带 alpha 的图标全 0 即可
const maskBytesPerRow = Math.ceil(SIZE / 32) * 4;
const mask = Buffer.alloc(maskBytesPerRow * SIZE);

// ---- 组装 ICO 容器：ICONDIR + 单项目录 + 图像数据 ----
const image = Buffer.concat([xor, mask]);
const ico = Buffer.alloc(6 + 16 + image.length);
ico.writeUInt16LE(0, 0);          // 保留
ico.writeUInt16LE(1, 2);          // 类型：1 = 图标
ico.writeUInt16LE(1, 4);          // 目录项数量
ico.writeUInt8(SIZE, 6);          // 宽（32 → 直接写 32）
ico.writeUInt8(SIZE, 7);          // 高
ico.writeUInt8(0, 8);             // 调色板颜色数（≥256 记 0）
ico.writeUInt8(0, 9);             // 保留
ico.writeUInt16LE(1, 10);         // 色平面数
ico.writeUInt16LE(32, 12);        // 位深
ico.writeUInt32LE(image.length, 14); // 图像数据长度
ico.writeUInt32LE(22, 18);        // 图像数据偏移 = 6 + 16
image.copy(ico, 22);

mkdirSync('public', { recursive: true });
writeFileSync('public/favicon.ico', ico);
console.log(`public/favicon.ico written: ${ico.length} bytes (${SIZE}x32 32bpp)`);
