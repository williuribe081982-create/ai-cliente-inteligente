import requests,json,os,re,time
os.makedirs("media/spa-cand",exist_ok=True)
H={"User-Agent":"WIA-demo/1.0 (whia.soluciones demo; contact via github) python-requests"}
HB={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}
meta=[]
def save(url,name,info,hd=H):
    try:
        b=requests.get(url,headers=hd,timeout=60)
        if b.status_code==200 and len(b.content)>8000:
            fn=f"media/spa-cand/{name}.jpg"; open(fn,"wb").write(b.content); info["file"]=fn; meta.append(info); return True
        print("dl",b.status_code,url[:80])
    except Exception as e: print("dl err",e)
    return False
for q in ["facial","skincare","face-mask","massage","beauty-products","manicure","spa-candles","serum","towels"]:
    time.sleep(8)
    try:
        r=requests.get(f"https://burst.shopify.com/photos/search?q={q}",headers=HB,timeout=30); print("burst",q,r.status_code)
        urls=[]
        for m in re.finditer(r'https://burst\.shopifycdn\.com/photos/([a-z0-9\-]+)\.jpg',r.text):
            if m.group(1) not in urls: urls.append(m.group(1))
        n=0
        for slug in urls[:8]:
            time.sleep(1)
            if save(f"https://burst.shopifycdn.com/photos/{slug}.jpg?width=720&format=pjpg&exif=0&iptc=0",f"b_{q}_{n}",{"src":"burst","slug":slug,"q":q},HB): n+=1
    except Exception as e: print("burst err",q,e)
for q in ["facial treatment beauty salon","spa massage woman","cosmetics skincare bottles","facial mask woman","spa relaxation room","manicure salon","beautician","day spa"]:
    try:
        r=requests.get("https://commons.wikimedia.org/w/api.php",params={"action":"query","generator":"search","gsrnamespace":6,"gsrsearch":q+" filetype:bitmap","gsrlimit":10,"prop":"imageinfo","iiprop":"url|extmetadata|size","iiurlwidth":720,"format":"json"},headers=H,timeout=40)
        pages=r.json().get("query",{}).get("pages",{}); print("wm",q,len(pages))
        n=0
        for p in pages.values():
            ii=p["imageinfo"][0]; md=ii.get("extmetadata",{})
            if ii.get("width",0)<900: continue
            lic=md.get("LicenseShortName",{}).get("value","")
            if save(ii["thumburl"],f"w_{q.replace(' ','-')}_{n}",{"src":"wikimedia","title":p["title"],"license":lic,"artist":re.sub('<[^>]+>','',md.get("Artist",{}).get("value",""))[:80],"q":q}): n+=1
            if n>=7: break
    except Exception as e: print("wm err",q,e)
json.dump(meta,open("media/spa-cand/meta.json","w"),indent=1)
print("total",len(meta))
