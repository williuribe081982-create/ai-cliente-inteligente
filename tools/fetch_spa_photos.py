import requests,json,os,re
os.makedirs("media/spa-cand",exist_ok=True)
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}
meta=[]
def save(url,name,info):
    try:
        b=requests.get(url,headers=H,timeout=60)
        if b.status_code==200 and len(b.content)>8000:
            fn=f"media/spa-cand/{name}.jpg"; open(fn,"wb").write(b.content); info["file"]=fn; meta.append(info); return True
    except Exception as e: print("dl err",e)
    return False
# Burst (Shopify free stock)
for q in ["spa","facial","skincare","face-mask","massage","beauty-products","manicure","candles","serum","bath"]:
    try:
        r=requests.get(f"https://burst.shopify.com/photos/search?q={q}",headers=H,timeout=30); print("burst",q,r.status_code)
        urls=[]
        for m in re.finditer(r'https://burst\.shopifycdn\.com/photos/([a-z0-9\-]+)\.jpg',r.text):
            if m.group(1) not in urls: urls.append(m.group(1))
        n=0
        for slug in urls[:8]:
            if save(f"https://burst.shopifycdn.com/photos/{slug}.jpg?width=720&format=pjpg&exif=0&iptc=0",f"b_{q}_{n}",{"src":"burst","slug":slug,"q":q}): n+=1
    except Exception as e: print("burst err",q,e)
# Openverse
for q in ["facial treatment","spa massage","skincare products","face mask","spa interior","manicure"]:
    try:
        r=requests.get("https://api.openverse.org/v1/images/",params={"q":q,"license_type":"commercial","page_size":8,"aspect_ratio":"wide"},headers=H,timeout=40); print("ov",q,r.status_code)
        if r.status_code!=200: continue
        for n,x in enumerate(r.json()["results"][:6]):
            save(x["url"],f"o_{q.replace(' ','-')}_{n}",{"src":"openverse","title":x.get("title"),"license":x.get("license"),"creator":x.get("creator"),"q":q,"url":x.get("foreign_landing_url")})
    except Exception as e: print("ov err",q,e)
json.dump(meta,open("media/spa-cand/meta.json","w"),indent=1)
print("total",len(meta))
