/**
 * main.js — XHS 匿名 Cookie 生成主入口（纯 Node.js，替代 main.py）
 *
 * 用法：
 *   node main.js                  → 刷新 cookies.json 身份的会话（单次）
 *   node main.js --test           → 同上 + 自动跑评论接口验证
 *   node main.js --batch 5        → 批量生成 5 条独立匿名 cookie
 *   node main.js --batch 5 --test → 批量 + 每条自检
 *   node main.js --fresh          → 完全生成新身份（会 300012，仅测试用）
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const BASE_DIR = __dirname;

// ─── 直接 require 签名引擎（消除 execjs + subprocess 开销）──────────────────
const xhsMain = require('./xhs_main_260411.js');

// ─── 导入工具模块（同进程调用，无子进程）─────────────────────────────────────
const { captureScripting }    = require('./capture_scripting.js');
const { runScriptingJsdom }   = require('./run_scripting_jsdom.js');

// ─────────────────────────────────────────────────────────────────────────────
// Cookie 工具
// ─────────────────────────────────────────────────────────────────────────────

function parseCookies(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.split(';')) {
    const t   = part.trim();
    const idx = t.indexOf('=');
    if (idx > 0) out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return out;
}

function cookiesToStr(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 将 Set-Cookie 头数组合并进已有 cookie 对象 */
function applSetCookie(existing, setCookieHeader) {
  if (!setCookieHeader) return existing;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of arr) {
    const kv  = h.split(';')[0].trim();
    const idx = kv.indexOf('=');
    if (idx > 0) existing[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  }
  return existing;
}

const _VOLATILE = new Set([
  'web_session', 'websectiga', 'sec_poison_id', 'acw_tc', 'loadts',
  'id_token', 'x-rednote-datactry', 'x-rednote-holderctry', 'unread',
]);

/** 从 cookie 字符串中剔除会话字段，返回长期身份部分 */
function stripVolatile(cookieStr, extras = []) {
  const drop = new Set([..._VOLATILE, ...extras]);
  const parts = {};
  for (const pair of cookieStr.split(';')) {
    const t = pair.trim();
    const idx = t.indexOf('=');
    if (idx > 0) {
      const k = t.slice(0, idx).trim();
      if (!drop.has(k)) parts[k] = t.slice(idx + 1).trim();
    }
  }
  return cookiesToStr(parts);
}

// ─────────────────────────────────────────────────────────────────────────────
// A1 / B1 生成
// ─────────────────────────────────────────────────────────────────────────────

const _CHARSET          = 'abcdefghijklmnopqrstuvwxyz1234567890';
const _PLATFORM_CODES   = { Windows: '1', 'Mac OS': '2', Linux: '3', Android: '4', iOS: '5' };

/** CRC32（与 Python binascii.crc32 等价） */
function crc32(str) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  const buf = Buffer.from(str, 'utf-8');
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function generateA1(platform = 'Windows') {
  const ts   = Date.now().toString(16);
  let rnd    = '';
  for (let i = 0; i < 30; i++) rnd += _CHARSET[Math.floor(Math.random() * _CHARSET.length)];
  const pc   = _PLATFORM_CODES[platform] || '1';
  const base = `${ts}${rnd}${pc}0000`;
  const crcHex = crc32(base).toString(16).padStart(8, '0');
  return (base + crcHex).slice(0, 52);
}

function generateB1(a1) {
  return crc32(a1).toString(16).padStart(8, '0');
}

// ─────────────────────────────────────────────────────────────────────────────
// 请求头工具
// ─────────────────────────────────────────────────────────────────────────────

function generateXrayTraceid() {
  return crypto.randomBytes(16).toString('hex');
}

function generateX_b3Traceid(len = 16) {
  let s = '';
  for (let i = 0; i < len; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return s;
}

/** 调用签名引擎，返回完整请求头对象 */
function generateHeaders(a1, api, data = '', method = 'POST') {
  const sig = xhsMain.get_request_headers_params(api, data, a1, method);
  return {
    authority:            'edith.xiaohongshu.com',
    accept:               'application/json, text/plain, */*',
    'accept-language':    'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    'cache-control':      'no-cache',
    'content-type':       'application/json;charset=UTF-8',
    origin:               'https://www.xiaohongshu.com',
    pragma:               'no-cache',
    referer:              'https://www.xiaohongshu.com/',
    'sec-ch-ua':          '"Not A(Brand";v="99", "Microsoft Edge";v="121", "Chromium";v="121"',
    'sec-ch-ua-mobile':   '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest':     'empty',
    'sec-fetch-mode':     'cors',
    'sec-fetch-site':     'same-site',
    'user-agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
    'x-b3-traceid':       generateX_b3Traceid(),
    'x-mns':              'unload',
    'x-s':                sig.xs,
    'x-s-common':         sig.xs_common,
    'x-t':                String(sig.xt),
    'x-xray-traceid':     generateXrayTraceid(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 工具
// ─────────────────────────────────────────────────────────────────────────────

function httpsRequest(method, urlStr, reqHeaders, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;

    let bodyBuf = null;
    if (body) bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');

    const opts = {
      method,
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers:  Object.assign({
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }, reqHeaders),
    };
    if (bodyBuf) opts.headers['content-length'] = bodyBuf.length;

    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function spliceStr(api, params) {
  const entries = Object.entries(params).map(([k, v]) => [k, v == null ? '' : String(v)]);
  const qs = new URLSearchParams(entries).toString();
  return qs ? `${api}?${qs}` : api;
}

// ─────────────────────────────────────────────────────────────────────────────
// websectiga 校验
// ─────────────────────────────────────────────────────────────────────────────

function isValidWebsectiga(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// 将 websectiga / sec_poison_id 注入 cookie 字符串
// ─────────────────────────────────────────────────────────────────────────────

function injectWebsectigaIntoCookie(cookieStr, websectiga, secPoisonId = '') {
  const parts = parseCookies(cookieStr);
  parts['websectiga'] = websectiga;
  if (secPoisonId) parts['sec_poison_id'] = secPoisonId;
  return cookiesToStr(parts);
}

// ─────────────────────────────────────────────────────────────────────────────
// 获取全新身份（纯 HTTP，无浏览器）
// ─────────────────────────────────────────────────────────────────────────────

async function getFreshIdentity() {
  const a1    = generateA1('Windows');
  const b1    = generateB1(a1);
  const webId = crypto.createHash('md5').update(a1).digest('hex');

  console.log('  → 纯 HTTP 方式获取新身份 ...');

  // 1. 访问首页拿 acw_tc
  let acw_tc = '';
  try {
    const res = await httpsRequest('GET', 'https://www.xiaohongshu.com/', {
      'accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
      'cache-control':   'no-cache',
    });
    const sc = res.headers['set-cookie'] || [];
    const arr = Array.isArray(sc) ? sc : [sc];
    for (const h of arr) {
      const kv = h.split(';')[0].trim();
      if (kv.startsWith('acw_tc=')) acw_tc = kv.slice('acw_tc='.length);
    }
  } catch (e) {
    return { error: `首页请求失败: ${e.message}` };
  }

  // 2. POST webprofile → Set-Cookie: gid
  const _PROFILE_DATA =
    'c058828ff50a429ae90a3cdb598d3a5945dc32e1a032b897fff9e445c22fbdf8' +
    'fc5dfe2a87c1ede77b2ed9059da7def5d9399d5e0b3ec04f7e6cc99badf2bb73' +
    'bcdf2c71fb5b01d3fb0e4028028f7a5f8e2d4b5b8aeaa1a1af';

  const payload = JSON.stringify({
    platform:    'PC',
    sdkVersion:  '3.3.4',
    svn:         '2',
    profileData: _PROFILE_DATA,
    reportUrl:   '/api/sec/v1/shield/webprofile',
  });

  let gid = '';
  try {
    const cookieStr = `a1=${a1}; b1=${b1}; acw_tc=${acw_tc}; xsecappid=xhs-pc-web`;
    const res = await httpsRequest(
      'POST',
      'https://www.xiaohongshu.com/api/sec/v1/shield/webprofile',
      {
        'content-type': 'application/json;charset=UTF-8',
        origin:         'https://www.xiaohongshu.com',
        referer:        'https://www.xiaohongshu.com/',
        cookie:         cookieStr,
      },
      payload,
    );
    const sc  = res.headers['set-cookie'] || [];
    const arr = Array.isArray(sc) ? sc : [sc];
    for (const h of arr) {
      const kv = h.split(';')[0].trim();
      if (kv.startsWith('gid=')) gid = kv.slice('gid='.length);
    }
    if (!gid) return { error: `webprofile 未返回 gid (status=${res.status})` };
  } catch (e) {
    return { error: `webprofile 请求失败: ${e.message}` };
  }

  const baseCk = `a1=${a1}; webId=${webId}; gid=${gid}; b1=${b1}; xsecappid=xhs-pc-web; webBuild=6.10.3`;
  console.log(`  ✓ 新 a1     : ${a1}`);
  console.log(`  ✓ 新 gid    : ${gid.slice(0, 60)}...`);
  console.log(`  ✓ 新 webId  : ${webId}`);
  return { a1, b1, webId, gid, acw_tc, baseCk };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程：生成完整匿名会话
// ─────────────────────────────────────────────────────────────────────────────

async function generateAnonSession(identityCk = '') {
  // ── 1. 解析或生成身份 ────────────────────────────────────────────────────
  let baseCk, a1;

  if (identityCk) {
    // 每次生成全新 a1/webId/b1，只继承 gid（gid 35年有效，无需重新请求）
    const p   = parseCookies(identityCk);
    const gid = p['gid'] || '';
    if (!gid) return { success: false, error: 'cookies.json 中找不到 gid' };
    a1          = generateA1('Windows');
    const webId = crypto.createHash('md5').update(a1).digest('hex');
    const b1    = generateB1(a1);
    baseCk = `a1=${a1}; webId=${webId}; gid=${gid}; b1=${b1}; xsecappid=xhs-pc-web; webBuild=6.10.3`;
    console.log(`  a1(新) : ${a1}`);
    console.log(`  webId  : ${webId}`);
    console.log(`  gid    : ${gid.slice(0, 30)}... (复用)`);
  } else {
    console.log('  [*] 获取全新身份 (a1/gid) ...');
    const id = await getFreshIdentity();
    if (id.error) return { success: false, error: id.error };
    a1     = id.a1;
    baseCk = id.baseCk;
    console.log(`  a1     : ${a1}`);
    console.log(`  webId  : ${id.webId}`);
    console.log(`  gid    : ${id.gid.slice(0, 30)}...`);
  }

  if (!a1) return { success: false, error: 'cookie 中找不到 a1' };

  // ── 2. 访问首页拿 acw_tc / abRequestId ──────────────────────────────────
  console.log('  [*] 访问首页获取 acw_tc ...');
  try {
    const res = await httpsRequest('GET', 'https://www.xiaohongshu.com/', {
      'accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
      'cache-control':   'no-cache',
      cookie:            baseCk,
    });
    const sc  = res.headers['set-cookie'] || [];
    const arr = Array.isArray(sc) ? sc : [sc];
    const ckParts = parseCookies(baseCk);
    for (const h of arr) {
      const kv  = h.split(';')[0].trim();
      const idx = kv.indexOf('=');
      if (idx > 0) {
        const name = kv.slice(0, idx).trim();
        if (name === 'acw_tc' || name === 'abRequestId') {
          ckParts[name] = kv.slice(idx + 1).trim();
          console.log(`  ${name} : ${ckParts[name].slice(0, 40)}`);
        }
      }
    }
    baseCk = cookiesToStr(ckParts);
  } catch (e) {
    console.log(`  [!] 首页访问失败（非阻塞）: ${e.message}`);
  }

  // ── 3. capture + jsdom 重试生成 websectiga ───────────────────────────────
  const existingWst = parseCookies(baseCk)['websectiga'] || '';
  let wsResult = null;

  if (isValidWebsectiga(existingWst)) {
    console.log(`  ✓ websectiga（复用）: ${existingWst}`);
    wsResult = { websectiga: existingWst, sec_poison_id: parseCookies(baseCk)['sec_poison_id'] || '' };
  } else {
    console.log('  [*] 生成 websectiga ...');
    for (let attempt = 1; attempt <= 10; attempt++) {
      await captureScripting(baseCk);
      const r   = await runScriptingJsdom(baseCk);
      const wst = r.websectiga || '';
      if (isValidWebsectiga(wst)) {
        wsResult = r;
        console.log(`  ✓ websectiga（尝试 ${attempt}）: ${wst}`);
        break;
      } else {
        console.log(`  [x] 尝试 ${attempt}/10: ${JSON.stringify(wst)}`);
      }
    }
    if (!wsResult) {
      return { success: false, cookie: baseCk, error: 'websectiga 10 次尝试全部失败' };
    }
  }

  const sessionCkParts = parseCookies(
    injectWebsectigaIntoCookie(baseCk, wsResult.websectiga, wsResult.sec_poison_id || '')
  );

  // ── 4. activate → web_session ────────────────────────────────────────────
  console.log('  [*] 调用 activate 获取 web_session ...');
  const actApi    = '/api/sns/web/v1/login/activate';
  const actHeaders = generateHeaders(a1, actApi, '{}', 'POST');
  actHeaders['origin']  = 'https://www.xiaohongshu.com';
  actHeaders['referer'] = 'https://www.xiaohongshu.com/explore';
  actHeaders['x-mns']   = 'unload';

  for (const host of ['https://edith.xiaohongshu.com']) {
    try {
      const ckStr = cookiesToStr(sessionCkParts);
      actHeaders['cookie'] = ckStr;
      const resp = await httpsRequest(
        'POST',
        `${host}${actApi}`,
        actHeaders,
        '{}',
      );
      console.log(`  activate [${host.replace('https://', '')}] status : ${resp.status}`);
      console.log(`  activate body   : ${resp.body.slice(0, 300)}`);

      const sc  = resp.headers['set-cookie'] || [];
      const arr = Array.isArray(sc) ? sc : [sc];
      let webSession = '';
      for (const h of arr) {
        const kv = h.split(';')[0].trim();
        if (kv.startsWith('web_session=')) {
          webSession = kv.slice('web_session='.length);
          break;
        }
      }
      if (webSession) {
        sessionCkParts['web_session'] = webSession;
        const finalCk = cookiesToStr(sessionCkParts);
        return { success: true, cookie: finalCk, a1, web_session: webSession };
      }
    } catch (e) {
      console.log(`  [!] ${host} 异常: ${e.message}`);
    }
  }

  return {
    success: false,
    cookie:  cookiesToStr(sessionCkParts),
    error:   'activate 两个 host 均未下发 web_session',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试评论接口
// ─────────────────────────────────────────────────────────────────────────────

async function testCommentApi(cookieStr, label = '') {
  const api    = '/api/sns/web/v2/comment/page';
  const params = {
    note_id:        '6a02fc260000000035022fc6',
    cursor:         '',
    top_comment_id: '',
    image_formats:  'jpg,webp,avif',
    xsec_token:     'ABUOWAgMqM2IvDPu3m_Rh0Hz-7yaHXN1pv-AsPjYokIuI=',
  };
  const fullApi = spliceStr(api, params);
  const cookies = parseCookies(cookieStr);
  const a1      = cookies['a1'] || '';
  const headers = generateHeaders(a1, fullApi, '', 'GET');
  headers['cookie'] = cookieStr;

  const tag = label ? ` [${label}]` : '';
  try {
    const resp = await httpsRequest('GET', `https://edith.xiaohongshu.com${fullApi}`, headers);
    let body;
    try { body = JSON.parse(resp.body); } catch (_) { body = {}; }
    const code     = body.code;
    const comments = (body.data && body.data.comments) || [];
    console.log(`[*] 评论接口${tag} HTTP ${resp.status}  code=${code}  评论数=${comments.length}`);
    if (comments.length > 0) {
      console.log(`  首条: ${(comments[0].content || '').slice(0, 80)}`);
    }
    if (code !== 0) {
      console.log(`  msg: ${body.msg || body.message || ''}`);
    }
    return code;
  } catch (e) {
    console.log(`[!] 请求异常${tag}: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args     = process.argv.slice(2);
  const runTest  = args.includes('--test');
  const fresh    = args.includes('--fresh');
  let   batchN   = 1;

  const batchIdx = args.indexOf('--batch');
  if (batchIdx !== -1) {
    const n = parseInt(args[batchIdx + 1], 10);
    if (!isNaN(n) && n > 0) batchN = n;
  }

  let baseCookie = '';
  const ckPath = path.join(BASE_DIR, 'cookies.json');
  if (fs.existsSync(ckPath) && !fresh) {
    baseCookie = fs.readFileSync(ckPath, 'utf-8').trim();
  }

  const results = [];
  const identityCk = fresh ? '' : baseCookie;

  if (batchN === 1) {
    // ── 单次模式 ─────────────────────────────────────────────────────────────
    console.log('='.repeat(60));
    if (baseCookie && !fresh) {
      console.log('[步骤 1] 从 cookies.json 身份自动生成匿名会话');
      console.log('  （每次新 a1/webId，gid 复用，自动刷新 websectiga + web_session）');
    } else {
      console.log('[步骤 1] 完全独立生成新身份匿名会话');
    }
    console.log('='.repeat(60));

    const t0    = Date.now();
    const anon  = await generateAnonSession(identityCk);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    if (anon.success) {
      results.push(anon.cookie);
      console.log(`  ✓ web_session : ${anon.web_session.slice(0, 30)}...`);
      console.log(`  ✓ 耗时        : ${elapsed}s`);
      if (runTest) await testCommentApi(anon.cookie, '匿名 cookie（自动生成）');
    } else {
      console.log(`  [!] 失败: ${anon.error}（耗时 ${elapsed}s）`);
      if (baseCookie) {
        console.log('\n[回退] 尝试用原始 cookies.json 直接测试 ...');
        await testCommentApi(baseCookie, '原始 cookie');
      }
    }

  } else {
    // ── 并行批量模式 ──────────────────────────────────────────────────────────
    console.log(`并行生成 ${batchN} 个独立匿名会话 ...\n`);
    const t0 = Date.now();

    const tasks = Array.from({ length: batchN }, (_, i) =>
      generateAnonSession(identityCk).then(anon => ({ i: i + 1, anon }))
    );
    const settled = await Promise.allSettled(tasks);

    for (const s of settled) {
      if (s.status === 'rejected') {
        console.log(`  [!!] 任务异常: ${s.reason?.message || s.reason}`);
        continue;
      }
      const { i, anon } = s.value;
      if (anon.success) {
        results.push(anon.cookie);
        console.log(`  [${String(i).padStart(2)}] ✓  web_session=${anon.web_session.slice(0, 24)}...`);
      } else {
        console.log(`  [${String(i).padStart(2)}] ✗  ${anon.error}`);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`\n  完成: ${results.length}/${batchN} 成功，总耗时 ${elapsed}s`);
  }

  // ── 保存结果 ───────────────────────────────────────────────────────────────
  if (results.length === 1) {
    const outPath = path.join(BASE_DIR, 'cookies_anonymous.json');
    fs.writeFileSync(outPath, results[0], 'utf-8');
    console.log('\n[✓] 完整匿名 cookie 已保存至 cookies_anonymous.json');
  } else if (results.length > 1) {
    const outFile = args.includes('--out')
      ? args[args.indexOf('--out') + 1]
      : 'test-cookie.json';
    const outPath = path.join(BASE_DIR, outFile);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\n[✓] ${results.length} 条匿名 cookie 已保存至 ${outFile}`);
  }
}

main().catch(e => {
  console.error(`[!] 未捕获异常: ${e.stack || e.message}`);
  process.exit(1);
});
