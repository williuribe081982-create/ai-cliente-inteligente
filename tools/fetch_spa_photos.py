import requests,json,os,time,urllib.parse,sys
shard,n=int(sys.argv[1]),int(sys.argv[2])
os.makedirs("out",exist_ok=True)
P=list(json.load(open("tools/spa_prompts.json")).items())
STY=", professional photography, luxury day spa in Miami, soft natural light, lavender and white color palette, clean minimal elegant aesthetic, shallow depth of field, photorealistic, no text, no logo, no watermark"
for i,(k,v) in enumerate(P):
    if i%n!=shard: continue
    url="https://image.pollinations.ai/prompt/"+urllib.parse.quote(v+STY)+f"?width=1024&height=640&seed={100+i}&nologo=true"
    for att in range(6):
        r=requests.get(url,timeout=120)
        if r.status_code==200 and len(r.content)>15000:
            open(f"out/{k}.jpg","wb").write(r.content); print("ok",k); break
        print("retry",k,r.status_code); time.sleep(12)
    time.sleep(46)
