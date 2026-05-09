/**
 * handwriting/styles.js
 * 风格预设。所有字段都是 renderer.js 的 opts 子集。
 * 暴露：window.Handwriting.STYLES, window.Handwriting.GOOGLE_FONTS_URL
 */
(function (root) {
  'use strict';

  const STYLES = {
    // ★★★★★ 真·云烟体 ★★★★★
    // 字体由 fonts/yunyan-data.js 自注入（已 base64 内嵌，可直接 file:// 双击打开页面）
    yunyan_real: {
      name: '★ 真·云烟体（已内嵌）',
      desc: '原 handwriting-web 项目同款 云烟体 · 截图原参数 · base64 内嵌无需服务器',
      fontFamily: "'YunYan', 'Ma Shan Zheng', cursive",
      fontSize: 70,
      color: '#000000',
      rotate: 0,
      perturbXSigma: 3,
      perturbYSigma: 3,
      perturbThetaSigma: 0.05,
      fontSizeSigma: 2,
      wordSpacingSigma: 2,
      inkDepthSigma: 30,
      letterSpacingPx: 1,
      underline: false,
      underlineStyle: '',
      strikethroughProbability: 0.005,
      strikethroughLengthSigma: 2,
      strikethroughAngleSigma: 2,
      strikethroughWidthSigma: 2,
      strikethroughWidth: 8
    },

    handright_thin: {
      name: 'Handright · Reenie Beanie',
      desc: '同参数，换成 Reenie Beanie · 细笔随手写',
      fontFamily: "'Reenie Beanie', cursive",
      fontSize: 110,
      color: '#000000',
      rotate: 0,
      perturbXSigma: 3,
      perturbYSigma: 3,
      perturbThetaSigma: 0.05,
      fontSizeSigma: 2,
      wordSpacingSigma: 2,
      inkDepthSigma: 30,
      letterSpacingPx: 1,
      underline: false,
      underlineStyle: '',
      strikethroughProbability: 0.005,
      strikethroughLengthSigma: 2,
      strikethroughAngleSigma: 2,
      strikethroughWidthSigma: 2,
      strikethroughWidth: 8
    },

    // 印度风手写
    kalam: {
      name: '简洁笔记',
      desc: 'Kalam 朴素印度手写体',
      fontFamily: "'Kalam', cursive",
      fontSize: 80,
      color: '#0a0a0a',
      rotate: 0,
      perturbXSigma: 2.5,
      perturbYSigma: 2.5,
      perturbThetaSigma: 0.04,
      fontSizeSigma: 2.5,
      wordSpacingSigma: 2,
      inkDepthSigma: 28,
      underline: false,
      underlineStyle: ''
    }
  };

  // Google Fonts URL（只含 styles 实际用到的字体）
  const GOOGLE_FONTS_URL = 'https://fonts.googleapis.com/css2?'
    + [
      'family=Kalam:wght@300;400;700',
      'family=Reenie+Beanie',
      'family=Ma+Shan+Zheng'
    ].join('&')
    + '&display=swap';

  // 字体名列表（用于预加载）
  const FONT_FAMILIES = [
    'Kalam', 'Reenie Beanie', 'Ma Shan Zheng'
  ];

  root.Handwriting = root.Handwriting || {};
  root.Handwriting.STYLES = STYLES;
  root.Handwriting.GOOGLE_FONTS_URL = GOOGLE_FONTS_URL;
  root.Handwriting.FONT_FAMILIES = FONT_FAMILIES;

})(typeof window !== 'undefined' ? window : globalThis);
