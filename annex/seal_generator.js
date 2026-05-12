/**
 * annex/seal_generator.js
 * 圆形红色公章生成器（Canvas）。完全离线，无第三方依赖。
 *
 * 风格参照常见 中国公章 / 公司印章 规范：
 *   - 外圈红色描边
 *   - 公司中文名沿圆环顶部弧线绕排（每个字"底部朝圆心"，标准印章字向）
 *   - 中心红色五角星（与外圈同色）
 *   - 透明背景（便于叠加到 PDF 模板上）
 *
 * 暴露：
 *   window.SealGenerator.generate(name, opts)        -> { canvas, dataURL }
 *   window.SealGenerator.generateDataURL(name, opts) -> string
 *   window.SealGenerator.generateBlob(name, opts)    -> Promise<Blob>
 *   window.SealGenerator.generatePngBytes(name, opts)-> Promise<Uint8Array>   // 给 pdf-lib 用
 *
 * 选项默认值与 Image 2 那种"中型公司圆章"一致，可被覆盖；详见 generate() 内注释。
 */
(function (root) {
  'use strict';

  const Seal = root.SealGenerator = root.SealGenerator || {};

  // -------------------------------------------------------------------------
  // 五角星绘制：以 (cx, cy) 为中心，外接半径 R，正上方为一个角的尖端。
  // 内/外半径比 ≈ sin(18°)/sin(54°) ≈ 0.381966，是标准等比五角星的比例。
  // -------------------------------------------------------------------------
  function drawStar(ctx, cx, cy, R, color) {
    const INNER_RATIO = 0.381966;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = (i % 2 === 0) ? R : R * INNER_RATIO;
      // i=0 在正上方（-π/2），每步 +π/5 (36°)
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 沿弧线绕排文字：以 (cx, cy) 为圆心，半径 textRadius 上排布 chars。
  // 字符方向：每个字"底部朝向圆心"（标准印章字向，顶部朝外）。
  // arcSpan 是文字横跨的总弧度；圆周顶部 (θ=π/2 math 约定) 为中线。
  // 数学约定：θ 自 +x 轴逆时针为正；canvas 的 y 轴翻转，所以画到画布时 y 取反。
  // -------------------------------------------------------------------------
  function drawArcText(ctx, chars, cx, cy, textRadius, arcSpan, opts) {
    const n = chars.length;
    if (n === 0) return;

    ctx.save();
    ctx.fillStyle = opts.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${opts.fontBold ? 'bold ' : ''}${opts.fontSize}px ${opts.font}`;

    // 中线在顶部 (math θ = π/2)；从顶部两侧对称展开。
    // 单字情况 step=0，直接放顶部。
    const halfSpan = arcSpan / 2;
    const step = n === 1 ? 0 : arcSpan / (n - 1);

    for (let i = 0; i < n; i++) {
      // 从弧线最左端（顶部往左 halfSpan）开始，向右扫到最右端。
      // 在 math 约定下，"左上" 角度 > π/2，"右上" 角度 < π/2；i 增大 → θ 减小。
      const theta = (Math.PI / 2 + halfSpan) - i * step;

      const px = cx + textRadius * Math.cos(theta);
      const py = cy - textRadius * Math.sin(theta);

      ctx.save();
      ctx.translate(px, py);
      // 字符 "up" 方向 = 径向向外。
      // 顶部 (θ=π/2) 旋转 0；右侧 (θ=0) 顺时针 π/2；左侧 (θ=π) 逆时针 π/2。
      // 线性关系：canvas 顺时针旋转量 = π/2 - θ。
      ctx.rotate(Math.PI / 2 - theta);
      ctx.fillText(chars[i], 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 根据字数自适应计算 弧线跨度（弧度）。
  // 经验值：11 字公司名 ≈ 300°(5π/3) 弧度，每字约 27°。
  //   - 单字最大 90°（避免太空）
  //   - 字数 <=4：每字 36° 左右
  //   - 字数 >=10：固定 300° 左右
  //   - 中间线性插值
  // -------------------------------------------------------------------------
  function autoArcSpan(n) {
    if (n <= 1) return Math.PI / 4;          // 1 个字给 45° 占位即可
    if (n <= 2) return Math.PI / 2;          // 2 字 90°
    // 每字 30°(π/6)，但封顶 300°(5π/3)，下限 120°(2π/3)
    const per = Math.PI / 6;
    const raw = n * per;
    const min = 2 * Math.PI / 3;             // 120°
    const max = 5 * Math.PI / 3;             // 300°
    return Math.min(max, Math.max(min, raw));
  }

  // -------------------------------------------------------------------------
  // 根据字数自适应字号（以画布像素 size 为基准）。
  // 默认目标：单字占外圈周长（在文字所在半径上）的 ~ arcSpan / n 对应弧长，
  // 再乘以一个收缩系数（0.85）让字之间不挤、字底不出环。
  // -------------------------------------------------------------------------
  function autoFontSize(size, ringWidth, ringPadding, n, arcSpan) {
    const R = size / 2 - ringPadding - ringWidth / 2;
    // textRadius = R - fontSize/2 - gap，反过来解 fontSize 比较绕；
    // 直接以"字宽 ≈ R * (arcSpan / n) * 0.85"近似（中文字接近方块）：
    const arcLenPerChar = (R * arcSpan) / Math.max(1, n);
    const target = arcLenPerChar * 0.85;
    // 不能太小也不能太大；与画布尺寸做绑定，保证印章在 400 像素时字 ~ 50px。
    const lo = size * 0.08;
    const hi = size * 0.18;
    return Math.min(hi, Math.max(lo, target));
  }

  // -------------------------------------------------------------------------
  // 主函数：渲染圆章到 canvas。
  // 返回 { canvas, width, height }。dataURL/blob/PngBytes 由便捷方法转换。
  // -------------------------------------------------------------------------
  function render(name, options) {
    const opts = Object.assign({
      size: 400,                          // 画布像素（正方形；输出 PNG 同尺寸）
      color: '#c62828',                   // 章红色（公章常用偏深的朱红/暗红）
      ringWidth: 8,                       // 外圈描边粗细
      ringPadding: 8,                     // 外圈到画布边缘的内边距
      // 图二风格：宋体粗体（横细竖粗，方块字感）。回退到楷体/仿宋系也能凑合。
      font: '"SimSun","宋体","STSong","NSimSun","FangSong","STFangsong","KaiTi","STKaiti",serif',
      fontBold: true,
      // fontSize / arcSpan 留 0 = 自适应：调用方（popup 面板）若未传值，按字数自动算；
      // popup 面板自身的默认值在 popup.html 里独立设为 86px / 300° 与图1一致。
      fontSize: 0,
      arcSpan: 0,
      starRatio: 0.39,                    // 五角星外接半径 / 外圈半径
      textRadiusRatio: 0.8,               // 文字所在半径 / 外圈半径（中线）
    }, options || {});

    const size = opts.size;
    const cx = size / 2;
    const cy = size / 2;
    const ringRadius = size / 2 - opts.ringPadding - opts.ringWidth / 2;

    const chars = Array.from(String(name || '').replace(/\s+/g, ''));
    const n = chars.length;
    const arcSpan = opts.arcSpan || autoArcSpan(n);
    const fontSize = opts.fontSize || autoFontSize(size, opts.ringWidth, opts.ringPadding, n, arcSpan);
    const textRadius = ringRadius * opts.textRadiusRatio;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // 透明背景：什么都不画
    ctx.clearRect(0, 0, size, size);

    // 外圈
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = opts.ringWidth;
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 文字
    if (n > 0) {
      drawArcText(ctx, chars, cx, cy, textRadius, arcSpan, {
        color: opts.color,
        font: opts.font,
        fontSize,
        fontBold: opts.fontBold,
      });
    }

    // 中心五角星
    const starR = ringRadius * opts.starRatio;
    drawStar(ctx, cx, cy, starR, opts.color);

    return { canvas, size, fontSize, arcSpan, ringRadius };
  }

  // -------------------------------------------------------------------------
  // 字体预热：避免首次渲染时浏览器还没加载 FangSong / SimSun 而回退到无衬线字体。
  // 系统字体一般 document.fonts.load 不会真正去加载（已 fallback 就当 ready），
  // 这里只是确保 fontFace 注册过；调用方可以选择 await 或忽略。
  // -------------------------------------------------------------------------
  async function preloadFont(opts) {
    const fontSize = (opts && opts.fontSize) || 80;
    const family = (opts && opts.font) || '"FangSong","STFangsong","SimSun",serif';
    if (!document || !document.fonts || !document.fonts.load) return;
    const families = String(family).split(',').map(f => f.replace(/['"]/g, '').trim()).filter(Boolean);
    await Promise.all(families.map(f =>
      document.fonts.load(`bold ${fontSize}px "${f}"`).catch(() => null)
    ));
  }

  function generate(name, options) {
    const r = render(name, options);
    return {
      canvas: r.canvas,
      dataURL: r.canvas.toDataURL('image/png'),
      size: r.size,
      fontSize: r.fontSize,
      arcSpan: r.arcSpan,
    };
  }

  function generateDataURL(name, options) {
    return generate(name, options).dataURL;
  }

  async function generateBlob(name, options) {
    const { canvas } = generate(name, options);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b); else reject(new Error('PNG 编码失败'));
      }, 'image/png');
    });
  }

  async function generatePngBytes(name, options) {
    const blob = await generateBlob(name, options);
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  }

  Seal.generate = generate;
  Seal.generateDataURL = generateDataURL;
  Seal.generateBlob = generateBlob;
  Seal.generatePngBytes = generatePngBytes;
  Seal.preloadFont = preloadFont;

})(typeof window !== 'undefined' ? window : globalThis);
