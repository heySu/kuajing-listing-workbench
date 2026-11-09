/**
 * listing-image-workbench.html 核心算法自测
 * 运行：node test-image-workbench.js
 * 从 HTML 中抽取 <script id="core"> 在 vm 里执行，保证测的就是交付文件里的真实代码。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const htmlPath = path.join(__dirname, 'listing-image-workbench.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function extractScript(id) {
  const re = new RegExp('<script id="' + id + '">([\\s\\S]*?)<\\/script>');
  const m = html.match(re);
  assert.ok(m, '未找到 <script id="' + id + '">');
  return m[1];
}

const coreSrc = extractScript('core');
// 语法检查（core 与 UI 两层都查，UI 只编译不执行）
new vm.Script(coreSrc, { filename: 'core.js' });
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
scripts.forEach((src, i) => new vm.Script(src, { filename: 'inline-' + i + '.js' }));
assert.strictEqual(scripts.length, 2, '应只有 core 与 UI 两段脚本');

const sandbox = { TextEncoder, console };
const CORE = vm.runInNewContext(coreSrc + '\n;CORE;', sandbox, { filename: 'core.js' });

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('  PASS  ' + name);
}

// ---------- 构造合成图 ----------
const W = 1200, H = 1200;
function build() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const g = 238 + 14 * (x / (W - 1)); // 水平渐变背景：左 238 → 右 252
      data[p] = data[p + 1] = data[p + 2] = g;
      data[p + 3] = 255;
    }
  }
  // 主体：深色矩形 (300,300)-(899,899)
  for (let y = 300; y < 900; y++) for (let x = 300; x < 900; x++) {
    const p = (y * W + x) * 4;
    data[p] = 60; data[p + 1] = 80; data[p + 2] = 70;
  }
  // 右下角"AI 生成"水印：灰块 (1000,1080)-(1179,1179)
  for (let y = 1080; y < 1180; y++) for (let x = 1000; x < 1180; x++) {
    const p = (y * W + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = 150;
  }
  return data;
}
const raw = build();
function lum(data, x, y) {
  const p = (y * W + x) * 4;
  return (data[p] + data[p + 1] + data[p + 2]) / 3;
}
function regionMean(data, x0, y0, x1, y1) {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += lum(data, x, y); n++; }
  return s / n;
}

console.log('\n上架图合规工作台 · 核心算法自测\n');

t('脚本语法检查通过（core + UI 共 2 段）', () => {
  assert.strictEqual(typeof CORE.whiten, 'function');
  assert.strictEqual(typeof CORE.zipStore, 'function');
});

t('UI 层引用的静态 DOM id 全部存在且无重复声明', () => {
  const uiSrc = scripts[1];
  const declared = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const declaredSet = new Set(declared);
  assert.strictEqual(declared.length, declaredSet.size, 'HTML 里不能有重复 id');
  const ids = [...uiSrc.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]);
  const missing = ids.filter((id) => !declaredSet.has(id) && !/^layer\d+$/.test(id));
  assert.deepStrictEqual(missing, [], 'UI 引用了不存在的 id');
});

t('whiten：近白像素被推亮，暗部主体不动', () => {
  const out = CORE.whiten(raw, W, H, 240, 252);
  assert.ok(lum(out, 1199, 100) > lum(raw, 1199, 100) + 1, '右端 252 应被推到接近 255');
  assert.ok(Math.abs(lum(out, 0, 100) - lum(raw, 0, 100)) < 1, '左端 238 低于 lo 不应变化');
  assert.ok(Math.abs(lum(out, 500, 500) - lum(raw, 500, 500)) < 1, '深色主体不应被洗白');
  assert.strictEqual(out.length, raw.length);
});

t('flatField：消除整幅水平渐变，保留主体', () => {
  const before = lum(raw, 0, 100) - lum(raw, 1199, 100);
  const out = CORE.flatField(raw, W, H, 90);
  const after = Math.abs(lum(out, 20, 100) - lum(out, 1180, 100));
  assert.ok(Math.abs(before) > 10, '合成图确实存在渐变');
  assert.ok(after < Math.abs(before) * 0.3, '左右背景差应缩小到原来的 30% 以下：before=' + before + ' after=' + after);
  assert.ok(lum(out, 20, 100) > 245, '校正后背景应接近纯白');
  assert.ok(lum(out, 500, 500) < 120, '主体仍应保持深色');
});

t('contentBBox：水印会把包围盒撑大（复现真实坑）', () => {
  const b = CORE.contentBBox(raw, W, H, 238);
  assert.deepStrictEqual([b.x0, b.y0], [300, 300]);
  assert.ok(b.x1 > 1100 && b.y1 > 1100, '右下角水印被算进主体，说明上架前必须清掉');
});

t('patchVertical：羽化插值清除平滑背景上的水印', () => {
  const box = { x0: 1000, y0: 1080, x1: 1180, y1: 1180 };
  const out = CORE.patchVertical(raw, W, H, box, 8, 12);
  const patched = regionMean(out, 1040, 1110, 1140, 1150);
  const around = regionMean(out, 1040, 1000, 1140, 1050);
  assert.ok(patched > 225, '水印区应被背景色填充，实测 ' + patched.toFixed(1));
  assert.ok(Math.abs(patched - around) < 12, '补丁与周边背景色差应很小，实测 ' + Math.abs(patched - around).toFixed(1));
  assert.ok(Math.abs(lum(out, 500, 500) - lum(raw, 500, 500)) < 1, '选区外像素不应被改动');
});

t('patch 后包围盒回到主体真实范围', () => {
  const box = { x0: 1000, y0: 1080, x1: 1180, y1: 1180 };
  const cleaned = CORE.patchVertical(raw, W, H, box, 8, 12);
  const b = CORE.contentBBox(cleaned, W, H, 238);
  assert.deepStrictEqual([b.x0, b.y0, b.x1, b.y1], [300, 300, 899, 899]);
});

t('cornerStats：右下角纯度低于右上；渐变底图左上本就不算纯白', () => {
  const cs = CORE.cornerStats(raw, W, H, 96);
  assert.ok(cs[3].whiteRatio < 0.5, '右下角有水印，纯白占比应明显下降，实测 ' + cs[3].whiteRatio.toFixed(3));
  assert.ok(cs[1].whiteRatio > cs[0].whiteRatio, '水平渐变下右上更亮');
  // 渐变底图左上 min<245，正是 checkImage 中 background 告警要提示的情况
  assert.ok(cs[0].whiteRatio < 0.5);
});

t('watermarkSuspect：渐变底图上水印仍能被检出（左侧同高度对照）', () => {
  const wm = CORE.watermarkSuspect(raw, W, H);
  assert.ok(wm.density > 0.2, '右下密度实测 ' + wm.density.toFixed(3));
  assert.ok(wm.leftDensity < 0.01, '左侧对照区不应命中暗像素，实测 ' + wm.leftDensity.toFixed(3));
  assert.ok(wm.density > wm.leftDensity + 0.1, '对照差应显著，避免渐变背景把水印抵消掉');
});

t('checkImage：水印告警 + 尺寸通过 + 水印撑大包围盒会连带触发贴边告警', () => {
  const r = CORE.checkImage(raw, W, H, { target: 1200 });
  const byCode = Object.fromEntries(r.items.map((i) => [i.code, i.level]));
  assert.strictEqual(byCode.size, 'pass');
  assert.strictEqual(byCode.ratio, 'pass');
  assert.strictEqual(byCode.watermark, 'warn');
  assert.strictEqual(byCode.margin, 'warn', '水印被算进主体后边距只剩 1.7%，应告警');
  assert.ok(r.items.length >= 6);
  assert.ok(r.counts.warn >= 2, '渐变背景 + 水印 + 贴边至少 3 条告警');
});

t('checkImage：清掉水印后水印/边距告警同时消失', () => {
  const cleaned = CORE.patchVertical(raw, W, H, { x0: 1000, y0: 1080, x1: 1180, y1: 1180 }, 8, 12);
  const r = CORE.checkImage(cleaned, W, H, { target: 1200 });
  const byCode = Object.fromEntries(r.items.map((i) => [i.code, i.level]));
  assert.strictEqual(byCode.watermark, 'pass');
  assert.strictEqual(byCode.margin, 'pass');
});

t('checkImage：非 1200 方图给出尺寸告警', () => {
  const small = new Uint8ClampedArray(600 * 400 * 4).fill(255);
  const r = CORE.checkImage(small, 600, 400, { target: 1200 });
  const byCode = Object.fromEntries(r.items.map((i) => [i.code, i.level]));
  assert.strictEqual(byCode.size, 'warn');
  assert.strictEqual(byCode.ratio, 'warn');
  assert.strictEqual(byCode.bbox, 'warn', '全白图应提示未检出主体');
});

t('geometryScore：同图为 1，结构改动后显著下降', () => {
  assert.ok(CORE.geometryScore(raw, W, H, raw, W, H) > 0.999);
  const changed = new Uint8ClampedArray(raw);
  // 把主体右半整个抹掉，模拟"格数/部件被 AI 改掉"
  for (let y = 300; y < 900; y++) for (let x = 600; x < 900; x++) {
    const p = (y * W + x) * 4;
    changed[p] = changed[p + 1] = changed[p + 2] = 250;
  }
  const s = CORE.geometryScore(raw, W, H, changed, W, H);
  assert.ok(s < 0.95 && s > 0, '相似度应明显下降但不为 0，实测 ' + s.toFixed(3));
});

t('crc32：与标准测试向量一致', () => {
  assert.strictEqual(CORE.crc32(Buffer.from('123456789')), 0xCBF43926);
});

t('zipStore：生成合法 store 模式 ZIP（含中文文件名）', () => {
  const a = new Uint8Array([1, 2, 3, 4]), b = new Uint8Array([9, 8, 7]);
  const zip = CORE.zipStore([{ name: '主图.png', bytes: a }, { name: 'b.png', bytes: b }]);
  const dv = new DataView(zip.buffer);
  // 第一个 local header
  assert.strictEqual(dv.getUint32(0, true), 0x04034b50);
  assert.strictEqual(dv.getUint16(8, true), 0, 'method = store');
  assert.strictEqual(dv.getUint16(6, true) & 0x0800, 0x0800, 'UTF-8 文件名标志位');
  // 末尾 EOCD
  const eocd = zip.length - 22;
  assert.strictEqual(dv.getUint32(eocd, true), 0x06054b50);
  assert.strictEqual(dv.getUint16(eocd + 8, true), 2, 'entry count = 2');
  assert.strictEqual(dv.getUint16(eocd + 10, true), 2);
  const cdOffset = dv.getUint32(eocd + 16, true);
  assert.strictEqual(dv.getUint32(cdOffset, true), 0x02014b50, 'central directory 起始签名');
  assert.ok(zip.length > 30, 'ZIP 非空');
});

console.log('\n' + passed + '/' + passed + ' 项通过\n');
