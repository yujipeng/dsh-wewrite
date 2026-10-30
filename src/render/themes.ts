/**
 * 排版主题（架构 §3 render：内联样式 + 主题）。
 * 微信正文禁 style 块——主题以「标签 → 内联 style 串」形态注入渲染层。
 * P0 视觉门禁：纯色平涂，无渐变；无紫粉禁色。
 *
 * 主题清单参考 wechat-article/.wewrite 的 toolkit/themes（sspai / impeccable / ink /
 * newspaper 等），只取纯色版本，避免紫粉渐变（tech-modern 不收录）。
 */

export interface RenderTheme {
  readonly id: string;
  readonly section: string;
  readonly p: string;
  readonly h2: string;
  readonly h3: string;
  readonly strong: string;
  readonly em: string;
  readonly a: string;
  readonly code: string;
  readonly pre: string;
  readonly preCode: string;
  readonly blockquote: string;
  readonly table: string;
  readonly th: string;
  readonly td: string;
  readonly ul: string;
  readonly ol: string;
  readonly li: string;
  readonly hr: string;
  readonly img: string;
  /** I-16：图注样式（图片后的纯斜体说明）。 */
  readonly imgCaption?: string;
  /** I-15：`:::` 容器样式（未覆盖时用默认纯色样式）。 */
  readonly containerSteps?: string;
  readonly containerSummary?: string;
  readonly containerHighlight?: string;
  readonly containerStepNum?: string;
  readonly containerStepText?: string;
}

const BASE_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
const SERIF_FONT = "'Songti SC', 'Noto Serif SC', 'SimSun', Georgia, serif";
const MONO_FONT = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

const professionalClean: RenderTheme = {
  id: 'professional-clean',
  section: `font-family: ${BASE_FONT}; line-height: 1.8; color: #333; font-size: 16px; padding: 0 16px; max-width: 100%; box-sizing: border-box;`,
  p: 'margin: 12px 0; text-align: justify;',
  h2: 'font-size: 19px; font-weight: bold; margin: 22px 0 12px; color: #222;',
  h3: 'font-size: 17px; font-weight: bold; margin: 18px 0 10px; color: #333;',
  strong: 'color: #111; font-weight: 600;',
  em: 'color: #555;',
  a: 'color: #576b95; text-decoration: none; word-break: break-all;',
  code: `background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-family: ${MONO_FONT}; font-size: 14px; color: #c7254e;`,
  pre: 'background: #282c34; color: #abb2bf; padding: 16px; border-radius: 6px; overflow-x: auto; margin: 14px 0; line-height: 1.5;',
  preCode: 'background: none; padding: 0; color: inherit; font-size: 13px; white-space: pre;',
  blockquote: 'border-left: 4px solid #ddd; margin: 14px 0; padding: 8px 16px; color: #666; background: #fafafa;',
  table: 'width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14px;',
  th: 'border: 1px solid #ddd; padding: 8px 12px; text-align: left; background: #f5f5f5; font-weight: 600;',
  td: 'border: 1px solid #ddd; padding: 8px 12px; text-align: left;',
  ul: 'padding-left: 20px; margin: 10px 0;',
  ol: 'padding-left: 20px; margin: 10px 0;',
  li: 'margin: 4px 0;',
  hr: 'border: none; border-top: 1px solid #eee; margin: 20px 0;',
  img: 'max-width: 100%; height: auto; display: block; margin: 16px auto; border-radius: 4px;',
  imgCaption: 'margin: 0 0 16px; text-align: center; font-size: 13px; color: #888; letter-spacing: 0.5px;',
  containerSteps: 'background: #f7f8fa; border-left: 3px solid #576b95; padding: 12px 16px; margin: 16px 0; border-radius: 4px;',
  containerSummary: 'background: #f7f8fa; border: 1px solid #e5e7eb; padding: 14px 16px; margin: 16px 0; border-radius: 6px;',
  containerHighlight: 'background: #fff8e6; border-left: 3px solid #f0b429; padding: 12px 16px; margin: 16px 0; border-radius: 4px;',
  containerStepNum: 'display: inline-flex; width: 20px; height: 20px; border-radius: 10px; background: #576b95; color: #fff; font-size: 12px; align-items: center; justify-content: center; margin-right: 8px; flex: none;',
  containerStepText: 'flex: 1; min-width: 0;',
};

const techDark: RenderTheme = {
  ...professionalClean,
  id: 'tech-dark',
  section: `font-family: ${BASE_FONT}; line-height: 1.8; color: #d7dae0; font-size: 16px; padding: 0 16px; max-width: 100%; box-sizing: border-box; background: #1e222a;`,
  h2: 'font-size: 19px; font-weight: bold; margin: 22px 0 12px; color: #e8eaed;',
  h3: 'font-size: 17px; font-weight: bold; margin: 18px 0 10px; color: #cfd3dc;',
  strong: 'color: #f2f3f5; font-weight: 600;',
  code: `background: #2c313a; padding: 2px 6px; border-radius: 3px; font-family: ${MONO_FONT}; font-size: 14px; color: #98c379;`,
  blockquote: 'border-left: 4px solid #4b5263; margin: 14px 0; padding: 8px 16px; color: #9da5b4; background: #23272f;',
  th: 'border: 1px solid #4b5263; padding: 8px 12px; text-align: left; background: #2c313a; font-weight: 600;',
  td: 'border: 1px solid #4b5263; padding: 8px 12px; text-align: left;',
};

const minimalGray: RenderTheme = {
  ...professionalClean,
  id: 'minimal-gray',
  p: 'margin: 14px 0; text-align: justify; color: #444;',
  h2: 'font-size: 18px; font-weight: bold; margin: 24px 0 12px; color: #111; padding-left: 10px; border-left: 3px solid #999;',
  h3: 'font-size: 16px; font-weight: bold; margin: 18px 0 10px; color: #333;',
  code: `background: #ececec; padding: 2px 5px; border-radius: 2px; font-family: ${MONO_FONT}; font-size: 14px; color: #333;`,
  blockquote: 'border-left: 3px solid #bbb; margin: 14px 0; padding: 6px 14px; color: #777;',
};

/** 纯色主题生成器：只覆盖颜色/字体/标题装饰，排版骨架与 professional-clean 一致。 */
function paletteTheme(input: {
  readonly id: string;
  readonly text: string;
  readonly heading: string;
  readonly accent: string;
  readonly codeBg: string;
  readonly codeColor: string;
  readonly quoteBg: string;
  readonly quoteBorder: string;
  readonly background?: string;
  readonly font?: string;
  readonly lineHeight?: number;
  readonly headingBar?: boolean;
  readonly headingUnderline?: boolean;
}): RenderTheme {
  const font = input.font ?? BASE_FONT;
  const lineHeight = input.lineHeight ?? 1.8;
  const bg = input.background ? ` background: ${input.background};` : '';
  const h2 = input.headingBar
    ? `font-size: 19px; font-weight: bold; margin: 24px 0 12px; color: ${input.heading}; padding-left: 10px; border-left: 3px solid ${input.accent};`
    : input.headingUnderline
      ? `font-size: 19px; font-weight: bold; margin: 24px 0 12px; color: ${input.heading}; padding-bottom: 6px; border-bottom: 1px solid ${input.quoteBorder};`
      : `font-size: 19px; font-weight: bold; margin: 22px 0 12px; color: ${input.heading};`;
  return {
    id: input.id,
    section: `font-family: ${font}; line-height: ${lineHeight}; color: ${input.text}; font-size: 16px; padding: 0 16px; max-width: 100%; box-sizing: border-box;${bg}`,
    p: 'margin: 12px 0; text-align: justify;',
    h2,
    h3: `font-size: 17px; font-weight: bold; margin: 18px 0 10px; color: ${input.heading};`,
    strong: `color: ${input.heading}; font-weight: 600;`,
    em: `color: ${input.text};`,
    a: `color: ${input.accent}; text-decoration: none; word-break: break-all;`,
    code: `background: ${input.codeBg}; padding: 2px 6px; border-radius: 3px; font-family: ${MONO_FONT}; font-size: 14px; color: ${input.codeColor};`,
    pre: 'background: #282c34; color: #abb2bf; padding: 16px; border-radius: 6px; overflow-x: auto; margin: 14px 0; line-height: 1.5;',
    preCode: 'background: none; padding: 0; color: inherit; font-size: 13px; white-space: pre;',
    blockquote: `border-left: 4px solid ${input.quoteBorder}; margin: 14px 0; padding: 8px 16px; color: ${input.text}; background: ${input.quoteBg};`,
    table: 'width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14px;',
    th: `border: 1px solid ${input.quoteBorder}; padding: 8px 12px; text-align: left; background: ${input.quoteBg}; font-weight: 600;`,
    td: `border: 1px solid ${input.quoteBorder}; padding: 8px 12px; text-align: left;`,
    ul: 'padding-left: 20px; margin: 10px 0;',
    ol: 'padding-left: 20px; margin: 10px 0;',
    li: 'margin: 4px 0;',
    hr: `border: none; border-top: 1px solid ${input.quoteBorder}; margin: 20px 0;`,
    img: 'max-width: 100%; height: auto; display: block; margin: 16px auto; border-radius: 4px;',
    imgCaption: `margin: 0 0 16px; text-align: center; font-size: 13px; color: ${input.text}; opacity: 0.7; letter-spacing: 0.5px;`,
    containerSteps: `background: ${input.quoteBg}; border-left: 3px solid ${input.accent}; padding: 12px 16px; margin: 16px 0; border-radius: 4px;`,
    containerSummary: `background: ${input.quoteBg}; border: 1px solid ${input.quoteBorder}; padding: 14px 16px; margin: 16px 0; border-radius: 6px;`,
    containerHighlight: `background: ${input.quoteBg}; border-left: 3px solid ${input.accent}; padding: 12px 16px; margin: 16px 0; border-radius: 4px;`,
    containerStepNum: `display: inline-flex; width: 20px; height: 20px; border-radius: 10px; background: ${input.accent}; color: #fff; font-size: 12px; align-items: center; justify-content: center; margin-right: 8px; flex: none;`,
    containerStepText: 'flex: 1; min-width: 0;',
  };
}

const readerSerif = paletteTheme({
  id: 'reader-serif',
  font: SERIF_FONT,
  lineHeight: 2,
  text: '#2c2416',
  heading: '#1f1a12',
  accent: '#8b4513',
  codeBg: '#f0ebe3',
  codeColor: '#8b4513',
  quoteBg: '#f7f2ea',
  quoteBorder: '#c8b8a0',
  background: '#faf8f4',
  headingUnderline: true,
});

const compactMono = paletteTheme({
  id: 'compact-mono',
  lineHeight: 1.65,
  text: '#3a3a3a',
  heading: '#1a1a1a',
  accent: '#576b95',
  codeBg: '#ececec',
  codeColor: '#333333',
  quoteBg: '#f5f5f5',
  quoteBorder: '#bbbbbb',
  headingBar: true,
});

const sspai = paletteTheme({
  id: 'sspai',
  lineHeight: 1.85,
  text: '#333333',
  heading: '#1a1a1a',
  accent: '#c7372f',
  codeBg: '#f5f2ed',
  codeColor: '#c7372f',
  quoteBg: '#fdf5f4',
  quoteBorder: '#c7372f',
  background: '#fafaf7',
  headingUnderline: true,
});

const impeccable = paletteTheme({
  id: 'impeccable',
  font: SERIF_FONT,
  lineHeight: 1.9,
  text: '#3d4249',
  heading: '#1c2024',
  accent: '#1a6b5a',
  codeBg: '#eef2f0',
  codeColor: '#1a6b5a',
  quoteBg: '#e8f5f0',
  quoteBorder: '#2d9b7e',
  headingBar: true,
});

const ink = paletteTheme({
  id: 'ink',
  font: SERIF_FONT,
  lineHeight: 2,
  text: '#1a1a1a',
  heading: '#1a1a1a',
  accent: '#4a4a4a',
  codeBg: '#f0ebe3',
  codeColor: '#555555',
  quoteBg: '#f4f0e8',
  quoteBorder: '#999999',
  background: '#f8f5f0',
  headingUnderline: true,
});

const newspaper = paletteTheme({
  id: 'newspaper',
  font: 'Georgia, "Songti SC", "SimSun", "Noto Serif SC", serif',
  lineHeight: 1.9,
  text: '#2c2416',
  heading: '#2c2416',
  accent: '#8b4513',
  codeBg: '#ede7db',
  codeColor: '#8b4513',
  quoteBg: '#f0eade',
  quoteBorder: '#8b4513',
  background: '#f5f0e8',
  headingUnderline: true,
});

const github = paletteTheme({
  id: 'github',
  lineHeight: 1.75,
  text: '#1f2328',
  heading: '#1f2328',
  accent: '#0969da',
  codeBg: '#f6f8fa',
  codeColor: '#0550ae',
  quoteBg: '#f6f8fa',
  quoteBorder: '#d0d7de',
  headingUnderline: true,
});

const bytedance = paletteTheme({
  id: 'bytedance',
  lineHeight: 2,
  text: '#1f2329',
  heading: '#1f2329',
  accent: '#1966ff',
  codeBg: '#f5f6f7',
  codeColor: '#1966ff',
  quoteBg: '#f0f5ff',
  quoteBorder: '#1966ff',
  headingBar: true,
});

const warmEditorial = paletteTheme({
  id: 'warm-editorial',
  text: '#333333',
  heading: '#1a1a1a',
  accent: '#d97706',
  codeBg: '#fef3c7',
  codeColor: '#92400e',
  quoteBg: '#fffbeb',
  quoteBorder: '#d97706',
  headingUnderline: true,
});

const elegantRose = paletteTheme({
  id: 'elegant-rose',
  lineHeight: 1.85,
  text: '#3d1f2e',
  heading: '#3d1f2e',
  accent: '#be185d',
  codeBg: '#fce7f3',
  codeColor: '#be185d',
  quoteBg: '#fce7f3',
  quoteBorder: '#be185d',
  background: '#fdf2f8',
});

const midnight = paletteTheme({
  id: 'midnight',
  text: '#e2e8f0',
  heading: '#f1f5f9',
  accent: '#60a5fa',
  codeBg: '#1e293b',
  codeColor: '#7dd3fc',
  quoteBg: '#172040',
  quoteBorder: '#60a5fa',
  background: '#0f172a',
});

const boldNavy = paletteTheme({
  id: 'bold-navy',
  text: '#1a1a2e',
  heading: '#1e3a5f',
  accent: '#1e3a5f',
  codeBg: '#f0f4f8',
  codeColor: '#1e3a5f',
  quoteBg: '#f0f4f8',
  quoteBorder: '#1e3a5f',
  headingBar: true,
});

const minimalGold = paletteTheme({
  id: 'minimal-gold',
  text: '#2a2a2a',
  heading: '#2a2a2a',
  accent: '#b8860b',
  codeBg: '#faf8f3',
  codeColor: '#8b6914',
  quoteBg: '#fdfbf5',
  quoteBorder: '#b8860b',
  headingUnderline: true,
});

const THEMES: Readonly<Record<string, RenderTheme>> = {
  'professional-clean': professionalClean,
  'tech-dark': techDark,
  'minimal-gray': minimalGray,
  'reader-serif': readerSerif,
  'compact-mono': compactMono,
  sspai,
  impeccable,
  ink,
  newspaper,
  github,
  bytedance,
  'warm-editorial': warmEditorial,
  'elegant-rose': elegantRose,
  midnight,
  'bold-navy': boldNavy,
  'minimal-gold': minimalGold,
};

/** 预览主题菜单的统一清单（client 与 render 共用，防止菜单与实现漂移）。 */
export const THEME_OPTIONS: ReadonlyArray<{ id: string; label: string; description: string }> = [
  { id: 'professional-clean', label: '经典蓝', description: '干净专业的企业公众号风格' },
  { id: 'reader-serif', label: '暖宋', description: '衬线正文，暖白底，适合长文阅读' },
  { id: 'compact-mono', label: '紧凑灰', description: '行距紧凑，信息密度高' },
  { id: 'sspai', label: '少数派', description: '暖白底红色点缀，清爽文艺' },
  { id: 'impeccable', label: '青琥珀', description: '深青 + 琥珀，衬线正文，反 AI 味' },
  { id: 'ink', label: '水墨', description: '宣纸底墨色文字，中文衬线，留白疏朗' },
  { id: 'newspaper', label: '报纸', description: '米黄底深棕，适合深度报道与评论' },
  { id: 'github', label: 'GitHub', description: '白底蓝链接，技术文档风格' },
  { id: 'bytedance', label: '品牌蓝', description: '现代无衬线，大间距' },
  { id: 'warm-editorial', label: '暖编辑', description: '暖橙点缀，生活方式与文化内容' },
  { id: 'elegant-rose', label: '玫瑰', description: '浅粉底玫瑰色，温柔精致' },
  { id: 'midnight', label: '午夜', description: '深蓝黑底，适合技术深夜阅读' },
  { id: 'bold-navy', label: '藏青', description: '白底藏青，金融与行业分析' },
  { id: 'minimal-gold', label: '极简金', description: '白底金线点缀，克制高级' },
  { id: 'tech-dark', label: '深色', description: '深灰底，技术内容' },
  { id: 'minimal-gray', label: '极简灰', description: '黑白灰，无色彩干扰' },
];

export const DEFAULT_THEME_ID = 'professional-clean';

/** 未知主题回落默认（接受任意 theme 字符串，产物恒合法）。 */
export function resolveTheme(themeId: string | undefined): RenderTheme {
  return THEMES[themeId ?? ''] ?? professionalClean;
}
