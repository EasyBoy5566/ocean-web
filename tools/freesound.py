"""List CC0 sounds on Freesound for a set of queries (title, duration, downloads, preview URL).

Usage: python tools/freesound.py "query one" "query two" ...
Only sounds under Creative Commons 0 are returned (license filter on the search).
"""
import html
import re
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (waterscape asset survey)"}
ATTR = re.compile(r'data-(sound-id|username|mp3|title|duration|num-downloads)="([^"]*)"')


def search(q: str, sort: str = "Num downloads desc"):
    url = "https://freesound.org/search/?" + urllib.parse.urlencode(
        {"q": q, "f": 'license:"Creative Commons 0"', "s": sort}
    )
    page = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf-8")
    out = []
    for block in page.split('class="bw-player"')[1:]:
        d = dict(ATTR.findall(block[:2500]))
        if "sound-id" in d:
            out.append(d)
    return out


for q in sys.argv[1:]:
    print(f"## {q}")
    for d in search(q)[:12]:
        print(
            f"  {d['sound-id']:>7}  {float(d['duration']):6.1f}s  dl={d.get('num-downloads','?'):>6}  "
            f"{html.unescape(d['title'])[:60]:60}  by {d['username']}  {d['mp3'].replace('-lq.', '-hq.')}"
        )
