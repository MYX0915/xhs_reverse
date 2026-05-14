/**
 * run_scripting_jsdom.js
 *
 * 在 jsdom 沙盒中执行 as.xiaohongshu.com/api/sec/v1/scripting 返回的安全JS，
 * 捕获 websectiga / sec_poison_id，并将结果以 JSON 输出到 stdout。
 *
 * 捕获机制（双保险）：
 *   1. 拦截 window.seccallback()  — scripting JS 执行后回调
 *   2. 拦截 document.cookie 的写入 — 回调内部写 cookie
 *
 * 用法：
 *   node run_scripting_jsdom.js "<cookie_string>"
 *
 * 输出（stdout）：
 *   {"success":true, "websectiga":"...", "sec_poison_id":"...", "all_new_cookies":{...}}
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE_DIR    = __dirname;
const RAW_JS_PATH = path.join(BASE_DIR, 'scripting_raw.js');
const TIMEOUT_MS  = 8000;   // 最长等待 seccallback 的时间

// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function parseCookies(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.split(';')) {
    const t = part.trim();
    const idx = t.indexOf('=');
    if (idx > 0) out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return out;
}

function trySign(api, bodyStr, a1) {
  try {
    const xhsMain = require('./xhs_main_260411.js');
    const sig = xhsMain.get_request_headers_params(api, bodyStr, a1, 'POST');
    return { xs: sig.xs, xt: String(sig.xt), xsc: sig.xs_common };
  } catch (e) {
    process.stderr.write(`[jsdom] 签名失败（跳过）: ${e.message}\n`);
    return { xs: '', xt: String(Date.now()), xsc: '' };
  }
}

// ─── 获取 scripting JS ────────────────────────────────────────────────────────
async function getScriptContent(cookieStr) {
  // 优先本地缓存
  if (fs.existsSync(RAW_JS_PATH) && fs.statSync(RAW_JS_PATH).size > 100) {
    process.stderr.write(`[jsdom] 使用本地 scripting_raw.js\n`);
    return fs.readFileSync(RAW_JS_PATH, 'utf-8');
  }

  process.stderr.write(`[jsdom] 在线获取 scripting JS...\n`);
  const cookies = parseCookies(cookieStr);
  const a1      = cookies['a1'] || '';
  const API     = '/api/sec/v1/scripting';
  const body    = JSON.stringify({ callFrom: 'web', callback: 'seccallback' });
  const sig     = trySign(API, body, a1);

  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body, 'utf-8');
    const req = https.request({
      method: 'POST',
      hostname: 'as.xiaohongshu.com',
      path: API,
      headers: {
        'content-type':  'application/json;charset=UTF-8',
        'content-length': buf.length,
        'user-agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'origin':        'https://www.xiaohongshu.com',
        'referer':       'https://www.xiaohongshu.com/',
        'x-s':           sig.xs,
        'x-t':           sig.xt,
        'x-s-common':    sig.xsc,
        'x-mns':         'unload',
        'cookie':        cookieStr,
      }
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        process.stderr.write(`[jsdom] scripting 响应: ${res.statusCode}, ${text.length} 字节\n`);
        // 尝试 JSON → data.data （标准格式）
        try {
          const json = JSON.parse(text);
          if (json.data && json.data.data) {
            // 同时记录 secPoisonId
            if (json.data.secPoisonId) {
              result.sec_poison_id = json.data.secPoisonId;
              result.all_new_cookies.sec_poison_id = json.data.secPoisonId;
            }
            resolve(json.data.data);
            return;
          }
          const url = (json.data && (json.data.url || json.data.scriptUrl)) || json.url;
          if (url) {
            https.get(url, (r2) => {
              const c2 = [];
              r2.on('data', d => c2.push(d));
              r2.on('end', () => resolve(Buffer.concat(c2).toString('utf-8')));
            }).on('error', reject);
            return;
          }
        } catch (_) {}
        resolve(text);
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ─── 解析新写入的 cookie 字符串 ───────────────────────────────────────────────
function parseCookieWrite(val) {
  // "websectiga=abc123; path=/; domain=.xiaohongshu.com; ..."
  const parts = val.split(';');
  const kv    = parts[0].trim();
  const idx   = kv.indexOf('=');
  if (idx < 1) return null;
  return { name: kv.slice(0, idx).trim(), value: kv.slice(idx + 1).trim() };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cookieStr = process.argv[2] || '';

  let scriptContent;
  try {
    scriptContent = await getScriptContent(cookieStr);
  } catch (e) {
    process.stdout.write(JSON.stringify({ success: false, error: `fetch: ${e.message}`, websectiga: null }));
    return;
  }

  if (!scriptContent || scriptContent.length < 20) {
    process.stdout.write(JSON.stringify({ success: false, error: 'empty script', websectiga: null }));
    return;
  }

  // ── 结果容器 ───────────────────────────────────────────────────────────────
  const result = {
    success:       false,
    websectiga:    null,
    sec_poison_id: null,
    all_new_cookies: {},
    callbackData:  null,
    error:         null,
  };

  // ── 用 Promise 等待 seccallback 被调用 ────────────────────────────────────
  let resolveCb;
  const cbPromise = new Promise(r => { resolveCb = r; });

  // ── 构建 jsdom ─────────────────────────────────────────────────────────────
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', msg => process.stderr.write(`[jsdom-err] ${msg}\n`));
  // virtualConsole.on('log', msg => process.stderr.write(`[jsdom-log] ${msg}\n`));

  const dom = new JSDOM(
    `<!DOCTYPE html><html lang="zh-CN"><head><title>小红书</title></head><body></body></html>`,
    {
      url:                  'https://www.xiaohongshu.com/explore',
      referrer:             'https://www.xiaohongshu.com/',
      contentType:          'text/html',
      pretendToBeVisual:    true,
      runScripts:           'dangerously',
      virtualConsole,
      beforeParse(window) {
        // ── 注入基础浏览器属性 ──────────────────────────────────────────
        try {
          Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
          });
          Object.defineProperty(window.navigator, 'platform', {
            value: 'Win32', configurable: true,
          });
          Object.defineProperty(window.navigator, 'language', {
            value: 'zh-CN', configurable: true,
          });
          Object.defineProperty(window.navigator, 'languages', {
            value: ['zh-CN', 'zh'], configurable: true,
          });
          Object.defineProperty(window.navigator, 'hardwareConcurrency', {
            value: 8, configurable: true,
          });
          Object.defineProperty(window.navigator, 'webdriver', {
            value: false, configurable: true,
          });
        } catch (_) {}

        // ── 注入初始 cookie ─────────────────────────────────────────────
        // jsdom 要求一次设置一个 k=v 对（无 domain/path 属性）
        for (const part of cookieStr.split(';')) {
          const t = part.trim();
          if (t && t.includes('=')) {
            try { window.document.cookie = t; } catch (_) {}
          }
        }

        // ── 拦截 document.cookie setter ────────────────────────────────
        const docProto = Object.getPrototypeOf(window.document);
        const origDesc = Object.getOwnPropertyDescriptor(docProto, 'cookie');
        if (origDesc && origDesc.set) {
          const origSet = origDesc.set;
          Object.defineProperty(window.document, 'cookie', {
            configurable: true,
            enumerable:   true,
            get: origDesc.get
              ? function() { return origDesc.get.call(window.document); }
              : undefined,
            set(val) {
              process.stderr.write(`[jsdom] cookie 写入: ${String(val).slice(0, 120)}\n`);
              const parsed = parseCookieWrite(String(val));
              if (parsed) {
                result.all_new_cookies[parsed.name] = parsed.value;
                if (parsed.name === 'websectiga') {
                  result.websectiga = parsed.value;
                  result.success    = true;
                }
                if (parsed.name === 'sec_poison_id') {
                  result.sec_poison_id = parsed.value;
                }
              }
              origSet.call(window.document, val);
              // 如果已拿到 websectiga，解除等待
              if (result.websectiga) resolveCb();
            },
          });
        }

        // ── 定义 seccallback（JSONP 式回调） ────────────────────────────
        window.seccallback = function(data) {
          process.stderr.write(`[jsdom] seccallback: ${JSON.stringify(data).slice(0, 300)}\n`);
          result.callbackData = data;
          if (typeof data === 'string' && data.length > 0) {
            // seccallback 直接返回 websectiga 字符串
            result.websectiga = data;
            result.all_new_cookies.websectiga = data;
            result.success = true;
          } else if (data && typeof data === 'object') {
            for (const [k, v] of Object.entries(data)) {
              result.all_new_cookies[k] = v;
              if (k === 'websectiga' || k === 'c3') {
                result.websectiga = v;
                result.success    = true;
              }
              if (k === 'sec_poison_id') result.sec_poison_id = v;
            }
          }
          resolveCb();
        };

        // ── 补全常用缺失 API（静默兜底） ────────────────────────────────
        if (!window.screen) {
          window.screen = { width: 1920, height: 1080, colorDepth: 24, pixelDepth: 24 };
        }
        if (!window.performance) {
          window.performance = { now: () => Date.now(), timing: { navigationStart: Date.now() } };
        }
        window.XMLHttpRequest = window.XMLHttpRequest || function() {
          this.open = this.send = this.setRequestHeader = () => {};
        };

        // ── 注入 Web Crypto API（JSVMP 哈希计算依赖）──────────────────
        try {
          const { webcrypto } = require('node:crypto');
          const existingCrypto = window.crypto;
          if (!existingCrypto || !existingCrypto.subtle) {
            Object.defineProperty(window, 'crypto', {
              value: webcrypto,
              configurable: true,
              writable: true,
            });
          } else if (!existingCrypto.subtle) {
            // 只补 subtle
            Object.defineProperty(existingCrypto, 'subtle', {
              value: webcrypto.subtle,
              configurable: true,
            });
          }
          process.stderr.write('[jsdom] crypto.subtle 已注入\n');
        } catch (e) {
          process.stderr.write(`[jsdom] crypto 注入失败: ${e.message}\n`);
        }

        // ── Canvas stub（Canvas 指纹 fallback，避免 toDataURL 报错）──
        if (!window.HTMLCanvasElement) {
          window.HTMLCanvasElement = function() {};
        }
        try {
          const origGetCtx = window.HTMLCanvasElement.prototype.getContext;
          if (!origGetCtx) {
            window.HTMLCanvasElement.prototype.getContext = function(type) {
              if (type === '2d') {
                return {
                  fillRect: () => {}, fillText: () => {}, measureText: () => ({ width: 80 }),
                  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
                  canvas: this,
                };
              }
              return null;
            };
            window.HTMLCanvasElement.prototype.toDataURL = function() {
              return 'data:image/png;base64,iVBORw0KGgo=';
            };
          }
        } catch (_) {}
      },
    }
  );

  const { window } = dom;

  // ── 执行 scripting JS ──────────────────────────────────────────────────────
  try {
    window.eval(scriptContent);
    process.stderr.write(`[jsdom] 脚本执行完毕，等待回调...\n`);
  } catch (e) {
    process.stderr.write(`[jsdom] 脚本执行错误: ${e.message}\n`);
    result.error = e.message;
    // 不立即退出——某些情况下脚本仍会异步回调
  }

  // ── 等待 seccallback（最多 TIMEOUT_MS 毫秒）────────────────────────────────
  await Promise.race([
    cbPromise,
    new Promise(r => setTimeout(r, TIMEOUT_MS)),
  ]);

  // ── 兜底：从当前 document.cookie 里再扫一遍 ───────────────────────────────
  if (!result.success) {
    try {
      const allCookies = window.document.cookie || '';
      process.stderr.write(`[jsdom] 当前 document.cookie: ${allCookies.slice(0, 300)}\n`);
      const afterCookies = parseCookies(allCookies);
      if (afterCookies.websectiga) {
        result.websectiga = afterCookies.websectiga;
        result.success    = true;
        Object.assign(result.all_new_cookies, afterCookies);
      }
    } catch (_) {}
  }

  if (!result.success && !result.error) {
    result.error = `timeout: seccallback not called within ${TIMEOUT_MS}ms`;
  }

  // 兜底：从 capture 步骤保存的 sec_poison_id.txt 读取
  if (!result.sec_poison_id) {
    const poisonPath = path.join(BASE_DIR, 'sec_poison_id.txt');
    if (fs.existsSync(poisonPath)) {
      result.sec_poison_id = fs.readFileSync(poisonPath, 'utf-8').trim();
      process.stderr.write(`[jsdom] sec_poison_id 从文件读取: ${result.sec_poison_id}\n`);
    }
  }

  try { window.close(); } catch (_) {}

  // 只向 stdout 输出 JSON，stderr 给 Python 的调试日志
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ success: false, error: e.stack || e.message, websectiga: null }) + '\n');
});
