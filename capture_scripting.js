/**
 * capture_scripting.js
 *
 * 从 as.xiaohongshu.com/api/sec/v1/scripting 拉取安全 JS 并保存为 scripting_raw.js。
 * 支持两种响应格式：
 *   1. 响应体直接是 JS（以 ; 或 ( 开头，或包含 seccallback）
 *   2. 响应体是 JSON，含 data.url 或 url 字段，需再 GET 下载实际 JS
 *
 * 用法：
 *   node capture_scripting.js "<cookie_string>"
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

const BASE_DIR    = __dirname;
const RAW_JS_PATH = path.join(BASE_DIR, 'scripting_raw.js');

// ─── cookie 解析 ────────────────────────────────────────────────────────────
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

// ─── 通用 HTTPS 请求封装 ─────────────────────────────────────────────────────
function httpsRequest(method, urlStr, reqHeaders, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: Object.assign({
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }, reqHeaders),
    };

    if (body) {
      const buf = Buffer.from(body, 'utf-8');
      opts.headers['content-length'] = buf.length;
    }

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── 生成 x-s / x-t 签名（可选，失败时跳过） ────────────────────────────────
function trySign(api, bodyStr, a1) {
  try {
    const xhsMain = require('./xhs_main_260411.js');
    const sig = xhsMain.get_request_headers_params(api, bodyStr, a1, 'POST');
    return { xs: sig.xs, xt: String(sig.xt), xsc: sig.xs_common };
  } catch (e) {
    process.stderr.write(`[capture] 签名失败（跳过）: ${e.message}\n`);
    return { xs: '', xt: String(Date.now()), xsc: '' };
  }
}

// ─── 判断响应体是否为 JS ─────────────────────────────────────────────────────
function looksLikeJs(text) {
  const t = text.trimStart();
  return (
    t.startsWith('(') ||
    t.startsWith(';') ||
    t.startsWith('!') ||
    t.startsWith('var ') ||
    t.startsWith('function') ||
    t.includes('seccallback') ||
    t.includes('document.cookie')
  );
}

// ─── 核心逻辑（可被 main.js 导入） ───────────────────────────────────────────
async function captureScripting(cookieStr) {
  const cookies   = parseCookies(cookieStr);
  const a1        = cookies['a1'] || '';
  const API  = '/api/sec/v1/scripting';
  const body = JSON.stringify({ callFrom: 'web', callback: 'seccallback' });
  const sig  = trySign(API, body, a1);

  const reqHeaders = {
    'authority':     'as.xiaohongshu.com',
    'content-type':  'application/json;charset=UTF-8',
    'origin':        'https://www.xiaohongshu.com',
    'referer':       'https://www.xiaohongshu.com/',
    'x-s':           sig.xs,
    'x-t':           sig.xt,
    'x-s-common':    sig.xsc,
    'x-mns':         'unload',
    'cookie':        cookieStr,
  };

  let res;
  try {
    res = await httpsRequest('POST', `https://as.xiaohongshu.com${API}`, reqHeaders, body);
  } catch (e) {
    process.stderr.write(`[capture] 请求失败: ${e.message}\n`);
    process.exit(1);
  }

  let scriptContent = null;
  let secPoisonId    = null;

  if (!looksLikeJs(res.body)) {
    try {
      const json = JSON.parse(res.body);
      if (json.data && json.data.data) {
        scriptContent = json.data.data;
        secPoisonId   = json.data.secPoisonId || '';
      } else {
        const scriptUrl =
          (json.data && (json.data.url || json.data.scriptUrl)) ||
          json.url || json.scriptUrl;
        if (scriptUrl) {
          const sr = await httpsRequest('GET', scriptUrl, { cookie: cookieStr });
          scriptContent = sr.body;
        }
      }
    } catch (_) {}
  }

  if (!scriptContent && looksLikeJs(res.body)) scriptContent = res.body;
  if (!scriptContent) scriptContent = '// raw response\n' + res.body;

  fs.writeFileSync(RAW_JS_PATH, scriptContent, 'utf-8');
  if (secPoisonId) {
    fs.writeFileSync(path.join(BASE_DIR, 'sec_poison_id.txt'), secPoisonId, 'utf-8');
  }
  return { ok: true, secPoisonId: secPoisonId || '' };
}

// ─── 独立运行入口 ─────────────────────────────────────────────────────────────
async function main() {
  const cookieStr = process.argv[2] || '';
  const r = await captureScripting(cookieStr);
  if (r && r.ok) {
    process.stdout.write(`[capture] 完成，secPoisonId=${r.secPoisonId}\n`);
  }
}

if (require.main === module) {
  main().catch(e => {
    process.stderr.write(`[capture] 未捕获异常: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { captureScripting };

