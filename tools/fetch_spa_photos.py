import requests,json,os,re
os.makedirs("media/spa-cand",exist_ok=True)
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36","Accept":"application/json"}
meta=[]
Q=["facial treatment spa","esthetician facial","face mask spa","facial massage","spa reception","spa interior","skincare products","serum dropper","spa towels candles","skincare routine woman","glowing skin","massage spa","manicure spa","steam room spa","laser hair removal","healthy lunch bowl"]
ok=False
for q in Q:
    try:
        r=requests.get("https://unsplash.com/napi/search/photos",params={"query":q,"per_page":10,"orientation":"landscape"},headers=H,timeout=30)
        print(q,r.status_code)
        if r.status_code!=200: continue
        ok=True; n=0
        for p in r.json()["results"]:
            if p.get("premium") or p.get("plus"): continue
            url=p["urls"]["raw"]+"&w=720&q=72&fm=jpg&fit=crop&ar=16:10"
            fn=f"media/spa-cand/{re.sub('[^a-z]+','-',q)}_{n}.jpg"
            b=requests.get(url,timeout=60).content; open(fn,"wb").write(b)
            meta.append({"file":fn,"id":p["id"],"alt":p.get("alt_description"),"by":p["user"]["name"],"q":q}); n+=1
            if n>=6: break
    except Exception as e: print("err",q,e)
json.dump(meta,open("media/spa-cand/meta.json","w"),indent=1)
print("unsplash ok",ok,len(meta))
