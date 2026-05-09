/**
 * handwriting/index.js
 * 统一入口。封装风格 + 自定义参数合并。
 *
 * 暴露：
 *   window.Handwriting.generate(name, opts) -> Promise<{blob, dataURL, canvas}>
 *   window.Handwriting.generateBlob(name, opts) -> Promise<Blob>
 *   window.Handwriting.generateDataURL(name, opts) -> Promise<string>
 *   window.Handwriting.preloadAll() -> Promise<void>  // 预热全部内置字体
 */
(function (root) {
  'use strict';

  const HW = root.Handwriting = root.Handwriting || {};

  /**
   * 生成签名图。
   * @param {string} name 签名内容
   * @param {object} [options] 选项；含 style 字段则继承预设，其它字段覆盖预设
   * @returns {Promise<{blob: Blob, dataURL: string, canvas: HTMLCanvasElement}>}
   */
  async function generate(name, options) {
    options = options || {};
    const styleKey = options.style || 'yunyan_real';
    const preset = (HW.STYLES && HW.STYLES[styleKey]) || (HW.STYLES && HW.STYLES.yunyan_real) || {};

    // preset < user options（user 覆盖 preset；空字符串/null/undefined 不覆盖）
    const opts = {};
    for (const k of Object.keys(preset)) opts[k] = preset[k];
    for (const k of Object.keys(options)) {
      if (k === 'style') continue;
      const v = options[k];
      if (v === undefined || v === null || v === '') continue;
      opts[k] = v;
    }

    return await HW.renderSignature(name, opts);
  }

  async function generateBlob(name, options) {
    const r = await generate(name, options);
    return r.blob;
  }

  async function generateDataURL(name, options) {
    const r = await generate(name, options);
    return r.dataURL;
  }

  /** 预热所有字体（避免首次渲染回退到 fallback） */
  async function preloadAll() {
    if (!document.fonts || !document.fonts.load) return;
    const families = HW.FONT_FAMILIES || [];
    await Promise.all(families.map(f =>
      document.fonts.load(`80px "${f}"`).catch(() => null)
    ));
  }

  /** 生成多张签名（不同随机），用于挑选 */
  async function generateMany(name, options, count) {
    count = count || 4;
    const result = [];
    for (let i = 0; i < count; i++) {
      result.push(await generate(name, options));
    }
    return result;
  }

  HW.generate = generate;
  HW.generateBlob = generateBlob;
  HW.generateDataURL = generateDataURL;
  HW.generateMany = generateMany;
  HW.preloadAll = preloadAll;

})(typeof window !== 'undefined' ? window : globalThis);
