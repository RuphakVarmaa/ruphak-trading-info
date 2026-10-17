"""WP14 step 0: download NSE's published participant-wise open-interest files (reports/wp14-positioning.md).

Source: NSE's daily end-of-day F&O report "Participant wise Open Interest (no. of contracts) in
Equity Derivatives", published as a file on the evening of each trading day at
https://archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv. Only these published
archive files are read: no nseindia.com, bseindia.com or broker website API is called. Raw data is
never committed (the repository is public).

    python3 -I scripts/research/wp14_fetch.py --out <new empty dir> --log <log.jsonl> \
        --from 2011-12-26 --to 2026-10-09 [--extra 2012-01-07,...] [--sleep 1.2]

Requests every weekday in [from, to] plus the --extra dates (weekend sessions), one at a time with
at least --sleep seconds between requests and an honest User-Agent. HEAD is not used (the archive
answers HEAD with 503). Files already in --out are kept (the run resumes). A 404 is a day without a
file (a holiday, or a file NSE never published) and is logged. On 403 or 429 the run stops at once
and says so: a block is never worked around. Other failures are retried twice with a back-off; five
failed dates in a row stop the run. Every request is logged with its status, size and the file's
Last-Modified header (the publication time).
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request

URL = "https://archives.nseindia.com/content/nsccl/fao_participant_oi_{ddmmyyyy}.csv"
UA = "research-download/1.0 (read-only)"


def dates(start, end, extra):
    d = start
    out = set(extra)
    while d <= end:
        if d.weekday() < 5:
            out.add(d)
        d += dt.timedelta(days=1)
    return sorted(x for x in out if start <= x <= end)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/csv,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read(), r.headers.get("Last-Modified"), r.headers.get("Content-Type")
    except urllib.error.HTTPError as e:
        return e.code, b"", e.headers.get("Last-Modified") if e.headers else None, e.headers.get("Content-Type") if e.headers else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--from", dest="start", required=True)
    ap.add_argument("--to", dest="end", required=True)
    ap.add_argument("--extra", default="")
    ap.add_argument("--sleep", type=float, default=1.2)
    a = ap.parse_args()
    if a.sleep < 1.0:
        sys.exit("--sleep must be at least 1 s")
    os.makedirs(a.out, exist_ok=True)
    extra = [dt.date.fromisoformat(s) for s in a.extra.split(",") if s.strip()]
    todo = dates(dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end), extra)
    counts = {"ok": 0, "cached": 0, "404": 0, "failed": 0}
    fails_in_row = 0
    t0 = time.time()
    with open(a.log, "a") as log:
        for i, d in enumerate(todo):
            name = f"fao_participant_oi_{d.strftime('%d%m%Y')}.csv"
            dest = os.path.join(a.out, name)
            if os.path.exists(dest) and os.path.getsize(dest) > 0:
                counts["cached"] += 1
                continue
            url = URL.format(ddmmyyyy=d.strftime("%d%m%Y"))
            status, body, last_mod, ctype = None, b"", None, None
            for attempt in range(3):
                try:
                    status, body, last_mod, ctype = get(url)
                except Exception as ex:  # network error: retried
                    status, body, last_mod, ctype = f"error: {ex}", b"", None, None
                if status in (200, 404, 403, 429):
                    break
                time.sleep([10, 30, 0][attempt])
            rec = {"date": d.isoformat(), "status": status, "bytes": len(body), "lastModified": last_mod, "contentType": ctype, "at": dt.datetime.now(dt.timezone.utc).isoformat()}
            if status in (403, 429):
                rec["note"] = "blocked: run stopped"
                log.write(json.dumps(rec) + "\n")
                log.flush()
                print(f"STOP: HTTP {status} on {d} - the archive refused the request; not retrying, not working around it", flush=True)
                sys.exit(2)
            head = body[:400].lower()
            # A file normally opens with its title row; a few (17 Jul 2014, 13 Jun 2018) start at the header row.
            if status == 200 and (b"participant wise open interest" in head or b"future index long" in head):
                tmp = dest + ".part"
                with open(tmp, "wb") as f:
                    f.write(body)
                os.replace(tmp, dest)
                counts["ok"] += 1
                fails_in_row = 0
            elif status == 404:
                counts["404"] += 1
                fails_in_row = 0
            else:
                rec["note"] = "unexpected response" if status == 200 else "failed after retries"
                counts["failed"] += 1
                fails_in_row += 1
            log.write(json.dumps(rec) + "\n")
            log.flush()
            if fails_in_row >= 5:
                print(f"STOP: five failed dates in a row (last {d}, status {status})", flush=True)
                sys.exit(3)
            if (i + 1) % 100 == 0:
                print(f"{i + 1}/{len(todo)} {d} {counts} {time.time() - t0:.0f} s", flush=True)
            time.sleep(a.sleep)
    print(f"done: {len(todo)} dates {counts} in {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
