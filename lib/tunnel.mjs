// cloudflared 隧道：把本机代理暴露成公网 https URL
//
// 两条路径（issue #66）：
//   - 快速隧道 startQuickTunnel：URL 由 cloudflared 随机分配（每次重启会变），零配置；
//   - 命名隧道 startNamedTunnel：用户自带 Cloudflare Tunnel Token + 固定域名，重启地址不变。
//
// 手机在任何网络都能访问。公网一律要求访问密码（dsh web 能执行代码，请勿泄露二维码/URL）。

import { spawn, execSync } from 'node:child_process';
import { mkdir, access, chmod, rm, stat, rename, cp, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream, writeFileSync } from 'node:fs';

// 快速隧道 URL：https://<随机子域>.trycloudflare.com
// (?!api\.) 负向前瞻排除保留子域 api（issue #32）：某些 cloudflared 版本/网络环境下
// 进程输出会先出现 https://api.trycloudflare.com（Cloudflare API 注册地址），原正则
// [a-z0-9-]+ 会把它误当隧道 URL → 设置页/二维码给出 api 地址 → 扫码打开返回
// {"code":10005,"message":"Method Not Allowed"}。api.trycloudflare.com 访问 GET 实测
// 正是该错误体，与 issue 完全一致。
export const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * 从 cloudflared 输出里提取最有诊断价值的一段（issue #78）。
 *
 * cloudflared 参数错误（如 "Incorrect Usage: flag provided but not defined"）的
 * 关键信息在输出**开头**，尾部整段都是 usage 帮助文本（对用户没用）；而运行期错误
 * （403 / 协议 / 网络）的关键信息在**尾部**。所以：参数错误取该行，其它仍取尾部。
 *
 * 本地修正：原实现是 `lines.slice(-4).slice(0, 500)`，但 cloudflared 启动时那段
 * "Thank you for trying Cloudflare Tunnel…" 安全横幅**单行就有约 495 字符**，
 * 于是 500 字符上限被横幅一行占满，真正的错误行（ERR/level=error）被整个丢掉 ——
 * 用户看到的就是"退出 code=1 + 一大段免责声明"，完全无从排查。
 * 现在改为：优先挑出带错误特征的行；挑不到再回退到尾部若干行。上限放宽到 1200。
 */
const ERR_LINE_RE = /\b(?:ERR|FTL|WRN)\b|level=error|error=|failed|refused|unable|no such host|timeout|EOF|unauthorized|forbidden|403|dial tcp|context deadline/i;
export function firstMeaningfulErrorLine(buf) {
  const lines = String(buf ?? '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // 命中哪行就返回哪行：cloudflared 先打版本横幅时，参数错误未必是首行
  const usageIdx = lines.findIndex((l) => /^(?:Incorrect Usage|flag provided but not defined|unknown flag|unknown command)/i.test(l));
  if (usageIdx >= 0) return lines[usageIdx].slice(0, 1200);
  // 优先：带错误特征的行（排除安全横幅那种纯 INF 说明）
  const errLines = lines.filter((l) => ERR_LINE_RE.test(l));
  if (errLines.length) return errLines.slice(-6).join('\n').slice(0, 1200);
  // 回退：尾部若干行（原行为，但放宽行数与长度，避免被单行横幅吃满）
  return lines.slice(-8).join('\n').slice(0, 1200);
}

function platformBinary() {
  const archMap = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' };
  const a = archMap[process.arch] ?? process.arch;
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  return { os, a, ext: os === 'windows' ? '.exe' : '' };
}

/**
 * 候选发布资产名，按优先级排列（issue #45）。
 *
 * cloudflared 现在的发布布局是**按平台分**：
 * - linux：只有裸二进制 `cloudflared-linux-amd64`（没有 .tgz）
 * - darwin：只有 `cloudflared-darwin-<arch>.tgz`
 * - windows：只有 `cloudflared-windows-<arch>.exe`
 *
 * 我们以前给 linux 拼的是 `cloudflared-linux-amd64.tgz`，而它**根本不存在**
 * （GitHub 返回 404），五个镜像全指向同一个 404 地址，于是必然"所有源都不通"
 * —— 表现就是 Linux 服务器上开了公网访问一直报"无法安装"，而 macOS/Windows
 * 一切正常。Linux 下裸二进制还有个额外好处：不用解压，也就不再依赖系统装了
 * `tar`（Alpine / slim 镜像 / 容器里常常没有）。
 *
 * linux 仍把 .tgz 留在候选里作为回退，万一上游改回打包方式也不会直接躺平。
 *
 * @returns {string[]} 资产名列表，越靠前越优先。
 */
export function platformAssets() {
  const { os, a } = platformBinary();
  if (os === 'windows') return [`cloudflared-windows-${a}.exe`];
  if (os === 'darwin') return [`cloudflared-darwin-${a}.tgz`];
  return [`cloudflared-linux-${a}`, `cloudflared-linux-${a}.tgz`];
}

/**
 * cloudflared 下载源。
 * 平台策略：macOS 优先清华 TUNA 镜像的 Homebrew bottle（国内 CDN，实测 ~3MB/s），
 * 拿不到再回退；Linux / Windows 直接走官方源优先（见 downloadCloudflared 里的说明）。
 * 兜底：官方 GitHub + 国内加速源（ghproxy.net / gh.ddlc.top / gh-proxy.com，2026-08
 * 实测可达）。npmmirror（淘宝）没有 cloudflared 镜像（已实测 404）。
 */
const CLOUDFLARED_MIRRORS = [
  (asset) => `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
];

const TUNA_BOTTLES = 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/';

/** 多线程分块下载的并发段数（Windows 官方源单线程 ~200KB/s，8 并发 ≈ 1.6MB/s）。 */
const PARALLEL_SEGMENTS = 8;
/** 小于该字节数的文件不值得分块（直接用单线程）。 */
const MIN_PARALLEL_SIZE = 8 * 1024 * 1024;
/** 探针大小：单线程先下这么多测速。 */
const PROBE_SIZE = 2 * 1024 * 1024;
/** 探针测速阈值（bytes/ms）：低于它认为慢网络，切多线程。300KB/s = 0.3。 */
const SLOW_SPEED_THRESHOLD = 0.3;

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/** 合并多个分段文件为一个目标文件（顺序拼接后统一结束）。 */
async function mergeParts(partFiles, dest) {
  const { createReadStream } = await import('node:fs');
  const out = createWriteStream(dest);
  try {
    for (const f of partFiles) {
      await new Promise((resolve, reject) => {
        const rs = createReadStream(f);
        rs.on('error', reject);
        rs.pipe(out, { end: false });
        rs.on('end', resolve);
      });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

/**
 * 下载文件到 dest（自适应）：
 * 1. 服务器不支持 Range 或文件小 → 单线程；
 * 2. 单线程下载探针（PROBE_SIZE）测速——速度够快 → 继续单线程（多线程在部分网络/
 *    服务器上反而更慢，如 GitHub CDN 并发限速）；
 * 3. 探针速度低于阈值（典型慢网络，如 Windows 用户官方源 ~200KB/s）→ 丢弃探针，
 *    改 8 段并发分块（可把 200KB/s 拉到 1.6MB/s）。
 * 返回实际下载字节数。
 */
export async function downloadFile(url, dest, { signal, segments = PARALLEL_SEGMENTS } = {}) {
  // HEAD 探测：Content-Length + Accept-Ranges
  let head = null;
  try { head = await fetch(url, { method: 'HEAD', signal }); } catch { head = null; }
  const len = head ? Number(head.headers.get('content-length') || 0) : 0;
  const acceptsRanges = head ? String(head.headers.get('accept-ranges') || '').toLowerCase() === 'bytes' : false;

  if (!head || !acceptsRanges || len < MIN_PARALLEL_SIZE) {
    // 单线程
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return len || 0;
  }

  // 探针测速：单线程下载前 PROBE_SIZE，计时
  const probeBytes = Math.min(PROBE_SIZE, len);
  const probeStart = Date.now();
  try {
    const probeRes = await fetch(url, { signal, headers: { Range: `bytes=0-${probeBytes - 1}` } });
    if (!probeRes.ok) throw new Error(`HTTP ${probeRes.status} (probe)`);
    const probeBody = await probeRes.arrayBuffer();
    const probeMs = Date.now() - probeStart;
    const probeSpeed = probeMs > 0 ? probeBytes / probeMs : Infinity; // bytes/ms
    if (probeMs < 500 || probeSpeed >= SLOW_SPEED_THRESHOLD) {
      // 够快 → 单线程下完剩余部分（探针字节已拿到，写入 dest）
      const { createWriteStream, createReadStream } = await import('node:fs');
      const w = createWriteStream(dest);
      await new Promise((resolve, reject) => {
        w.on('error', reject);
        w.write(Buffer.from(probeBody));
        w.end(resolve);
      });
      const restRes = await fetch(url, { signal, headers: { Range: `bytes=${probeBytes}-${len - 1}` } });
      if (!restRes.ok) throw new Error(`HTTP ${restRes.status} (rest)`);
      await pipeline(Readable.fromWeb(restRes.body), createWriteStream(dest, { flags: 'a' }));
      return len;
    }
    // 慢 → 丢弃探针，转分块并发（从 0 开始全量分块）
    await rm(dest, { force: true }).catch(() => {});
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {});
    if (!/HTTP|fetch/i.test(String(err?.message ?? ''))) throw err; // 探针网络异常 → 抛给上层换源
    // 探针 HTTP 错误（部分服务器 HEAD 与 GET 行为不一致）→ 直接分块
  }

  // 分块并发
  const parts = [];
  const chunk = Math.ceil(len / segments);
  for (let i = 0; i < segments; i++) {
    const start = i * chunk;
    const end = i === segments - 1 ? len - 1 : Math.min(start + chunk - 1, len - 1);
    if (start > end) break;
    parts.push({ start, end, file: `${dest}.part${i}` });
  }
  try {
    await Promise.all(parts.map(async (p) => {
      const res = await fetch(url, { signal, headers: { Range: `bytes=${p.start}-${p.end}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} (range ${p.start}-${p.end})`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(p.file));
    }));
    await mergeParts(parts.map((p) => p.file), dest);
  } finally {
    await Promise.all(parts.map((p) => rm(p.file, { force: true }).catch(() => {})));
  }
  return len;
}

/**
 * 清华 TUNA 镜像的 cloudflared Homebrew bottle URL（国内 CDN，实测 ~3MB/s）。
 * **仅 macOS**——Linux 的 Homebrew bottle 其 ELF 解释器是 `@@HOMEBREW_PREFIX@@`
 * 占位符（需 brew install 时 patchelf 替换），没装 Homebrew 的机器直接 spawn 会
 * ENOENT（issue #22）；Linux 走官方 GitHub 裸二进制（无需解压）+ 加速源。
 * 匹配按 CPU 架构取清华目录里版本号最新的 bottle——Homebrew 构建时部署目标
 * 设得较老、向后兼容，所以旧系统（如 Ventura）也能用新一点的 bottle。
 * 抓目录失败/无匹配 → null（调用方回退 GitHub/加速源，不影响可用性）。
 */
async function tsinghuaBottleUrl({ os, a }) {
  if (os !== 'darwin') return null;
  let res;
  try {
    res = await fetch(TUNA_BOTTLES, { signal: AbortSignal.timeout(20_000) });
  } catch { return null; }
  if (!res.ok) return null;
  let html;
  try { html = await res.text(); } catch { return null; }
  // macOS: arm64_<代号> 或 <代号>（Intel 无前缀），代号白名单排除 linux；Linux: arm64_linux / x86_64_linux
  const MACOS_CODES = 'monterey|ventura|sonoma|sequoia|tahoe';
  const pattern = os === 'darwin'
    ? new RegExp(`cloudflared-([0-9.]+)\\.${a === 'arm64' ? 'arm64_' : ''}(${MACOS_CODES})\\.bottle\\.tar\\.gz`, 'g')
    : new RegExp(`cloudflared-([0-9.]+)\\.${a === 'arm64' ? 'arm64' : 'x86_64'}_linux\\.bottle\\.tar\\.gz`, 'g');
  let best = null;
  let bestV = '';
  for (const m of html.matchAll(pattern)) {
    if (m[1] > bestV) { bestV = m[1]; best = m[0]; }
  }
  return best ? `${TUNA_BOTTLES}${best}` : null;
}

async function downloadCloudflared(binPath, signal) {
  const { os, a, ext } = platformBinary();
  const dir = dirname(binPath);
  const tmpFile = join(dir, `cloudflared.download`);
  const isWindows = os === 'windows';
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);

  // 源的顺序按平台定（issue #45）：
  // - macOS：清华 Homebrew bottle 排第一（国内 CDN 实测 ~3MB/s，给家用网络省几分钟），
  //   拿不到再退回官方源 + 国内加速源。
  // - Linux / Windows：不走 bottle，直接官方源优先。这两类环境网络差异太大
  //   （服务器、容器、 corporate 网络），多一层镜像就多一层失败模式；官方源
  //   拿不到时，再用国内加速源兜底。
  // bottle 与资产名无关，只算一次。
  const bottle = os === 'darwin' ? await tsinghuaBottleUrl({ os, a }).catch(() => null) : null;

  // 逐个资产试（linux 首选裸二进制，.tgz 只是回退），每个资产再逐个源试
  const assets = platformAssets();
  let lastErr = null;
  let usedAsset = null;

  for (let ai = 0; ai < assets.length && usedAsset === null; ai++) {
    const asset = assets[ai];
    const sources = [];
    if (bottle && asset.endsWith('.tgz')) {
      sources.push({ url: bottle, host: 'mirrors.tuna.tsinghua.edu.cn' });
    }
    for (const m of CLOUDFLARED_MIRRORS) sources.push({ url: m(asset), host: hostOf(m(asset)) });

    for (let i = 0; i < sources.length; i++) {
      const { url, host } = sources[i];
      console.log(`⬇️  下载 cloudflared（${asset}，源 ${i + 1}/${sources.length}：${host}）…`);
      try {
        // 多线程分块（官方 GitHub 支持 Range，Windows 50MB 从几分钟降到几十秒）；
        // 不支持 Range 的源自动回退单线程
        await downloadFile(url, tmpFile, { signal: fetchSignal });
        // 简单校验：空文件/极小文件视为下载失败（可能是镜像返回了错误页）
        const st = await stat(tmpFile);
        if (st.size < 1024 * 1024) throw new Error(`文件异常小（${st.size} 字节），疑似镜像错误页`);
        usedAsset = asset;
        lastErr = null;
        break; // 下载成功
      } catch (err) {
        lastErr = err;
        await rm(tmpFile, { force: true }).catch(() => {}); // 清掉半截文件
        console.warn(`  ⚠️ 源 ${i + 1} 失败：${err?.message ?? err}，尝试下一个…`);
      }
    }
  }
  if (usedAsset === null) {
    throw new Error(
      `cloudflared 下载失败：所有源都不通（最后错误：${lastErr?.message ?? lastErr}）。`
      + (isWindows
        ? `Windows 可手动安装后重试：winget install cloudflared；或下载 ${assets[0]} 放到 ${dir} 目录 | download failed — try: winget install cloudflared, or put the exe into ${dir}`
        : `也可以自己装好后在 settings.json 写 "cloudflaredPath": "/path/to/cloudflared" 跳过下载（或用环境变量 DSH_POCKET_CLOUDFLARED）；或用包管理器安装：apt/dnf install cloudflared | all mirrors failed — install cloudflared manually and set "cloudflaredPath" in settings.json, or: apt/dnf install cloudflared`),
    );
  }

  let extracted = join(dir, `cloudflared${ext}`);
  // 只有 .tgz 才需要解压：Windows 的 .exe 和 linux 的裸二进制本身就可直接执行
  // （linux 用裸二进制还有个好处——不依赖系统装了 tar，见 platformAssets 的说明）
  if (!usedAsset.endsWith('.tgz')) {
    await rename(tmpFile, extracted).catch(async () => {
      await cp(tmpFile, extracted).catch(() => {});
    });
  } else {
    // 解压到独立临时子目录（bottle 解压产物会占用 cacheDir/cloudflared 这个名字，
    // 直接解压到 dir 会让目标路径变成目录，rename 失败）
    const extractDir = join(dir, `.extract-${process.pid}-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xzf', tmpFile, '-C', extractDir], { stdio: 'ignore' });
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`cloudflared 解压失败（code=${code}）`)));
        // spawn 失败（Alpine / slim 镜像 / 容器里常见：根本没有 tar）时 err.code 是
        // ENOENT，直接抛出来只有一句 "spawn tar ENOENT"，看不出该怎么办
        child.once('error', (err) => reject(
          err?.code === 'ENOENT'
            ? new Error(`系统里没有 tar 命令，无法解压 ${usedAsset} —— 可改用 linux 裸二进制（默认已如此）或手动安装后设置 cloudflaredPath | no tar on this system`)
            : err,
        ));
      });
      // 找真实的二进制**文件**（排除目录）：
      // - GitHub tgz：extractDir/cloudflared
      // - Homebrew bottle（清华）：extractDir/cloudflared/<版本>/bin/cloudflared
      const { readdir } = await import('node:fs/promises');
      let found = null;
      const direct = join(extractDir, `cloudflared${ext}`);
      try { if ((await stat(direct)).isFile()) found = direct; } catch { /* 不存在 */ }
      if (!found) {
        const verDir = join(extractDir, 'cloudflared');
        try {
          const vers = await readdir(verDir);
          for (const v of vers) {
            const bin = join(verDir, v, 'bin', `cloudflared${ext}`);
            try { if ((await stat(bin)).isFile()) { found = bin; break; } } catch { /* 继续 */ }
          }
        } catch { /* 无此目录 */ }
      }
      if (!found) throw new Error('cloudflared 解压成功但未找到二进制 | binary not found after extract');
      if (found !== extracted) {
        await rename(found, extracted).catch(async () => { await cp(found, extracted).catch(() => {}); });
      }
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!isWindows) await chmod(extracted, 0o755);
  // 解压/搬移完成就删掉临时下载文件，避免长期占用缓存目录
  await rm(tmpFile, { force: true }).catch(() => {});
  return extracted;
}

/** PATH 里是否已有 cloudflared。 */
function cloudflaredOnPath() {
  try {
    execSync(process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** in-flight 下载（单飞）：并发调用复用同一次，防止交错写入损坏 tgz。 */
let downloading = null;

/**
 * 拿一个可用的 cloudflared 路径。
 * 优先：PATH 已有 → 直接用；否则用持久缓存（$DSH_HOME/dsh-pocket/cloudflared），
 * 只有缓存缺失才下载——避免每次开启公网都重新下 20MB。
 */
export { tsinghuaBottleUrl };

export async function resolveCloudflared({ home, onPhase = () => {}, signal } = {}) {
  // 自定义路径（issue #45）：用户可能在 settings.json 写了 cloudflaredPath，
  // 或者在外部注入 process.env.DSH_POCKET_CLOUDFLARED；命中就直接用，绕过
  // PATH 探测与下载（远程 Linux 服务器上下载源不可达时的兜底）。
  const explicit = process.env.DSH_POCKET_CLOUDFLARED;
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch {
      throw new Error(
        `DSH_POCKET_CLOUDFLARED 指向的路径不可执行：${explicit} | cloudflaredPath is set but not accessible: ${explicit}`,
      );
    }
  }
  if (cloudflaredOnPath()) return 'cloudflared';
  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const cacheDir = join(dshHome, 'dsh-pocket', 'bin');
  const { os, a, ext } = platformBinary();
  // 缓存命中，兼容两种文件名（issue #15）：
  // 1) 本插件下载时写入的 bin 名：cloudflared.exe
  // 2) 手动放置的**发布资产名**：cloudflared-windows-amd64.exe（与下载失败的错误提示一致）
  const candidates = [
    join(cacheDir, `cloudflared${ext}`),
    join(cacheDir, `cloudflared-${os}-${a}${ext}`),
  ];
  for (const bin of candidates) {
    try {
      await access(bin);
      // Linux：识别并丢弃 Homebrew bottle 坏缓存（issue #22）——其 ELF 解释器是
      // @@HOMEBREW_PREFIX@@ 占位符，直接 spawn 报 ENOENT；读文件头（解释器路径在
      // ELF 头部附近）即可识别，命中则删掉走重新下载
      if (os === 'linux') {
        try {
          const fd = await open(bin, 'r');
          const head = Buffer.alloc(8192);
          await fd.read(head, 0, 8192, 0);
          await fd.close();
          if (head.includes('@@HOMEBREW_PREFIX@@')) {
            await rm(bin, { force: true }).catch(() => {});
            console.warn('dsh-pocket: discarding unusable Homebrew-bottle cloudflared cache | 丢弃不可用的 Homebrew bottle 缓存，重新下载');
            continue;
          }
        } catch { /* 读失败按正常缓存处理 */ }
      }
      return bin; // 缓存命中，秒开
    } catch { /* 继续找下一个 */ }
  }
  onPhase('downloading');
  await mkdir(cacheDir, { recursive: true });
  if (!downloading) {
    downloading = downloadCloudflared(join(cacheDir, `cloudflared${ext}`), signal).finally(() => { downloading = null; });
  }
  return downloading;
}

/**
 * 启动 cloudflared 快速隧道，返回公网 URL。
 * @param {object} opts
 * @param {number} opts.port  本机代理端口
 * @param {string} [opts.home] $DSH_HOME（cloudflared 持久缓存）
 * @param {AbortSignal} [opts.signal]
 * @param {(phase:string)=>void} [opts.onPhase] 进度回调：downloading→starting→registering→ready
 * @returns {Promise<{url:string, kill:()=>void}>}
 */
/**
 * 启动 cloudflared 命名隧道（issue #66：固定公网域名）。
 *
 * 用户在 Cloudflare Zero Trust 后台创建 Tunnel、把域名 ingress 的 Service 指向
 * `http://127.0.0.1:<port>`，复制 Tunnel Token 填进设置页。与快速隧道的区别：
 *   - Token 走 `TUNNEL_TOKEN` **环境变量**（不进 argv——长期凭据不该出现在
 *     进程列表/崩溃日志里，issue #66 讨论中的一致意见）；
 *   - URL 固定为用户绑定的域名（cloudflared 输出不打印它），由调用方拼 `https://<域名>`，
 *     所以这里返回 `url: null`；
 *   - 就绪判据是 stderr 出现 `Registered tunnel connection`（边缘连接注册成功即开始服务）。
 * @param {object} opts
 * @param {string} opts.token    Cloudflare Tunnel Token
 * @param {string} [opts.home]   $DSH_HOME（cloudflared 持久缓存）
 * @param {AbortSignal} [opts.signal]
 * @param {(phase:string)=>void} [opts.onPhase] 进度回调：downloading→starting→registering→ready
 * @returns {Promise<{url:null, kill:()=>void, onExit:(cb)=>()=>void}>}
 */
export async function startNamedTunnel({ token, home, signal, onPhase = () => {} }) {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase('starting');
  // 与快速隧道一致强制 HTTP/2（国内/企业网常屏蔽 UDP 7844 → error 1033）
  // 与快速隧道一致强制 HTTP/2（国内/企业网常屏蔽 UDP 7844 → error 1033）
  // `--no-autoupdate` 必须在全局位置（子命令之前）：cloudflared 2026.x 移除了
  // `tunnel run` 子命令层级的该 flag，但全局位置仍有效（issue #78）
  const child = spawn(bin, ['--no-autoupdate', 'tunnel', 'run', '--protocol', 'http2'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TUNNEL_TOKEN: String(token ?? '') },
  });
  let cleanup = null;
  let rejectErr = null;
  // H1：spawn 失败（缓存二进制损坏等）必须接住，否则 uncaughtException 崩宿主
  child.on('error', (err) => {
    cleanup?.();
    onPhase?.('error');
    rejectErr?.(new Error(`cloudflared 启动失败：${err?.message ?? err}（可删除 $DSH_HOME/dsh-pocket/bin 缓存后重试）`));
  });
  onPhase('registering');

  await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      // 边缘连接注册成功即开始服务（每条连接一行；等第一条就够）
      if (/Registered tunnel connection/i.test(buf)) {
        cleanup();
        onPhase('ready');
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(
        `cloudflared 退出（code=${code}）${tail ? '：' + tail : ''}——请检查 Tunnel Token 是否有效、域名 Service 是否指向本机代理端口 | `
        + `tunnel exited (code=${code})${tail ? ': ' + tail : ''} — check the Tunnel Token and the ingress hostname`,
      ));
    };
    cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // M4：摘掉监听后管道不再消费 → 64KB 缓冲填满会阻塞 cloudflared → 继续吞掉输出
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(new Error('已取消 | cancelled'));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(
        'cloudflared 启动超时（30s）——请检查 Tunnel Token 是否有效、域名 Service 是否指向本机代理端口，'
        + '以及是否开着代理/VPN（Clash 等 TUN 模式会掐断隧道连接） | timeout — check the token, the ingress hostname, and quit any proxy/VPN (TUN mode)',
      ));
    }, 30_000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    rejectErr = reject;
  });

  // M1：隧道进程运行中死亡（崩溃/被杀）→ 通知监听方（service 据此把状态从 ready 打回）
  const exitListeners = new Set();
  child.on('exit', (code) => {
    for (const cb of exitListeners) cb(code);
  });

  return {
    url: null, // 固定域名由调用方（service）按设置拼 https://<hostname>
    kill: () => {
      try { child.kill(); } catch { /* 忽略 */ }
    },
    /** 注册「进程已退出」回调，返回取消函数。 */
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}

/**
 * 只对「瞬时」失败重试的快速隧道启动（本地修复）。
 *
 * 背景（实测复现）：短时间内发起两次快速隧道请求时，先发的会占住 Cloudflare 的
 * `POST https://api.trycloudflare.com/tunnel`，后发的等不到响应头就退出，输出
 *   failed to request quick Tunnel: Post "...": context deadline exceeded
 * 而 `code=1`。这类失败是**瞬时**的——间隔几秒重试即可成功，但原实现直接放弃，
 * 用户只能自己反复点。
 *
 * 触发场景很常见：DSH 重启会重载插件并可能自动恢复隧道（lib/index.js 的
 * restoreTunnelIfNeeded），若用户紧接着手动点「开启公网访问」，两次请求就会相撞。
 *
 * 因此这里做两件事：
 *   1. 串行化：整段「spawn → 拿到 URL 或失败」用单飞 promise 包住，避免同时起两个进程；
 *   2. 窄重试：**只**对可识别的瞬时错误重试（退避 1s / 3s），永久性错误（403、参数错误、
 *      域名配置错等）立即抛出，不做无谓等待。
 */
/**
 * 判断是否为「瞬时」错误（值得重试）。
 *
 * 注意：**先排除永久性错误**。403/Unauthorized、404/not found 这类带着
 * `failed to request quick Tunnel` 前缀，若只用正向特征匹配会被误判成瞬时错误，
 * 导致白白重试并让用户多等数秒（实测：403 被重试 3 次、多等 4.1 秒）。
 */
const PERMANENT_TUNNEL_ERR_RE = /\b(?:403|401|404)\b|Unauthorized|Forbidden|not found|Incorrect Usage|flag provided but not defined|unknown flag|unknown command/i;
const TRANSIENT_TUNNEL_ERR_RE = /failed to request quick Tunnel|context deadline exceeded|Client\.Timeout exceeded|i\/o timeout|connection reset|TLS handshake timeout|temporary failure|Too Many Requests|\b429\b|\b5\d\d\b/i;

function isTransientTunnelError(message) {
  const s = String(message ?? '');
  if (PERMANENT_TUNNEL_ERR_RE.test(s)) return false;
  return TRANSIENT_TUNNEL_ERR_RE.test(s);
}

async function startQuickTunnelOnce({ port, home, signal, onPhase, bin }) {
  // 强制 HTTP/2（TCP 443）而不是默认的 QUIC（UDP 7844）：
  // 国内网络/部分企业网常屏蔽 UDP 7844，导致 tunnel 报 error 1033（Tunnel error）；
  // HTTP/2 走 443 更稳。若平台未来恢复 QUIC 可达，可去掉 --protocol http2。
  // `--no-autoupdate` 必须在全局位置（子命令之前，见 issue #78 同款修复）
  const child = spawn(bin, ['--no-autoupdate', 'tunnel', '--url', `http://127.0.0.1:${port}`, '--protocol', 'http2'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onPhase?.('registering');
  // 运行期退出监听：必须在 spawn 时立即挂上并保留退出码。
  // 若改用「注册回调时才 child.once('exit')」的写法，一旦隧道进程在回调注册**之前**
  // 就已退出，回调永远不会触发——service.mjs 依赖它把状态从 ready 打回 error
  // （见其 M1 处理），漏掉就会出现"UI 显示隧道可用、实际早已断开"。
  const exitListeners = new Set();
  let exitedCode;
  child.on('exit', (code) => {
    exitedCode = code;
    for (const cb of exitListeners) { try { cb(code); } catch { /* 忽略 */ } }
  });
  // H1：spawn 失败（缓存二进制损坏等）必须接住，否则 uncaughtException 崩宿主
  child.on('error', (err) => {
    cleanup?.();
    onPhase?.('error');
    rejectErr?.(new Error(`cloudflared 启动失败：${err?.message ?? err}（可删除 $DSH_HOME/dsh-pocket/bin 缓存后重试）`));
  });

  let cleanup = null;
  let rejectErr = null;
  return await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(QUICK_TUNNEL_URL_RE);
      if (m) {
        cleanup();
        onPhase('ready');
        resolve({
          url: m[0],
          kill: () => { try { child.kill(); } catch { /* 忽略 */ } },
          // 注册「进程已退出」回调，返回取消函数；已退出时立即回调，避免漏通知。
          onExit: (cb) => {
            if (exitedCode !== undefined) { try { cb(exitedCode); } catch { /* 忽略 */ } return () => {}; }
            exitListeners.add(cb);
            return () => exitListeners.delete(cb);
          },
        });
      }
    };
    const onExit = (code) => {
      cleanup();
      // 本地诊断增强：把 cloudflared 的**完整输出**落盘。
      // 报错信息受长度限制，只能显示一部分；完整日志留在
      // `<DSH_HOME>/dsh-pocket/cloudflared-last.log` 便于事后排查失败原因。
      try {
        const logPath = join(home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-pocket', 'cloudflared-last.log');
        writeFileSync(logPath, `# cloudflared 退出 code=${code} at ${new Date().toISOString()}\n# 参数: --no-autoupdate tunnel --url http://127.0.0.1:${port} --protocol http2\n\n${buf}`, 'utf8');
      } catch { /* 诊断日志失败不影响主流程 */ }
      // 带上 cloudflared 自己的输出（参数错误显示开头、运行期错误显示尾部，见 firstMeaningfulErrorLine），
      // 否则「code=1」用户无从排查（issue #65 / #78）
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(`cloudflared 退出（code=${code}）${tail ? '：' + tail : ''}`));
    };
    cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // M4：摘掉监听后管道不再消费 → 64KB 缓冲填满会阻塞 cloudflared → 继续吞掉输出
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(new Error('已取消 | cancelled'));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(
        'cloudflared 启动超时（30s）——请检查是否开着代理/VPN（Clash 等 TUN 模式会掐断隧道连接），退出代理后重试 | '
        + 'timeout — if you run a proxy/VPN (Clash etc., TUN mode), it can block the tunnel; quit it and retry',
      ));
    }, 30_000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    rejectErr = reject;
  });
}

// 单飞：避免同一个进程内同时起两个快速隧道（两次请求会互相挤掉，见上方说明）。
let quickTunnelInFlight = null;

export async function startQuickTunnel({ port, home, signal, onPhase = () => {} }) {
  if (quickTunnelInFlight) return quickTunnelInFlight;
  const run = (async () => {
    // 先确保二进制就绪（可能触发首次下载），再进入重试循环
    const bin = await resolveCloudflared({ home, onPhase, signal });
    onPhase('starting');
    const delays = [0, 1000, 3000];
    let lastErr;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) {
        onPhase('starting');
        await new Promise((r) => setTimeout(r, delays[i]));
      }
      if (signal?.aborted) throw new Error('已取消 | cancelled');
      try {
        onPhase('registering');
        return await startQuickTunnelOnce({ port, home, signal, onPhase, bin });
      } catch (err) {
        lastErr = err;
        // 只重试瞬时错误；永久性错误立刻抛出，不做无谓等待
        if (!isTransientTunnelError(err?.message)) throw err;
        if (i === delays.length - 1) break;
        console.warn(`dsh-pocket: 快速隧道瞬时失败，准备重试（第 ${i + 2}/${delays.length} 次）| transient quick-tunnel failure, retrying: ${err?.message ?? err}`);
      }
    }
    throw lastErr;
  })().finally(() => { quickTunnelInFlight = null; });
  quickTunnelInFlight = run;
  return run;
}
