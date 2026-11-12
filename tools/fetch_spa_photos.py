import requests,json,os,time,urllib.parse
os.makedirs("media/spa",exist_ok=True)
P=json.load(open("tools/spa_prompts.json"))
STY=", professional photography, luxury day spa in Miami, soft natural light, lavender and white color palette, clean minimal elegant aesthetic, shallow depth of field, photorealistic, no text, no logo, no watermark"
for i,(k,v) in enumerate(P.items()):
    fn=f"media/spa/{k}.jpg"
    if os.path.exists(fn): continue
    url="https://image.pollinations.ai/prompt/"+urllib.parse.quote(v+STY)+f"?width=1024&height=640&seed={100+i}&nologo=true&model=flux"
    for att in range(4):
        try:
            r=requests.get(url,timeout=180)
            if r.status_code==200 and r.headers.get("content-type","").startswith("image") and len(r.content)>15000:
                open(fn,"wb").write(r.content); print("ok",k,len(r.content)); break
            print("bad",k,r.status_code,r.headers.get("content-type"),len(r.content))
        except Exception as e: print("err",k,e)
        time.sleep(15)
    time.sleep(4)
print("done",len(os.listdir("media/spa")))
