"""Print per-second loudness of audio files to pick clean, steady loop windows.
Usage: python tools/audio_scan.py file.mp3 [window_seconds]"""
import array, math, subprocess, sys

path = sys.argv[1]
win = int(sys.argv[2]) if len(sys.argv) > 2 else 60
pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                     capture_output=True, check=True).stdout
a = array.array("h", pcm)
rate = 8000
secs = len(a) // rate
db = []
for s in range(secs):
    seg = a[s * rate:(s + 1) * rate]
    rms = math.sqrt(sum(x * x for x in seg) / len(seg)) / 32768
    peak = max(abs(x) for x in seg) / 32768
    db.append((20 * math.log10(max(rms, 1e-6)), 20 * math.log10(max(peak, 1e-6))))
# best window: lowest spread of loudness and no crest spikes
best = None
for start in range(0, max(1, secs - win)):
    w = db[start:start + win]
    if len(w) < win:
        break
    mean = sum(r for r, _ in w) / win
    spread = math.sqrt(sum((r - mean) ** 2 for r, _ in w) / win)
    crest = max(p - r for r, p in w)
    score = spread + max(0, crest - 18) * 0.5
    if best is None or score < best[0]:
        best = (score, start, mean, spread, crest)
print(f"{path}: {secs}s, mean {sum(r for r,_ in db)/len(db):.1f} dBFS")
if best:
    print(f"  best {win}s window starts at {best[1]}s: mean {best[2]:.1f} dB, spread {best[3]:.1f} dB, max crest {best[4]:.1f} dB")
