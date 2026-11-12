import asyncio,json,os,edge_tts
SEG=json.load(open('tools/tts_segments.json'))
async def main():
    os.makedirs('media/vo/tts',exist_ok=True)
    for voice,tag in SEG['voices']:
        for i,txt in enumerate(SEG['segments']):
            c=edge_tts.Communicate(txt,voice,rate=SEG.get('rate','+0%'))
            await c.save(f'media/vo/tts/{tag}_{i}.mp3')
asyncio.run(main())
