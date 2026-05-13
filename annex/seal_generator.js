/**
 * annex/seal_generator.js
 * 圆形公章生成器（Canvas）。完全离线，无第三方依赖。支持 两种风格：
 *
 *   style: "mainland"  （默认 · 大陆公章风）
 *     - 外圈红色描边
 *     - 公司中文名沿圆环顶部弧线绕排（每个字"底部朝圆心"，标准印章字向）
 *     - 中心红色五角星（与外圈同色）
 *
 *   style: "hk"        （香港公章风，对应法国|香港组合的委托书盖章）
 *     - 外圈深蓝色描边
 *     - 公司英文名沿外圈顶部弧线绕排（serif 字体，"HONG KONG XXX CO., LIMITED"）
 *     - 公司中文名在中心，多行方块布局，每行水平居中（如：香港 / XXX / 有限公司）
 *       中文名为空时，中心区域留空，仅显示外圈英文 + 底部小星
 *     - 底部一颗小五角星（不在中心；中心让位给中文名块）
 *
 * 共用：透明背景（便于叠加到 PDF 模板上）
 *
 * 暴露：
 *   window.SealGenerator.generate(name, opts)        -> { canvas, dataURL }
 *   window.SealGenerator.generateDataURL(name, opts) -> string
 *   window.SealGenerator.generateBlob(name, opts)    -> Promise<Blob>
 *   window.SealGenerator.generatePngBytes(name, opts)-> Promise<Uint8Array>   // 给 pdf-lib 用
 *
 * HK 模式调用约定（保持 API 形状不变）：
 *   - 第 1 个参数 `name` 仍是 公司中文名（中心方块；可为空字符串）
 *   - 英文名通过 `opts.englishName` 传入
 *   - `opts.style = "hk"` 触发分支
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
  // HK 风格中心中文方块布局：按 "香港 / XXX / 有限公司" 这种自然语义切行。
  // 返回 [[char,...], ...]，每个子数组是一行字符。
  //
  // 切行规则（经验值，匹配用户提供的三张 HK 章图）：
  //   1) 若以 "香港" 开头 → 单独成第一行（地名前缀习惯独占一行）
  //   2) 若以 公司后缀（"有限公司" / "股份有限公司" / "集团有限公司" / "股份公司" / "公司" 等）
  //      结尾 → 整段后缀独占最后一行
  //   3) 中间段按 ≤5 字/行（少于等于 5 不拆）、≤8 字 / 拆 2 行、超过 8 字按 ceil(N/4) 行
  //      均分。最大化"行宽接近"以贴近真实印章的方块感。
  //
  // 没匹配到前缀/后缀也能跑：直接对全部字符走步骤 3。
  // -------------------------------------------------------------------------
  function layoutCenterLines(name) {
    const trimmed = String(name || '').trim().replace(/\s+/g, '');
    if (!trimmed) return [];

    const lines = [];
    let s = trimmed;

    // 1) 香港 前缀 → 独占一行
    if (/^香港/.test(s)) {
      lines.push(Array.from('香港'));
      s = s.slice(2);
    }

    // 2) 公司后缀 → 暂存到 suffixLine，最后追加
    // 长后缀优先匹配（"股份有限公司" 比 "有限公司" 优先）
    const SUFFIXES = ['股份有限公司', '集团有限公司', '有限合伙企业', '有限公司', '股份公司', '集团', '公司'];
    let suffixLine = null;
    for (const suf of SUFFIXES) {
      if (s.endsWith(suf)) {
        suffixLine = Array.from(suf);
        s = s.slice(0, -suf.length);
        break;
      }
    }

    // 3) 中间段均分
    const midChars = Array.from(s);
    const midLen = midChars.length;
    if (midLen > 0) {
      let midLines;
      if (midLen <= 5) midLines = 1;
      else if (midLen <= 8) midLines = 2;
      else midLines = Math.ceil(midLen / 4);

      const perLine = Math.ceil(midLen / midLines);
      for (let i = 0; i < midLen; i += perLine) {
        lines.push(midChars.slice(i, i + perLine));
      }
    }

    if (suffixLine) lines.push(suffixLine);

    return lines;
  }

  // -------------------------------------------------------------------------
  // 在 (cx, cy) 周围一个内接圆（半径 innerR）内绘制 多行中文方块。
  //   - 每一行水平居中
  //   - 行间距 = fontSize（即字与字、行与行的"格子"基本同尺寸，方块感）
  //   - fontSize 自适应：使 rows × maxCols 的字符矩阵能完整放进 innerR 圆内
  //     （以矩形对角线 ≤ 2*innerR 估算，留 0.95 倍 padding）
  //   - opts.fontSize > 0 时直接采用，跳过自适应
  //   - opts.explicitLines（数组，每串=一行）若给出，跳过 layoutCenterLines 自动拆分
  // -------------------------------------------------------------------------
  function drawCenterTextBlock(ctx, name, cx, cy, innerR, opts) {
    const lines = (opts.explicitLines && opts.explicitLines.length > 0)
      ? opts.explicitLines
      : layoutCenterLines(name);
    if (lines.length === 0) return;

    const rows = lines.length;
    const maxCols = Math.max(...lines.map((l) => l.length));

    // 自适应字号：让 rows × maxCols 的方块（按字号当单元尺寸）刚好放进 2*innerR 圆
    // 对角线公式：sqrt(maxCols² + rows²) * fontSize ≤ 2 * innerR
    let fontSize = (2 * innerR / Math.sqrt(maxCols * maxCols + rows * rows)) * 0.95;
    if (opts.fontSize && opts.fontSize > 0) fontSize = opts.fontSize;

    ctx.save();
    ctx.fillStyle = opts.color;
    ctx.font = `${opts.fontBold ? 'bold ' : ''}${Math.round(fontSize)}px ${opts.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 行垂直布局：第 i 行 中心 y = cy + (i - (rows-1)/2) * fontSize
    for (let i = 0; i < rows; i++) {
      const lineChars = lines[i];
      const numInLine = lineChars.length;
      const yi = cy + (i - (rows - 1) / 2) * fontSize;
      // 同一行字水平居中，字间距 = fontSize（方块网格）
      for (let j = 0; j < numInLine; j++) {
        const xi = cx + (j - (numInLine - 1) / 2) * fontSize;
        ctx.fillText(lineChars[j], xi, yi);
      }
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // HK 风格主渲染。返回 { canvas, size, ringRadius }。
  // 与 render()（mainland）的差异：
  //   - 外圈 / 次外圈 / 内圈 三同心圆（粗细可调）
  //   - 外圈顶部绕排 英文公司名（serif 粗体）
  //   - 中心中文多行方块：
  //       - 默认按 layoutCenterLines 自动拆分 (香港/XXX/有限公司)
  //       - 若传 opts.centerLines = [ "香港", "某某印章", "有限公司", "样式章" ]，
  //         则按用户逐行输入渲染（image 2 面板：中心 4 个输入框 = 4 行）
  //   - 底部一行文本 / 字符（opts.bottomText，默认 "*"，可改为 "★"、"专用章"）
  //     底部文本用独立字号 opts.bottomFontSize 控制
  // -------------------------------------------------------------------------
  function renderHK(chineseName, englishName, options) {
    const opts = Object.assign({
      size: 400,
      color: 'rgba(51,51,102,1)',                                      // HK 章默认深蓝紫（#333366）
      // 三同心圆粗细：外 / 次外 / 内（默认以用户给的样式参考图为准：17 / 8 / 8）
      ringWidth: 17,
      secondaryRingWidth: 8,
      innerRingWidth: 8,
      secondaryRingGap: 10,                                             // 外圈与次外圈的"视觉空白"宽度
      innerRingRatio: 0.62,                                             // 内圈半径 / 外圈半径
      ringPadding: 8,
      // 中心中文（沿用通用 font/fontBold/fontSize 字段，便于复用 popup 面板控件）
      font: '"SimSun","宋体","STSong","NSimSun","FangSong","STFangsong","KaiTi","STKaiti",serif',
      fontBold: true,
      fontSize: 0,
      centerLines: null,                                                // 按行输入；数组 = 覆盖自动拆分
      // 外圈英文（独立字段：HK 章特有，与 mainland 字段不冲突）
      // 默认与中心中文一样用 宋体（SimSun），且不加粗 —— 与用户提供的样式参考图一致
      enFont: '"SimSun","宋体","STSong","NSimSun",serif',
      enFontBold: false,
      enFontSize: 0,
      // 外圈弧线参数（沿用通用 arcSpan/textRadiusRatio 字段）
      arcSpan: 0,
      textRadiusRatio: 0.79,                                            // 弧文半径 / 外圈半径
      // 中心中文方块内接圆半径 / 外圈半径（内圈里）
      centerInnerRatio: 0.52,
      // 中心方块整体往上偏移 (×ringRadius)，给底部文本让出空间
      centerYOffsetRatio: -0.08,
      // 底部文本（默认单个 "*"；可改为 "★"、"专用章" 等）
      bottomText: '*',
      bottomFontSize: 0,                                                // 0 = 由面板/readPoaSealParams 覆盖；renderHK 层级用 size*0.12 兜底
      bottomOffsetRatio: 0.78,                                          // 底部文本中心 y / 外圈半径
    }, options || {});

    const size = opts.size;
    const cx = size / 2;
    const cy = size / 2;
    const ringRadius = size / 2 - opts.ringPadding - opts.ringWidth / 2;
    // secondaryRingGap 现在表示"两条线之间的视觉空白宽度"（外圈内缘 → 次外圈外缘的距离），
    // 而非圆心距 —— 这样不管两条线粗细如何变化，视觉间距都恒定。
    // 公式：外圈内缘半径 = ringRadius - ringWidth/2
    //       次外圈外缘半径 = secondaryRadius + secondaryRingWidth/2
    //       期望：(ringRadius - ringWidth/2) - (secondaryRadius + secondaryRingWidth/2) = gap
    const secondaryRadius = ringRadius - opts.ringWidth / 2 - opts.secondaryRingGap - opts.secondaryRingWidth / 2;
    const innerRadius = ringRadius * opts.innerRingRatio;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);

    // 1) 三同心圆
    ctx.save();
    ctx.strokeStyle = opts.color;
    // 外圈
    ctx.lineWidth = opts.ringWidth;
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    // 次外圈
    if (opts.secondaryRingWidth > 0 && secondaryRadius > 0) {
      ctx.lineWidth = opts.secondaryRingWidth;
      ctx.beginPath();
      ctx.arc(cx, cy, secondaryRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 内圈（围中心中文方块）
    if (opts.innerRingWidth > 0 && innerRadius > 0) {
      ctx.lineWidth = opts.innerRingWidth;
      ctx.beginPath();
      ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // 2) 外圈与次外圈之间：英文弧文
    const enChars = Array.from(String(englishName || '').trim());
    if (enChars.length > 0) {
      const arcSpan = opts.arcSpan || autoArcSpan(enChars.length);
      const enFontSize = opts.enFontSize || autoFontSize(
        size, opts.ringWidth, opts.ringPadding, enChars.length, arcSpan
      );
      // 弧文半径：默认在外圈和次外圈中间偏外
      const textRadius = ringRadius * opts.textRadiusRatio;
      drawArcText(ctx, enChars, cx, cy, textRadius, arcSpan, {
        color: opts.color,
        font: opts.enFont,
        fontSize: enFontSize,
        fontBold: opts.enFontBold,
      });
    }

    // 3) 内圈之内：中心中文方块
    const hasExplicitLines = Array.isArray(opts.centerLines) && opts.centerLines.length > 0;
    if (hasExplicitLines || String(chineseName || '').trim()) {
      const innerR = ringRadius * opts.centerInnerRatio;
      const yOff = ringRadius * opts.centerYOffsetRatio;
      let explicitLines = null;
      if (hasExplicitLines) {
        // 把用户每行输入拆成字符数组；空行忽略（image 2 第 4 行可能为空）
        explicitLines = opts.centerLines
          .map((s) => String(s || '').trim())
          .filter((s) => s.length > 0)
          .map((s) => Array.from(s));
      }
      drawCenterTextBlock(ctx, chineseName, cx, cy + yOff, innerR, {
        color: opts.color,
        font: opts.font,
        fontBold: opts.fontBold,
        fontSize: opts.fontSize,
        explicitLines,
      });
    }

    // 4) 底部文本（"*" / "★" / 等）
    const bottomText = String(opts.bottomText || '').trim();
    if (bottomText) {
      const bFontSize = opts.bottomFontSize > 0 ? opts.bottomFontSize : size * 0.12;
      const by = cy + ringRadius * opts.bottomOffsetRatio;
      ctx.save();
      ctx.fillStyle = opts.color;
      ctx.font = `${opts.fontBold ? 'bold ' : ''}${Math.round(bFontSize)}px ${opts.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(bottomText, cx, by);
      ctx.restore();
    }

    return { canvas, size, ringRadius };
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
    options = options || {};
    // HK 分支：name = 中文公司名（可空，留空中心），英文名走 options.englishName。
    // 这样保持 generate(name, opts) 单一入口，调用方/PoaComposer 只需在 sealOpts 里多塞
    // style + englishName 两个字段就能切到 HK 样式，不必拆分新 API。
    if (options.style === 'hk') {
      const r = renderHK(name, options.englishName, options);
      return {
        canvas: r.canvas,
        dataURL: r.canvas.toDataURL('image/png'),
        size: r.size,
      };
    }
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
