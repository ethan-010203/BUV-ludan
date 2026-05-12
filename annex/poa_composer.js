/**
 * annex/poa_composer.js
 * 委托书（Power of Attorney）合成器：
 *   - 加载 annex/委托书.pdf 模板
 *   - 在模板第 1 页"请在区域内盖章"的红框区中央嵌入 SealGenerator 生成的 PNG 圆章
 *   - 导出新 PDF（Uint8Array / Blob / File）
 *
 * 依赖：
 *   - libs/pdf-lib.min.js   (window.PDFLib)
 *   - annex/seal_generator.js (window.SealGenerator)
 *
 * 暴露：
 *   window.PoaComposer.compose(companyName, opts) -> Promise<{ bytes, blob, file }>
 *   window.PoaComposer.SEAL_BOX_DEFAULT            -> 红框 PDF 坐标默认值（可被 opts.sealBox 覆盖）
 *
 * 坐标系：PDF 原点在左下角，Y 轴向上；A4 = 595.2 × 841.92 pt。
 *        红框估算来自模板截图，可在调用方通过 opts.sealBox 微调。
 */
(function (root) {
  'use strict';

  const Poa = root.PoaComposer = root.PoaComposer || {};

  // 红框中心 / 半径默认值（PDF 坐标，单位：pt）。
  // 估算自模板截图：红框跨度约 page 宽度的 47% ~ 90%，高度方向约 12% ~ 40%（从底算）。
  // 实际生成后若发现章偏移，可在 popup.js 调用处覆盖 sealBox。
  const SEAL_BOX_DEFAULT = {
    // 红框的中心点
    centerX: 408,
    centerY: 219,
    // 章直径（取红框可用空间一半左右，常见公司公章 40mm ≈ 113pt；这里放大到 150pt 更醒目）
    diameter: 150,
    // 章旋转（弧度，正值逆时针；真实盖章常微歪，可设 -0.05 ~ 0.05）
    rotateRad: 0,
    // 透明度（真实印油会让背景文字若隐若现；红框区内是空白虚线框，设 1.0 即可，不需要叠加效果）
    opacity: 1.0,
  };

  // 模板路径（相对插件根目录）。chrome.runtime.getURL 解析为 chrome-extension://xxx/annex/委托书.pdf
  const TEMPLATE_PATH = 'annex/委托书.pdf';

  /**
   * 从插件包加载 annex/委托书.pdf 模板字节。
   * popup 上下文里可直接 fetch chrome.runtime.getURL，无需声明 web_accessible_resources。
   */
  async function loadTemplateBytes() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
      throw new Error('PoaComposer 仅支持在 Chrome 扩展环境运行');
    }
    const url = chrome.runtime.getURL(TEMPLATE_PATH);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`加载委托书模板失败: ${resp.status} ${resp.statusText}`);
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * 合成委托书：模板 + 公司名圆章。
   *
   * @param {string} companyName 公司中文名（用于生成圆章上的弧形文字）
   * @param {object} [options]
   * @param {object} [options.sealBox]    覆盖默认红框坐标（centerX/centerY/diameter/rotateRad/opacity）
   * @param {object} [options.sealOpts]   传给 SealGenerator.generate 的样式参数（color/font/ringWidth 等）
   * @param {number} [options.sealPx=600] 章 PNG 像素分辨率（嵌入 PDF 时按 diameter 缩放，越大越清晰；600 在 150pt 直径下 ≈ 288 dpi）
   * @param {number} [options.pageIndex=0] 在哪一页盖章（A4 模板只有 1 页，默认 0）
   * @param {string} [options.filename='委托书盖章_自动生成.pdf'] 输出文件名
   * @returns {Promise<{ bytes: Uint8Array, blob: Blob, file: File, sealDataURL: string }>}
   */
  async function compose(companyName, options) {
    options = options || {};
    if (!root.PDFLib) throw new Error('PoaComposer: 未加载 pdf-lib（libs/pdf-lib.min.js）');
    if (!root.SealGenerator) throw new Error('PoaComposer: 未加载 SealGenerator（annex/seal_generator.js）');

    const sealBox = Object.assign({}, SEAL_BOX_DEFAULT, options.sealBox || {});
    const sealPx = options.sealPx || 600;
    const pageIndex = options.pageIndex || 0;
    const filename = options.filename || '委托书盖章_自动生成.pdf';

    // 1) 生成圆章 PNG bytes
    const sealOpts = Object.assign({ size: sealPx }, options.sealOpts || {});
    // 字体预热（系统字体一般 fonts.load 也很快返回）
    await root.SealGenerator.preloadFont(sealOpts).catch(() => null);
    const sealPngBytes = await root.SealGenerator.generatePngBytes(companyName, sealOpts);
    // 留一份 dataURL 给调用方做预览（可选）
    const sealDataURL = root.SealGenerator.generateDataURL(companyName, sealOpts);

    // 2) 加载模板 PDF
    const templateBytes = await loadTemplateBytes();
    const { PDFDocument, degrees } = root.PDFLib;
    const pdfDoc = await PDFDocument.load(templateBytes);

    // 3) 嵌入 PNG 并在红框区中央 drawImage
    const png = await pdfDoc.embedPng(sealPngBytes);
    const pages = pdfDoc.getPages();
    if (pageIndex >= pages.length) {
      throw new Error(`PoaComposer: pageIndex=${pageIndex} 超出模板页数（${pages.length}）`);
    }
    const page = pages[pageIndex];

    const d = sealBox.diameter;
    // pdf-lib 的 drawImage 以 (x, y) 为图片左下角；要让中心落在 (centerX, centerY)，
    // 需要把左下角设为 (centerX - d/2, centerY - d/2)。
    page.drawImage(png, {
      x: sealBox.centerX - d / 2,
      y: sealBox.centerY - d / 2,
      width: d,
      height: d,
      opacity: sealBox.opacity,
      // pdf-lib 的 rotate 以图片左下角为旋转中心；若需让中心点为旋转中心，
      // 后续可改为先做坐标变换。目前 rotateRad=0，影响为零。
      rotate: sealBox.rotateRad ? degrees(sealBox.rotateRad * 180 / Math.PI) : undefined,
    });

    // 4) 导出
    const bytes = await pdfDoc.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const file = new File([blob], filename, { type: 'application/pdf' });
    return { bytes, blob, file, sealDataURL };
  }

  Poa.compose = compose;
  Poa.loadTemplateBytes = loadTemplateBytes;
  Poa.SEAL_BOX_DEFAULT = SEAL_BOX_DEFAULT;

})(typeof window !== 'undefined' ? window : globalThis);
