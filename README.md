# 小红书 (XHS) Web 端签名逆向分析文档

> 本文档记录了对小红书网页版（`www.xiaohongshu.com`）API 请求签名体系的完整逆向分析过程，涵盖算法原理、环境补全策略、实战踩坑及完整调用示例。

---

## 目录

1. [项目概述](#1-项目概述)
2. [签名体系全景](#2-签名体系全景)
3. [核心算法深度解析](#3-核心算法深度解析)
4. [环境补全（补环境）策略](#4-环境补全补环境策略)
5. [实战踩坑记录](#5-实战踩坑记录)
6. [完整调用链路](#6-完整调用链路)
7. [项目文件结构](#7-项目文件结构)
8. [运行环境与依赖](#8-运行环境与依赖)
9. [后续维护建议](#9-后续维护建议)

---

## 1. 项目概述

### 1.1 目标

实现对小红书网页版敏感 API（评论、搜索、笔记详情等）的匿名访问，核心任务是还原请求头中的三个加密签名字段：`X-s`、`X-t`、`X-s-common`。

### 1.2 技术栈

| 组件 | 说明 |
|------|------|
| **签名引擎** | 基于 JSVMP 的 `xhs_main_260411.js`（约 318KB） |
| **Python 调用层** | `PyExecJS` 通过 Node.js 运行时执行 JS |
| **Cookie 采集** | Playwright (Chromium) 无头浏览器 |
| **HTTP 请求** | Python `requests` 库 |
| **加密依赖** | `crypto-js`（npm 包） |

---

## 2. 签名体系全景

### 2.1 请求头签名字段

小红书 API 网关通过以下自定义 Header 字段验证请求合法性：

| 字段名 | 格式示例 | 说明 |
|--------|---------|------|
| `X-s` | `XYS_2UQhPsHCH0c1PU...HdF=` | **核心签名**。由 JSVMP 虚拟机计算，输入为 URL 路径 + POST 数据 + 环境指纹 |
| `X-t` | `1777052028425` | 签名生成时的 **Unix 毫秒时间戳**，由 `Date.now()` 产生 |
| `X-s-common` | `eyJzMCI6NSwi...` | **辅助签名**。对 `X-s`、`X-t` 和 `a1` 进行二次校验，防篡改 |
| `x-s-v` | `1.3.8` | 签名算法版本号，需与 JS 引擎版本匹配 |
| `x-b3-traceid` | `a1b2c3d4e5f67890` | 分布式追踪 ID，16 位随机十六进制字符串 |
| `x-xray-traceid` | `cee010dc...d87104` | X-Ray 追踪 ID |

### 2.2 校验流程（服务端视角）

```
客户端请求 → API 网关
    ├── 1. 检查 Cookie 中是否包含有效的 web_session（匿名会话凭证）
    ├── 2. 检查 X-s 签名是否与请求路径 + Body 匹配
    ├── 3. 检查 X-s 内部的 a1 指纹是否与 Cookie 中的 a1 一致
    ├── 4. 检查 X-s-common 是否与 X-s + X-t + a1 匹配
    └── 5. 检查 X-t 时间戳是否在合理范围内（防重放）
```

**任何一项不通过，返回 `{"code": -101, "msg": "无登录信息，或登录信息为空"}`**

---

## 3. 核心算法深度解析

### 3.1 签名生成入口：`get_request_headers_params()`

该函数是 Python 层调用的主入口（`xhs_main_260411.js` 第 440 行）：

```javascript
function get_request_headers_params(api, data, a1, method) {
    method = method || "POST";
    var payload = data;
    if (typeof data === 'string' && data.trim()) {
        try { payload = JSON.parse(data); } catch (e) { payload = data; }
    }
    // 1. 计算 X-s 签名
    var xs = seccore_signv2(api, payload, a1);
    // 2. 生成时间戳
    var xt = Date.now();
    // 3. 计算 X-s-common 辅助签名
    var xs_common = XsCommon(a1, xs, xt);
    return { xs: xs, xt: xt, xs_common: xs_common };
}
```

### 3.2 X-s 签名核心：`seccore_signv2()`

位于 `xhs_main_260411.js` 第 337 行，是整个逆向的核心：

```javascript
function seccore_signv2(url_param, json_data, a1) {
    // ① 动态注入 Cookie 环境（关键修复点）
    if (a1) {
        document.cookie = 'abRequestId=...; xsecappid=xhs-pc-web; a1=' + a1 + '; webId=...; ...';
    }
    // ② 预处理请求数据
    var dataStr = '';
    if (json_data) {
        dataStr = (typeof json_data === 'object') ? JSON.stringify(json_data) : json_data;
    }
    // ③ 拼接待签名字符串
    var fullStr = url_param + dataStr;
    // ④ 计算两个 MD5 摘要
    var c = MD5(fullStr);    // 完整字符串的 MD5
    var d = MD5(url_param);  // 仅 URL 路径的 MD5
    // ⑤ 调用 JSVMP 虚拟机核心
    var s = window.mnsv2(fullStr, c, d);
    // ⑥ 封装签名对象
    var signObj = {
        x0: "4.3.2",      // 签名算法版本
        x1: "ugc",         // 应用标识
        x2: "Windows",     // 操作系统
        x3: s,             // JSVMP 计算结果
        x4: "object"       // 数据类型标记
    };
    // ⑦ Base64 编码 + 前缀
    return "XYS_" + b64Encode(encodeUtf8(JSON.stringify(signObj)));
}
```

### 3.3 JSVMP 虚拟机：`window.mnsv2()`

这是小红书签名的最核心防线。`mnsv2` 是一个 **JavaScript 虚拟机保护（JSVMP）** 函数，其特征如下：

- **字节码驱动**：将加密逻辑编译为私有字节码（位于 `__$c` 变量中，约 100KB+），运行时由解释器逐条执行
- **控制流平坦化**：所有操作码通过巨型 `if-else` 链分发，极难静态分析
- **环境指纹采集**：在执行过程中，会读取 `document.cookie`、`navigator`、`screen` 等浏览器环境信息
- **混淆层级**：变量名全部替换为 `_0x` 前缀的十六进制标识符

> **本项目不对 JSVMP 做二次逆向，而是采用"补环境"策略——在 Node.js 中模拟完整的浏览器 DOM 环境，让虚拟机在其中正常运行。**

### 3.4 X-s-common 辅助签名：`XsCommon()`

位于第 410 行，用于对 `X-s` 签名进行二次校验：

```javascript
function XsCommon(a1, xs, xt) {
    // 使用预置的指纹数据 fff 参与计算
    var md5_url2 = MD5(xt.toString() + xs + fff);
    var d = {
        s0: 5,                    // 固定值
        x0: "1",                  // 协议版本
        x1: "4.3.2",              // 算法版本
        x2: "Windows",            // 操作系统
        x3: "xhs-pc-web",         // 应用标识
        x4: "4.84.1",             // 客户端版本
        x5: a1,                   // Cookie 中的 a1
        x6: xt,                   // 时间戳
        x7: xs,                   // X-s 签名
        x8: fff,                  // 预置指纹数据（静态 Base64 串）
        x9: gens9(hexToBytes(md5_url2)),  // CRC32 校验值
        x10: 0,
        x11: "normal",
    };
    return b64Encode(encodeUtf8(JSON.stringify(d)));
}
```

其中 `fff` 是一段预置的 Base64 编码指纹数据，`gens9` 是 CRC32 计算函数。

---

## 4. 环境补全（补环境）策略

### 4.1 补环境原理

JSVMP 虚拟机在执行签名计算时，会检测当前运行环境是否为真实浏览器。在 Node.js 中运行时，需要模拟以下浏览器对象：

### 4.2 核心补全清单

| 对象/属性 | 补全位置（行号） | 说明 |
|-----------|----------------|------|
| `window` / `globalThis` | 1-160 | 全局对象，包含 `navigator`、`location`、`screen` 等 |
| `document.cookie` | 248, **337-341** | **最关键**。第 248 行为静态初始化，第 337-341 行为动态覆盖 |
| `navigator` | ~100 | `userAgent`、`platform`、`language` 等 |
| `HTMLDocument` | 241-274 | 模拟 DOM 文档对象 |
| `HTMLHtmlElement` | 190-215 | 模拟 `<html>` 元素 |
| `HTMLBodyElement` | 217-239 | 模拟 `<body>` 元素 |
| `chrome` | 161-175 | 模拟 Chrome 扩展 API |
| `screen` | ~120 | 屏幕分辨率等 |

### 4.3 Cookie 环境的动态同步（核心修复）

这是本项目最关键的修复。`seccore_signv2` 函数在第 339-341 行动态覆盖 `document.cookie`：

```javascript
if (a1) {
    document.cookie = 'abRequestId=...; xsecappid=xhs-pc-web; a1=' + a1
        + '; webId=...; gid=...; webBuild=6.7.4; web_session=...; websectiga=...';
}
```

**必须包含的关键 Cookie 字段：**

| Cookie 名 | 必要性 | 说明 |
|-----------|--------|------|
| `a1` | **必须动态传入** | 设备指纹标识，每次新会话不同 |
| `xsecappid` | 必须 | 固定值 `xhs-pc-web` |
| `webId` | 必须 | 浏览器指纹 ID |
| `gid` | 必须 | 全局会话 ID |
| `webBuild` | 必须 | 客户端构建版本号 |
| `websectiga` | 必须 | 安全签名标识 |
| `web_session` | 必须 | 匿名访问会话凭证 |

---

## 5. 实战踩坑记录

### 5.1 坑 1：指纹割裂（Signature Mismatch）

**现象**：签名生成成功，但接口返回 `-101`

**根因**：JS 沙箱中 `document.cookie` 里硬编码了旧的 `a1` 值，而 Python 请求使用了新的 `a1`。JSVMP 引擎读取的是沙箱内的旧 `a1`，导致生成的签名与实际请求携带的 `a1` 不匹配。

**修复**：在 `seccore_signv2` 函数执行前，动态将最新的 `a1` 注入到 `document.cookie` 中（见 4.3 节）。

### 5.2 坑 2：URL 编码不一致

**现象**：签名生成成功，但接口返回 `-101`

**根因**：`xsec_token` 参数末尾包含 `=` 字符。当使用 `requests.get(url, params=dict)` 时，`requests` 库会自动将 `=` 编码为 `%3D`。但生成签名时使用的是未编码的 `=`，导致 MD5 摘要不同。

```python
# 错误方式（签名路径与实际请求路径不一致）
params = {"xsec_token": "ABjn3...Ho="}
response = requests.get(url, params=params)  # requests 会将 = 转为 %3D

# 正确方式（手动处理编码，确保一致）
xsec_token = "ABjn3...Ho=".replace("=", "%3D")
full_url = f"https://edith.xiaohongshu.com/api/...?xsec_token={xsec_token}"
response = requests.get(full_url)  # 直接请求，不让 requests 二次编码
```

### 5.3 坑 3：HttpOnly Cookie 缺失（`web_session`）

**现象**：Cookie 看似完整，但接口仍返回 `-101`

**根因**：`web_session` 带有 `HttpOnly` 标记，JavaScript（包括浏览器控制台的 `document.cookie`）无法读取。通过脚本或插件复制的 Cookie 天然缺少此字段。

**修复**：

- **方法 A**（推荐）：使用 Playwright 的 `context.cookies()` API，它能获取**包含 HttpOnly 标记**的所有 Cookie
- **方法 B**：从浏览器 DevTools → Network → Request Headers 中手动复制完整的 `cookie:` 字段

### 5.4 坑 4：GBK 编码报错

**现象**：`UnicodeEncodeError: 'gbk' codec can't encode character '\U0001f31f'`

**根因**：Windows 系统默认编码为 GBK。`PyExecJS` 通过子进程管道将 JS 代码传给 Node.js 时，如果代码中包含 Emoji 或特殊 Unicode 字符，GBK 编码器会报错。

**修复**：清除 JS 文件中所有非 ASCII 字符（Emoji、特殊符号等），仅保留纯英文注释。

---

## 6. 完整调用链路

### 6.1 流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                        完整调用流程                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Step 1: Playwright 访问小红书首页                                │
│  ┌──────────────────────────────────────┐                       │
│  │  browser → https://www.xiaohongshu.com │                     │
│  │  等待 networkidle + 3s                 │                     │
│  │  提取全量 Cookie (含 HttpOnly)          │                     │
│  │  关闭浏览器释放资源                     │                     │
│  └──────────────┬───────────────────────┘                       │
│                 │ cookies_dict                                  │
│                 ▼                                                │
│  Step 2: 构造签名路径                                            │
│  ┌──────────────────────────────────────┐                       │
│  │  手动处理 URL 编码 (= → %3D)          │                      │
│  │  拼接完整 API 路径 (含 query string)  │                      │
│  └──────────────┬───────────────────────┘                       │
│                 │ full_api_path, a1                             │
│                 ▼                                                │
│  Step 3: 生成签名                                               │
│  ┌──────────────────────────────────────┐                       │
│  │  Python (execjs) → Node.js           │                       │
│  │  → get_request_headers_params()      │                       │
│  │    → seccore_signv2()  ← 注入 a1     │                       │
│  │      → MD5() × 2                     │                       │
│  │      → window.mnsv2() (JSVMP)        │                       │
│  │    → XsCommon()                       │                       │
│  │  返回 {xs, xt, xs_common}            │                       │
│  └──────────────┬───────────────────────┘                       │
│                 │ xs, xt, xs_common                             │
│                 ▼                                                │
│  Step 4: 发起 API 请求                                          │
│  ┌──────────────────────────────────────┐                       │
│  │  requests.get(full_url,              │                       │
│  │    headers={x-s, x-t, x-s-common},  │                       │
│  │    cookies=cookies_dict)             │                       │
│  │  → 返回评论/笔记/搜索数据             │                      │
│  └──────────────────────────────────────┘                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Python 调用示例

```python
from main import generate_xs_xs_common, generate_x_b3_traceid

# 1. 提取 a1
a1 = cookies_dict.get('a1')

# 2. 构造已编码的 API 路径
xsec_token = "ABjn3...Ho=".replace("=", "%3D")
full_api_path = f"/api/sns/web/v2/comment/page?note_id={note_id}&xsec_token={xsec_token}"

# 3. 生成签名三元组
xs, xt, xs_common = generate_xs_xs_common(a1, full_api_path, "", method='GET')

# 4. 构建请求头
headers = {
    "x-s": xs,
    "x-t": str(xt),
    "x-s-common": xs_common,
    "x-s-v": "1.3.8",
    "x-b3-traceid": generate_x_b3_traceid(),
    # ... 其他标准浏览器头
}

# 5. 发起请求（直接使用完整 URL，不用 params 参数）
full_url = f"https://edith.xiaohongshu.com{full_api_path}"
response = requests.get(full_url, headers=headers, cookies=cookies_dict)
```

---

## 7. 项目文件结构

```
xhs/
├── xhs_main_260411.js      # 核心签名引擎 (~318KB)
│                            #   - 浏览器环境模拟 (1-330行)
│                            #   - seccore_signv2 签名函数 (337-367行)
│                            #   - CRC32 + XsCommon 辅助签名 (372-430行)
│                            #   - get_request_headers_params 主入口 (440-462行)
│                            #   - JSVMP 字节码 + 解释器 (278-330行)
│                            #   - 模块导出 (473-497行)
│
├── main.py                  # Python 签名调用封装层
│                            #   - execjs 编译 JS 引擎
│                            #   - generate_xs_xs_common() 生成签名三元组
│                            #   - generate_xs() 仅生成 X-s + X-t
│                            #   - generate_headers() 生成完整请求头
│                            #   - trans_cookies() Cookie 字符串解析
│
├── xhs_playwright_test.py   # 全自动化测试脚本（推荐使用）
│                            #   - Playwright 访问首页获取游客 Cookie
│                            #   - 自动生成签名并请求评论接口
│
├── test_request.py          # 手动 Cookie 测试脚本
│                            #   - 使用硬编码 Cookie 进行签名测试
│
├── README_REVERSE.md        # 本文档
├── package.json             # npm 配置
└── node_modules/            # JS 依赖 (crypto-js)
```

---

## 8. 运行环境与依赖

### 8.1 系统要求

| 组件 | 版本要求 | 安装方式 |
|------|---------|---------|
| Python | 3.10+ | - |
| Node.js | 16+ | [nodejs.org](https://nodejs.org) |
| Playwright 浏览器 | Chromium | `playwright install chromium` |

### 8.2 Python 依赖

```bash
pip install PyExecJS requests playwright
```

### 8.3 JS 依赖

```bash
cd xhs/
npm install crypto-js
```

### 8.4 快速验证

```bash
# 全自动模式（推荐，自动获取 Cookie + 签名 + 请求）
python xhs_playwright_test.py

# 手动 Cookie 模式（需在脚本中填写从浏览器复制的完整 Cookie）
python test_request.py
```

---

## 9. 后续维护建议

### 9.1 签名算法更新

小红书会不定期更新签名算法版本。当请求开始批量失败时，需要：

1. 检查浏览器中 `x-s-v` 的值是否已变更（当前为 `1.3.8`）
2. 从浏览器中重新提取最新的签名 JS 文件
3. 更新 `seccore_signv2` 中的 `signObj.x0` 版本号

### 9.2 Cookie 生命周期管理

- 匿名 `web_session` 有效期有限，过期后需重新通过 Playwright 获取
- 建议建立 Cookie 池，检测到 `-101` 时自动轮换
- `a1` 与 `web_session` 是绑定关系，必须成对使用

### 9.3 风控等级升级

如果遇到 `300011`（风控拦截）等错误码：

- 增加请求间隔，模拟人类操作节奏
- 在 JS 环境中补充更多指纹（Canvas、WebGL、AudioContext 等）
- 考虑使用代理 IP 池分散请求来源
- 使用 `xsec_token` 时注意其有效期和绑定的笔记 ID

### 9.4 Windows 编码注意事项

- JS 文件中**禁止使用 Emoji 或非 ASCII 字符**，否则 `PyExecJS` 在 Windows (GBK) 环境下会报编码错误
- 注释统一使用英文或确保文件以 UTF-8 无 BOM 格式保存
