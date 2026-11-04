// secret.js — 免密本地加密：随机保险库密钥（AES-GCM-256）+ 本机设备密钥封装。
// 首次运行自动生成 256 位保险库密钥，用同样随机生成的本机设备密钥封装后存 storage.local，
// 启动时自动解封，全程无感，无需用户输入任何密码。
//
// 威胁模型（如实告知，不夸大）：
// - 能防：直接读取 chrome.storage.local 的离线拷贝/备份泄露时，敏感字段呈密文形态，
//   普通查看无法直接读出明文。
// - 不能防：已能读取本机浏览器配置/内存的恶意程序或恶意扩展（设备密钥也在同一存储里，
//   只是分离保存便于轮换）；本机保险箱不是 TPM。
//
// 兼容：保留 PBKDF2 派生与旧密文解密能力，仅供「旧版主密码数据」一次性迁移使用。
(function (global) {
  'use strict';

  const VAULT_KEY = 'openpocket:vault';
  const IV_BYTES = 12;
  const KEY_BYTES = 32; // 256 位
  const CANARY = 'open-collections-master-key-check';
  const MIGRATION_ITERATIONS = 600000;

  function webcrypto() {
    const c = global.crypto;
    if (!c || !c.subtle) throw new Error('当前环境不支持 Web Crypto，无法加密凭据');
    return c;
  }

  function toB64(bytes) {
    let binary = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return btoa(binary);
  }

  function fromB64(text) {
    const binary = atob(String(text || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function encryptText(key, text) {
    const c = webcrypto();
    const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
    const data = await c.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(String(text == null ? '' : text))
    );
    return { iv: toB64(iv), v: toB64(new Uint8Array(data)) };
  }

  async function decryptText(key, envelope) {
    if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.v !== 'string') {
      throw new Error('密文格式不完整');
    }
    const c = webcrypto();
    const plain = await c.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(envelope.iv) },
      key,
      fromB64(envelope.v)
    );
    return new TextDecoder().decode(plain);
  }

  async function importRawKey(bytes, usages) {
    return webcrypto().subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, true, usages);
  }

  // 读取保险库记录。必须区分「键不存在」与「读取失败」：前者可以安全地创建新保险库，
  // 后者若被当成“不存在”会覆盖旧记录，使旧凭据永久无法解密（OCP-CONF-015）。
  function readVaultRaw() {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(VAULT_KEY, (items) => {
          if (chrome.runtime.lastError) {
            reject(new Error('读取本地保险库失败：' + chrome.runtime.lastError.message));
            return;
          }
          if (items == null || typeof items !== 'object') {
            reject(new Error('读取本地保险库失败：返回数据无效'));
            return;
          }
          const raw = items[VAULT_KEY];
          resolve(raw && typeof raw === 'object' ? raw : null);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function writeVaultRaw(record) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [VAULT_KEY]: record }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(record);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function removeVaultRaw() {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.remove(VAULT_KEY, () => {
          if (chrome.runtime.lastError) reject(new Error('删除本地保险库失败：' + chrome.runtime.lastError.message));
          else resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  let memoryKey = null;
  let memoryKeyFingerprint = '';
  let ensurePromise = null;

  // 保险库记录指纹：其他上下文清除/重建保险库时，本上下文必须丢弃旧的内存密钥，
  // 否则会用旧密钥加密新凭据，生成无法解密的孤儿密文（OCP-CONF-016）。
  function vaultFingerprint(record) {
    if (!record || typeof record.deviceKey !== 'string' || !record.wrappedKey) return '';
    const w = record.wrappedKey;
    return [record.deviceKey, w.iv || '', w.v || ''].join('|');
  }

  function forgetMemoryKey() {
    memoryKey = null;
    memoryKeyFingerprint = '';
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !changes[VAULT_KEY]) return;
      forgetMemoryKey();
    });
  }

  // 首次创建 / 解封必须串行：两个上下文同时判断“没有保险库”会各自生成一把密钥，
  // 后写入的记录覆盖先写入的，先写入一方加密的凭据将永远无法解密。
  function withVaultLock(task) {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (nav && nav.locks && typeof nav.locks.request === 'function') {
      return Promise.resolve(nav.locks.request('openpocket:vault-key', () => Promise.resolve().then(task)));
    }
    return Promise.resolve().then(task);
  }

  async function ensureKeyNow() {
    const record = await readVaultRaw();
    if (!record) {
      await createVault();
      return memoryKey;
    }
    memoryKey = await unwrapVault(record);
    memoryKeyFingerprint = vaultFingerprint(record);
    return memoryKey;
  }

  // 首次运行创建保险库：随机设备密钥 + 随机保险库密钥（用设备密钥封装）。
  async function createVault() {
    const c = webcrypto();
    const deviceBytes = c.getRandomValues(new Uint8Array(KEY_BYTES));
    const vaultBytes = c.getRandomValues(new Uint8Array(KEY_BYTES));
    const deviceKey = await importRawKey(deviceBytes, ['encrypt', 'decrypt']);
    const vaultKey = await importRawKey(vaultBytes, ['encrypt', 'decrypt']);
    const wrapped = await encryptText(deviceKey, toB64(vaultBytes));
    const record = {
      schema: 2,
      createdAt: Date.now(),
      deviceKey: toB64(deviceBytes),
      wrappedKey: wrapped
    };
    await writeVaultRaw(record);
    memoryKey = vaultKey;
    memoryKeyFingerprint = vaultFingerprint(record);
    return record;
  }

  // 解封保险库：用存储的设备密钥解开保险库密钥。
  async function unwrapVault(record) {
    if (!record || typeof record.deviceKey !== 'string' || !record.wrappedKey) {
      throw new Error('保险库数据不完整');
    }
    const deviceKey = await importRawKey(fromB64(record.deviceKey), ['encrypt', 'decrypt']);
    const vaultB64 = await decryptText(deviceKey, record.wrappedKey);
    const vaultKey = await importRawKey(fromB64(vaultB64), ['encrypt', 'decrypt']);
    return vaultKey;
  }

  const Vault = {
    VAULT_KEY: VAULT_KEY,
    CANARY: CANARY,
    MIGRATION_ITERATIONS: MIGRATION_ITERATIONS,

    // 启动自动解封；无保险库时自动创建。全程无感。
    // 缓存命中时校验 storage 中的 vault 记录指纹：其他上下文清除/重建保险库后，
    // 本上下文不能继续使用旧密钥（OCP-CONF-016）。
    async ensureKey() {
      if (memoryKey) {
        if (!memoryKeyFingerprint) return memoryKey;
        try {
          const record = await readVaultRaw();
          if (record && vaultFingerprint(record) === memoryKeyFingerprint) return memoryKey;
        } catch (e) {
          throw e;
        }
        forgetMemoryKey();
      }
      if (ensurePromise) return ensurePromise;
      ensurePromise = withVaultLock(ensureKeyNow).finally(() => { ensurePromise = null; });
      return ensurePromise;
    },

    isReady() {
      return !!memoryKey;
    },

    // 保险库信息（用于设置页展示），不暴露任何密钥。
    async getInfo() {
      const record = await readVaultRaw();
      if (!record) return { exists: false, createdAt: null };
      return { exists: true, createdAt: record.createdAt || null, schema: record.schema || 0 };
    },

    // 清除本地密钥：丢弃保险库；调用方负责同时清除已加密凭据（不可逆）。
    // 等待在途 ensureKey 后删除记录，避免“清空后又立刻被 ensureKey 重建”。
    async clear() {
      forgetMemoryKey();
      try {
        if (ensurePromise) await ensurePromise;
      } catch (e) {}
      await withVaultLock(async () => {
        await removeVaultRaw();
      });
      forgetMemoryKey();
    },

    encrypt(key, text) {
      return encryptText(key, text);
    },

    decrypt(key, envelope) {
      return decryptText(key, envelope);
    },

    // ---- 旧版主密码数据的一次性迁移工具 ----

    // 用旧主密码派生密钥并解密其 canary，验证密码正确性；返回派生密钥。
    async verifyLegacyPassword(password, security) {
      if (!security || !security.salt || !security.check) {
        throw new Error('旧版加密数据不完整，无法迁移');
      }
      let salt;
      try {
        salt = fromB64(security.salt);
      } catch (e) {
        throw new Error('旧版加密数据的 salt 已损坏，无法迁移');
      }
      const c = webcrypto();
      const material = await c.subtle.importKey(
        'raw',
        new TextEncoder().encode(String(password || '')),
        'PBKDF2',
        false,
        ['deriveKey']
      );
      const key = await c.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt,
          iterations: Number(security.iterations) || MIGRATION_ITERATIONS,
          hash: 'SHA-256'
        },
        material,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      let plain;
      try {
        plain = await decryptText(key, security.check);
      } catch (e) {
        throw new Error('旧主密码不正确或旧版密文已损坏');
      }
      if (plain !== CANARY) throw new Error('旧主密码不正确');
      return key;
    },

    decryptLegacy(key, envelope) {
      return decryptText(key, envelope);
    }
  };

  // 兼容旧引用（Secret 名称为历史遗留，新实现为免密 Vault）。
  global.Secret = Vault;
  global.Vault = Vault;
})(typeof self !== 'undefined' ? self : this);
