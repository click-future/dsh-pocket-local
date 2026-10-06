// dsh-pocket 网页客户端：
//   1. 设置页签「手机访问」（局域网/公网二维码 + 更新/重启提示）
//   2. 移动端适配（移植自 MIT 项目 dsh-web-mobile，见 client/mobile/LICENSE.dsh-web-mobile）
//
// 手机扫码打开的就是电脑上的 dsh web，实时同步；窄屏自动变成抽屉布局。
//
// 注：Web Push 已移除——浏览器推送依赖 Google FCM（Chrome）等境外服务，
// 国内直连被墙，普通用户用不了。专注扫码同屏这一件事。

import { createElement as h, useEffect, useRef, useState } from 'react';

import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS, redactStatus, compareVersions } from './api.js';
import { Icon, IconText } from './icons.js';
import { mobileApply } from './mobile/mobile-apply.tsx';
import { NS as POCKET_NS, zh as POCKET_ZH, en as POCKET_EN } from './pocket-locales.js';

const name = 'dsh-pocket';
const inject = ['slots', 'connection', 'layout', 'locale', 'sessionLogDownload'];

// 词典在 pocket-locales.js；这里只做「取 key → 替换 {占位符} → 字符串」。
// 不依赖 DSH t() 的插值能力，避免行为不一致。
function fmt(t, key, vars) {
  let s = t(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = String(s).split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

// 官方 DeepSeek Harness 设计系统（dsh-client-ui-theme design-platform.css）：
// 按钮 md=36px 胶囊形 / sm=28px；品牌色 --dsw-alias-brand-primary；
// hover 走 --dsw-alias-button-*-hover；间距 4px 栅格；正文 13px。
const styles = {
  card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 12, padding: '16px 20px', maxWidth: 480 },
  block: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', marginTop: 16, paddingTop: 16 },
  muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
  code: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, wordBreak: 'break-all', margin: '6px 0 10px', color: 'var(--dsw-alias-label-primary,inherit)' },
  // 主按钮：官方 md 胶囊形（36px）
  primary: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))', color: 'var(--dsw-alias-label-primary-foreground, #fff)', height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  // 次级按钮：官方 outline/ghost 胶囊形
  btn: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)', height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  qr: { width: 220, height: 220, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', margin: '8px 0' },
  warn: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.5 },
};

function PocketSettingsTab({ rpcCall, t }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tunnelState, setTunnelState] = useState(null); // 隧道进度 {phase, detail, startedAt}
  const [restartNotice, setRestartNotice] = useState(false); // 重启后提示
  const [updateInfo, setUpdateInfo] = useState(null); // { current, latest, updating, result, startedAt } | null
  const [isDesktop, setIsDesktop] = useState(false); // DSH Desktop（Electron）环境：更新/重启由桌面版管理
  const [now, setNow] = useState(Date.now()); // 每秒 tick，驱动倒计时

  // 进行中操作的「已等待 X 秒」倒计时
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = (startedAt) => (startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0);

  const call = async (endpoint, payload) => {
    const res = await rpcCall(endpoint, payload);
    if (!res?.ok) throw new Error(res?.error?.message ?? 'RPC failed');
    return res.value;
  };

  const load = async () => {
    try {
      const s = await call(POCKET_ENDPOINTS.status, {});
      setStatus(s);
      setTunnelState(s.tunnelState ?? null);
      if (s.desktop) setIsDesktop(true);
      if (s.restartNotice) {
        // 新进程确认起来了：显示一次「已重启」，清掉旧的更新横幅（单状态，不并存），
        // 然后自动刷新页面加载新代码——不用用户手动刷新
        setRestartNotice(true);
        setUpdateInfo(null);
        if (!sessionStorage.getItem('dshp-auto-reloaded')) {
          sessionStorage.setItem('dshp-auto-reloaded', '1');
          setTimeout(() => { try { location.reload(); } catch { /* 忽略 */ } }, 2000);
        }
      }
    } catch { /* 忽略瞬时失败 */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  // 每次页面加载清掉自动刷新标记——这样下次重启（更新后）才能再次触发自动刷新
  useEffect(() => {
    try { sessionStorage.removeItem('dshp-auto-reloaded'); } catch { /* 忽略 */ }
  }, []);

  // 版本检测：host 当前版本 vs npm registry latest（registry 带 CORS *）
  // 两种情况显示横幅：① 有新版可更新；② 磁盘已更新但进程还是旧代码（重启生效）
  // cache: 'no-store' —— registry 响应带缓存头，浏览器会缓存旧版本号导致「小版本不提示」
  // 周期重查（每 5 分钟）：npm registry 的 /latest 走 CDN 边缘缓存，刚发布后打开页面
  // 可能拿到旧版本号——周期性重查让更新提示在缓存刷新后自动出现，不用重开页面。
  // 桌面端（isDesktop）：更新/重启由 DSH Desktop 管理，这里不做版本检测、不显示更新横幅
  useEffect(() => {
    if (isDesktop) return;
    let alive = true;
    const check = async () => {
      try {
        const v = await call(POCKET_ENDPOINTS.version, {});
        const meta = await (await fetch('https://registry.npmjs.org/dsh-pocket/latest', { cache: 'no-store' })).json();
        if (!alive) return;
        const latest = typeof meta?.version === 'string' ? meta.version : null;
        if (latest && v.current && compareVersions(latest, v.current) > 0) {
          setUpdateInfo({ current: v.current, latest, updating: false, result: null });
        } else if (v.current && v.loaded && compareVersions(v.current, v.loaded) > 0) {
          // 已更新未重启：显示「已更新，重启生效」+ 重启按钮
          setUpdateInfo({ current: v.current, latest: v.current, updating: false, result: 'ok', updated: true });
        }
      } catch { /* 网络失败静默 */ }
    };
    check();
    const t = setInterval(check, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [isDesktop]);

  // 重启宿主（更新生效必需：刷新页面不会重载服务端代码）
  const restartPocket = async () => {
    setUpdateInfo((u) => ({ ...u, restarting: true, startedAt: Date.now() }));
    try {
      // 宿主 500ms 后自杀，RPC 响应可能来不及送达 → 3 秒超时兜底，别让按钮永远卡「重启中…」
      await Promise.race([
        call(POCKET_ENDPOINTS.restart, {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('restart requested (no reply within 3s)')), 3000)),
      ]);
      setUpdateInfo((u) => ({ ...u, restarting: true, result: 'ok' }));
    } catch (err) {
      // 网络断连/超时同样视为「已请求重启」——旧进程即将退出，等新进程起来后刷新即可
      const msg = String(err?.message ?? '');
      if (/connection|socket|fetch|network|abort|cancelled|ECONN|disconnect|closed|timeout/i.test(msg)) {
        setUpdateInfo((u) => ({ ...u, restarting: true, result: 'ok' }));
        return;
      }
      setUpdateInfo((u) => ({ ...u, restarting: false, result: 'fail', output: err.message }));
    }
  };

  // 一键更新：调宿主 dsh plugin update（成功后宿主自动重启生效，用户只点一次）
  const runUpdate = async () => {
    setUpdateInfo((u) => ({ ...u, updating: true, result: null, startedAt: Date.now() }));
    try {
      const r = await call(POCKET_ENDPOINTS.update, {});
      setUpdateInfo((u) => ({
        ...u,
        updating: false,
        result: r.ok ? 'ok' : 'fail',
        autoRestart: r.autoRestart === true,
        output: r.output ?? r.error,
      }));
    } catch (err) {
      setUpdateInfo((u) => ({ ...u, updating: false, result: 'fail', output: err.message }));
    }
  };

  // 安全免责声明（issue #31）：每次开启公网都必须先弹框勾选「我已知情」。
  // 服务端同样强制（tunnel.start 需 disclaimer: true），防绕过前端直接调 RPC。

  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);

  const doStartTunnel = async () => {
    // 命名隧道模式：Token/域名没配齐就不发起（服务端同样会拒绝）
    const cfg = status?.tunnelConfig;
    if (cfg?.mode === 'named' && (!cfg.hostname || !cfg.tokenSet)) {
      setError(t('namedNeedCfg'));
      return;
    }
    setBusy(true);
    setError(null);
    setTunnelState({ phase: 'starting', detail: '正在开启…', startedAt: Date.now() });
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const startTunnel = () => {
    // 每次开启都弹免责确认（勾选后才能继续）
    setDisclaimerChecked(false);
    setDisclaimerOpen(true);
  };
  const confirmDisclaimer = () => {
    if (!disclaimerChecked) return; // 未勾选不允许
    setDisclaimerOpen(false);
    doStartTunnel();
  };

  const stopTunnel = async () => {
    try { setStatus(await call(POCKET_ENDPOINTS.tunnelStop, {})); } catch { /* 忽略 */ }
  };

  // 公网模式（issue #66）：随机域名（默认零配置）/ 固定域名（Cloudflare 命名隧道 + Tunnel Token）
  // tunnelCfg：编辑态 { hostname, token, err } | null；token 输入留空 = 保持已存的 Token 不变
  const [tunnelCfg, setTunnelCfg] = useState(null);
  const switchToQuick = async () => {
    try { setStatus(await call(POCKET_ENDPOINTS.tunnelSetConfig, { mode: 'quick' })); } catch (err) { setError(err.message); }
  };
  const saveNamedTunnel = async () => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.tunnelSetConfig, {
        mode: 'named',
        hostname: tunnelCfg?.hostname ?? '',
        token: tunnelCfg?.token || undefined, // 留空不覆盖已存 Token
      }));
      setTunnelCfg(null);
    } catch (err) {
      setTunnelCfg((c) => ({ ...c, err: err.message }));
    }
  };

  // 恢复出厂设置：清本机设置 + 重设随机密码（弹窗确认；RPC 端也强制校验 confirm）
  const [resetOpen, setResetOpen] = useState(false);
  const doFactoryReset = async () => {
    setResetOpen(false);
    setBusy(true);
    setError(null);
    try {
      setStatus(await call(POCKET_ENDPOINTS.pocketReset, { confirm: true }));
      setTunnelCfg(null);
      setCustomPin(null);
      setAdvOpen(false);
      showToast(h(IconText, { name: t('updateStatusIcon'), size: 15 }, t('resetDone')));
    } catch (err) {
      setError(err.message);
      showToast(h(IconText, { name: t('failureIcon'), size: 15 }, t('resetFailed')));
    } finally {
      setBusy(false);
    }
  };

  // 刷新局域网访问密码（旧密码立即作废）
  const refreshLanPin = async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.lanTokenRefresh, {});
      setStatus((s) => ({ ...s, lanToken: r.lanToken }));
    } catch { /* 忽略 */ }
  };

  // 局域网访问密码开关（issue #24）：默认开启；关闭后局域网扫码直连（公网不受影响）
  const setLanAuth = async (on) => {
    try {
      const r = await call(POCKET_ENDPOINTS.lanAuthSetEnabled, { on });
      setStatus((s) => ({ ...s, lanAuthEnabled: r.lanAuthEnabled }));
    } catch { /* 忽略 */ }
  };

  // 局域网访问总开关：关闭后局域网扫码/链接直接失效（公网不受影响）。
  // 切换前弹窗确认（弹窗提醒）；服务端用 setLanEnabled 持久化，代理按 Host 实时拦截。
  const [lanToggleOpen, setLanToggleOpen] = useState(null); // null | true | false（目标 on 状态）
  const requestLanToggle = (on) => setLanToggleOpen(on);
  const confirmLanToggle = async () => {
    const on = lanToggleOpen;
    setLanToggleOpen(null);
    if (on === null) return;
    try {
      const r = await call(POCKET_ENDPOINTS.lanSetEnabled, { on });
      setStatus((s) => ({ ...s, lanEnabled: r.lanEnabled }));
    } catch (err) {
      setError(err.message);
    }
  };

  // 局域网地址手动覆盖（Tailscale/VPN 等远程访问场景）：空值恢复自动选择
  const setLanAddress = async (ip) => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.lanSetOverride, { ip }));
    } catch (err) {
      setError(err.message);
    }
  };

  // 自定义访问密码（issue #33）：公网/局域网各自设固定 8 位密码（英文字母大小写或数字）；自定义后公网不再自动轮换。
  // customPin: { which: 'public'|'lan', value, err } | null —— 正在输入自定义密码的区块
  const [customPin, setCustomPin] = useState(null);
  const saveCustomPin = async (which) => {
    try {
      const r = await call(POCKET_ENDPOINTS.pinSetCustom, { which, value: customPin?.value ?? '' });
      setStatus((s) => ({
        ...s,
        accessToken: which === 'public' ? r.pin : s.accessToken,
        lanToken: which === 'lan' ? r.pin : s.lanToken,
        publicPinCustom: which === 'public' ? true : s.publicPinCustom,
        lanPinCustom: which === 'lan' ? true : s.lanPinCustom,
      }));
      setCustomPin(null);
    } catch (err) {
      setCustomPin((c) => ({ ...c, err: err.message }));
    }
  };
  // 渲染自定义输入行（共用）：输入框 + 保存/取消
  const customPinRow = (which) => h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)', lineHeight: 1.5 } },
    t('customizing'),
    h('input', {
      style: { width: 130, margin: '0 6px', padding: '4px 8px', fontSize: 14, letterSpacing: 1, textAlign: 'center', border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, outline: 'none' },
      type: 'password',
      maxLength: 8,
      value: customPin?.value ?? '',
      autoFocus: true,
      onChange: (e) => setCustomPin((c) => ({ ...c, value: e.target.value.replace(/[^a-zA-Z0-9]/g, ''), err: null })),
      onKeyDown: (e) => { if (e.key === 'Enter') saveCustomPin(which); if (e.key === 'Escape') setCustomPin(null); },
    }),
    h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12, marginLeft: 2 }, onClick: () => saveCustomPin(which) }, t('save')),
    h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: () => setCustomPin(null) }, t('cancel')),
    customPin?.err ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', marginTop: 4 } }, errText(customPin.err)) : null,
  );
  // 「自定义」按钮（非输入态显示在密码行末尾）
  const customBtn = (which) => h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12, marginLeft: 8 }, onClick: () => setCustomPin({ which, value: '', err: null }) }, t('customize'));

  const lanUrl = status?.lanUrl;
  const tunnelUrl = status?.tunnelUrl;
  const tunnelPhase = tunnelState?.phase ?? 'idle';
  const tunnelStarting = ['downloading', 'starting', 'registering'].includes(tunnelPhase);
  const tunnelStateDetail = tunnelState?.detail ?? '';
  const tunnelStateStarted = tunnelState?.startedAt ?? null;
  // 公网模式视图（issue #66）：{ mode, hostname, tokenSet }
  const tunnelModeView = status?.tunnelConfig ?? { mode: 'quick', hostname: '', tokenSet: false };
  const namedMode = tunnelModeView.mode === 'named';
  // 模式按钮选中态高亮：固定域名模式本身，或正在编辑固定域名配置，都视为「选中」
  const namedActive = namedMode || tunnelCfg !== null;
  // 后端错误消息统一为「中文 | English」混排；按当前界面语言只显示对应一半
  const errText = (msg) => {
    const s = String(msg ?? '');
    const i = s.indexOf(' | ');
    if (i < 0) return s;
    return (t('ok') === POCKET_ZH.ok ? s.slice(0, i) : s.slice(i + 3)).trim();
  };
  // 轻量 Toast：操作成功/失败后短暂提示（自动消失，不打断操作）
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const modeBtnStyle = (active) => ({
    ...styles.btn, height: 28, padding: '0 12px', fontSize: 12,
    fontWeight: active ? 600 : 400,
    background: active ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))' : 'var(--dsw-alias-bg-layer-1,#fff)',
    color: active ? 'var(--dsw-alias-label-primary-foreground, #fff)' : 'var(--dsw-alias-label-primary,inherit)',
  });
  // iOS 风格小开关（重排后统一用：局域网总开关 / 局域网密码开关）
  //
  // 本地补丁：原实现只用一个浅灰底 + 18px 滑块的位移来表达状态，两点都不够醒目——
  //   ① 关闭态用的是「边框色」`--dsw-alias-border-l2`（回退 #d1d5db）当填充色，
  //      浅灰铺在浅色卡片上对比极低；且该主题变量在桌面版未必定义，会落到硬编码回退值；
  //   ② 滑块只挪 18px，扫一眼很难判断。
  // 因此改为**颜色 + 文字双通道**：轨道内直接写「开/关」（置于滑块对侧，位移与文字
  // 互相印证），并给关闭态加深底色、加描边。这样即使主题变量缺失或色觉有差异，
  // 也不会把「开」误读成「关」。轨道加宽到 46 是为了同时容纳滑块与文字。
  const Switch = (on, onClick) => h('button', {
    role: 'switch', 'aria-checked': !!on,
    title: t(on ? 'on' : 'off'),
    style: {
      flexShrink: 0, width: 46, height: 22, borderRadius: 11, border: 'none', padding: 0,
      position: 'relative', cursor: 'pointer', font: 'inherit',
      background: on
        ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))'
        : 'var(--dsw-alias-bg-layer-3,#cbd2dc)',
      boxShadow: on
        ? 'inset 0 0 0 1px rgba(0,0,0,.06)'
        : 'inset 0 0 0 1px var(--dsw-alias-border-l3,#aab2bd)',
      transition: 'background .18s ease',
    },
    onClick,
  },
    // 状态文字：开启时靠左、关闭时靠右（滑块在另一侧，位置与文字互相印证）
    h('span', {
      'aria-hidden': 'true',
      style: {
        position: 'absolute', top: 0, height: 22, display: 'flex', alignItems: 'center',
        fontSize: 10, fontWeight: 700, letterSpacing: .5, userSelect: 'none', pointerEvents: 'none',
        color: '#fff',
        ...(on ? { left: 7, right: 20, justifyContent: 'flex-start' } : { left: 20, right: 7, justifyContent: 'flex-end' }),
      },
    }, t(on ? 'on' : 'off')),
    h('span', {
      style: {
        position: 'absolute', top: 2, left: on ? 26 : 2, width: 18, height: 18, borderRadius: '50%',
        background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.3)', transition: 'left .18s ease',
      },
    }),
  );
  // 卡片内主内容：二维码 + 地址 + 提示
  const qrArea = (src, url, hint) => h('div', { style: { background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', borderRadius: 10, padding: '10px 12px', textAlign: 'center', margin: '10px 0' } },
    h('img', { src, alt: 'QR', style: styles.qr }),
    h('div', { style: styles.code }, url),
    h('div', { style: styles.muted }, hint));
  // 设置行：上分隔线，内部第一行 = 左标签 + 右操作；extra 作为第二段渲染
  const row = (label, control, extra) => h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', paddingTop: 9, marginTop: 9 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h('span', { style: { fontSize: 13 } }, label), control), extra ?? null);
  // 高级（手动选地址）展开态
  const [advOpen, setAdvOpen] = useState(false);

  return h('div', { style: styles.card },
    // 标题行（本地补丁）：右侧放一个紧凑的「问题反馈」按钮。
    // 原先这里是「开发者 / Star 引导」整块（已按需求移除），底部另有一整行反馈文案
    // （也已移除）—— 两处合并为这一个按钮：既然标题行右侧空出来了，把反馈放这里
    // 既不占额外纵向空间，也不必在页面末尾再留一行。
    h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 } },
      h('div', { style: { minWidth: 0 } },
        h('strong', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h(Icon, { name: t('titleIcon'), size: 16 }),
          t('title')),
        h('div', { style: styles.muted }, t('subtitle')),
      ),
      h('a', {
        href: 'https://github.com/shaobeichen/dsh-pocket/issues',
        target: '_blank',
        rel: 'noreferrer',
        title: t('feedbackHint'),
        style: {
          // 对齐 DSH 设计系统：.button 基础 + .ghost 变体 + .sm 尺寸
          boxSizing: 'border-box',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          flexShrink: 0,
          height: 28,
          padding: '0 10px',
          borderRadius: 'var(--dsw-radius-sm,6px)',
          border: 'none',
          fontSize: 12,
          lineHeight: '18px',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          textDecoration: 'none',
          color: 'var(--dsw-alias-label-secondary,#6b7280)',
          background: 'transparent',
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))'; },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
      },
        h(Icon, { name: t('feedbackIcon'), size: 14 }),
        t('feedback')),
    ),

    // 桌面端不显示更新/重启横幅（更新由 DSH Desktop 管理），也不需要额外提示

    // 重启后提示（进程在后台运行，停止方法）——左侧蓝色色条（桌面端不会触发本插件的自重启）
    !isDesktop && restartNotice ? h('div', { style: { ...styles.block, borderLeft: '4px solid var(--dsw-alias-brand-primary,#4f6ef7)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', padding: '10px 12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { fontWeight: 600, fontSize: 13 } }, t('restarted')),
        h('button', { style: styles.btn, onClick: () => setRestartNotice(false) }, t('ok')),
      ),
      h('div', { style: styles.muted, marginTop: 4, wordBreak: 'break-all' }, fmt(t, 'bgHint', { cmd: status?.killHint ?? `lsof -ti :${status?.dshPort ?? 3080} | xargs kill -9` })),
    ) : null,

    // 更新提示——左侧黄色色条（提示有新版本）；单状态：有更新/更新中/已更新自动重启，不并存
    // 桌面端不渲染（更新由 DSH Desktop 管理）
    !isDesktop && updateInfo ? h('div', { style: { ...styles.block, borderLeft: '4px solid var(--dsw-alias-state-warn-primary,#b45309)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', padding: '10px 12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('div', { style: { fontWeight: 600, fontSize: 13 } },
          updateInfo.updated
            ? fmt(t, 'updatedRestart', { ver: updateInfo.current })
            : updateInfo.result === 'ok'
              ? (updateInfo.autoRestart ? fmt(t, 'updateAutoRestarting', { ver: updateInfo.latest }) : fmt(t, 'updatedOk', { ver: updateInfo.latest }))
              : fmt(t, 'updateAvailable', { ver: updateInfo.latest })),
        updateInfo.result !== 'ok'
          ? h('button', { style: styles.primary, onClick: runUpdate, disabled: updateInfo.updating }, updateInfo.updating ? t('updating') : fmt(t, 'updateTo', { ver: updateInfo.latest }))
          : updateInfo.autoRestart
            ? h('button', { style: styles.btn, disabled: true }, t('restartingNow'))
            : h('button', { style: styles.primary, onClick: restartPocket, disabled: updateInfo.restarting },
                updateInfo.restarting
                  ? t('restarting')
                  : h(IconText, { name: t('restartNowIcon'), size: 14, gap: 5 }, t('restartNow'))),
      ),
      h('div', { style: { ...styles.muted, marginTop: 4 } },
        h(IconText, {
          // 进度 / 成功 / 失败各自换图标，替代原先写在文案里的 ⏳✅❌
          name: (updateInfo.updating || updateInfo.restarting) ? t('progressIcon')
            : updateInfo.result === 'ok' ? t('updateStatusIcon')
              : updateInfo.result === 'fail' ? t('failureIcon')
                : t('updateAvailableIcon'),
          size: 14,
          style: { alignItems: 'flex-start' },
        },
          h('span', null,
            updateInfo.updating
              ? fmt(t, 'updatingDetail', { s: elapsed(updateInfo.startedAt) })
              : updateInfo.restarting
                ? fmt(t, 'restartingDetail', { s: elapsed(updateInfo.startedAt) })
                : updateInfo.result === 'ok'
                  ? (updateInfo.autoRestart ? t('updatedAutoDetail') : t('updatedRestartDetail'))
                  : updateInfo.result === 'fail' ? fmt(t, 'updateFailed', { err: errText(updateInfo.output) || t('unknownError') })
                    : fmt(t, 'versionRange', { cur: updateInfo.current, latest: updateInfo.latest })))),
    ) : null,

    // 局域网：标题行自带总开关 → 二维码+地址 → 设置行（访问密码 / 高级·手动选地址）
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } },
          h(IconText, { name: t('lanTitleIcon'), size: 15, gap: 5 }, t('lanAccess'))),
        Switch(status?.lanEnabled !== false, () => requestLanToggle(status?.lanEnabled === false)),
      ),
      status?.lanEnabled === false
        ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-warn-primary,#b45309)', lineHeight: 1.5 } },
            h(IconText, { name: t('lanDisabledHintIcon'), size: 14 }, t('lanDisabledHint')))
        : (lanUrl
          ? h('div', null,
            qrArea(status.lanQr, lanUrl, t('lanHint')),
            // 访问密码行：开关 + 值（关闭时提示直连）
            row(t('lanPin'), Switch(status?.lanAuthEnabled !== false, () => setLanAuth(status?.lanAuthEnabled === false)),
              status?.lanAuthEnabled === false
                ? h('div', { style: { ...styles.muted, marginTop: 6 } },
                    h(IconText, { name: t('lanPinOffIcon'), size: 14 }, t('lanPinOff')))
                : (customPin?.which === 'lan'
                  ? customPinRow('lan')
                  : h('div', { style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('span', { style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13, letterSpacing: 1 } }, status.lanToken),
                    h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: refreshLanPin }, t('refresh')),
                    customBtn('lan'),
                    status?.lanPinCustom ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary,#b45309)' } }, t('pinCustomHint')) : null,
                  ))),
            // 高级：手动选地址（默认收起）
            row(t('advAddress'),
              h('button', { style: { border: 'none', background: 'none', font: 'inherit', cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', padding: 0 }, onClick: () => setAdvOpen((v) => !v) },
                (status?.lanIpOverride || t('lanAddressAuto')) + ' ›'),
              advOpen ? h('div', { style: { marginTop: 8 } },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)' } },
                  t('lanAddress'),
                  h('select', {
                    value: status?.lanIpOverride || '',
                    onChange: (e) => setLanAddress(e.target.value),
                    style: { font: 'inherit', height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)' },
                  },
                  h('option', { value: '' }, t('lanAddressAuto')),
                  (status?.lanCandidates || []).map((ip) => h('option', { key: ip, value: ip }, ip)),
                  ),
                ),
              ) : null),
          )
          : h('div', { style: styles.muted }, t('lanStarting'))),
    ),

    // 公网：标题行自带 开启/关闭 → 开启后：二维码+地址、地址模式行、访问密码行
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } },
          h(IconText, { name: t('wanTitleIcon'), size: 15, gap: 5 }, t('wanAccess'))),
        tunnelUrl
          ? h('button', { style: { ...styles.btn, height: 28, padding: '0 12px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' }, onClick: stopTunnel }, t('stopTunnel'))
          : h('button', { style: { ...styles.primary, height: 28, padding: '0 14px', fontSize: 12 }, onClick: startTunnel, disabled: busy || tunnelStarting }, busy || tunnelStarting ? t('opening') : t('enable')),
      ),
      tunnelStarting
        ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)' } },
          h(IconText, { name: t('progressIcon'), size: 14, style: { alignItems: 'flex-start' } },
            h('span', null,
              tunnelPhase === 'downloading'
                ? fmt(t, 'downloading', { s: elapsed(tunnelStateStarted) })
                : fmt(t, 'connecting', { s: elapsed(tunnelStateStarted), suffix: elapsed(tunnelStateStarted) > 30 ? t('slowHint') : '' }))))
        : tunnelPhase === 'error'
          ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } },
            h(IconText, { name: t('failureIcon'), size: 14, style: { alignItems: 'flex-start' } },
              h('span', null, fmt(t, 'error', { detail: errText(tunnelStateDetail) || t('unknownError') }))))
          : (!tunnelUrl && !isDesktop ? h('div', { style: { ...styles.muted, marginTop: 8 } }, t('wanOffHint')) : null),
      tunnelUrl
        ? h('div', null,
          qrArea(status.tunnelQr, tunnelUrl, namedMode ? t('namedRunningHint') : t('wanHint')),
          // 防钓鱼 / 别收藏（issue #82）：公网链接仅本次有效、勿收藏提示
          h('div', { style: { marginTop: 8, fontSize: 12, lineHeight: 1.5, borderLeft: '4px solid var(--dsw-alias-state-warn-primary,#b45309)', background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', borderRadius: 8, padding: '8px 10px' } },
            h(IconText, { name: t('wanEphemeralWarnIcon'), size: 14, style: { alignItems: 'flex-start' }, gap: 6 },
              h('span', null, t('wanEphemeralWarn')))),
          // 地址模式行（随机/固定；固定域名选中或编辑时高亮）
          row(t('modeLabel'),
            h('span', { style: { display: 'inline-flex', gap: 6 } },
              h('button', { style: modeBtnStyle(!namedActive), onClick: namedMode ? switchToQuick : (tunnelCfg ? () => setTunnelCfg(null) : undefined) }, t('modeQuick')),
              h('button', { style: modeBtnStyle(namedActive), onClick: () => setTunnelCfg(tunnelCfg ? null : { hostname: tunnelModeView.hostname ?? '', token: '', err: null }) }, t('modeNamed')),
            ),
            h('div', { style: { marginTop: 6 } },
              // 刚保存固定域名但当前连接仍是随机域名：需关闭后重新开启才生效
              namedMode && /trycloudflare\.com/i.test(tunnelUrl ?? '') ? h('div', { style: { ...styles.warn } }, t('namedTakeEffect')) : null,
              // 固定域名：已保存摘要 + 修改入口（非编辑态）
              namedMode && !tunnelCfg ? h('div', { style: { ...styles.muted } },
                fmt(t, 'namedSummary', { host: tunnelModeView.hostname || '—', token: tunnelModeView.tokenSet ? t('namedTokenSet') : t('namedTokenMissing') }),
                h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12, marginLeft: 8 }, onClick: () => setTunnelCfg({ hostname: tunnelModeView.hostname ?? '', token: '', err: null }) }, t('namedEdit')),
                h('div', { style: { ...styles.muted, marginTop: 4 } }, t('namedHow')),
                !tunnelModeView.tokenSet || !tunnelModeView.hostname ? h('div', { style: { marginTop: 2, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, t('namedNeedCfg')) : null,
              ) : null,
              // 固定域名：编辑表单（域名 + Tunnel Token，Token 留空保持不变）
              tunnelCfg ? h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#6b7280)', lineHeight: 1.6 } },
                h('div', null,
                  t('namedHostnameLabel'),
                  h('input', {
                    style: { margin: '4px 0 0 6px', padding: '4px 8px', fontSize: 13, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, outline: 'none', width: 200 },
                    placeholder: 'pocket.example.com',
                    value: tunnelCfg.hostname ?? '',
                    autoFocus: true,
                    onChange: (e) => setTunnelCfg((c) => ({ ...c, hostname: e.target.value.trim(), err: null })),
                    onKeyDown: (e) => { if (e.key === 'Enter') saveNamedTunnel(); if (e.key === 'Escape') setTunnelCfg(null); },
                  }),
                ),
                h('div', { style: { marginTop: 6 } },
                  t('namedTokenLabel'),
                  h('input', {
                    style: { margin: '4px 0 0 6px', padding: '4px 8px', fontSize: 13, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', borderRadius: 6, outline: 'none', width: 240, fontFamily: 'ui-monospace,Menlo,monospace' },
                    type: 'password',
                    value: tunnelCfg.token ?? '',
                    onChange: (e) => setTunnelCfg((c) => ({ ...c, token: e.target.value.trim(), err: null })),
                    onKeyDown: (e) => { if (e.key === 'Enter') saveNamedTunnel(); if (e.key === 'Escape') setTunnelCfg(null); },
                  }),
                ),
                h('div', { style: { marginTop: 6, display: 'flex', gap: 8 } },
                  h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: saveNamedTunnel }, t('save')),
                  h('button', { style: { ...styles.btn, height: 26, padding: '0 10px', fontSize: 12 }, onClick: () => setTunnelCfg(null) }, t('cancel')),
                ),
                h('div', { style: { ...styles.muted, marginTop: 6 } }, t('namedHow')),
                h('div', { style: { marginTop: 2, fontSize: 11, color: 'var(--dsw-alias-state-warn-primary,#b45309)', lineHeight: 1.5 } }, t('namedSecurity')),
                tunnelCfg.err ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', marginTop: 4 } }, errText(tunnelCfg.err)) : null,
              ) : null,
            ),
          ),
          // 访问密码行：值 + 自定义（自定义输入态整体替换）
          status.accessToken
            ? row(h(IconText, { name: t('pinIcon'), size: 14, gap: 5 }, t('pinLabel')),
              customPin?.which === 'public'
                ? null
                : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                  h('span', { style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13, letterSpacing: 1 } }, status.accessToken),
                  customBtn('public')),
              h('div', { style: { marginTop: 6 } },
                customPin?.which === 'public' ? customPinRow('public') : null,
                status?.publicPinCustom ? h('div', { style: { ...styles.warn } }, t('pinCustomHint')) : null,
                namedMode ? h('div', { style: { ...styles.warn } }, t('namedSecurity')) : null))
            : null,
        )
        : null,
    ),

    error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 12, marginTop: 8 } }, `❌ ${errText(error)}`) : null,

    // 恢复出厂设置：设置出问题时的临时兜底（最底部，避免误触）
    h('div', { style: styles.block },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: { fontWeight: 600, fontSize: 13 } },
          h(IconText, { name: t('resetFactoryIcon'), size: 15, gap: 5 }, t('resetFactory'))),
        h('button', { style: { ...styles.btn, height: 28, padding: '0 12px', fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' }, onClick: () => setResetOpen(true) }, t('resetGo')),
      ),
      h('div', { style: { ...styles.muted, marginTop: 6 } }, t('resetIntro')),
    ),

    // 恢复出厂设置确认弹框
    resetOpen ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
      h('div', { style: { background: 'var(--dsw-alias-bg-layer-1,#fff)', borderRadius: 12, maxWidth: 440, width: '100%', padding: '20px 22px', boxShadow: '0 8px 32px rgba(0,0,0,.18)' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, color: 'var(--dsw-alias-state-warn-primary,#b45309)', marginBottom: 10 } },
          h(IconText, { name: t('resetTitleIcon'), size: 16, gap: 6 }, t('resetTitle'))),
        h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary,inherit)', whiteSpace: 'pre-line' } }, t('resetBody')),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
          h('button', { style: { ...styles.btn, flex: 1 }, onClick: () => setResetOpen(false) }, t('cancel')),
          h('button', { style: { ...styles.primary, flex: 1, background: 'var(--dsw-alias-state-error-primary,#dc2626)' }, onClick: doFactoryReset }, t('resetConfirm')),
        ),
      ),
    ) : null,

    // Toast：重置等操作的即时反馈（固定屏幕正中央，2.6s 自动消失）
    toast ? h('div', {
      style: { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 10001, width: 'auto', maxWidth: 280, background: 'rgba(17,24,39,.92)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 16px', fontSize: 13, lineHeight: 1.5, textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,.22)' },
    }, toast) : null,

    // 局域网访问开关确认弹框（关闭/打开时弹窗提醒）
    lanToggleOpen !== null ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
      h('div', { style: { background: 'var(--dsw-alias-bg-layer-1,#fff)', borderRadius: 12, maxWidth: 420, width: '100%', padding: '20px 22px', boxShadow: '0 8px 32px rgba(0,0,0,.18)' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, color: lanToggleOpen ? 'var(--dsw-alias-brand-primary,#4f6ef7)' : 'var(--dsw-alias-state-warn-primary,#b45309)', marginBottom: 10 } }, t(lanToggleOpen ? 'lanToggleTitleOn' : 'lanToggleTitleOff')),
        h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary,inherit)' } }, t(lanToggleOpen ? 'lanToggleBodyOn' : 'lanToggleBodyOff')),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
          h('button', { style: { ...styles.btn, flex: 1 }, onClick: () => setLanToggleOpen(null) }, t('cancel')),
          h('button', { style: { ...styles.primary, flex: 1 }, onClick: confirmLanToggle }, t('confirm')),
        ),
      ),
    ) : null,

    // 安全免责声明弹框（issue #31）：每次开启公网访问前确认
    disclaimerOpen ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
      h('div', { style: { background: 'var(--dsw-alias-bg-layer-1,#fff)', borderRadius: 12, maxWidth: 420, width: '100%', padding: '20px 22px', boxShadow: '0 8px 32px rgba(0,0,0,.18)' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, color: 'var(--dsw-alias-state-warn-primary,#b45309)', marginBottom: 10 } },
          h(IconText, { name: t('disclaimerTitleIcon'), size: 16, gap: 6 }, t('disclaimerTitle'))),
        h('div', { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary,inherit)' } }, t('disclaimerBody')),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 13, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: disclaimerChecked, onChange: (e) => setDisclaimerChecked(e.target.checked), style: { width: 16, height: 16 } }),
          t('disclaimerAgree'),
        ),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
          h('button', { style: { ...styles.btn, flex: 1 }, onClick: () => setDisclaimerOpen(false) }, t('cancel')),
          h('button', {
            style: { ...styles.primary, flex: 1, opacity: disclaimerChecked ? 1 : .5 },
            disabled: !disclaimerChecked,
            onClick: confirmDisclaimer,
          }, t('disclaimerAgree')),
        ),
        !disclaimerChecked ? h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, t('disclaimerHint')) : null,
      ),
    ) : null,
  );
}

/**
 * 侧栏导航项 + 主面板（本地补丁）。
 *
 * 位置语义：`sidebar.panellist` 是左侧导航栏的图标列表，配合 `main` 面板使用
 * —— 点导航项把中栏切换成对应面板（官方「插件」面板同机制）。该位置**常驻**，
 * 不依赖是否有活动会话，因此没有对话时也能看到手机连接入口。
 *
 * 图标规范对齐 DSH 侧栏 glyph：`renderSlot("sidebar.panellist", { size, active })`
 * 会把尺寸和选中态传进来，所以这里必须跟随 `size`（而非写死像素），
 * 并在 `active` 时加重描边 —— 与同排其它 glyph 的选中观感一致。
 * 用 SVG 而非 emoji：emoji 在深色主题下是固定彩色，和侧栏那排线性图标不是一套语言。
 */
const POCKET_PANEL_ID = 'pocket-mobile';
const PHONE_ICON_PATH = 'M7 2.75h6a1.25 1.25 0 0 1 1.25 1.25v12a1.25 1.25 0 0 1-1.25 1.25H7A1.25 1.25 0 0 1 5.75 16V4A1.25 1.25 0 0 1 7 2.75ZM9.25 14.4h1.5';

/** 统一的手机图标：尺寸可控、跟随 currentColor。 */
function PhoneGlyph({ size = 16, strokeWidth = 1.5 }) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
    stroke: 'currentColor', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
  }, h('path', { d: PHONE_ICON_PATH }));
}

/** 侧栏导航图标。
 *  只接收并使用 `size`，与官方 PluginsPanelIcon({ size }) 完全一致 ——
 *  选中态由侧栏自身 CSS（panelGlyph / aria-current）负责，组件内不要再叠加，
 *  否则选中时会出现"双重加重"、与同排图标不一致。 */
function PocketRailIcon({ size, t }) {
  return h('span', {
    title: t?.('headerButton'),
    'aria-label': t?.('headerButton'),
    style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 },
  }, h(PhoneGlyph, { size: size ?? 18 }));
}

/**
 * 主面板：承载与设置页**完全相同**的 PocketSettingsTab（零逻辑复制）。
 * 外层只补内边距与滚动，因为设置分区自带卡片外观、原本依赖设置面板的容器留白。
 */
function PocketMainPanel({ rpcCall, t }) {
  return h('div', {
    style: { height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: '20px 24px' },
  }, h('div', { style: { maxWidth: 720, margin: '0 auto' } },
    h(PocketSettingsTab, { rpcCall, t }),
  ));
}

export function apply(ctx) {
  // 兜底：确保 connection.isLoopback 为 true（issue #58）。
  // 注：代理注入的 loopback 补丁（proxy.mjs LOOPBACK_ENV_PATCH）已在 #105 移除——
  // 它与 DSH Desktop 2.0.4+ 客户端运行时不兼容，会令 BootHandoff 阶段白屏。
  // #58「远程浏览器开设置页」需上游提供官方信任来源机制才能正经解决；此处仅保留兜底。
  if (ctx?.connection) {
    try {
      Object.defineProperty(ctx.connection, 'isLoopback', { value: true, writable: true, configurable: true });
    } catch {
      try { ctx.connection.isLoopback = true; } catch { /* 忽略 */ }
    }
  }

  // 移动端适配（dsh-web-mobile 移植）：抽屉布局/触控/安全区，仅窄屏生效
  mobileApply(ctx);

  const rpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(POCKET_RPC_CHANNEL, endpoint, payload, signal);

  // 设置页签接入 DSH 本地化：注册 pocket 词典（zh/en），并绑定一个随当前 locale 切换的 t()。
  const translate = ctx.locale.bind(POCKET_NS);
  ctx.effect(() => ctx.locale.register(POCKET_NS, { zh: POCKET_ZH, en: POCKET_EN }), 'dsh-pocket: pocket locale dictionaries');

  // 本地补丁：入口放到**侧栏导航（常驻）**，而不是会话顶栏。
  //
  // 为什么改：`conversation.session.header.utilities` 只在**打开了会话**时渲染
  // （顶栏属于会话界面），没有活动会话时该入口完全不可见 —— 手机连接是随时可能要用的
  // 功能，不该依赖"是否开着会话"。
  //
  // 新位置沿用官方「导航项 + 主面板」范式（见 @deepseek-ai/dsh-client-ui-plugin-manager）：
  //   · `sidebar.panellist` 渲染左侧导航图标，渲染签名是
  //     `renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })`
  //     —— 所以组件接收 { size, active, t }，图标尺寸要跟随 size、选中态跟随 active。
  //   · `main` 是按 key 索引的面板注册表：`renderSlot("main", {}, { entryKey: activePanelId })`
  //     —— 用同一个 PANEL_ID 注册即可，点导航项就会把中栏切成该面板（与"插件"面板同机制）。
  // 两处都注册在侧栏，故**任何界面状态下都可见**（含没有会话时）。
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: POCKET_PANEL_ID,
        order: 10,
        label: () => translate('headerButton'),
        locale: POCKET_NS,
        inject: () => ({ t: translate }),
      },
      PocketRailIcon,
    ),
  );

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: POCKET_PANEL_ID,
        locale: POCKET_NS,
        inject: () => ({ rpcCall, t: translate }),
      },
      PocketMainPanel,
    ),
  );
}

export { name, inject, redactStatus };
