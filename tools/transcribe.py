from faster_whisper import WhisperModel
import sys
m=WhisperModel("small",device="cpu",compute_type="int8")
segs,_=m.transcribe(sys.argv[1],language="es",vad_filter=True)
with open(sys.argv[2],"w") as f:
    for s in segs: f.write(f"[{s.start:.1f}-{s.end:.1f}] {s.text.strip()}\n")
