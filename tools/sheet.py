# Combine screenshots side by side: python tools/sheet.py out.png a.png b.png ...
import sys
from PIL import Image
out, *paths = sys.argv[1:]
imgs = [Image.open(p).convert('RGB') for p in paths]
h = min(i.height for i in imgs)
imgs = [i.resize((round(i.width * h / i.height), h)) for i in imgs]
sheet = Image.new('RGB', (sum(i.width for i in imgs) + 8 * (len(imgs) - 1), h), (255, 255, 255))
x = 0
for i in imgs:
    sheet.paste(i, (x, 0))
    x += i.width + 8
sheet.save(out)
