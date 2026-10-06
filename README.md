# dsh-pocket（个人构建版）

把 **DeepSeek Harness 装进你的口袋**：手机扫码即同步访问电脑上的 DSH，局域网 + 公网都行。

> **这是 [dsh-pocket](https://github.com/shaobeichen/dsh-pocket) 的个人构建版（fork）**，
> 基于上游 **v2.10.6** 并做了若干本地改动。上游作者与版权归原作者所有。
> 本仓库不是上游官方仓库；遇到问题请先对照下面「本仓库的改动」确认是否由本地改动引入。
>
> 上游的完整功能说明见 [`README.upstream.md`](README.upstream.md)（中文）与
> [`README.upstream.en.md`](README.upstream.en.md)（English）。
> 本文件只说明**本构建版改了什么**以及怎么用。

---

## 本仓库的改动

相对上游 v2.10.6，本构建版共 7 处改动。

### 1. 「手机访问」入口迁到侧栏导航（常驻）

- **改前**：入口是「设置」里的一个一级分区。
- **改后**：入口是**侧栏导航项**（手机图标），点击后把中栏切换为「手机访问」整页。

采用官方的「导航项 + 主面板」范式（`sidebar.panellist` + `main`，与官方「插件」面板同机制），
因此**任何界面状态下都可见，包括没有打开会话时** —— 手机连接是随时可能要用到的功能，
不该依赖"是否开着会话"。

> 中途曾短暂试过放在会话顶栏（`conversation.session.header.utilities`），
> 但该插槽只在打开了会话时渲染，没有会话就完全进不去，已废弃。

### 2. 开关配色：不再只靠颜色表达状态

- **改前**：开关仅靠底色 + 滑块位移表达状态，关闭态用「边框色」当填充色、对比度极低，
  且该主题变量在桌面版未必定义。
- **改后**：**颜色 + 文字双通道** —— 轨道内直接写「开 / 关」（置于滑块对侧），
  关闭态加深底色并加描边。

这样即使主题变量缺失、或存在色觉差异，也不会把「开」误读成「关」。

### 3. emoji 换成线性 SVG 图标

界面与词典里原有的手机/锁/警告/扫帚/刷新/对勾等 emoji，全部换成
[`client/icons.js`](client/icons.js) 里的 20×20 线性图标。

原因：emoji 在不同平台字形不一、在深色主题下是**固定彩色**、无法跟随文字颜色，
与 DSH 那套灰色线性图标不是一套视觉语言。SVG 走 `currentColor`，能跟随主题与状态色。

服务端的登录/提示页（手机扫码最先看到的几页）同样做了处理。

### 4. 移除「开发者 / Star 引导」区块

设置页标题行右侧原有的「开发者：…」「顺手留颗 Star…」整块已移除。

### 5. 反馈入口简化为一个按钮

页面底部原有一整行反馈文案，现收敛为标题行右侧的**一个紧凑按钮**（图标 +「问题反馈」）。

### 6. 修复「开启公网访问失败」报错不可读的问题

上游的报错提取逻辑是"取最后 4 行、截断 500 字符"，而 cloudflared 启动时的安全横幅
**单行就有 601 字符**，于是真正的错误行被整个挤掉，用户只能看到「code=1 + 一大段免责声明」。

现改为**优先提取带错误特征的行**、上限放宽到 1200 字符；并额外把 cloudflared 的
完整输出写入 `$DSH_HOME/dsh-pocket/cloudflared-last.log`，便于事后排查。

### 7. 公网隧道瞬时失败自动重试 + 启动单飞

- **瞬时重试**：只对可识别的瞬时错误（`context deadline exceeded`、连接重置等）重试 3 次
  （退避 1s / 3s）；403/404/参数错误这类**永久错误立即抛出**，不做无谓等待。
- **启动单飞**：保证同进程内只起一个快速隧道，避免两次 `POST /tunnel` 互相挤掉。

> 注意：重试只能缓解**偶发**瞬时失败。若本机网络对大范围 Cloudflare 域名存在阻断，
> 免账号快速隧道（`api.trycloudflare.com`）依然不可用；此时请改用
> **命名隧道**（自带 Cloudflare 账号 + 域名，用 Tunnel Token 直连边缘）或更换网络。

---

## 安装

```sh
# 装到你的 DSH profile（web 或 desktop）
dsh plugin --profile web     add dsh-pocket -w
dsh plugin --profile desktop add dsh-pocket -w

# 改了客户端源码后必须重建产物，否则界面不生效：
npm install          # 需要 devDependencies 里的 esbuild
npm run build:client
```

装完**重启 DSH** 生效。入口在**侧栏**（手机图标）。

---

## 与上游同步

本仓库是上游 v2.10.6 的快照 + 上述改动。上游更新后若要跟进：

1. 取上游新版源码；
2. 按上面 7 条重新施加改动（改动集中在
   `client/index.jsx`、`client/pocket-locales.js`、`client/icons.js`、
   `lib/proxy.mjs`、`lib/tunnel.mjs`）；
3. `npm run build:client` 重建 `client/client.js`。

---

## 许可与署名

- 本仓库与上游代码均以 **GPL-2.0** 发布（见 [`LICENSE`](LICENSE)）。
  按该许可，修改版**必须同样以 GPL 开源并保留版权声明** —— 本仓库遵循此要求。
- 原始项目：[shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（作者：程序员少北晨）
- 移动端适配部分移植自 [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（MIT），
  其版权声明保留在 [`client/mobile/LICENSE.dsh-web-mobile`](client/mobile/LICENSE.dsh-web-mobile)。
- 公网隧道基于 [cloudflared](https://github.com/cloudflare/cloudflared)。
