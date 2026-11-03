# 发布与上架（Microsoft Edge Add-ons）

本文是 Open Collections 1.2.0 的发布说明与商店提交材料。商店文案、隐私政策可直接复制粘贴。

## 发布物

| 项目 | 位置 | 说明 |
| --- | --- | --- |
| 扩展包 | `dist/open-collections-1.2.0.zip` | 上传到 Partner Center 的文件 |
| 商店截图 | `store-assets/01-main.png`、`02-batch.png`、`03-sync.png` | 1280×800，PNG |
| 版本号 | `manifest.json` → `version: "1.2.0"` | 「关于」页自动读取，无需另改 |
| 图标 | `icons/icon16|32|48|128.png` | 由 `node icons/make-icons.js` 生成 |

### 本地安装（拖入 zip）

下载发布包 zip 后，打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」，把 zip 文件直接拖入页面即可安装。若浏览器不接受拖入，解压 zip 后点击「加载已解压的扩展程序」，选择解压出来的文件夹。

## 一、提交前自检

已完成的机器校验：

- `manifest.json` 可解析，MV3 字段齐全，`version` 为 `1.2.0`
- 图标 128×128 / 48×48 / 32×32 / 16×16 均为有效 PNG
- 全部 JS 通过 `node --check`；包内无远程代码、无 `eval`
- 包内不含开发文件（`.tmp/`、`store-assets/`、`RELEASE.md`、`PROGRESS.md`、`icons/make-icons.js`）

提交前请在真实浏览器里手动走一遍（这些无法自动化）：

- [ ] 首次安装自动创建「默认集锦」分组，界面不空白
- [ ] 侧边栏与独立窗口（▢ 按钮）数据联动
- [ ] 收藏当前页面（按钮 + `Ctrl+Shift+S`）
- [ ] 批量收藏：只收藏 / 收藏并关闭（关闭后留下新标签页）
- [ ] 摘录：首次点击弹窗请求网页访问权限，允许后能读选区；`Ctrl+Shift+E` 同样可用
- [ ] 搜索（跨分组）、全部打开、编辑卡片、删除卡片、拖拽排序
- [ ] 导出 JSON / 导入 JSON（合并、覆盖）/ 导出 HTML 书签
- [ ] WebDAV：测试连接、立即同步、仅上传、仅下载（需一台真实服务器，如 Nextcloud）
- [ ] 暗色模式下界面与图标可读
- [ ] 侧边栏拉到最窄（约 320px）时排版不破版

## 二、商店信息（可直接粘贴）

### 名称（≤ 45 字符）

```
Open Collections — 网页集锦与摘录
```

### 简短描述（来自 manifest，≤ 132 字符）

```
把网页与摘录收进分组：侧边栏、搜索、批量打开、备份导入导出，可选 WebDAV 云同步。
```

### 详细描述（中文）

```
Open Collections 是一个本地网页收藏夹，用来替代已下线的 Microsoft Edge「集锦（Collections）」：把网页和选中文字收进分组，随时搜索、批量打开、备份与跨设备同步。

【分组管理】
· 新建、重命名、删除分组，10 种颜色标识
· 侧栏实时显示每组条目数，拖拽调整卡片顺序

【收藏与摘录】
· 一键把当前页面收进当前分组（Ctrl+Shift+S）
· 把选中文字存成摘录卡片，保留来源标题与链接（Ctrl+Shift+E）
· 批量收藏：一次收进本窗口全部网页标签；可选择「只收藏」或「收藏并关闭」——关闭已收藏标签（含当前页）并留下一个干净的新标签页，固定标签自动跳过
· 可选 OneTab 模式：批量收藏按本地日期归入每日标签页，当天多次收藏追加到同一组

【查找与使用】
· 跨全部组搜索标题、URL、笔记与摘录正文，结果标注所属分组
· 单击卡片直接打开原链接；悬停可快速编辑（✎）或删除（🗑）
· 「全部打开」一键在新标签页打开本组所有链接
· 可选 AI 整理：自带 OpenAI 兼容接口，预览建议分组后再应用，支持撤销
· 独立窗口（默认 1200×850，可调整并记住）与侧边栏共用同一份数据，适合大屏整理

【数据与同步】
· 全部数据保存在浏览器本地（chrome.storage.local），不上传
· JSON 完整备份：合并导入 / 覆盖导入，覆盖前自动快照
· Netscape HTML 书签导出，可导入浏览器收藏夹
· 可选 WebDAV 云同步（兼容 Nextcloud 等标准服务）：支持定时自动同步，按条目时间戳合并冲突，删除使用墓碑标记不会误伤新内容

【隐私】
· 无账号、无分析统计、无广告、无遥测、无远程代码
· AI 整理与 WebDAV 同步默认关闭；首次启用会展示发送内容与目标，确认后才生效
· 只有你主动点击「摘录」、启用并确认 WebDAV 或 AI 整理时，才会申请网页访问权限或发起网络请求
· 端点仅接受 https；WebDAV 凭据与 AI API Key 经本机自动生成的保险库密钥加密后只保存在本机（无需设置任何密码），仅发送给你自己填写的服务器或接口

【快捷键】
Ctrl+Shift+S 收藏当前页面 · Ctrl+Shift+E 保存摘录 · Ctrl+Shift+O 打开侧边栏（建议键位，实际以浏览器快捷键设置为准）
（可在 edge://extensions/shortcuts 中修改）

适合需要「稍后读」、整理资料、收集设计灵感与开发文档的用户。纯本地、无构建、开源可审查。
```

### 详细描述（英文，可选，用于多语言列表）

```
Open Collections is a local bookmark manager that replaces Microsoft Edge's retired Collections feature. Save pages and selected text into groups, search everything, open a whole group at once, and back up or sync across devices.

• Groups: create, rename, delete, 10 colors, per-group item count, drag to reorder cards.
• Save pages with one click (default shortcut Ctrl+Shift+S); save selected text as an excerpt with its source (default shortcut Ctrl+Shift+E). Shortcuts are suggestions and can be changed in the browser.
• Batch collect: pull every web tab in the current window into the active group, optionally closing them afterwards (pinned tabs are skipped) and leaving one fresh tab behind.
• Optional OneTab mode: batch collections go into a date-named daily group, with multiple collections on the same day appended together.
• Search across all groups by title, URL, notes and excerpt text.
• Open all links in a group at once; edit or delete a card straight from its hover actions.
• Optional AI organization with your own OpenAI-compatible endpoint: preview suggested groups before applying, with undo.
• Standalone window (480×720) shares the same data as the side panel.
• JSON backup with merge/overwrite import, Netscape HTML export, and optional WebDAV sync (Nextcloud compatible) with per-item conflict resolution.

Privacy: no account, no analytics, no ads, no telemetry, no remote code. AI organization and WebDAV sync are off by default; the first enablement shows what is sent and where, and only works after confirmation. Web access is requested only when you click "Excerpt" or enable and confirm WebDAV/AI. Endpoints must use https; credentials and keys are encrypted with a locally generated vault key (no password to set or remember), stored locally, and sent only to the server or endpoint you configure.
```

### 分类

```
效率（Productivity）
```

### 搜索词（最多 7 个，每个 ≤ 30 字符，合计 ≤ 21 个单词）

```
网页收藏夹
集锦
书签管理
摘录
侧边栏
collections
read later
```

### 隐私政策 URL（已发布）

```
https://siran-dev.github.io/Open-Collections/privacy.html
```

源文件是 `docs/privacy.html`，通过 GitHub Pages 发布（首页 `docs/index.html` 为产品介绍页）。修改政策后推送该文件即可自动更新，URL 不用换。

## 三、权限用途说明（填在认证说明中）

```
本扩展不使用账号系统，不上传用户数据，不含分析/广告/远程代码。各权限用途：

- storage：保存分组、卡片与设置在 chrome.storage.local。
- sidePanel：提供浏览器侧边栏界面。
- tabs：读取标签页标题与 URL，仅用于「添加当前页面」与「批量收藏本窗口标签页」；不记录、不传输浏览历史。
- activeTab：在用户点击按钮或按快捷键时访问当前标签页。
- scripting：仅在用户点击「摘录」或按 Ctrl+Shift+E 时读取当前页面的选中文字。
- favicon：通过浏览器内置 _favicon 接口显示站点图标，不额外发起网络请求。
- alarms：仅在用户勾选「定时自动同步」后用于 WebDAV 同步计时。
- optional_host_permissions(<all_urls>)：不是默认授予。仅在用户点击「摘录」时申请读取当前页选区；WebDAV 同步或 AI 整理时申请用户自填服务器的网络访问。用户拒绝后扩展其余功能仍可用。
```

### 认证测试说明

```
无需登录，安装后即可使用。
1. 点击工具栏图标打开侧边栏，首次安装已自动创建「默认集锦」分组。
2. 任意网页点「添加当前页面」或按 Ctrl+Shift+S 收藏。
3. 在网页选中文字后点「摘录」，浏览器会弹出网页访问权限请求，允许后保存成功；拒绝时界面会提示改用快捷键。
4. 「添加」右侧下拉菜单可批量收藏本窗口标签，其中「收藏并关闭标签页」会关闭已收藏标签（含当前页）并留下一个新标签页。
5. WebDAV 为可选功能，测试连接需要用户自己的 WebDAV 服务器；未配置时其余功能不受影响。
```

## 四、隐私政策（全文，已发布为公开页面）

```markdown
# Open Collections 隐私政策

最后更新：2026-11-03

Open Collections（以下简称"本扩展"）是一个本地网页收藏工具。本政策说明本扩展会处理哪些信息、存放在哪里，以及与谁共享。

## 1. 我们不收集你的数据

本扩展不含账号系统、分析统计、广告 SDK、遥测或远程代码。开发者不会收到你的任何数据，也不会将其出售或共享给第三方；只有你主动配置的 WebDAV 服务器或 AI 接口会收到你主动发送的数据。

## 2. 本扩展在本地处理的信息

仅当你主动操作时，本扩展才会处理以下信息，且全部保存在你本机的浏览器存储（chrome.storage.local）中：

- 你收藏的网页：标题、网址、站点图标、收藏时间
- 你保存的摘录：选中文字、来源标题与网址
- 你填写的笔记、分组名称与颜色
- 扩展设置：包括启用 WebDAV 时填写的服务器地址、用户名与密码，以及启用 AI 整理时填写的接口地址、API Key、模型名称与分类表；其中用户名、密码与 API Key 经本机自动生成的保险库密钥加密后保存
- AI 分类缓存（内容哈希与分类结果），仅保存在本机，用于避免重复调用接口

## 3. 网络访问

- 站点图标：通过浏览器内置的 `_favicon` 接口读取，不向站点或第三方发起额外请求。
- 摘录：只在你点击「摘录」或按 Ctrl+Shift+E 时，读取当前页面中你选中的文字。不会读取页面其他内容。
- WebDAV 同步：只在你点击「测试连接」「立即同步」「仅上传」「仅下载」，或你主动开启「定时自动同步」后，向**你自己填写的** WebDAV 服务器发起请求。数据与凭据只发送到该服务器。
- AI 整理：只在你点击「AI 整理」或设置中的「测试连接」时，向**你自己填写的** OpenAI 兼容接口发送当前分组的标题、URL、笔记与摘录片段，以及用于认证的 API Key。开发者不会收到这些数据；请自行确认该接口运营方的隐私与数据处理政策。
- 除上述情况外，本扩展不发起任何网络请求。

## 4. 权限用途

- `storage`：保存分组、卡片与设置
- `sidePanel`：显示侧边栏界面
- `tabs`：读取标签标题与网址，用于收藏当前页与批量收藏本窗口标签
- `activeTab` / `scripting`：在你点击「摘录」或按快捷键时读取当前页选中文字
- `favicon`：显示站点图标
- `alarms`：在你开启定时同步后进行计时
- 可选的主机权限（`<all_urls>`）：默认不授予，仅在你点击「摘录」，或使用 WebDAV / AI 时按需申请对应站点的访问权限

## 5. 数据的保存与删除

- 数据保存在本机浏览器存储中；卸载扩展会清除全部本地数据。
- 你可以在界面内随时删除分组或卡片，也可以用「导入 JSON（覆盖）」替换全部数据。
- 若启用 WebDAV，云端副本存放于你自己的服务器，由你自行管理与删除。

## 6. 凭据安全

WebDAV 用户名、密码与 AI 接口的 API Key 使用本机自动生成的随机 256 位保险库密钥（经同样随机生成的本机设备密钥封装后存于浏览器存储）以 AES-GCM 加密保存；磁盘不保存明文，整个使用过程无需输入任何密码，发起请求时只在内存中临时解密。该措施能降低浏览器存储被离线读取（如拷贝浏览器配置、备份泄露）时的泄露风险，但不能防御已能读取本机浏览器配置或扩展内存的恶意程序/扩展（设备密钥与保险库记录在同一存储中），也不能替代系统磁盘加密。若担心本机被他人使用，请不要启用同步或 AI 整理，或使用专用的低权限账号 / 应用专用密码。

## 7. 儿童隐私

本扩展不是面向儿童的产品，也不会有意处理儿童的个人信息。

## 8. 政策变更

如本政策发生变化，会更新本页面顶部的日期。

## 9. 联系方式

如有疑问，请联系：313007674+SiRan-Dev@users.noreply.github.com
```

> 以上全文即 `docs/privacy.html` 的内容，已发布在 https://siran-dev.github.io/Open-Collections/privacy.html ，可直接作为商店的隐私政策 URL。

## 五、上架步骤

1. 用 Microsoft 账号登录 [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)，加入 **Microsoft Edge 扩展计划**（免费）。
2. **新建扩展** → 填写扩展名称 → 上传 `dist/open-collections-1.2.0.zip`。
3. **属性**：选择分类「效率」，勾选支持的平台与语言。
4. **隐私**：当被问到是否访问、收集或传输个人信息时选择 **是**（本扩展会处理标签页标题、网址与你保存的摘录等），并填入隐私政策 URL。
5. **商店列表**（中文）：粘贴上面的名称、简短描述、详细描述，上传 3 张 1280×800 截图，填写搜索词与隐私政策 URL。
6. **认证说明**：粘贴「三、权限用途说明」中的两段文字。
7. 提交后进入认证，官方说明最长 **7 个工作日**；通过后状态变为「在商店中」。

## 六、审核风险与规避

| 风险点 | 现状 | 应对 |
| --- | --- | --- |
| `tabs` + 可选 `<all_urls>` 被认为权限过宽 | 批量收藏需要读取标签标题/网址；`<all_urls>` 是 `optional_host_permissions`，运行时才申请 | 提交「权限用途说明」，并在描述中写明只在用户点击时使用 |
| 隐私数据声明不符 | 扩展确实处理标签页与摘录内容 | 隐私问卷选择「是」并提供政策 URL |
| 远程代码 | 全部脚本在包内，无 eval、无外部 JS | 无需处理；保持现状 |
| 截图与功能不一致 | 截图均来自真实界面渲染 | 功能变更后同步更新截图 |
| 空白首次体验 | 首次安装自动建「默认集锦」 | 已实现 |

## 七、后续发版流程

1. 修改 `manifest.json` 的 `version`（「关于」页会自动显示新版本，无需改 HTML）。
2. 如需改图标：编辑 `icons/make-icons.js` 顶部常量后执行 `node icons/make-icons.js`。
3. 重新打包（PowerShell，在项目根目录）：

```powershell
$v = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$stage = ".tmp/package"
Remove-Item -Recurse -Force $stage, "dist" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage, "dist" | Out-Null
Copy-Item manifest.json, background.js, management.html, management.css, LICENSE -Destination $stage
Copy-Item js -Destination $stage -Recurse
New-Item -ItemType Directory -Force "$stage/icons" | Out-Null
Copy-Item icons/icon16.png, icons/icon32.png, icons/icon48.png, icons/icon128.png -Destination "$stage/icons"
Compress-Archive -Path "$stage/*" -DestinationPath "dist/open-collections-$v.zip"
```

4. 把 `dist/open-collections-$v.zip` 拖到 `edge://extensions` 自测（拖入不被接受时，解压后「加载已解压的扩展程序」指向 `.tmp/package`），确认无误再上传新包。
5. 商店页面的截图与描述若功能有变化，同步更新 `store-assets/` 与本文。
