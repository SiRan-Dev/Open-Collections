// tools/screenshots/capture.cjs — 离线截图：file:// 渲染仓库前端 + chrome API stub + 演示数据。
// 运行：node tools/screenshots/capture.cjs
// 依赖：puppeteer-core（优先 NODE_PATH 解析，回落到 %TEMP%\oc-media\node_modules）；
// 浏览器：%TEMP%\oc-media\browsers\chrome\win64-*\chrome-win64\chrome.exe（或环境变量 OC_CHROME 指定）。
const path = require('path');
const fs = require('fs');

function requirePuppeteer() {
  try { return require('puppeteer-core'); } catch (e) {}
  return require(path.join(process.env.TEMP, 'oc-media', 'node_modules', 'puppeteer-core'));
}

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'assets', 'screenshots');
const CHROME = process.env.OC_CHROME || (() => {
  const base = path.join(process.env.TEMP, 'oc-media', 'browsers', 'chrome');
  const dir = fs.readdirSync(base).find((d) => d.startsWith('win64-'));
  return path.join(base, dir, 'chrome-win64', 'chrome.exe');
})();

// ---- 演示数据（公开站点，无个人数据）----
const HOUR = 3600000;
const DAY = 86400000;
const now = Date.now();
function faviconDataUri(letter, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="${color}"/><text x="16" y="22" font-family="Segoe UI,Arial" font-size="17" font-weight="600" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
function card(id, title, url, extra) {
  return Object.assign({
    id, type: 'page', title, url,
    favicon: extra && extra.favicon ? extra.favicon : faviconDataUri(title[0], '#64748b'),
    notes: '', excerpt: '', sourceTitle: '', sourceUrl: '',
    addedAt: now - 2 * DAY, updatedAt: now - 2 * DAY, deleted: false, deletedAt: null, pinned: false
  }, extra || {});
}
function group(id, name, color, cards, extra) {
  return Object.assign({
    id, name, color, createdAt: now - 30 * DAY, updatedAt: now - HOUR,
    deleted: false, deletedAt: null, cards: cards || []
  }, extra || {});
}

const sysId = 'g-default';
const groups = [
  group(sysId, '默认集锦', '#3b82f6', [
    card('c-sys-1', 'GitHub 官方文档 - Get started', 'https://docs.github.com/en/get-started', { pinned: true, addedAt: now - 5 * HOUR }),
    card('c-sys-2', 'MDN Web Docs - JavaScript 指南', 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Guide', { pinned: true, addedAt: now - 26 * HOUR }),
    card('c-sys-3', 'React 中文文档 - 快速开始', 'https://zh-hans.react.dev/learn', { addedAt: now - 30 * HOUR }),
    card('c-sys-4', 'Vue 3 官方教程', 'https://cn.vuejs.org/tutorial/', { addedAt: now - 2 * DAY }),
    card('c-sys-5', 'TypeScript 入门教程', 'https://ts.xcatliu.com/', { addedAt: now - 3 * DAY }),
    card('c-sys-6', 'B 站 - 前端工程化系列课', 'https://www.bilibili.com/video/BV1wS411P7ov', { addedAt: now - 3 * DAY }),
    card('c-sys-7', 'CSS 布局速查', 'https://csslayout.io/', { addedAt: now - 4 * DAY }),
    card('c-sys-8', 'CSS 布局速查', 'https://csslayout.io/', { addedAt: now - 4 * DAY + HOUR })
  ], { system: true }),
  group('g-dev', '开发', '#0ea5e9', [
    card('c-dev-1', 'Vite 官方指南', 'https://vitejs.dev/guide/', { addedAt: now - 2 * DAY }),
    card('c-dev-2', 'Node.js API 文档', 'https://nodejs.org/api/', { addedAt: now - 5 * DAY }),
    card('c-dev-3', '正则表达式速查', 'https://regexlearn.com/zh-cn', { notes: '第三章的反向引用例子值得收藏', addedAt: now - 6 * DAY })
  ]),
  group('g-learn', '学习', '#10b981', [
    card('c-learn-1', '少数派 - 如何搭建个人知识库', 'https://sspai.com/post/68888', { addedAt: now - DAY }),
    card('c-learn-2', 'B 站 - 高等数学公开课', 'https://www.bilibili.com/video/BV1jt411d76o', {
      type: 'excerpt', title: '摘录：泰勒展开的几何直觉', excerpt: '泰勒级数本质上是用多项式在局部逼近函数，阶数越高逼近区间越大。这是理解数值方法误差来源的关键。',
      sourceTitle: '高等数学公开课', sourceUrl: 'https://www.bilibili.com/video/BV1jt411d76o', addedAt: now - 2 * DAY
    })
  ]),
  group('g-fun', '娱乐', '#f59e0b', [
    card('c-fun-1', 'Steam 秋季特卖页', 'https://store.steampowered.com/sale/autumn', { addedAt: now - 12 * HOUR }),
    card('c-fun-2', '摘录：本周独立游戏推荐', 'https://indienova.com/', {
      type: 'excerpt', excerpt: '《山海旅人》《风来之国》《笼中窥梦》都进入了史低，优先补票《风来之国》。',
      sourceTitle: 'indienova', sourceUrl: 'https://indienova.com/', addedAt: now - 2 * DAY
    })
  ]),
  group('g-life', '生活', '#a855f7', [
    card('c-life-1', '下厨房 - 一周便当合集', 'https://www.xiachufang.com/', { notes: '周三的照烧鸡腿可以试试', addedAt: now - 4 * DAY })
  ]),
  group('g-news', '资讯', '#ef4444', [
    card('c-news-1', 'InfoQ 中文站', 'https://www.infoq.cn/', { addedAt: now - 6 * HOUR })
  ]),
  group('g-other', '其他', '#64748b', []),
  group('daily-2026-11-01', '2026-11-01', '#10b981', [
    card('c-daily-1', 'B 站 - Docker 入门 40 分钟', 'https://www.bilibili.com/video/BV1og4y1q7M4', { addedAt: now - 2 * DAY }),
    card('c-daily-2', '阮一峰的网络日志', 'https://www.ruanyifeng.com/blog/', { addedAt: now - 2 * DAY })
  ])
];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const commandsAll = Object.entries(manifest.commands || {}).map(([name, def]) => ({
  name,
  description: def.description || '',
  shortcut: (def.suggested_key && def.suggested_key.default) || ''
}));

const settingsSeed = {
  webdav: { enabled: false, url: '', username: '', password: '', remoteDir: '/open-collections', autoSync: false, intervalMinutes: 30, syncScope: { aiCache: false, backups: false } },
  behavior: { batchCollectDaily: true, aiIncludeInbox: false, allowDuplicateLinks: false },
  ai: { enabled: true, baseUrl: 'https://api.demo.example.com/v1', apiKey: 'sk-demo-not-real', model: 'demo-model', categories: ['开发', '学习', '娱乐', '生活', '资讯', '其他'] },
  security: null, secretsV: 0, secrets: {}
};

const storeSeed = {
  'openpocket:v1': { version: 1, activeGroupId: sysId, groups },
  'openpocket:settings': settingsSeed,
  'openpocket:onboarding': { dismissed: true },
  'openpocket:fold-state': { sidepanel: false, standalone: false },
  'openpocket:ai-cache': {}
};

const AI_PLAN = JSON.stringify({
  summary: 'AI 建议归入 3 个分类，已固定条目不参与整理。',
  groups: [
    { name: '学习', cardIds: ['c1'], reason: '文档与教程' },
    { name: '开发', cardIds: ['c2', 'c3'], reason: '框架与工具' },
    { name: '娱乐', cardIds: ['c4'], reason: '视频内容' }
  ]
});

// ---- chrome stub（覆盖页面实际调用面）----
function stubSource() {
  return `
    (() => {
      const store = ${JSON.stringify(storeSeed)};
      const clone = (v) => JSON.parse(JSON.stringify(v));
      const listeners = { changed: [], message: [] };
      window.chrome = {
        runtime: {
          id: 'abcdefghijklmnopabcdefghijklmnop',
          lastError: null,
          getManifest: () => (${JSON.stringify(manifest)}),
          getURL: (p) => p,
          sendMessage: (msg, cb) => { if (cb) setTimeout(() => cb({ ok: true }), 0); return Promise.resolve({ ok: true }); },
          onMessage: { addListener: (fn) => listeners.message.push(fn) }
        },
        storage: {
          local: {
            get(key, cb) {
              let out = {};
              if (key == null) out = clone(store);
              else if (typeof key === 'string') { if (key in store) out[key] = clone(store[key]); }
              else if (Array.isArray(key)) { for (const k of key) if (k in store) out[k] = clone(store[k]); }
              else if (key && typeof key === 'object') { for (const k of Object.keys(key)) out[k] = (k in store) ? clone(store[k]) : clone(key[k]); }
              setTimeout(() => cb(out), 0);
            },
            set(items, cb) { Object.assign(store, clone(items)); setTimeout(() => cb && cb(), 0); },
            remove(key, cb) { (Array.isArray(key) ? key : [key]).forEach((k) => delete store[k]); setTimeout(() => cb && cb(), 0); }
          },
          session: {
            get(key, cb) { setTimeout(() => cb({}), 0); },
            set(items, cb) { setTimeout(() => cb && cb(), 0); },
            remove(key, cb) { setTimeout(() => cb && cb(), 0); }
          },
          onChanged: { addListener: () => {} }
        },
        commands: { getAll: (cb) => setTimeout(() => cb(${JSON.stringify(commandsAll)}), 0) },
        permissions: { contains: (o, cb) => cb(true), request: (o, cb) => cb(true) },
        tabs: {
          query: async () => [], get: async () => null,
          create: async () => ({ id: 1 }), remove: async () => {},
          onActivated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} }
        },
        windows: {
          getLastFocused: async () => null, getAll: async () => [], get: async () => null,
          create: async () => ({ id: 99 }), update: async () => ({}),
          onCreated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
          onFocusChanged: { addListener: () => {} }, onBoundsChanged: { addListener: () => {} }
        },
        alarms: { create: () => {}, clear: async () => {}, onAlarm: { addListener: () => {} } },
        sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
        notifications: { create: () => {}, clear: () => {} }
      };
      // AI 预览：拦截对演示接口的请求，返回固定方案（mock，仅用于截图）。
      const realFetch = window.fetch ? window.fetch.bind(window) : null;
      window.fetch = async (url, init) => {
        if (String(url).includes('/chat/completions')) {
          return new Response(JSON.stringify({
            model: 'demo-model',
            choices: [{ message: { role: 'assistant', content: ${JSON.stringify(AI_PLAN)} } }],
            usage: { total_tokens: 64 }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (realFetch) return realFetch(url, init);
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
    })();
  `;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const puppeteer = requirePuppeteer();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1']
  });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluateOnNewDocument(stubSource());
  page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text()); });

  const fileUrl = 'file:///' + ROOT.replace(/\\/g, '/') + '/management.html';
  const results = [];
  async function shot(name, desc, checks) {
    await sleep(250);
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    const check = await page.evaluate(() => {
      const broken = Array.from(document.querySelectorAll('img'))
        .filter((img) => img.complete && img.naturalWidth === 0 && img.src).length;
      return {
        scrollW: document.scrollingElement.scrollWidth,
        innerW: window.innerWidth,
        broken
      };
    });
    const ok = check.broken === 0 && check.scrollW <= check.innerW + 1;
    results.push({ name, desc, ...check, ok });
    console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + ` (scrollW=${check.scrollW} innerW=${check.innerW} brokenImg=${check.broken})`);
  }

  // 1. 侧边栏（380px，分组区展开）
  await page.setViewport({ width: 380, height: 800, deviceScaleFactor: 2 });
  await page.goto(fileUrl, { waitUntil: 'networkidle0' });
  await sleep(700);
  await shot('sidebar.png', '侧边栏 380px 视口（分组区可见，与真实侧栏同源 HTML/CSS）');

  // 2. 独立窗口（1200×850，standalone 场景）
  await page.setViewport({ width: 1200, height: 850, deviceScaleFactor: 1 });
  await page.goto(fileUrl + '?standalone=1', { waitUntil: 'networkidle0' });
  await sleep(700);
  await shot('standalone.png', '独立管理窗口 1200×850（顶部单一收藏主按钮）');

  // 3. 默认集锦固定区特写（截列表区域）
  await shot('pinned.png', '默认集锦「已固定」区与图钉按钮');

  // 4-6. 设置页：概览 / AI 整理 / 云同步
  await page.click('#btn-settings');
  await sleep(600);
  await shot('settings-general.png', '设置页 · 概览');
  await page.click('#settings-nav [data-goto="ai-settings-section"]');
  await sleep(300);
  await shot('settings-ai.png', '设置页 · AI 整理');
  await page.click('#settings-nav [data-goto="webdav-section"]');
  await sleep(300);
  await shot('settings-sync.png', '设置页 · 云同步');

  // 7. 快捷键设置区
  await page.click('#settings-nav [data-goto="shortcuts-section"]');
  await sleep(400);
  await shot('shortcut.png', '设置页 · 快捷键');

  // 8. AI 整理预览：先播种 2 条分类缓存（复用页面自身 AI.cacheKey），再发起整理
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.evaluate(async () => {
    const data = await Storage.load();
    const g = data.groups.find((x) => x.system);
    const cats = ['开发', '学习', '娱乐', '生活', '资讯', '其他'];
    const uncached = g.cards.filter((c) => !c.deleted && !c.pinned).slice(0, 2);
    const entries = uncached.map((c) => ({ key: AI.cacheKey(c, cats), category: '学习' }));
    await Storage.saveAiCacheEntries(entries);
  });
  await sleep(200);
  await page.click('#btn-ai-organize');
  await page.waitForSelector('#ai-proposal:not(.hidden)', { timeout: 15000 });
  await sleep(500);
  await shot('ai-preview.png', 'AI 整理预览（mock 响应：分类方案 + 新增/缓存/去重统计 + 固定条目免疫提示）');

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log('DONE ' + results.length + ' shots, failed: ' + failed.length);
  if (failed.length) process.exit(2);
})().catch((e) => {
  console.error(e && (e.stack || e.message) || e);
  process.exit(1);
});
