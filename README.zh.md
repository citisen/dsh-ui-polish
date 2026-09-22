# dsh-ui-polish

[English](README.md) | 中文

## 已废弃 —— dsh 自己就会做这件事了

**本包已冻结：不要装，装了请卸掉。** 它唯一的行为已经被 dsh 吸收：从
`0.1.7-alpha.1` 起，对话自带的调宽手柄自己就转交滚轮 —— `WidthHandle` 渲染时挂了
`onWheel`，会滚动它旁边的 `[data-conversation-scroll]` —— 所以下面那个 fix 在新线上是多余的，
而且**开关打开时会把这同一段滚轮位移花掉两次**。不会再发布新版本。

卸掉它只需要在 profile 的 patch 层（`$DSH_HOME/profiles/web/cordis.patch.yml`）写一行：

```yaml
- id: ui-polish
  disabled: true
```

再把 `@citisen/dsh-ui-polish` 从 `$DSH_HOME/profiles/<name>/package.json` 的
`dsh.profile.bundles` 里去掉（或执行 `dsh plugin --profile web remove @citisen/dsh-ui-polish`）。
在 `0.1.5-rc.x` 上这个 fix 仍然有用 —— 没有它，鼠标停在那两条手柄上滚轮不会滚动 —— 所以在旧线上卸掉
它只是偏好，不是修复。

## dsh 起不来怎么办

你正在看的报错就是这三行 ——

    Failed to load plugins
    web boot: 3 entries did not activate
    @citisen/dsh-ui-polish: pending (waiting for service: settingsScope)

「启用的条目却始终不激活」在 dsh 里算**启动失败**而不是警告：它会拒绝完成启动，而不是少个插件
照常起来。三条出路，从快到慢，**三条都在 dsh 起不来的情况下可用**。本插件在 profile 里的行是
`id: ui-polish`，对应 `name: '@citisen/dsh-ui-polish'`。

**1. 禁用它 —— 在 profile 自己的补丁层里加一条**
（`$DSH_HOME/profiles/web/cordis.patch.yml`，这一层在所有 bundle 层之后应用）：

    - id: ui-polish
      disabled: true

不用敲命令、不用联网、不用装东西；删掉这两行它就回来了。`dsh --profile web --dump-config`
会打印组装后的树 —— 每个行的 id 和包名，不管它属于谁 —— 补丁生效时这一行会带
`disabled: true`；它不加载任何插件，所以 dsh 起不来时也能用。

**2. 只影响这一次启动，什么都不改** —— 把同样两行写进你自己的文件，当叠加层传进去：

    dsh --profile web --patch ./no-polish.yml web

**3. 卸载它** —— 一条命令同时摘掉依赖和 bundle 层（`dsh.profile.bundles` 会按已安装状态自动
对齐）。它只是转发给 profile 目录里的 pnpm，不组装 profile，所以 dsh 起不来时也能跑：

    dsh plugin --profile web remove @citisen/dsh-ui-polish

需要 `PATH` 上有 `pnpm`。没有的话，就手工从 `$DSH_HOME/profiles/web/package.json` 的
`dsh.profile.bundles`（以及对应的 `dependencies`）里删掉包名。

**或者先要一个能用的 dsh**：用官方模板起一个干净的 profile，它不带你装的任何 bundle：

    dsh --profile rescue --from-default-profile web

## 兼容性

本构建在两条 dsh 线上都能跑：**0.1.5-rc.x** 系列（也就是当前的 `latest` 和 `next`），以及
**0.1.7-alpha.1** —— 后者的设置模型它同样会说。两条线上，这份插件的 section 都叫同一个名字
`ui-polish`：0.1.7 线按 Loader 条目 id 定位设置，而本 bundle 的补丁正是以这个名字插入条目；
0.1.5 线则把同一个名字注册为设置命名空间。

| 它读什么 | 0.1.5-rc.x | 0.1.7-alpha.1 |
| --- | --- | --- |
| 那份持久 section | `settingsScope.bind({ namespace: 'ui-polish' })` | `configForms.get('ui-polish')`，读条目自己的 `Config` |
| 宿主契约 | `settings.register('ui-polish', schema)` | 导出的 `Config`，字段标记为 `.volatile()` |

两者都是**可选绑定**，所以两条服务都不提供的 dsh 也照样激活：插件不会一直 `pending`（那会直接
阻断启动），也不会在激活时抛错。它按出厂默认值工作，而你在设置行上第一次动开关时，它会告诉你为
什么存不下来。`0.1.2` 及更早的版本要求 0.1.5 那条服务，所以在 `0.1.7-alpha.1`
上被报成「未激活」的条目；`0.1.3` 两条线都会说。

### 0.1.7 改名时丢掉的设置

dsh 0.1.7 会把旧的 `$DSH_HOME/settings.yaml` 导入一次 —— 每个 section 写进同名条目 —— 并把文件
改名为 `settings.yaml.imported`。在 `0.1.3` 之前，本插件的条目叫 `polish`，于是
`ui-polish` 这个 section 无处可去，只留在改名后的文件里。现在名字对上了，dsh 自己的导入就能把
这些值放回去：

1. 把 `$DSH_HOME/settings.yaml.imported` **复制**成 `$DSH_HOME/settings.yaml`（是复制不是移动 ——
   导入跑之前，那个文件是唯一的记录），并且只保留条目现在仍然声明的键：dsh 会用条目自己的 schema
   校验这个 section，只要有一个不认识的键就整段拒绝，所以上面表格没列出的键都要删掉。
2. 用你平时用的 profile 启动一次 dsh 0.1.7。凡是现在有条目对应的 section —— 包括
   `ui-polish` —— 都会写进那个 profile 的 Cordis patch。
3. dsh 仍然不认的 section 会被报告出来，并继续留在 `settings.yaml.imported` 里；所以**在你把需要
   的东西取出来之前，别删那个文件**。

面向 DeepSeek Harness **Web 界面的一小组可用性修正**，打成一个插件：一套构建、一个设置命名空间、一次发布，并且每一项都有独立开关，不需要为了关掉某一项而卸载整个插件。

这是一个第三方 [dsh](https://github.com/deepseek-ai/deepseek-harness) profile bundle（插件包）。它是一个「双面」包：Node 半边负责持久化的设置命名空间，浏览器半边负责安装各项修正并注册设置行。

需要 dsh `0.1.5-rc.1` 或更新的 `0.1.5-rc.x`；它用到 `settings.general.item` 插槽、`settingsScope` 服务与 `ctx.effect`，这些在 `latest` 与 `next` 两条发布通道里都已具备。

## 加什么

在 *设置 → 通用* 中新增一个 **界面润色** 行，把包里每一项修正列出来并配一个开关。所有修正**默认开启**：一项修正之所以存在，是因为出厂行为是错的，让用户去手动打开等于发布 bug 而藏起解药；开关的作用是出问题时不挡路，而不是给插件打广告。

| 修正 | 作用 | 默认 |
| --- | --- | --- |
| 滚轮穿过对话两侧的调宽手柄 | 鼠标停在两侧那条看不见的调宽手柄上时，滚轮依然能滚动对话正文 | 开 |

## 第一项修正：调宽手柄上的"死滚轮"

对话正文左右各有一条调宽手柄，最宽约 40px，**在鼠标悬停之前完全透明**，而且它会吞掉滚轮：把鼠标停上去滚，正文纹丝不动，界面上也没有任何东西解释为什么——所以才像 bug，而不像边界。

原因是结构性的：手柄是**贴在**滚动元素**旁边**的绝对定位覆盖层，而不是它的子元素。

```
.body (position: relative)
├─ .scrollBody [data-conversation-scroll]   ← 真正滚动的那一层
├─ div [data-width-handle="left"]           ← 覆盖层，没有背景
└─ div [data-width-handle="right"]          ← 覆盖层，没有背景
```

落在手柄上的滚轮事件沿祖先链往上找可滚动容器，链上没有任何"接受滚轮"的盒子（`overflow: hidden` 虽然算滚动容器，但滚轮永远不滚动它），于是就地死掉；真正该滚的那个容器是它的**兄弟**，根本轮不到。

开启这项修正后，插件在 document 的捕获阶段接管滚轮，**只有**当它落在手柄上时，才把同样的位移交给手柄下面真正的那一层——通过询问"如果忽略手柄，这个坐标上是什么"得到，因此不依赖任何可能被 dsh 改版的 DOM 形状。

它刻意**不做**的事：

- **不动布局。** 手柄的尺寸、拖拽手感、悬停指示线都保持原样，只有滚轮被桥接。
- **不干扰别处。** 没落在手柄上的事件原样放行；正文、侧栏、任何弹窗的滚动行为与之前完全一致。
- **不抢手势。** <kbd>Ctrl</kbd>+滚轮仍然是浏览器缩放。
- **不制造新的死角。** 滚到正文顶部或底部时事件被放行，浏览器自己的滚动链式传递照旧生效——手柄不会变成另一种"死区"。

如果它在某种布局下表现异常，去 *设置 → 通用 → 界面润色* 关掉即可：不需要重装，也不用等新版本。

## 安装

```sh
dsh plugin --profile web add @citisen/dsh-ui-polish
```

直接从 GitHub 安装（同一个包，不走 registry）：

```sh
dsh plugin --profile web add github:citisen/dsh-ui-polish
```

然后重启 Web 界面：

```sh
dsh --profile web
```

`dsh plugin` 会在 profile 目录里转发给 pnpm，然后对 `dsh.profile.bundles` 做一次对账：由于本包声明了 `dsh.bundle`，安装时会自动把它追加为一个 profile 层，无需手工修改 `cordis.patch.yml`。

### 从本地目录安装

在 Windows 上，如果 profile 和代码目录位于**不同盘符**，`dsh plugin --profile web add <路径>` 不可靠：pnpm 会把目录链接解析成一个不存在的路径，随后对账会认为该包没有声明 `dsh.bundle`，于是不把它写进 `bundles`。（同一个盘符下也可能遇到——先检查链接，别假设。）这时请自己建立链接：

```sh
cd "$DSH_HOME/profiles/web"
pnpm add "D:/path/to/dsh-ui-polish"      # 写入依赖
# pnpm 建立的链接指向 <profile>/D:/path/...，该路径不存在，需要修复：
cmd /c rmdir node_modules\@citisen\dsh-ui-polish
cmd /c mklink /J node_modules\@citisen\dsh-ui-polish D:\path\to\dsh-ui-polish
# 再手工把 "@citisen/dsh-ui-polish" 加进 package.json 的 dsh.profile.bundles
```

用 `node scripts/verify-profile.mjs` 校验结果；只要这一行没进最终的 entry 列表，它就会直接报错。

## 开发

```sh
npm run build     # src/client.js -> lib/client.js
npm run check     # 发布闸门：产物同步 + host/client 校验
npm run check:all # 再加上 profile 组合校验（需要本机有 dsh）
npm run verify    # 只跑校验脚本
npm run watch     # 保存即重建，配合 dsh-client-hmr
```

浏览器半边的唯一真源是 `src/client.js`。它为了可读性写成 ES module，但 DSH 的客户端 bundle 是**传统脚本（classic script）**，只允许通过 `window.__ModuleLoader__` 注册一个惰性 CommonJS 工厂——因此 `scripts/build-client.mjs` 负责套上这层外壳并改写静态 import。这个转换刻意做得很窄，遇到无法改写的写法会直接让构建失败；其中也包括"没被改写的 import"，否则它会以 ES import 的形式留在传统脚本里，在浏览器里直接不加载。

### 加一项修正

在 `src/client.js` 的 `FIXES` 里加一个条目：一个 id、两个文案键，以及一个返回自己 disposer 的 `install(ctx)`。设置行由这份列表生成，装配器只安装开启的项、在开关关闭时销毁它——所以一项修正不需要别的东西，而且某一项安装失败不会带倒其它项。

id 同时就是设置键，host 半边的 schema 也由同一份列表生成。两个半边是各自独立的 bundle，无法共享模块，所以这份列表是手工同步的；`verify-client.mjs` 会比较两份副本，把"悄悄写歪"变成一次校验失败。

命名请按用户得到的行为来（`wheelThroughWidthHandle`），而不是按被修补的组件——因为 id 会出现在 bug 报告里。

## 包结构

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | Node 半边：设置命名空间。由 loader 加载。 |
| `lib/client.js` | 浏览器半边，**由 `src/client.js` 生成**，由 shell 提供给 GUI。 |
| `src/client.js` | 浏览器半边源码：修正注册表、各项修正、设置行。 |
| `cordis.patch.yml` | 本 bundle 贡献的 profile 层。 |
| `scripts/` | 构建与校验脚本。 |
| `PUBLISHING.md` | trusted publishing：一次性配置，以及这套机制防不住什么。 |
| `RELEASING.md` | 改完代码之后怎么发布的完整流程。 |

## 已知限制

- **只匹配对话两侧那两条手柄。** 判定用 `[data-width-handle]`，兜底用该组件的 CSS-module 类名。框架自己的 8px 分栏手柄刻意**不**匹配：它对手柄有可见反馈，也没有被报告吞掉滚轮。
- **dsh 改版可能让这项修正失效（而不是出错）。** 如果属性名或类名消失，就什么都匹配不到、什么事件都不接管，插件安静地什么也不做——bug 回来，但不会弄坏别的东西。这是刻意的失败模式；真正的长效解法在上游 `ui-conversation` 里。
- **只处理垂直位移。** 手柄上的横向滚轮不转发，因为那个位置没有可横向滚动的东西。
- **行/页单位的位移是近似值。** `deltaMode` 为"行"时用该容器的计算行高（取不到时按 16px），为"页"时用它的可视高度；而普通鼠标与触控板报告的像素位移是精确转发的。
- **是滚动，不是重新派发。** 合成滚轮事件无法触发原生滚动，所以插件自己设置 `scrollTop`；因此平滑滚动的偏好由目标元素自己决定，与插件无关。
- **设置项只有中英两种文案**，与官方内置的语言对一致。

## 许可证

MIT
