/**
 * handwriting/renderer.js
 * 手写签名渲染核心。算法参考 https://github.com/Gsllchb/Handright 的 7-sigma 扰动模型。
 *
 * 暴露：window.Handwriting.renderSignature(name, opts) -> Promise<{blob, dataURL, canvas}>
 */
(function (root) {
  'use strict';

  // ---------- 工具：Box-Muller 正态分布 ----------
  function gauss(mu, sigma) {
    if (!sigma || sigma <= 0) return mu || 0;
    const u1 = Math.random() || 1e-9;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return (mu || 0) + z * sigma;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // ---------- 颜色解析：hex / rgb / rgba → [r, g, b] ----------
  function parseColor(c) {
    if (!c) return [0, 0, 0];
    c = String(c).trim();
    let m = c.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      const h = m[1];
      if (h.length === 3) {
        return [parseInt(h[0]+h[0],16), parseInt(h[1]+h[1],16), parseInt(h[2]+h[2],16)];
      }
      if (h.length === 6 || h.length === 8) {
        return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
      }
    }
    m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) return [parseInt(m[1])|0, parseInt(m[2])|0, parseInt(m[3])|0];
    return [0, 0, 0];
  }

  // ---------- 字体预热（避免首次渲染回退到 fallback 字体） ----------
  async function preloadFont(family, size) {
    if (!document || !document.fonts || !document.fonts.load) return;
    try {
      // 取第一个 family（去掉引号和 fallback）
      const first = String(family).split(',')[0].replace(/['"]/g, '').trim();
      await document.fonts.load(`${size || 80}px "${first}"`);
    } catch (e) { /* ignore */ }
  }

  // ---------- 装饰底线 ----------
  function drawDecoration(ctx, x1, x2, y, cfg) {
    const color = cfg.underlineColor || cfg.color;
    ctx.strokeStyle = color;
    ctx.lineWidth = cfg.underlineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    const len = Math.max(x2 - x1, 10);

    if (cfg.underlineStyle === 'curve') {
      // 波浪曲线 + 尾部小勾
      ctx.moveTo(x1 - 6, y + 2);
      ctx.bezierCurveTo(
        x1 + len * 0.25, y - 8,
        x1 + len * 0.55, y + 6,
        x1 + len * 0.85, y - 2
      );
      ctx.bezierCurveTo(
        x2 + 4, y + 2,
        x2 + 14, y - 4,
        x2 + 24, y + 6
      );
    } else if (cfg.underlineStyle === 'line') {
      // 直线
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
    } else if (cfg.underlineStyle === 'tail') {
      // 长尾笔（书法尾巴）
      ctx.moveTo(x2 - len * 0.30, y - 5);
      ctx.bezierCurveTo(
        x2 - len * 0.05, y - 16,
        x2 + 30,         y + 4,
        x2 + 70,         y - 6
      );
    } else if (cfg.underlineStyle === 'scribble') {
      // 涂鸦短勾
      ctx.moveTo(x1 + len * 0.1, y);
      ctx.bezierCurveTo(
        x1 + len * 0.4, y + 6,
        x1 + len * 0.7, y - 4,
        x2 - 5, y + 2
      );
    }

    ctx.stroke();
  }

  // ---------- 主渲染函数 ----------
  async function renderSignature(name, opts) {
    opts = opts || {};
    const cfg = {
      width:        opts.width        != null ? opts.width        : 500,
      height:       opts.height       != null ? opts.height       : 180,
      background:   opts.background   || '#ffffff',
      transparent:  !!opts.transparent,
      color:        opts.color        || '#0a1a3e',
      fontFamily:   opts.fontFamily   || "'Caveat', cursive",
      fontSize:     opts.fontSize     != null ? opts.fontSize     : 78,

      // 7-sigma 扰动（与 handright 同一语义）
      // inkDepthSigma：墙色向白色偏移的高斯标准差（0～255 灰度）
      fontSizeSigma:      opts.fontSizeSigma      != null ? opts.fontSizeSigma      : 2,
      perturbXSigma:      opts.perturbXSigma      != null ? opts.perturbXSigma      : 3,
      perturbYSigma:      opts.perturbYSigma      != null ? opts.perturbYSigma      : 3,
      perturbThetaSigma:  opts.perturbThetaSigma  != null ? opts.perturbThetaSigma  : 0.05,
      wordSpacingSigma:   opts.wordSpacingSigma   != null ? opts.wordSpacingSigma   : 2,
      inkDepthSigma:      opts.inkDepthSigma      != null ? opts.inkDepthSigma      : 30,

      // 涂改线（与 handright 同语义）
      strikethroughProbability:  opts.strikethroughProbability  != null ? opts.strikethroughProbability  : 0,
      strikethroughLengthSigma:  opts.strikethroughLengthSigma  != null ? opts.strikethroughLengthSigma  : 2,
      strikethroughAngleSigma:   opts.strikethroughAngleSigma   != null ? opts.strikethroughAngleSigma   : 2,
      strikethroughWidthSigma:   opts.strikethroughWidthSigma   != null ? opts.strikethroughWidthSigma   : 2,
      strikethroughWidth:        opts.strikethroughWidth        != null ? opts.strikethroughWidth        : 8,

      // 排版
      rotate:           opts.rotate           != null ? opts.rotate           : 0,
      letterSpacingPx:  opts.letterSpacingPx  != null ? opts.letterSpacingPx  : 0,

      // 装饰
      underline:       opts.underline !== false,
      underlineStyle:  opts.underlineStyle != null ? opts.underlineStyle : 'curve',
      underlineColor:  opts.underlineColor || null,
      underlineWidth:  opts.underlineWidth || 1.8,
      underlineOffset: opts.underlineOffset != null ? opts.underlineOffset : 0.42, // 相对 fontSize 的距离

      // 设备像素比（高 DPI 显示更清晰）
      dpr: opts.dpr != null ? opts.dpr : (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    };

    if (!cfg.underlineStyle) cfg.underline = false;

    // 字体预热
    await preloadFont(cfg.fontFamily, cfg.fontSize);

    const W = cfg.width, H = cfg.height;
    const dpr = Math.max(1, cfg.dpr);

    // 创建 canvas（高 DPR）
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // 背景
    if (!cfg.transparent) {
      ctx.fillStyle = cfg.background;
      ctx.fillRect(0, 0, W, H);
    }

    // 设置基础字体用于测量
    ctx.font = `${cfg.fontSize}px ${cfg.fontFamily}`;
    ctx.textBaseline = 'middle';

    // 字符宽度测量（基于 baseFont）
    const chars = Array.from(name); // 支持 emoji / Unicode
    const charWidths = chars.map(c => ctx.measureText(c).width);
    const totalBaseWidth = charWidths.reduce((a, b) => a + b, 0)
      + cfg.letterSpacingPx * Math.max(0, chars.length - 1);

    // 居中起点
    const startX = (W - totalBaseWidth) / 2;
    const baseY = H / 2;

    // 整体倾斜（绕画布中心）
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(cfg.rotate);
    ctx.translate(-W / 2, -H / 2);

    ctx.fillStyle = cfg.color;
    const baseRGB = parseColor(cfg.color);

    // 逐字符绘制
    let cursorX = startX;
    let firstX = null, lastX = null;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const baseW = charWidths[i];

      // 空白：仅推进光标
      if (/^\s$/.test(ch)) {
        cursorX += baseW + cfg.letterSpacingPx;
        continue;
      }

      // 每字符独立扰动
      const charSize = clamp(
        cfg.fontSize + gauss(0, cfg.fontSizeSigma),
        cfg.fontSize * 0.7,
        cfg.fontSize * 1.3
      );
      const px = gauss(0, cfg.perturbXSigma);
      const py = gauss(0, cfg.perturbYSigma);
      const theta = gauss(0, cfg.perturbThetaSigma);

      // 墙色扰动（handright 语义）：RGB 各通道向白色偏移 |gauss(0, sigma)|
      const inkOffset = Math.abs(gauss(0, cfg.inkDepthSigma));
      const cR = Math.min(255, baseRGB[0] + inkOffset) | 0;
      const cG = Math.min(255, baseRGB[1] + inkOffset) | 0;
      const cB = Math.min(255, baseRGB[2] + inkOffset) | 0;

      // 此字符中心 X 位置（在 baseFont 度量下）
      const cx = cursorX + baseW / 2 + px;
      const cy = baseY + py;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(theta);
      ctx.font = `${charSize}px ${cfg.fontFamily}`;
      ctx.fillStyle = `rgb(${cR}, ${cG}, ${cB})`;
      const actualW = ctx.measureText(ch).width;
      ctx.fillText(ch, -actualW / 2, 0);
      ctx.restore();

      // 涂改线（按概率）
      if (cfg.strikethroughProbability > 0 && Math.random() < cfg.strikethroughProbability) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(theta + gauss(0, cfg.strikethroughAngleSigma * Math.PI / 180));
        ctx.strokeStyle = `rgb(${cR}, ${cG}, ${cB})`;
        ctx.lineWidth = clamp(cfg.strikethroughWidth + gauss(0, cfg.strikethroughWidthSigma), 0.5, 30);
        ctx.lineCap = 'round';
        const len = (actualW + gauss(0, cfg.strikethroughLengthSigma * 5)) * 1.1;
        ctx.beginPath();
        ctx.moveTo(-len / 2, 0);
        ctx.lineTo( len / 2, 0);
        ctx.stroke();
        ctx.restore();
      }

      if (firstX === null) firstX = cursorX;
      lastX = cursorX + baseW;

      // 推进光标（使用 baseW 保持整体节奏，并加字距扰动）
      const wordPerturb = gauss(0, cfg.wordSpacingSigma);
      cursorX += baseW + cfg.letterSpacingPx + wordPerturb;
    }

    // 底部装饰
    if (cfg.underline && cfg.underlineStyle && firstX !== null) {
      const decoY = baseY + cfg.fontSize * cfg.underlineOffset;
      drawDecoration(ctx, firstX, lastX, decoY, cfg);
    }

    ctx.restore();

    // 输出
    const dataURL = canvas.toDataURL('image/png');
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

    return { blob, dataURL, canvas };
  }

  // ---------- 暴露 ----------
  root.Handwriting = root.Handwriting || {};
  root.Handwriting.renderSignature = renderSignature;
  root.Handwriting.preloadFont = preloadFont;
  root.Handwriting._gauss = gauss;
  root.Handwriting._clamp = clamp;

})(typeof window !== 'undefined' ? window : globalThis);
