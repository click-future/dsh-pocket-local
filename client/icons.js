// 线性图标集（本地补丁）：替代原先散落在界面与词典里的 emoji。
//
// 为什么换成 SVG：emoji 在不同平台/字体下字形不一，在深色主题里是固定彩色，
// 与 DSH 界面那套灰色线性图标不是一套视觉语言，且无法跟随文字颜色变化。
// 这里统一用 20×20 viewBox、stroke=currentColor、圆头圆角的线性风格，
// 尺寸由调用方决定（顶栏 16、正文 14~15），因此能贴合各处排版。
import { createElement as h } from 'react';

/** 图标路径表。全部按 20×20 网格绘制，坐标为整数以免半像素发虚。 */
const PATHS = {
  // 手机 / 移动端
  phone: 'M7 2.75h6a1.25 1.25 0 0 1 1.25 1.25v12a1.25 1.25 0 0 1-1.25 1.25H7A1.25 1.25 0 0 1 5.75 16V4A1.25 1.25 0 0 1 7 2.75ZM9.25 14.4h1.5',
  // 锁（关闭 / 受保护）
  lock: 'M6.75 8.75h6.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1ZM7.75 8.75V6.5a2.25 2.25 0 0 1 4.5 0v2.25M10 11.5v2',
  // 开锁（密码已关闭）
  unlock: 'M6.75 8.75h6.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1ZM7.75 8.75V6.5a2.25 2.25 0 0 1 4.5 0',
  // 警告（三角 + 感叹号）
  warn: 'M10 3.4 17.2 15.6a1 1 0 0 1-.86 1.5H3.66a1 1 0 0 1-.86-1.5ZM10 8.2v3.4M10 14.1h.01',
  // 清理（扫帚）
  broom: 'M12.6 3.4l3.9 3.9-5.4 5.4-3.9-3.9ZM7.2 8.8l3.9 3.9-2.6 2.6c-.5.5-1.3.6-1.9.1l-2.1-2.1a1.3 1.3 0 0 1 .1-1.9ZM3.6 16.4h5.2',
  // 无线（局域网）
  wifi: 'M3.4 8.2a10 10 0 0 1 13.2 0M6 11.1a6.2 6.2 0 0 1 8 0M8.5 13.9a2.6 2.6 0 0 1 3 0M10 16.8h.01',
  // 地球（公网）
  globe: 'M10 2.9a7.1 7.1 0 1 0 0 14.2 7.1 7.1 0 0 0 0-14.2ZM2.9 10h14.2M10 2.9c1.9 2 2.9 4.5 2.9 7.1s-1 5.1-2.9 7.1c-1.9-2-2.9-4.5-2.9-7.1s1-5.1 2.9-7.1Z',
  // 刷新 / 重启
  refresh: 'M16.4 10a6.4 6.4 0 1 1-1.9-4.5M16.6 3.2v3.4h-3.4',
  // 成功
  check: 'M4.6 10.4l3.5 3.5 7.3-7.3',
  // 失败
  cross: 'M5.6 5.6l8.8 8.8M14.4 5.6l-8.8 8.8',
  // 进行中（沙漏）
  hourglass: 'M6.2 3.2h7.6M6.2 16.8h7.6M7.2 3.2v3.1c0 1.5 1.2 2.6 2.8 3.7 1.6-1.1 2.8-2.2 2.8-3.7V3.2M7.2 16.8v-3.1c0-1.5 1.2-2.6 2.8-3.7 1.6 1.1 2.8 2.2 2.8 3.7v3.1',
  // 更新包
  package: 'M10 2.9l6.2 3.4v7.4L10 17.1 3.8 13.7V6.3ZM3.8 6.3 10 9.7l6.2-3.4M10 9.7v7.4',
  // 反馈（聊天气泡 + 三点）
  feedback: 'M3.4 5.6a1.8 1.8 0 0 1 1.8-1.8h9.6a1.8 1.8 0 0 1 1.8 1.8v6a1.8 1.8 0 0 1-1.8 1.8H8.6L4.6 16.6v-3.2H5.2a1.8 1.8 0 0 1-1.8-1.8ZM7.6 9.1h.01M10 9.1h.01M12.4 9.1h.01',
};

/**
 * 线性图标。
 * @param {object} props
 * @param {keyof typeof PATHS} props.name 图标名
 * @param {number} [props.size=15] 边长（px）
 * @param {number} [props.strokeWidth=1.5]
 * @param {string} [props.color] 覆盖颜色；默认 currentColor（跟随文字）
 */
export function Icon({ name, size = 15, strokeWidth = 1.5, color, style }) {
  const d = PATHS[name];
  if (!d) return null;
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: color ?? 'currentColor',
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    style: { display: 'inline-block', verticalAlign: '-0.15em', flexShrink: 0, ...style },
  }, h('path', { d }));
}

/**
 * 图标 + 文字的紧凑组合，用于替代「emoji 前缀 + 文本」的写法。
 * 图标自带一点右边距，并整体 inline-flex 对齐，避免与文字基线错位。
 */
export function IconText({ name, size = 15, gap = 6, color, style, children }) {
  return h('span', {
    style: { display: 'inline-flex', alignItems: 'center', gap, ...style },
  }, h(Icon, { name, size, color }), children);
}

export { PATHS as ICON_PATHS };
