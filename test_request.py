import requests
import json
from main import generate_xs_xs_common, generate_x_b3_traceid, trans_cookies

def test_xhs_request():
    # 修复点 1：手动处理转码，确保计算 MD5 的路径与发送给服务器的一致
    note_id = "69e204690000000021038d7b"
    # 小红书服务器接收的是转码后的 %3D，签名计算也必须基于转码后的字符串
    xsec_token = "AB6ArQKxATnegrNcZjtGPQ7oOHgVEdw-M9ObsbZJYS6Ho=".replace("=", "%3D")
    
    # 手动拼接完整的带参数路径 (供签名使用)
    query_str = f"note_id={note_id}&cursor=&top_comment_id=&image_formats=jpg,webp,avif&xsec_token={xsec_token}"
    full_api_path = f"/api/sns/web/v2/comment/page?{query_str}"
    
    # 拼接完整的请求 URL (供 requests 使用)
    full_request_url = f"https://edith.xiaohongshu.com{full_api_path}"
    
    cookie_str = "abRequestId=79581748-f3e1-5bac-b2ac-99b3c29fba4b; xsecappid=xhs-pc-web; a1=19d57e8cd67gh1984uuqclxo276h7q97joljzvk9h50000643170; webId=7d55e4e1c9d6a5edc976170f19d84ae8; gid=yjf2WdYfWqVSyjf2WdYSflhTKWkxyjY477AS1jx1ClJWKV28xWAjWu888K4qyW88W222dj8j; webBuild=6.7.4; web_session=040069b7fa52ea22690f4002de3b4bb3d7067a; websectiga=cf46039d1971c7b9a650d87269f31ac8fe3bf71d61ebf9d9a0a87efb414b816c; sec_poison_id=7f0db15c-4abd-4dff-99f8-2ccca0d76c5e; loadts=1777049241038; ets=1777049252901"
    
    cookies = trans_cookies(cookie_str)
    a1 = cookies.get('a1')
    
    print(f"[*] Generating signature for path: {full_api_path}")
    xs, xt, xs_common = generate_xs_xs_common(a1, full_api_path, "")
    print(f"[+] Generated X-s: {xs}")
    print(f"[+] Generated X-t: {xt}")

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

    print(f"[*] Sending request...")
    try:
        # 修复点 2：直接请求完整 URL
        response = requests.get(full_request_url, headers=headers, cookies=cookies, timeout=10)
        print(f"[+] Status Code: {response.status_code}")
        
        res_json = response.json()
        if res_json.get('code') == 0:
            print("\n[SUCCESS] Comments fetched successfully!")
            print(json.dumps(res_json, indent=2, ensure_ascii=False))
        else:
            print(f"\n[ERROR] API returned: {res_json.get('msg')} (code: {res_json.get('code')})")
    except Exception as e:
        print(f"[-] Request failed: {e}")

if __name__ == "__main__":
    test_xhs_request()
