# 小红书 (XHS) 匿名 Cookie 生成完整指南

> 本文档记录通过纯 HTTP + jsdom 方案，**无需 Playwright/Chromium**，批量生成可用于访问受限 API 的匿名 Cookie 的完整流程。
>
> **状态**：批量模式评论接口 `code=0` ✅
> **特点**：单条耗时 2~5 秒，无浏览器依赖，可大规模生产
> **最后更新**：2026-05-15

---

## 目录

1. [项目概述](#1-项目概述)
2. [文件清单与依赖](#2-文件清单与依赖)
3. [快速开始](#3-快速开始)
4. [完整数据流](#4-完整数据流)
5. [核心模块解析](#5-核心模块解析)
6. [关键技术点](#6-关键技术点)
7. [风控阈值](#7-风控阈值)
8. [实战踩坑记录](#8-实战踩坑记录)
9. [后期维护指南](#9-后期维护指南)
10. [常见问题排查](#10-常见问题排查)

---

## 1. 项目概述

### 1.1 目标

给定一份**已被 XHS 信任**的基础身份（`cookies.json`，含 `a1` / `gid` 等长期字段），批量生成大量**带独立 `web_session`** 的匿名 Cookie。每条生成的 Cookie 都能独立用于访问需要"匿名登录态"的 API（评论列表、笔记详情等）。

### 1.2 与浏览器方案的对比

| 维度 | Playwright 方案 (旧) | 纯 HTTP + jsdom (本方案) |
|------|---------------------|--------------------------|
| 单条耗时 | 10s+ | 2~5s |
| 资源占用 | Chromium 进程 (~500MB) | Node 进程 (~50MB) |
| 并发能力 | 难（每条要独立浏览器） | 简单（多进程/异步即可） |
| 维护成本 | 反爬升级时受指纹/stealth 影响 | 仅需跟随签名算法升级 |

### 1.3 技术栈

| 组件 | 作用 |
|------|------|
| **Python 3.10+** | 编排层、HTTP 请求、入口 |
| **`curl_cffi`** | 替代 `requests`，支持 `impersonate='firefox135'` 模拟浏览器 TLS/HTTP2 指纹 |
| **`execjs` + Node.js** | 执行 `xhs_main_260411.js` 生成 `x-s` / `x-t` / `x-s-common` 签名 |
| **`jsdom`** (npm) | 沙箱执行 XHS 下发的 scripting JS，提取 `websectiga` |
| **`xhs_main_260411.js`** | 签名核心引擎（JSVMP 虚拟机） |

---

## 2. 文件清单与依赖

### 2.1 必备文件（缺一不可）

```
xhs/
├── main.py                  ← 主入口（Python 编排层）
├── capture_scripting.js     ← Node 端：拉取 scripting JS 响应
├── run_scripting_jsdom.js   ← Node 端：jsdom 沙箱执行脚本 → 提取 websectiga
├── xhs_main_260411.js       ← XHS 官方签名引擎（约 318KB）
├── cookies.json             ← 基础身份（含已被信任的 a1+gid）
├── package.json             ← npm 配置（jsdom + crypto-js）
└── node_modules/            ← npm install 后生成
```

### 2.2 运行时生成的文件

```
xhs/
├── cookies_anonymous.json   ← 单次模式输出（一行 cookie 字符串）
├── cookies_batch.json       ← 批量模式输出（JSON 数组）
├── scripting_raw.js         ← 最近一次 scripting 端点的响应（调试用）
└── sec_poison_id.txt        ← 最近一次 sec_poison_id（调试用）
```

### 2.3 环境要求

| 组件 | 版本 | 安装命令 |
|------|------|---------|
| Python | 3.10+ | — |
| Node.js | 16+ | [nodejs.org](https://nodejs.org) |
| Python 依赖 | — | `pip install PyExecJS curl_cffi` |
| Node 依赖 | jsdom ^29.1.1<br>crypto-js ^4.2.0 | `npm install` |

### 2.4 `cookies.json` 字段要求

⚠️ **`cookies.json` 是整套方案的"信任凭据"，必须从真实浏览器采集**。

**必须保留：**

| 字段 | 用途 | 备注 |
|------|------|------|
| `a1` | 设备指纹 | 52 字符，本方案以此为基底生成新 a1 |
| `gid` | 全局设备 ID | **前缀必须是 `yjDY`**（受信任）；`yjdJ` 前缀会触发 IP 风险 |
| `webId` | 浏览器指纹 ID | md5(a1) 衍生 |
| `b1` | a1 衍生指纹 | CRC32(a1) |
| `xsecappid` | 应用标识 | 固定值 `xhs-pc-web` |
| `webBuild` | 客户端版本号 | 当前 `6.10.3`，需跟随官方版本升级 |

**必须剔除：**

| 字段 | 原因 |
|------|------|
| `web_session` | 会话级，本流程会重新生成 |
| `websectiga` | 短期签名，需每次重算 |
| `sec_poison_id` | 同上 |
| `acw_tc` | WAF 临时会话 |

**示例 `cookies.json`（单行）：**

```
a1=19b8effd1ac78suri6qrt923vwlm5ym5umwyighia50000329872; webId=7f69728c813b546d7e3b21c9a2483134; gid=yjDYdiidJS72yjDYdiify6kx0SWYM7F3KAF9E30jJqhE1v2862v623888qJjYWJ80YJDSd4J; b1=...; xsecappid=xhs-pc-web; webBuild=6.10.3
```

---

## 3. 快速开始

### 3.1 安装依赖

```powershell
cd xhs/
npm install
pip install PyExecJS curl_cffi
```

### 3.2 准备身份

从真实浏览器复制 `a1` / `gid` / `webId` / `b1` 等字段到 `cookies.json`（参考 §2.4）。

### 3.3 运行命令

| 命令 | 行为 | 用途 |
|------|------|------|
| `python main.py` | 复用 `cookies.json` 身份生成 1 条 | 日常单次刷新 |
| `python main.py --test` | 同上 + 自动跑评论接口验证 | 调试验证 |
| `python main.py --batch N` | 用 `cookies.json` 身份生成 N 条独立会话 | **批量生产** |
| `python main.py --batch N --test` | 批量 + 每条自检 | 批量 + 验证 |
| `python main.py --fresh` | **本地伪造**全新 a1，调 webprofile 拿新 gid | 测试新身份链路（会 `300012`） |

**输出文件：**

- 单条 → `cookies_anonymous.json`（一行字符串）
- 多条 → `cookies_batch.json`（JSON 数组）

### 3.4 成功输出示例

```
============================================================
[步骤 1] 从 cookies.json 身份自动生成匿名会话
  （a1/webId/gid 保持不变，自动刷新 websectiga + web_session）
============================================================
  a1     : 19b8effd1ac78suri6qrt923vwlm5ym5umwyighia50000329872
  webId  : 7f69728c813b546d7e3b21c9a2483134
  gid    : yjDYdiidJS72yjDYdiify6kx0SWYM7...
  [*] 访问首页获取 acw_tc ...
  acw_tc : 0a00d96117787780230335651e4b430123bbac38
  [*] 生成 websectiga ...
  ✓ websectiga（尝试 2）: 3934fe24d49c7dd0eb923efc8205740f10fdb18b25d424d2a2322c6196d2a4ad
  [*] 调用 activate 获取 web_session ...
  activate [edith.xiaohongshu.com] status : 200
  ✓ web_session   : 030037ae68b314c82d10f0b97d2d4a...
[*] 评论接口 [匿名 cookie（自动生成）] HTTP 200  code=0  评论数=9
[✓] 完整匿名 cookie 已保存至 cookies_anonymous.json
```

---

## 4. 完整数据流

### 4.1 高层流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│  cookies.json (基础身份)                                              │
│  └─ a1 + gid + webId + b1   ← 真实浏览器采集，必须 yjDY 前缀 gid       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼ (每次会话独立执行以下 3 步)
┌─────────────────────────────────────────────────────────────────────┐
│ Step 1: GET https://www.xiaohongshu.com/                             │
│   携带：a1 + gid + webId   →  Set-Cookie: acw_tc, abRequestId         │
│   作用：让 WAF 给本次会话下发临时 acw_tc，并热身身份                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Step 2: POST https://as.xiaohongshu.com/api/sec/v1/scripting         │
│   body: {"callFrom":"web","callback":"seccallback"}                  │
│   → 返回一段动态 JS（含 seccallback("…hex…") 调用）                    │
│                                                                       │
│   用 Node.js + jsdom 执行该 JS，捕获 seccallback 参数：                 │
│     - 若是 64 位纯 hex → websectiga ✓                                 │
│     - 否则（含 g/h/:/; 等非 hex 字符）→ 被服务端污染，重试，最多 10 次   │
│                                                                       │
│   同时从响应头取 sec_poison_id (UUID)，一并写入 cookie                │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Step 3: POST https://edith.xiaohongshu.com/api/sns/web/v1/login/activate │
│   headers: x-s / x-t / x-s-common (由 xhs_main_260411.js 签名生成)    │
│   body:    {}                                                         │
│   cookies: 全部累积字段 + websectiga + sec_poison_id                  │
│   → Set-Cookie: web_session（每次唯一）                                │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
        最终 cookie = a1; webId; gid; b1; xsecappid; webBuild;
                      acw_tc; abRequestId; websectiga;
                      sec_poison_id; web_session
```

### 4.2 单条生成时序

```
Python main.py
  │
  ├── 读 cookies.json                              [I/O]
  ├── GET https://www.xiaohongshu.com/              [HTTP, ~500ms]
  │     ← Set-Cookie: acw_tc, abRequestId
  │
  ├── 重试循环 (最多 10 次):
  │   ├── subprocess: node capture_scripting.js     [Node, ~600ms]
  │   │     ← POST as.xiaohongshu.com/.../scripting
  │   │     → scripting_raw.js + sec_poison_id.txt
  │   │
  │   └── subprocess: node run_scripting_jsdom.js   [Node + jsdom, ~1.5s]
  │         → JSON: {websectiga, sec_poison_id}
  │         ├── is_valid_websectiga(hex 64)? → break
  │         └── 非 hex → 重试
  │
  ├── execjs.call('get_request_headers_params')     [Node, ~300ms]
  │     → {xs, xt, xs_common}
  │
  └── POST edith.xiaohongshu.com/.../activate       [HTTP, ~400ms]
        ← Set-Cookie: web_session
        → 写 cookies_anonymous.json
```

**总耗时**：2~5 秒/条（取决于 websectiga 重试次数）

---

## 5. 核心模块解析

### 5.1 `main.py`（Python 编排层）

| 函数 | 功能 | 关键参数 |
|------|------|---------|
| `generate_a1(platform)` | 本地生成 52 字符合法 `a1`（时间戳+随机+平台码+CRC32） | `'Windows'` |
| `generate_b1(a1)` | CRC32(a1) → 8 位十六进制 | — |
| `get_fresh_identity()` | 纯 HTTP 生成新身份：本地造 a1/b1，访问首页拿 acw_tc，POST webprofile 拿 gid | 见 §6.1 |
| `refresh_gid_only(ck)` | 复用 a1 但调 webprofile 只刷新 gid（**当前未启用**，会触发 IP 风险） | — |
| `capture_scripting_js(ck)` | 调用 `capture_scripting.js`，把 scripting 响应存到 `scripting_raw.js` | cookie 字符串 |
| `get_websectiga_via_jsdom(ck)` | 调用 `run_scripting_jsdom.js` 在 jsdom 中执行脚本，返回 `{websectiga, sec_poison_id}` | timeout 默认 30s |
| `is_valid_websectiga(s)` | 校验 `^[0-9a-f]{64}$` | 污染判定的唯一依据 |
| `inject_websectiga_into_cookie()` | 把 websectiga / sec_poison_id 写回 cookie 字符串 | — |
| `generate_anon_session(identity_ck)` | **主流程**：解析身份 → 首页热身 → 重试拿 websectiga → activate 拿 web_session | 见 §6.2 |
| `generate_headers(a1, api, data, method)` | 用 `xhs_main_260411.js` 生成 `x-s`/`x-t`/`x-s-common` | — |
| `test_comment_api(ck, label)` | 用生成的 cookie 跑评论列表接口，打印 code | 验证用 |

**入口逻辑（约 line 603）**：

```python
if fresh:
    identity_ck = ''                # 全新身份（评论会 300012，仅用于链路测试）
elif batch_n > 1 and BASE_COOKIE:
    identity_ck = BASE_COOKIE       # 批量：复用原 a1+gid，每条 web_session 唯一
else:
    identity_ck = BASE_COOKIE       # 单条：同上
```

### 5.2 `capture_scripting.js`（Node 端）

**输入**：cookie 字符串（命令行参数）

**输出**：
- `scripting_raw.js`（响应 JS 内容）
- `sec_poison_id.txt`（响应头 `x-poison-id`）

**核心逻辑**：

```js
POST https://as.xiaohongshu.com/api/sec/v1/scripting
  cookies: 传入的 ck
  body:    {"callFrom":"web","callback":"seccallback"}

→ 保存 response.body 到 scripting_raw.js
→ 保存 response.headers['x-poison-id'] 到 sec_poison_id.txt
```

### 5.3 `run_scripting_jsdom.js`（Node 端）

**输入**：cookie 字符串

**输出**：JSON 一行
```json
{"success": true, "websectiga": "<64位hex>", "sec_poison_id": "<UUID>"}
```

**核心逻辑**：

```js
// 在 jsdom 沙箱注入 crypto.subtle、document、cookie
const dom = new JSDOM(...);
dom.window.seccallback = function(arg) {
    // 捕获回调参数，即 websectiga
    process.stdout.write(JSON.stringify({success: true, websectiga: arg, ...}));
};
// 在沙箱中执行 scripting_raw.js
dom.window.eval(scripting_raw_content);
```

### 5.4 `xhs_main_260411.js`（签名引擎）

由 XHS 官方下发的 `signUrl` 反混淆得来，导出：

```js
function get_request_headers_params(api, data, a1, method) {
    return { xs, xt, xs_common };
}
```

**核心结构**：

- 第 1~330 行：浏览器环境补全（`window`、`document`、`navigator`、`screen` 等）
- 第 337~367 行：`seccore_signv2()` 签名核心
- 第 372~430 行：`XsCommon()` 辅助签名
- 第 440~462 行：`get_request_headers_params()` 主入口
- 第 278~330 行：JSVMP 字节码 + 解释器
- 第 473~497 行：模块导出

---

## 6. 关键技术点

### 6.1 `get_fresh_identity()` 内部

```
1. a1 = generate_a1('Windows')        本地生成（52 字符）
2. b1 = CRC32(a1)
3. webId = md5(a1)
4. GET https://www.xiaohongshu.com/    → 取 Set-Cookie: acw_tc
5. POST https://www.xiaohongshu.com/api/sec/v1/shield/webprofile
   headers:
     content-type: application/json;charset=UTF-8
     origin/referer: https://www.xiaohongshu.com/
   cookies: a1 + b1 + acw_tc + xsecappid=xhs-pc-web
   body:
     {"platform":"PC","sdkVersion":"3.3.4","svn":"2",
      "profileData":"<固定 178 字符 hex>",
      "reportUrl":"/api/sec/v1/shield/webprofile"}
   → Set-Cookie: gid (服务端随机生成，每次唯一，必为 yjdJ 前缀)
```

⚠️ **重要发现**：

| 现象 | 说明 |
|------|------|
| `gid` 在响应 **Set-Cookie 头**，不在 body | 必须 `r.cookies.get('gid')` 取，`r.json()['data']` 没有 |
| 固定 `profileData` 也能拿到 gid | 但前缀必为 `yjdJ`（受限身份），评论会 `300012` |
| 真实 29648 字符指纹也是 `yjdJ` 前缀 | → 前缀由**时间/会话状态**决定，与指纹内容无关 |
| 真正信任的 `yjDY` 前缀 | 只有真实浏览器访问几次后才会出现，必须人工采集 |

### 6.2 `generate_anon_session()` 内部

```
1. 解析 identity_ck 拿 a1，剔除会话字段（web_session/websectiga/acw_tc/...）
   identity_ck 为空 → 调 get_fresh_identity()
2. GET https://www.xiaohongshu.com/   携带身份 cookie 热身
   收集 Set-Cookie: acw_tc, abRequestId
3. for attempt in 1..10:
     capture_scripting_js(base_ck)         # 调 capture_scripting.js
     r = get_websectiga_via_jsdom(base_ck) # 调 run_scripting_jsdom.js
     if is_valid_websectiga(r.websectiga): break
   失败 → 整个会话返回 success=False
4. inject_websectiga_into_cookie()         # 写回 websectiga / sec_poison_id
5. for host in (www, edith):
     POST {host}/api/sns/web/v1/login/activate
       headers = generate_headers(a1, api, '{}', 'POST')
                 + origin/referer + x-mns=unload
       data    = b'{}'
     if Set-Cookie: web_session → 拼回 cookie，成功返回
```

**注意**：`www.xiaohongshu.com/api/sns/web/v1/login/activate` 经常返回 500 `create invoker failed`，是正常现象，会自动 fallback 到 `edith.xiaohongshu.com`。

### 6.3 websectiga 污染与重试

scripting 端点返回的 JS 中嵌入 `seccallback("…")` 调用，参数本应是 64 位纯 hex。但对**新建（未热身）的 a1+gid**，服务端会**故意污染字符**：

| 实际字符 | 应为 | ASCII 偏移 |
|---------|------|-----------|
| `g` | `c` | +4 |
| `h` | `d` | +4 |
| `<` | `9` | +3 |
| `:` | `6` | +4 |
| `;` | `7` | +4 |

→ **判定**：`re.fullmatch(r'[0-9a-f]{64}', s)`，不通过就重试。
→ 真实浏览器 SDK 内部有重试逻辑，模拟该行为即可。
→ 经热身（首页携带身份访问后）通常 1~3 次能拿到干净结果。

### 6.4 签名注入 a1（指纹一致性）

`xhs_main_260411.js` 在 `seccore_signv2` 函数内会**动态覆盖 `document.cookie`**，强制使用 Python 传入的 `a1`：

```js
if (a1) {
    document.cookie = '...; a1=' + a1 + '; ...';
}
```

这保证了：**生成签名时用的 a1 必须与 HTTP 请求实际携带的 a1 一致**，否则服务端校验失败返回 `-101`。

---

## 7. 风控阈值

基于实测数据（单 cookie、固定 note_id）：

| 间隔 | 触发位置 | 结论 |
|------|---------|------|
| 0.5s | 第 31 次 | 滑动窗口 ~30 次触发 `300013 访问频繁` |
| 0.1s | 第 39 次 | 与间隔无关，主要看总次数 |
| 触发后立即重试 | 第 1 次就拦 | 冷却期内全部拦截 |

**规律**：

- 限流粒度绑定 **`web_session`**，不是 IP
- 大致阈值为**单 cookie ≤ 30 次请求/短时间窗**
- 触发后该 cookie 进入冷却期（具体时长未测）

**实用建议**：

- ✅ 单 cookie 安全频率：**≤ 2 req/s**（0.5s 间隔）
- ✅ 单 cookie 安全总量：**≤ 25 次**，留 buffer 避免踩线
- ✅ 高吞吐场景：批量生成多条 cookie 轮换使用，每条独立计数
- ❌ 不要在 cookie 冷却期间继续重试，需要等待或换 cookie

---

## 8. 实战踩坑记录

### 8.1 坑 1：gid 从 body 取不到

**现象**：`webprofile` 接口 `status=200`，但 `r.json()['data']` 里没有 `gid`。

**根因**：`gid` 在响应 **Set-Cookie 头**，不在 JSON body。

**修复**：

```python
r = sess.post('.../webprofile', ...)
gid = r.cookies.get('gid', '')   # ✓ 从 Set-Cookie 头取
# gid = r.json()['data'].get('gid')   # ✗ 错误
```

### 8.2 坑 2：`yjdJ` 前缀 gid 评论 `300012`

**现象**：用 `--fresh` 模式生成的 cookie，评论接口返回 `300012 IP 存在风险`。

**根因**：`get_fresh_identity()` 通过 webprofile 拿到的 gid 永远是 `yjdJ` 前缀（受限身份），不被信任。

**修复**：

- ❌ 不要用 `--fresh` 做生产，仅用于链路测试
- ✅ `--batch N` 模式复用 `cookies.json` 里的 `yjDY` 前缀 gid（真实浏览器采集），每条只生成新 `web_session`

### 8.3 坑 3：websectiga 重试一直失败

**现象**：`websectiga 10 次尝试全部失败`，每次都是含 `g`/`h`/`:` 等非 hex 字符的脏值。

**根因**：

1. `cookies.json` 里的 gid 失效或已被标记
2. 首页热身没起作用，base_ck 不完整

**修复**：

1. 重新用真实浏览器采集 `cookies.json`，确认 gid 是 `yjDY` 前缀
2. 检查首页 GET 请求的 cookies 是否完整携带了身份字段
3. 临时把 `is_valid_websectiga` 改宽松，看是否能跑通（仅调试）

### 8.4 坑 4：activate 在 `www` 域名 500，`edith` 200

**现象**：

```
activate [www.xiaohongshu.com] status : 500
activate body   : create invoker failed, service: jarvis-gateway-default
activate [edith.xiaohongshu.com] status : 200
```

**根因**：XHS 内部网关路由变化，`www` 已不接 activate。

**修复**：已在 `generate_anon_session()` 中实现 fallback，**两个 host 都试，任一成功即可**，无需手动改。

### 8.5 坑 5：Windows GBK 编码报错

**现象**：

```
UnicodeEncodeError: 'gbk' codec can't encode character '\u2717'
```

**根因**：Windows 默认控制台是 GBK，`✗` (U+2717) 等特殊符号编码失败。

**修复**：所有打印中的特殊字符改为 ASCII：

- `✗` → `[x]`
- `✓` 保留（`\u2713` 大多数版本可显示）
- 也可以在脚本头部加 `sys.stdout.reconfigure(encoding='utf-8')`

### 8.6 坑 6：批量模式每条会触发 `300012`

**现象**：早期版本批量模式调用 `refresh_gid_only()`，每条都重新拿 gid，结果**每条都 `300012`**。

**根因**：`refresh_gid_only` 调 webprofile 拿到的新 gid 是 `yjdJ` 前缀，受限。

**修复**：批量模式**完全复用 cookies.json 的原始 gid**，每条只走 `scripting → activate` 拿新 `web_session`。

---

## 9. 后期维护指南

按改动可能性从高到低排序。

### 9.1 `cookies.json` 过期（最高频）

**症状**：所有模式评论接口都 `code=300012` 或返回登录过期 `code=-100`。

**原因**：基础 gid/a1 被 XHS 标记过期或失效。

**修复步骤**：

1. 用真实 Chrome/Edge 打开 https://www.xiaohongshu.com/explore
2. 浏览几个笔记，让 XHS 把你"养熟"（让 gid 变成 `yjDY` 前缀）
3. F12 → Application → Cookies → 复制全部
4. 粘贴成单行 `key=value; key=value; ...` 写入 `cookies.json`
   - 必须保留：`a1`、`gid`（前缀应为 `yjDY`）、`webId`、`b1`、`xsecappid`、`webBuild`
   - 可选：`acw_tc`、`abRequestId`（运行时会重新拿）
   - **必须剔除**：`web_session`、`websectiga`、`sec_poison_id`（会被脚本动态生成）

### 9.2 scripting 端点变化（中频）

**症状**：`websectiga 10 次尝试全部失败`，且 `seccallback` 输出根本不是 hex 而是 base64 / JSON 等。

**修复**：

1. 查看 `xhs/scripting_raw.js`（最近一次响应）
2. 在 jsdom 控制台手动跑，看新的回调形式
3. 修改 `run_scripting_jsdom.js` 里捕获 `seccallback` 的逻辑
4. 如果格式整体变了 → 改 `is_valid_websectiga()` 校验函数

### 9.3 签名算法变化（中频）

**症状**：activate 或评论接口返回 `code=-100` / `461 sign error`。

**修复**：

1. 从浏览器拉取最新的 `signUrl`（在 `as.xiaohongshu.com/api/sec/v1/scripting` 的 getconfig 响应里）
2. 反混淆后替换 `xhs_main_260411.js`
3. 确保对外导出 `get_request_headers_params(api, data, a1, method) → {xs, xt, xs_common}`
4. 若函数签名没变，Python 端无需修改
5. 注意检查 `x-s-v` 版本号，必要时同步更新请求头

### 9.4 webprofile 接口变化（低频）

**症状**：`webprofile 未返回 gid (status=4xx)`。

**修复**：

1. 看返回 body 的错误码（通常是 `sdkVersion` 或 `profileData` 格式校验失败）
2. 从浏览器 DevTools Network 抓真实的 webprofile 请求，对比 body 字段
3. 改 `get_fresh_identity()` 里的 `sdkVersion` / `profileData` 字段
4. ⚠️ `gid` 永远在 Set-Cookie 头，不要去 body 里找

### 9.5 a1 生成规则变化（低频）

**症状**：本地生成的 a1 拿不到 gid，或 activate 报 invalid a1。

**修复**：

1. 抓真实浏览器的 a1，对比格式（目前是 `<13位ts><30位随机><1位平台码>0000<8位CRC32>` 共 52 字符）
2. 改 `generate_a1()` 的字符集 / 长度 / CRC 算法
3. 参考 XHS 官方 SDK 的 `generateLocalId()` 函数

### 9.6 `webBuild` 版本号升级（低频，可选）

**症状**：返回数据缺字段，或 `x-s-v` 报版本不匹配。

**修复**：

1. 浏览器 DevTools 看真实请求里 `cookie: webBuild=X.X.X`
2. 更新 `cookies.json` 里的 `webBuild` 字段
3. 必要时同步 `xhs_main_260411.js` 里的版本字符串

### 9.7 风控阈值变化

**症状**：之前 25 次/小时安全，现在 10 次就触发。

**修复**：

- 降低单 cookie 使用频率
- 增加 cookie 池规模（`--batch N` 一次生成多条轮换）
- 引入代理 IP 池分散来源
- 在请求间加随机延迟模拟人类行为

---

## 10. 常见问题排查

### 10.1 评论接口返回 `code=-100 登录已过期`

| 可能原因 | 排查 |
|---------|------|
| `web_session` 没注入 | 检查最终 cookie 是否包含 `web_session=` 字段 |
| `a1` 签名时和实际请求不一致 | 确认 `generate_headers(a1, ...)` 传入的 a1 与 cookie 里的一致 |
| URL 编码不一致 | 检查 `xsec_token` 等含 `=` 参数，签名路径与请求 URL 必须**完全相同**（包括是否 URL 编码） |
| `web_session` 已过期 | 重新运行 `python main.py` 生成 |

### 10.2 评论接口返回 `code=300012 IP 存在风险`

| 可能原因 | 排查 |
|---------|------|
| 用 `--fresh` 生成的 cookie | 改用 `--batch N`，复用 cookies.json 原始 gid |
| `cookies.json` 里 gid 是 `yjdJ` 前缀 | 重新采集，确保是 `yjDY` 前缀 |
| IP 已被风控 | 换 IP / 等冷却 |

### 10.3 评论接口返回 `code=300013 访问频繁`

| 可能原因 | 排查 |
|---------|------|
| 单 cookie 短时间内请求过多 | 降低频率到 ≤ 2 req/s，单 cookie 总量 ≤ 25 |
| cookie 处于冷却期 | 换一条新 cookie |

### 10.4 `websectiga 10 次尝试全部失败`

| 可能原因 | 排查 |
|---------|------|
| `cookies.json` 失效 | §9.1 重新采集 |
| jsdom 版本不兼容 | `npm install jsdom@29.1.1` |
| Node 版本过低 | `node -v` 应 ≥ 16 |
| 首页热身失败 | 看日志里 `acw_tc` 是否拿到 |

### 10.5 `webprofile 未返回 gid (status=4xx)`

| 可能原因 | 排查 |
|---------|------|
| `profileData` 格式变了 | §9.4 |
| `sdkVersion` 过期 | 抓真实请求看新版本号 |
| WAF 拦截 | 检查响应 body 是否含 "blocked" / "challenge" |

### 10.6 Node 子进程超时

| 可能原因 | 排查 |
|---------|------|
| jsdom 启动慢（首次） | 第一次运行通常较慢，第二次正常 |
| 网络问题（scripting 端点慢） | 加大 `get_websectiga_via_jsdom` 的 `timeout` |

---

## 附录 A：错误码对照表

| code | 含义 | 解决方向 |
|------|------|---------|
| `0` | 成功 | — |
| `-100` | 登录已过期 | 重新生成 cookie / 检查 web_session |
| `-101` | 签名错误 | 检查 a1 一致性 / URL 编码 |
| `300012` | IP 存在风险 | 用 yjDY 前缀 gid / 换 IP |
| `300013` | 访问频繁 | 降低频率 / 换 cookie |
| `461` | 签名版本错误 | 升级 `xhs_main_260411.js` |

## 附录 B：关键 URL

| 用途 | URL | 方法 |
|------|-----|------|
| 首页热身 | `https://www.xiaohongshu.com/` | GET |
| 拿 gid | `https://www.xiaohongshu.com/api/sec/v1/shield/webprofile` | POST |
| 拿 websectiga | `https://as.xiaohongshu.com/api/sec/v1/scripting` | POST |
| 拿 web_session | `https://edith.xiaohongshu.com/api/sns/web/v1/login/activate` | POST |
| 测试评论 | `https://edith.xiaohongshu.com/api/sns/web/v2/comment/page` | GET |
