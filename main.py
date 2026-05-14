import json
import os
import math
import random
import subprocess
import time
import execjs
try:
    from xhs_utils.cookie_util import trans_cookies
except ImportError:
    def trans_cookies(cookie_str):
        cookies = {}
        for item in cookie_str.split(';'):
            item = item.strip()
            if not item: continue
            if '=' in item:
                k, v = item.split('=', 1)
                cookies[k] = v
        return cookies

# 获取当前文件所在目录
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

try:
    js_path = os.path.join(BASE_DIR, 'xhs_main_260411.js')
    js = execjs.compile(open(js_path, 'r', encoding='utf-8').read())
except FileNotFoundError:
    js_path = os.path.join(BASE_DIR, 'static', 'xhs_main_260411.js')
    js = execjs.compile(open(js_path, 'r', encoding='utf-8').read())

# 移除 xray 依赖，使用随机生成的 traceid 替代
def generate_xray_traceid():
    import uuid
    return uuid.uuid4().hex

def generate_x_b3_traceid(len=16):
    x_b3_traceid = ""
    for t in range(len):
        x_b3_traceid += "abcdef0123456789"[math.floor(16 * random.random())]
    return x_b3_traceid

def generate_xs_xs_common(a1, api, data='', method='POST'):
    ret = js.call('get_request_headers_params', api, data, a1, method)
    xs, xt, xs_common = ret['xs'], ret['xt'], ret['xs_common']
    return xs, xt, xs_common

def generate_xs(a1, api, data='', method='GET'):
    ret = js.call('get_request_headers_params', api, data, a1, method)
    xs, xt = ret['xs'], ret['xt']
    return xs, xt

# 已移动至上方实现
def get_common_headers():
    return {
        "authority": "www.xiaohongshu.com",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "zh-CN,zh;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "referer": "https://www.xiaohongshu.com/",
        "sec-ch-ua": "\"Chromium\";v=\"122\", \"Not(A:Brand\";v=\"24\", \"Google Chrome\";v=\"122\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    }
def get_request_headers_template():
    return {
        "authority": "edith.xiaohongshu.com",
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "cache-control": "no-cache",
        "content-type": "application/json;charset=UTF-8",
        "origin": "https://www.xiaohongshu.com",
        "pragma": "no-cache",
        "referer": "https://www.xiaohongshu.com/",
        "sec-ch-ua": "\"Not A(Brand\";v=\"99\", \"Microsoft Edge\";v=\"121\", \"Chromium\";v=\"121\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0",
        "x-b3-traceid": "",
        "x-mns": "unload",
        "x-s": "",
        "x-s-common": "",
        "x-t": "",
        "x-xray-traceid": generate_xray_traceid()
    }

def generate_headers(a1, api, data='', method='POST'):
    xs, xt, xs_common = generate_xs_xs_common(a1, api, data, method)
    x_b3_traceid = generate_x_b3_traceid()
    headers = get_request_headers_template()
    headers['x-s'] = xs
    headers['x-t'] = str(xt)
    headers['x-s-common'] = xs_common
    headers['x-b3-traceid'] = x_b3_traceid
    if data:
        data = json.dumps(data, separators=(',', ':'), ensure_ascii=False)
    return headers, data

def generate_request_params(cookies_str, api, data='', method='POST'):
    cookies = trans_cookies(cookies_str)
    a1 = cookies['a1']
    headers, data = generate_headers(a1, api, data, method)
    return headers, cookies, data

# ─────────────────────────────────────────────────────────────────────────────
# 路径一：jsdom 沙盒执行 scripting JS → 获取 websectiga
# ─────────────────────────────────────────────────────────────────────────────

JSDOM_SCRIPT = os.path.join(BASE_DIR, 'run_scripting_jsdom.js')
CAPTURE_SCRIPT = os.path.join(BASE_DIR, 'capture_scripting.js')

def get_websectiga_via_jsdom(cookie_str: str, timeout: int = 30) -> dict:
    """
    调用 Node.js jsdom 沙盒拿 websectiga + sec_poison_id。
    返回 dict，包含:
      success       bool
      websectiga    str | None
      sec_poison_id str | None
      all_new_cookies dict
    """
    try:
        proc = subprocess.run(
            ['node', JSDOM_SCRIPT, cookie_str],
            capture_output=True,
            text=True,
            encoding='utf-8',
            timeout=timeout,
            cwd=BASE_DIR,
        )
        # stderr 是调试日志，stdout 是 JSON 结果
        if proc.stderr:
            for line in proc.stderr.strip().splitlines():
                print(f'  [jsdom] {line}')

        stdout = proc.stdout.strip()
        if not stdout:
            return {'success': False, 'error': 'no stdout', 'websectiga': None}

        return json.loads(stdout)

    except subprocess.TimeoutExpired:
        return {'success': False, 'error': 'timeout', 'websectiga': None}
    except json.JSONDecodeError as e:
        return {'success': False, 'error': f'json parse: {e}', 'websectiga': None}
    except Exception as e:
        return {'success': False, 'error': str(e), 'websectiga': None}


def capture_scripting_js(cookie_str: str) -> bool:
    """
    路径二辅助：调用 capture_scripting.js 拉取 scripting 原始 JS，
    保存到 scripting_raw.js（供静态反混淆分析）。
    返回 True 表示成功保存。
    """
    try:
        proc = subprocess.run(
            ['node', CAPTURE_SCRIPT, cookie_str],
            capture_output=True,
            text=True,
            encoding='utf-8',
            timeout=20,
            cwd=BASE_DIR,
        )
        print(proc.stdout)
        if proc.returncode != 0:
            print('[!] capture_scripting 失败:', proc.stderr[:300])
            return False
        raw_path = os.path.join(BASE_DIR, 'scripting_raw.js')
        return os.path.exists(raw_path) and os.path.getsize(raw_path) > 100
    except Exception as e:
        print(f'[!] capture_scripting 异常: {e}')
        return False


def get_fresh_identity(headless: bool = True, timeout_ms: int = 40000) -> dict:
    """
    纯 HTTP 方式获取新身份（无需浏览器）：
      1. 本地生成 a1/b1/webId
      2. GET 首页拿 acw_tc
      3. POST /api/sec/v1/shield/webprofile → 服务端下发 Set-Cookie: gid

    返回 {'a1', 'b1', 'webId', 'gid', 'acw_tc', 'base_ck'}
    失败时返回 {'error': '...'}
    """
    import hashlib
    import curl_cffi.requests as req_s

    a1     = generate_a1('Windows')
    b1     = generate_b1(a1)
    web_id = hashlib.md5(a1.encode()).hexdigest()

    print(f'  → 纯 HTTP 方式获取新身份 ...')

    try:
        sess = req_s.Session()
        sess.get(
            'https://www.xiaohongshu.com/',
            impersonate='firefox135',
            allow_redirects=True,
            timeout=10,
        )
        acw_tc = sess.cookies.get('acw_tc', '')
    except Exception as e:
        return {'error': f'首页请求失败: {e}'}

    # profileData 固定值（浏览器指纹，服务端只用它的格式校验；gid 由服务端随机生成）
    _PROFILE_DATA = (
        'c058828ff50a429ae90a3cdb598d3a5945dc32e1a032b897fff9e445c22fbdf8'
        'fc5dfe2a87c1ede77b2ed9059da7def5d9399d5e0b3ec04f7e6cc99badf2bb73'
        'bcdf2c71fb5b01d3fb0e4028028f7a5f8e2d4b5b8aeaa1a1af'
    )

    payload = json.dumps(
        {
            'platform':   'PC',
            'sdkVersion': '3.3.4',
            'svn':        '2',
            'profileData': _PROFILE_DATA,
            'reportUrl':  '/api/sec/v1/shield/webprofile',
        },
        separators=(',', ':'),
    )
    try:
        r = sess.post(
            'https://www.xiaohongshu.com/api/sec/v1/shield/webprofile',
            headers={
                'content-type': 'application/json;charset=UTF-8',
                'origin':       'https://www.xiaohongshu.com',
                'referer':      'https://www.xiaohongshu.com/',
                'user-agent':   (
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/124.0.0.0 Safari/537.36'
                ),
            },
            cookies={
                'a1':        a1,
                'b1':        b1,
                'acw_tc':    acw_tc,
                'xsecappid': 'xhs-pc-web',
            },
            data=payload.encode(),
            impersonate='firefox135',
            timeout=10,
            allow_redirects=False,
        )
    except Exception as e:
        return {'error': f'webprofile 请求失败: {e}'}

    gid = r.cookies.get('gid', '')
    if not gid:
        return {'error': f'webprofile 未返回 gid (status={r.status_code})'}

    base_ck = (
        f"a1={a1}; webId={web_id}; gid={gid}; b1={b1}; "
        f"xsecappid=xhs-pc-web; webBuild=6.10.3"
    )

    print(f'  ✓ 新 a1     : {a1}')
    print(f'  ✓ 新 gid    : {gid[:60]}...')
    print(f'  ✓ 新 webId  : {web_id}')

    return {
        'a1':            a1,
        'b1':            b1,
        'webId':         web_id,
        'gid':           gid,
        'acw_tc':        acw_tc,
        'websectiga':    '',
        'sec_poison_id': '',
        'web_session':   '',
        'loadts':        '',
        'base_ck':       base_ck,
    }



def refresh_gid_only(identity_ck: str) -> str:
    """
    复用已建立 a1，通过 webprofile 获取全新唯一 gid，剔除所有会话字段。
    用于批量模式：每条 cookie 拥有相同 a1 但不同 gid/web_session。

    Returns:
        含原始 a1/b1/webId 和新 gid 的 cookie 字符串（无会话字段）。
        若 webprofile 失败，原样返回去除会话字段后的 identity_ck。
    """
    import curl_cffi.requests as req_s

    _VOLATILE = {'web_session', 'websectiga', 'sec_poison_id', 'acw_tc', 'loadts',
                 'id_token', 'x-rednote-datactry', 'x-rednote-holderctry', 'unread', 'gid'}
    parts: dict = {}
    for pair in identity_ck.split(';'):
        pair = pair.strip()
        if '=' in pair:
            k, v = pair.split('=', 1)
            k = k.strip()
            if k not in _VOLATILE:
                parts[k] = v.strip()

    a1  = parts.get('a1', '')
    b1  = parts.get('b1', '')
    if not a1:
        return identity_ck

    _PROFILE_DATA = (
        'c058828ff50a429ae90a3cdb598d3a5945dc32e1a032b897fff9e445c22fbdf8'
        'fc5dfe2a87c1ede77b2ed9059da7def5d9399d5e0b3ec04f7e6cc99badf2bb73'
        'bcdf2c71fb5b01d3fb0e4028028f7a5f8e2d4b5b8aeaa1a1af'
    )
    payload = json.dumps(
        {'platform': 'PC', 'sdkVersion': '3.3.4', 'svn': '2',
         'profileData': _PROFILE_DATA, 'reportUrl': '/api/sec/v1/shield/webprofile'},
        separators=(',', ':'),
    )
    try:
        sess = req_s.Session()
        # 先访问首页，让服务端为这次 webprofile 请求下发 acw_tc
        sess.get('https://www.xiaohongshu.com/', impersonate='firefox135',
                 allow_redirects=True, timeout=10)
        acw_tc = sess.cookies.get('acw_tc', '')
        r = sess.post(
            'https://www.xiaohongshu.com/api/sec/v1/shield/webprofile',
            headers={
                'content-type': 'application/json;charset=UTF-8',
                'origin':       'https://www.xiaohongshu.com',
                'referer':      'https://www.xiaohongshu.com/',
                'user-agent':   (
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/124.0.0.0 Safari/537.36'
                ),
            },
            cookies={'a1': a1, 'b1': b1, 'acw_tc': acw_tc, 'xsecappid': 'xhs-pc-web'},
            data=payload.encode(),
            impersonate='firefox135',
            timeout=10,
            allow_redirects=False,
        )
        new_gid = r.cookies.get('gid', '')
        if new_gid:
            parts['gid'] = new_gid
            print(f'  → 已刷新 gid: {new_gid[:60]}...')
        else:
            print(f'  [!] webprofile 未返回 gid (status={r.status_code})，沿用原 gid')
    except Exception as e:
        print(f'  [!] refresh_gid_only 失败: {e}，沿用原 gid')

    return '; '.join(f'{k}={v}' for k, v in parts.items())


def generate_a1(platform: str = 'Windows') -> str:
    """本地生成合法 a1（52 字符）。"""
    import binascii, string as _string, time as _t
    CHARSET = 'abcdefghijklmnopqrstuvwxyz1234567890'
    PLATFORM_CODES = {'Windows': '1', 'Mac OS': '2', 'Linux': '3', 'Android': '4', 'iOS': '5'}
    ts  = hex(int(_t.time() * 1000))[2:]
    rnd = ''.join(random.choice(CHARSET) for _ in range(30))
    pc  = PLATFORM_CODES.get(platform, '1')
    base = f'{ts}{rnd}{pc}0000'
    crc  = format(binascii.crc32(base.encode()) & 0xFFFFFFFF, '08x')
    return (base + crc)[:52]


def generate_b1(a1: str) -> str:
    """生成 b1（a1 的 CRC32 变体）。"""
    import binascii
    return format(binascii.crc32(a1.encode()) & 0xFFFFFFFF, '08x')


def generate_anon_session(identity_ck: str = '') -> dict:
    """
    从身份 cookie（a1/webId/gid）自动生成完整匿名会话：
      1. 访问首页拿 acw_tc / abRequestId
      2. capture + jsdom 重试生成 websectiga
      3. POST /api/sns/web/v1/login/activate → web_session

    Args:
        identity_ck: 含 a1/webId/gid 的 cookie 字符串。
                     为空时自动调用 get_fresh_identity() 通过指纹上报获取新身份。

    Returns:
        success  bool
        cookie   str    完整可用 cookie 字符串
        a1       str
        web_session str
        error    str    (失败时)
    """
    import curl_cffi.requests as req_s

    # ── 1. 解析或生成身份 cookie ────────────────────────────────────────────
    # 只保留长期字段，剔除所有会话字段
    _VOLATILE = {'web_session', 'websectiga', 'sec_poison_id', 'acw_tc', 'loadts',
                 'id_token', 'x-rednote-datactry', 'x-rednote-holderctry', 'unread'}
    if identity_ck:
        parts = {}
        for pair in identity_ck.split(';'):
            pair = pair.strip()
            if '=' in pair:
                k, v = pair.split('=', 1)
                if k.strip() not in _VOLATILE:
                    parts[k.strip()] = v.strip()
        a1 = parts.get('a1', '')
        base_ck = '; '.join(f'{k}={v}' for k, v in parts.items())
        print(f"  a1     : {a1}")
        print(f"  webId  : {parts.get('webId', '(无)')}")
        print(f"  gid    : {parts.get('gid', '(无)')[:30]}...")
    else:
        # 全新身份：用 playwright 浏览器访问 XHS，自动生成 gid
        print('  [*] 启动浏览器获取新身份 (gid/webId) ...')
        identity = get_fresh_identity(headless=True)
        if 'error' in identity:
            return {'success': False, 'error': identity['error']}
        a1      = identity['a1']
        base_ck = identity['base_ck']
        print(f"  a1     : {a1}")
        print(f"  webId  : {identity['webId']}")
        print(f"  gid    : {identity['gid'][:30]}...")
        # 如果浏览器已经带回 acw_tc / websectiga，直接注入，跳过后续重试
        _prefill = {}
        for _k in ('acw_tc', 'websectiga', 'sec_poison_id', 'loadts'):
            _v = identity.get(_k, '')
            if _v:
                _prefill[_k] = _v
        if _prefill:
            _parts_tmp = {}
            for _p in base_ck.split(';'):
                _p = _p.strip()
                if '=' in _p:
                    _k2, _v2 = _p.split('=', 1)
                    _parts_tmp[_k2.strip()] = _v2.strip()
            _parts_tmp.update(_prefill)
            base_ck = '; '.join(f'{k}={v}' for k, v in _parts_tmp.items())

    if not a1:
        return {'success': False, 'error': 'cookie 中找不到 a1'}

    # ── 2. 访问首页获取 acw_tc / abRequestId，同时热身新身份 ──────────────
    print("  [*] 访问首页获取 acw_tc ...")
    try:
        _home_sess = req_s.Session()
        _home_sess.get(
            'https://www.xiaohongshu.com/',
            impersonate='firefox135',
            cookies=trans_cookies(base_ck),   # 携带新 a1+gid 热身
            allow_redirects=True,
            timeout=10,
        )
        for name in ['acw_tc', 'abRequestId']:
            v = _home_sess.cookies.get(name, '')
            if v:
                # 替换已有的同名字段（避免重复）
                parts_tmp = {}
                for p in base_ck.split(';'):
                    p = p.strip()
                    if '=' in p:
                        k2, v2 = p.split('=', 1)
                        if k2.strip() != name:
                            parts_tmp[k2.strip()] = v2.strip()
                parts_tmp[name] = v
                base_ck = '; '.join(f'{k}={v}' for k, v in parts_tmp.items())
                print(f"  {name} : {v[:40]}")
    except Exception as e:
        print(f"  [!] 首页访问失败（非阻塞）: {e}")

    # ── 3. capture + jsdom 重试生成 websectiga ─────────────────────────────
    # 先检查 base_ck 里是否已有有效的 websectiga（来自浏览器）
    _existing_wst = trans_cookies(base_ck).get('websectiga', '')
    if is_valid_websectiga(_existing_wst):
        print(f"  ✓ websectiga（复用浏览器值）: {_existing_wst}")
        ws_result = {'websectiga': _existing_wst,
                     'sec_poison_id': trans_cookies(base_ck).get('sec_poison_id', '')}
    else:
        print("  [*] 生成 websectiga ...")
        ws_result = None
        for attempt in range(1, 11):
            capture_scripting_js(base_ck)
            r = get_websectiga_via_jsdom(base_ck)
            wst = r.get('websectiga', '')
            if is_valid_websectiga(wst):
                ws_result = r
                print(f"  ✓ websectiga（尝试 {attempt}）: {wst}")
                break
            else:
                print(f"  [x] 尝试 {attempt}/10: {wst!r}")

        if not ws_result:
            return {'success': False, 'cookie': base_ck, 'error': 'websectiga 10 次尝试全部失败'}

    session_ck = inject_websectiga_into_cookie(
        base_ck, ws_result['websectiga'], ws_result.get('sec_poison_id', '')
    )

    # ── 4. activate → web_session ──────────────────────────────────────────
    print("  [*] 调用 activate 获取 web_session ...")
    act_api = '/api/sns/web/v1/login/activate'
    # activate 在签名列表中，必须携带 x-s/x-t/x-s-common
    act_signed_headers, _ = generate_headers(a1, act_api, '{}', 'POST')
    act_signed_headers['origin'] = 'https://www.xiaohongshu.com'
    act_signed_headers['referer'] = 'https://www.xiaohongshu.com/explore'
    act_signed_headers['x-mns'] = 'unload'

    for host in ('https://www.xiaohongshu.com', 'https://edith.xiaohongshu.com'):
        try:
            resp_act = req_s.post(
                f'{host}{act_api}',
                headers=act_signed_headers,
                cookies=trans_cookies(session_ck),
                data=b'{}',
                impersonate='firefox135',
                timeout=10,
            )
            print(f"  activate [{host.split('//')[1]}] status : {resp_act.status_code}")
            print(f"  activate body   : {resp_act.text[:300]}")
            web_session = resp_act.cookies.get('web_session')
            if web_session:
                session_ck += f'; web_session={web_session}'
                print(f"  ✓ web_session   : {web_session[:30]}...")
                return {'success': True, 'cookie': session_ck, 'a1': a1, 'web_session': web_session}
        except Exception as e:
            print(f"  [!] {host} 异常: {e}")

    return {
        'success': False, 'cookie': session_ck,
        'error': 'activate 两个 host 均未下发 web_session'
    }


def inject_websectiga_into_cookie(cookie_str: str, websectiga: str,
                                   sec_poison_id: str = '') -> str:
    """将获取到的 websectiga 注入 cookie 字符串（替换或追加）。"""
    parts = {}
    for pair in cookie_str.split(';'):
        pair = pair.strip()
        if '=' in pair:
            k, v = pair.split('=', 1)
            parts[k.strip()] = v.strip()

    parts['websectiga'] = websectiga
    if sec_poison_id:
        parts['sec_poison_id'] = sec_poison_id

    return '; '.join(f'{k}={v}' for k, v in parts.items())


def splice_str(api, params):
    from urllib.parse import urlencode
    clean = {k: (v if v is not None else '') for k, v in params.items()}
    qs = urlencode(clean)
    return f"{api}?{qs}" if qs else api

import re as _re

def is_valid_websectiga(s: str) -> bool:
    """websectiga 必须是 64 位纯 hex 字符串。"""
    return bool(s and _re.fullmatch(r'[0-9a-f]{64}', s))


def test_comment_api(cookie_str: str, label: str = ''):
    """用给定 cookie 测试评论接口，打印结果。"""
    import curl_cffi.requests as req_session
    api = '/api/sns/web/v2/comment/page'
    params = {
        "note_id": "69e204690000000021038d7b",
        "cursor": "",
        "top_comment_id": "",
        "image_formats": "jpg,webp,avif",
        "xsec_token": "AB6ArQKxATnegrNcZjtGPQ7oOHgVEdw-M9ObsbZJYS6Ho=",
    }
    full_api = splice_str(api, params)
    cookies = trans_cookies(cookie_str)
    a1 = cookies.get('a1', '')
    headers, _ = generate_headers(a1, full_api, '', 'GET')
    tag = f' [{label}]' if label else ''
    try:
        resp = req_session.get(
            f"https://edith.xiaohongshu.com{full_api}",
            headers=headers,
            cookies=cookies,
            impersonate="firefox135",
        )
        body = resp.json()
        code = body.get('code')
        comments = body.get('data', {}).get('comments', [])
        print(f"[*] 评论接口{tag} HTTP {resp.status_code}  code={code}  评论数={len(comments)}")
        if comments:
            print(f"  首条: {comments[0].get('content', '')[:80]}")
        if code != 0:
            print(f"  msg: {body.get('msg', body.get('message', ''))}")
        return code
    except Exception as e:
        print(f"[!] 请求异常{tag}: {e}")
        return None


if __name__ == '__main__':
    import sys as _sys

    # ── 命令行参数解析 ───────────────────────────────────────────────────────
    # 用法:
    #   python main.py                  → 刷新 cookies.json 身份的会话（单次）
    #   python main.py --batch 5        → 完全独立地生成 5 条匿名 cookie
    #   python main.py --batch 5 --test → 生成 5 条并逐一测试评论接口
    args = _sys.argv[1:]
    batch_n  = 1
    run_test = '--test' in args
    fresh    = '--fresh' in args  # 强制忽略 cookies.json，完全生成新身份
    if '--batch' in args:
        try:
            batch_n = int(args[args.index('--batch') + 1])
        except (IndexError, ValueError):
            batch_n = 1

    BASE_COOKIE = ''
    ck_path = os.path.join(BASE_DIR, 'cookies.json')
    if os.path.exists(ck_path) and not fresh:
        BASE_COOKIE = open(ck_path, encoding='utf-8').read().strip()

    results = []   # 收集所有生成结果

    for i in range(batch_n):
        if batch_n > 1:
            print(f'\n{"=" * 60}')
            gid_mode = '刷新 gid（复用 a1）' if BASE_COOKIE and not fresh else '全新身份'
            print(f'[{i+1}/{batch_n}] 生成独立匿名会话 [{gid_mode}]')
            print('=' * 60)
        else:
            print('=' * 60)
            if BASE_COOKIE and not fresh:
                print('[步骤 1] 从 cookies.json 身份自动生成匿名会话')
                print('  （a1/webId/gid 保持不变，自动刷新 websectiga + web_session）')
            else:
                print('[步骤 1] 完全独立生成新身份匿名会话')
            print('=' * 60)

        # 决定本次 identity_ck：
        #   --fresh：完全新身份（新 a1+gid），适合单次测试
        #   --batch N（有 BASE_COOKIE）：复用已建立 a1+gid，仅生成新 web_session
        #     （新建 gid 会被服务端标记 IP 风险，必须沿用原始 cookies.json gid）
        #   --batch N（无 BASE_COOKIE）：回退到全新身份
        if fresh:
            identity_ck = ''          # 全新 a1+gid
        elif batch_n > 1 and BASE_COOKIE:
            identity_ck = BASE_COOKIE  # 复用原始 gid（避免 IP 风险）
        else:
            identity_ck = BASE_COOKIE  # 单次：复用 cookies.json
        anon = generate_anon_session(identity_ck=identity_ck)

        if anon.get('success'):
            results.append(anon['cookie'])
            print(f'  ✓ web_session : {anon["web_session"][:30]}...')
            if run_test or batch_n == 1:
                label = f'会话#{i+1}' if batch_n > 1 else '匿名 cookie（自动生成）'
                test_comment_api(anon['cookie'], label)
        else:
            print(f'  [!] 失败: {anon.get("error")}')
            if batch_n == 1 and BASE_COOKIE:
                print('\n[回退] 尝试用原始 cookies.json 直接测试 ...')
                test_comment_api(BASE_COOKIE, '原始 cookie')

    # ── 保存结果 ─────────────────────────────────────────────────────────────
    if results:
        if len(results) == 1:
            out_path = os.path.join(BASE_DIR, 'cookies_anonymous.json')
            open(out_path, 'w', encoding='utf-8').write(results[0])
            print(f'\n[✓] 完整匿名 cookie 已保存至 cookies_anonymous.json')
        else:
            out_path = os.path.join(BASE_DIR, 'cookies_batch.json')
            open(out_path, 'w', encoding='utf-8').write(
                json.dumps(results, ensure_ascii=False, indent=2)
            )
            print(f'\n[✓] {len(results)} 条匿名 cookie 已保存至 cookies_batch.json')

