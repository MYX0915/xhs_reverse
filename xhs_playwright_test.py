import json
import time
import requests
from playwright.sync_api import sync_playwright
from main import generate_xs_xs_common, generate_x_b3_traceid, trans_cookies

def get_guest_cookies_from_home():
    """访问小红书首页并获取完整游客 Cookie (包含 HttpOnly 字段)"""
    home_url = "https://www.xiaohongshu.com"
    print(f"[*] 正在启动浏览器访问首页: {home_url}")
    
    with sync_playwright() as p:
        # 启动无头浏览器
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
        )
        page = context.new_page()
        
        # 访问首页
        page.goto(home_url)
        
        # 等待首页加载和 Cookie 植入
        print("[*] 等待首页会话激活...")
        page.wait_for_load_state("networkidle")
        time.sleep(3) # 额外等待确保 HttpOnly Cookie (如 web_session) 写入完毕
        
        # 提取所有 Cookie
        playwright_cookies = context.cookies()
        cookies_dict = {c['name']: c['value'] for c in playwright_cookies}
        
        browser.close()
        print("[+] 首页 Cookie 获取成功，浏览器已关闭并释放")
        return cookies_dict

def fetch_note_comments(cookies_dict, note_id, xsec_token_raw):
    """使用获取的 Cookie 和逆向算法请求指定笔记的评论"""
    # 核心：处理 xsec_token 转码，确保签名路径 100% 匹配请求路径
    xsec_token = xsec_token_raw.replace("=", "%3D")
    
    api_url = "https://edith.xiaohongshu.com/api/sns/web/v2/comment/page"
    query_str = f"note_id={note_id}&cursor=&top_comment_id=&image_formats=jpg,webp,avif&xsec_token={xsec_token}"
    full_api_path = f"/api/sns/web/v2/comment/page?{query_str}"
    full_request_url = f"https://edith.xiaohongshu.com{full_api_path}"
    
    a1 = cookies_dict.get('a1', '')
    print(f"[*] 正在生成签名 (基于 a1: {a1[:10]}...)")
    
    # 调用逆向导出的签名函数
    xs, xt, xs_common = generate_xs_xs_common(a1, full_api_path, "", method='GET')
    
    headers = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        "origin": "https://www.xiaohongshu.com",
        "referer": "https://www.xiaohongshu.com/",
        "sec-ch-ua": '"Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0",
        "x-b3-traceid": generate_x_b3_traceid(),
        "x-s": xs,
        "x-t": str(xt),
        "x-s-common": xs_common,
        "x-s-v": "1.3.8",
        "x-xray-traceid": "cee010dca0405e8f1c6cdc47ced87104"
    }
    
    print(f"[*] 正在请求评论接口: {note_id}")
    try:
        response = requests.get(full_request_url, headers=headers, cookies=cookies_dict, timeout=10)
        print(f"[+] 状态码: {response.status_code}")
        res_json = response.json()
        
        if res_json.get('code') == 0:
            print("\n✅ 成功获取评论！部分数据如下：")
            print(json.dumps(res_json, indent=2, ensure_ascii=False))
        else:
            print(f"\n❌ 获取失败: {res_json.get('msg')} (代码: {res_json.get('code')})")
            if res_json.get('code') == -101:
                print("提示：-101 通常是因为首页获取的 Cookie 中缺少 web_session，请确保 Playwright 运行环境正常。")
    except Exception as e:
        print(f"[-] 发生错误: {e}")

if __name__ == "__main__":
    # 指定要爬取的笔记 ID 和 Token
    target_note_id = "69eb1bc10000000019032401"
    target_xsec_token = "ABjn3ShfSRJsT1scWcRV30M2xwrkR4s7AxovdEXerSPH0="
    
    # 1. 首页获取 Cookie
    guest_cookies = get_guest_cookies_from_home()
    
    # 2. 调用接口
    fetch_note_comments(guest_cookies, target_note_id, target_xsec_token)
