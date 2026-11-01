// utils.js — 通用工具函数，在 background 与 management 页面都可加载。
(function (global) {
  'use strict';

  const Utils = {};

  // 生成足够随机的 ID（不依赖 crypto.randomUUID 以兼容旧环境，但优先使用）。
  Utils.uuid = function () {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  Utils.now = function () {
    return Date.now();
  };

  // 格式化时间戳为本地可读字符串。
  Utils.formatTime = function (ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // 相对时间，如「3 分钟前」。
  Utils.relativeTime = function (ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const day = Math.floor(h / 24);
    if (day < 30) return `${day} 天前`;
    return Utils.formatTime(ts);
  };

  // 从 URL 提取域名。
  Utils.hostname = function (url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  };

  // 取标题首字母（用于 favicon 兜底）。
  Utils.initial = function (title) {
    const t = (title || '').trim();
    if (!t) return '?';
    const ch = t[0];
    return /[\u4e00-\u9fa5]/.test(ch) ? ch : ch.toUpperCase();
  };

  // 从字符串生成稳定的 HSL 颜色（兜底色块用）。
  Utils.colorFromString = function (str) {
    let hash = 0;
    const s = String(str || '?');
    for (let i = 0; i < s.length; i++) {
      hash = (hash << 5) - hash + s.charCodeAt(i);
      hash |= 0;
    }
    const h = Math.abs(hash) % 360;
    return `hsl(${h}, 65%, 50%)`;
  };

  // 分组预设色板。
  Utils.PALETTE = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
    '#6366f1', '#84cc16'
  ];

  // 深拷贝（仅 JSON 安全）。
  Utils.clone = function (obj) {
    return JSON.parse(JSON.stringify(obj));
  };

  // 简易去抖。
  Utils.debounce = function (fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  // HTML 转义。
  Utils.escapeHtml = function (s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // 截断字符串。
  Utils.truncate = function (s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  };

  // 判断是否为 http(s) URL。
  Utils.isHttpUrl = function (url) {
    return /^https?:\/\//i.test(String(url || ''));
  };

  // 生成带 ID 的分组默认名。
  Utils.defaultGroupName = function (index) {
    return `集锦 ${index}`;
  };

  global.Utils = Utils;
})(typeof self !== 'undefined' ? self : this);
