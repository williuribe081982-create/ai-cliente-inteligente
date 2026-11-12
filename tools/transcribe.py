from faster_whisper import WhisperModel
import sys,subprocess,numpy as np
raw=subprocess.run(['ffmpeg','-loglevel','error','-i',sys.argv[1],'-f','s16le','-ac','1','-ar','16000','-'],capture_output=True,check=True).stdout
audio=np.frombuffer(raw,np.int16).astype(np.float32)/32768.0
m=WhisperModel("small",device="cpu",compute_type="int8")
segs,_=m.transcribe(audio,language="es",vad_filter=True)
with open(sys.argv[2],"w") as f:
    for s in segs: f.write(f"[{s.start:.1f}-{s.end:.1f}] {s.text.strip()}\n")
