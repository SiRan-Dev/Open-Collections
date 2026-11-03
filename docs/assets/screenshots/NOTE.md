# 截图说明（NOTE）

本目录截图**全部使用演示数据**，不包含任何真实用户数据；界面由仓库内的 `management.html` / `management.css` / `js/` **原样渲染**（无修图、无 PS、无二次绘制）。

## 生成方式

- 脚本：`tools/screenshots/capture.cjs`（不进发布包）。
- 方法：在无头 Chrome 中以 `file://` 直接打开 `management.html`，在页面脚本执行前注入 `chrome` API stub（`storage.local` 内存存储、`runtime.getManifest/getURL/sendMessage`、`commands.getAll`、`tabs/windows/permissions/alarms/sidePanel` 等，覆盖页面真实调用面），并由 stub 预置演示数据与设置。
- 侧边栏形态：侧边栏是浏览器 UI 层，无法直接截取；`sidebar.png` 使用**同源页面在 380px 视口**渲染（CSS 媒体查询一致），图注统一标注「视口模拟」。
- AI 整理预览（`ai-preview.png`）：对演示接口地址的 `/chat/completions` 请求在页面内拦截并返回固定方案（**mock**），分类逻辑、缓存复用与固定条目免疫均为真实代码路径。
- favicon：演示卡片使用内联 SVG 数据 URI（彩色字母块），未请求任何外部站点图标，无裂图。

## 演示数据

- 分组：受保护的「默认集锦」+ 开发编程 / 学习 / 娱乐 / 生活 / 资讯 / 其他 + 每日收件箱 2026-11-01。
- 卡片：16 张，全部为公开站点（GitHub Docs、MDN、React/Vue/TS 官方文档、Bilibili 学习视频、Steam、少数派、InfoQ 等），含 2 条摘录、2 条笔记、2 个已固定条目、1 组同 URL 重复（用于去重统计展示）；时间戳分布在近几天。

## 文件清单

| 文件 | 尺寸（CSS px × DPR） | 用途 |
| --- | --- | --- |
| sidebar.png | 380×800 @2x | 侧边栏形态（分组区可见），视口模拟 |
| standalone.png | 1200×850 @1x | 独立管理窗口默认视图 |
| pinned.png | 1200×850 @1x | 默认集锦「已固定」区与图钉按钮 |
| settings-general.png | 1200×850 @1x | 设置页 · 概览（四张状态卡片） |
| settings-ai.png | 1200×850 @1x | 设置页 · AI 整理 |
| settings-sync.png | 1200×850 @1x | 设置页 · 云同步（同步范围） |
| shortcut.png | 1200×850 @1x | 设置页 · 快捷键 |
| ai-preview.png | 1200×850 @1x | AI 整理预览（mock 响应，新增/缓存/去重统计 + 固定免疫提示） |

校验：每张均通过「无横向滚动、无溢出、无裂图」自动检查（脚本内断言，退出码非零即失败）。
