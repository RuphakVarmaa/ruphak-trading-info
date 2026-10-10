"""WP13 step 0a: download the TradeMarkk 1-minute NIFTY/SENSEX files at a pinned revision (reports/wp13-expiry-calendar-events.md).

Source: Hugging Face dataset "India Index & Options - 1-minute OHLC" by TradeMarkk,
repo thetrademarkk/india-index-options-1m, revision 0f4800e43e6f96cec0794369d78eb4d3c4211ef5,
licence CC-BY-NC-4.0 (non-commercial research use only). Raw data is never committed.

    python3 -I scripts/research/wp13_fetch.py --meta <dir for the file lists> --out <new empty download dir>

Lists index/ and options/{NIFTY,SENSEX}/ through the Hugging Face tree API (cached in --meta as
tree_<folder>.json, the same files WP11 used), then downloads index/NIFTY.parquet,
index/SENSEX.parquet and every option file of the two indices, each checked against the sha256 of
its LFS pointer. Files already present with the right hash are kept. The extractor
(wp13_extract.py) reads the result; delete the download afterwards.
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import time
import urllib.request

REPO = "thetrademarkk/india-index-options-1m"
REV = "0f4800e43e6f96cec0794369d78eb4d3c4211ef5"


def list_folder(meta, folder):
    fn = os.path.join(meta, f"tree_{folder.replace('/', '_')}.json")
    if os.path.exists(fn):
        return json.load(open(fn))
    entries = []
    cursor = f"https://huggingface.co/api/datasets/{REPO}/tree/{REV}/{folder}"
    while cursor:
        with urllib.request.urlopen(cursor, timeout=60) as r:
            entries.extend(json.load(r))
            link = r.headers.get("Link")
        cursor = link.split(";")[0].strip("<> ") if link and 'rel="next"' in link else None
    os.makedirs(meta, exist_ok=True)
    with open(fn, "w") as f:
        json.dump(entries, f)
    return entries


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(out_root, e):
    path = e["path"]
    dest = os.path.join(out_root, path)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    want = e.get("lfs", {}).get("oid")
    if os.path.exists(dest) and want and sha256_of(dest) == want:
        return path, "cached"
    url = f"https://huggingface.co/datasets/{REPO}/resolve/{REV}/{path}"
    err = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                data = r.read()
            got = hashlib.sha256(data).hexdigest()
            if want and got != want:
                raise ValueError(f"sha256 mismatch {got} != {want}")
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, dest)
            return path, "ok"
        except Exception as ex:  # network hiccup: retry with backoff
            err = ex
            time.sleep(2 + 3 * attempt)
    return path, f"FAILED {err}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--symbols", default="NIFTY,SENSEX")
    a = ap.parse_args()
    syms = a.symbols.split(",")
    entries = [e for e in list_folder(a.meta, "index") if e["type"] == "file" and e["path"] in {f"index/{s}.parquet" for s in syms}]
    for s in syms:
        entries += [e for e in list_folder(a.meta, f"options/{s}") if e["type"] == "file" and e["path"].endswith(".parquet")]
    t0 = time.time()
    ok = 0
    failed = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for path, status in ex.map(lambda e: fetch(a.out, e), entries):
            if status.startswith("FAILED"):
                failed.append((path, status))
            else:
                ok += 1
    for path, status in failed:
        print(path, status, flush=True)
    size = sum(e.get("lfs", {}).get("size", e.get("size", 0)) for e in entries)
    print(f"{ok}/{len(entries)} files ({size / 1e9:.2f} GB) at {REV[:8]} in {time.time() - t0:.0f} s; {len(failed)} failed", flush=True)


if __name__ == "__main__":
    main()
