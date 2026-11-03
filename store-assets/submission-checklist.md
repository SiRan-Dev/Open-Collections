# Open Collections — Edge Add-ons 提交清单

> 用途：把商店后台需要填写/勾选的内容集中在一处，避免逐项查找。发布前请核对实际页面地址与文案。
> 隐私政策公开地址（商店后台填写）：https://siran-dev.github.io/Open-Collections/

## 1. 单一用途描述（Single purpose）

**中文建议：**
本地收藏与管理网页、摘录和标签页：把当前页面、批量标签页或选中文字收进分组；可选使用用户自己配置的 WebDAV 服务器同步，或调用用户自己配置的 OpenAI 兼容接口做 AI 归类。扩展不提供账号、广告、分析或与收藏无关的功能。

**English suggestion:**
A local web-page, excerpt, and tab collection manager: save the current page, batch-collect tabs, or save selected text into groups; optionally sync through a user-configured WebDAV server or organize with a user-configured OpenAI-compatible endpoint. No accounts, ads, analytics, or unrelated features.

## 2. 权限 justification（英文，逐项）

| Permission | English justification |
| --- | --- |
| `storage` | Stores the user's groups, cards, excerpts, settings, encrypted credentials, and session-only unlock state locally via `chrome.storage.local` and `chrome.storage.session`. No data is sent to the developer. |
| `sidePanel` | Displays the extension's management UI in the browser side panel so users can view and organize their collections without leaving the page. |
| `tabs` | Reads tab titles and URLs only when the user saves the current page or chooses "collect this window's tabs"; also opens/closes tabs after a batch collect when the user explicitly chooses that option. |
| `activeTab` | Grants temporary access to the active tab when the user invokes the excerpt command or clicks the excerpt button, so the extension can read the selected text. |
| `scripting` | Injects a minimal script into the active page to read `window.getSelection()` for the user-initiated "save excerpt" action only. |
| `favicon` | Uses the browser's built-in `_favicon` endpoint to display site icons for saved pages; no extra network requests are made. |
| `alarms` | Schedules periodic WebDAV sync only after the user explicitly enables cloud sync and scheduled sync; disabling sync clears the alarm. |
| Optional host permissions `<all_urls>` | Not granted by default. Requested at runtime only for the exact origins needed: reading a page selection for excerpts, the user's WebDAV server, or the user's AI endpoint. The extension does not use broad host access for any other purpose. |

审计结论：manifest 中的权限均被实际功能使用；未声明 `unlimitedStorage`、`webRequest`、`cookies` 等未使用权限。`alarms` 仅用于用户开启的定时同步。

## 3. 远程代码（Remote code）

- 是否使用远程代码：**No**
- 说明：所有 JavaScript 随扩展打包（`background.js`、`js/*.js`），不加载远程脚本，不使用 `eval`、`new Function`、动态 `import()` 或远程 `<script src>`。AI 接口只返回数据，扩展将其作为 JSON 解析，不执行模型输出。

## 4. 数据使用披露（Data types to disclose）

开发者不收集、不出售、不出租任何数据。若商店表单要求逐项声明，请按实际功能选择：

- **Web history / Website content**：用户保存的网页标题、URL、笔记与摘录保存在本机；仅在用户主动启用 WebDAV 或 AI 时，发送到用户自己填写的服务器/接口。
- **Authentication information**：WebDAV 用户名/密码与 AI API Key 保存在本机并由主密码加密；仅在用户发起同步/AI 请求时临时解密并发送到用户填写的目标。
- **Settings / preferences**：分组、颜色、分类表、开关等保存在本机。
- 不涉及健康、财务、位置、个人通信、联系人等数据类型。
- 数据不用于广告、画像、信用评估或与单一用途无关的目的。

## 5. 隐私政策

- URL：https://siran-dev.github.io/Open-Collections/
- 页面内容：中文 + English，覆盖本地存储范围、可选功能数据流、第三方仅限用户自填端点、不出售不出租不用于广告、导出/删除/撤回、https 与主密码加密、政策变更。
- 发布前确认该 URL 可公开访问（GitHub Pages 已启用）。

## 6. 商店描述草稿（每种语言 ≥ 250 字符）

**中文（≥250 字符）：**
Open Collections 是一个本地优先的网页收藏与整理工具，把「Edge 集锦」和「OneTab」的体验合在一起：一键收藏当前页面，批量把本窗口标签页收进按日期命名的「每日收件箱」，也可以保存网页选中文字为摘录。所有分组、卡片、笔记与摘录默认只保存在本机浏览器存储中，不需要账号。你可以用搜索跨分组查找内容，拖拽调整顺序或在分组之间移动，批量打开、导出 JSON / HTML 书签，并用 WebDAV 同步到你自己的服务器。可选的 AI 整理会按固定粗分类表把收件箱或主题分组归入「开发编程、学习、娱乐、生活、资讯、其他」，支持预览、缓存与撤销。AI 与云同步默认关闭，首次启用会展示发送内容与目标，只有确认后才会联网；端点仅接受 https，WebDAV 凭据与 API Key 由主密码加密保存。扩展不出售、不出租数据，不包含广告、分析或遥测。

**English（≥250 characters）：**
Open Collections is a local-first web page collection and organization tool that combines the feel of Edge Collections and OneTab: save the current page with one click, batch-collect the current window's tabs into a date-based Daily Inbox, or save selected text as an excerpt. All groups, cards, notes, and excerpts are stored locally in your browser by default, with no account required. Search across groups, drag to reorder or move cards between groups, batch-open links, export JSON or HTML bookmarks, and optionally sync to your own WebDAV server. Optional AI organization uses a fixed coarse category list (Development, Learning, Entertainment, Life, News, Other) with preview, caching, and undo. AI and cloud sync are off by default; the first enablement shows exactly what is sent and where, and only works after confirmation. Endpoints must use https, and WebDAV credentials plus the AI API key are encrypted with a master password. The extension does not sell or rent data and contains no ads, analytics, or telemetry.

## 7. Notes for certification（认证备注建议）

- AI organization and WebDAV sync are **disabled by default**; the first time the user enables either one, a confirmation panel lists the data sent and the destination. No network request is made before confirmation.
- To test AI without a real provider: open Settings → enable AI, enter a harmless https endpoint (or skip testing). The "AI Organize" button requires a configured endpoint, model, and API key; without them it only opens Settings.
- To test WebDAV without a server: the sync buttons are disabled until cloud sync is enabled; enabling requires confirmation, then requests go only to the entered https URL.
- Credentials require a master password (Settings → Master password). Set one, then enter WebDAV/AI credentials; they are encrypted at rest. Wrong master passwords are rejected; manual lock and idle auto-lock stop requests.
- Excerpt testing: select text on any http/https page, click the quote button or press Ctrl+Shift+E, and grant the requested host permission when prompted.
- Batch collect testing: open several normal http/https tabs in one window, use the add menu → "Collect this window's tabs" (does not close tabs) or "Collect and close tabs".
- No remote code, no eval/new Function, no analytics, no ads. All scripts are packaged.
- Permission prompts are runtime optional host permissions and are limited to the origin being used.

## 8. 商店后台仍需人工完成

1. 上传最新打包产物并填写隐私政策 URL（确认 Pages 可访问）。
2. 在数据使用表单中按第 4 节如实勾选并填写说明。
3. 粘贴第 6 节描述（确认字符数满足商店要求）并上传截图。
4. 在认证备注中粘贴第 7 节要点。
5. 提交后如商店要求补充权限视频或说明，按第 2 节逐项解释。
