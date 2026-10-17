"""WP14: an independent re-computation of the headline numbers, written from scratch in Python.

It shares no code with scripts/research/wp14-positioning.ts. From the raw inputs it rebuilds the signals, the
trailing-250 ranks and terciles, the entry mapping (E trades on the file of the session before it, skipping
special sessions without a file) and then:
  - index: each signal's "follow" pick at D1, W1 and M1, as n, mean per trade and hit rate, over all signal days and the
    last 40% (the frozen cut dates of report section 2.3);
  - D1 options: each signal's "follow" trades at both fills (ATM at the 09:29 index close, the nearest expiry with at
    least 2 sessions to go, the bhavcopy's modal lot, entry in [09:30, 09:32], exit in [15:20, 15:25]). It reports
    gross ₹ per lot before charges, to be compared with the main script's net plus its charges per trade.
Standard library only. Read-only. Run it with python3 -I, because the inputs are downloaded data.

  python3 -I scripts/research/wp14-xcheck.py OI_DIR YAHOO_DAILY_JSON X13_DIR BHAVCOPY_DIR
"""
import csv
import gzip
import io
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

OI_DIR, YAHOO, X13, BHAV = sys.argv[1:5]
# The frozen exclusions, special sessions and cut dates (report sections 1.1, 2.1, 2.3 and 2.4).
EXCLUDED = {"2012-01-02", "2013-08-22", "2014-02-24"}
MUHURAT = {"2012-11-13", "2013-11-03", "2014-10-23", "2015-11-11", "2016-10-30", "2017-10-19", "2018-11-07",
           "2019-10-27", "2020-11-14", "2021-11-04", "2022-10-24", "2023-11-12", "2024-11-01", "2025-10-21"}
SIGNALS = ("S1", "S2", "S3", "S4")
INDEX_CUT = {"S1": "2021-06-17", "S2": "2020-11-20", "S3": "2021-05-31", "S4": "2021-08-02"}
OPTION_CUT = {"S1": "2024-06-06", "S2": "2024-04-26", "S3": "2024-04-29", "S4": "2024-07-19"}
HOLD = {"D1": 1, "W1": 5, "M1": 20}


def norm(s):
    return re.sub(r"[\s\"']", "", s).lower()


def count(s):
    s = s.strip().strip('"').replace(",", "")
    return 0.0 if s.upper() == "NA" else float(s)


def special(d):
    return date.fromisoformat(d).weekday() >= 5 or d in MUHURAT


# --- participant files, read by label ---
files = {}
for name in sorted(os.listdir(OI_DIR)):
    m = re.fullmatch(r"fao_participant_oi_(\d{2})(\d{2})(\d{4})\.csv", name)
    if not m:
        continue
    day = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    if day in EXCLUDED:
        continue
    with open(os.path.join(OI_DIR, name), encoding="utf-8", errors="replace") as fh:
        text = fh.read().replace("\r\n", "\n").replace("\r", "\n")
    rows = list(csv.reader(io.StringIO(text)))
    h = next(i for i, r in enumerate(rows) if any(norm(c) == "futureindexlong" for c in r))
    cols = {norm(c): j for j, c in enumerate(rows[h]) if norm(c) and j > 0}
    got = {}
    for r in rows[h + 1:]:
        if r and r[0].strip():
            lab = norm(r[0])
            got["fii" if lab in ("fii", "fpi") else lab] = {k: count(r[j]) for k, j in cols.items() if j < len(r) and r[j].strip()}
    files[day] = got
days = sorted(files)


def share(row):
    return row["futureindexlong"] / (row["futureindexlong"] + row["futureindexshort"])


def net_direction(f):
    cl, cs, pl, ps = f["optionindexcalllong"], f["optionindexcallshort"], f["optionindexputlong"], f["optionindexputshort"]
    return ((cl - cs) - (pl - ps)) / (cl + cs + pl + ps)


# --- Yahoo daily bars (IST dates) and the session calendar ---
with open(YAHOO) as fh:
    y = json.load(fh)["chart"]["result"][0]
q = y["indicators"]["quote"][0]
bars = {}
for i, ts in enumerate(y["timestamp"]):
    d = (datetime.fromtimestamp(ts, timezone.utc) + timedelta(hours=5, minutes=30)).date().isoformat()
    if None not in (q["open"][i], q["high"][i], q["low"][i], q["close"][i]) and d >= "2011-12-01":
        bars[d] = (q["open"][i], q["close"][i])
cal = sorted(set(days) | set(bars) | EXCLUDED)
calix = {d: i for i, d in enumerate(cal)}
reg = [d for d in cal if not special(d)]
regix = {d: i for i, d in enumerate(reg)}
file_sessions = [d for d in cal if not special(d) or d in files]
fsix = {d: i for i, d in enumerate(file_sessions)}

# --- signals, ranks and terciles (aligned with `days`) ---
L = [share(files[d]["fii"]) for d in days]
series = {
    "S1": L,
    "S2": [None] + [L[i] - L[i - 1] if fsix[days[i]] - fsix[days[i - 1]] == 1 else None for i in range(1, len(days))],
    "S3": [L[i] - share(files[d]["client"]) for i, d in enumerate(days)],
    "S4": [net_direction(files[d]["fii"]) for d in days],
}


def trailing_rank(v, window=250):
    out, hist = [None] * len(v), []
    for i, x in enumerate(v):
        if x is None:
            continue
        hist.append(x)
        if len(hist) >= window:
            win = hist[-window:]
            out[i] = (sum(z < x for z in win) + 0.5 * sum(z == x for z in win)) / window
    return out


bucket = {s: {} for s in SIGNALS}
for s in SIGNALS:
    for d, r in zip(days, trailing_rank(series[s])):
        bucket[s][d] = None if r is None else (-1 if r < 1 / 3 else (1 if r > 2 / 3 else 0))


def file_before(E):
    """The session before E, skipping special sessions without a file; None when that session has no usable file."""
    for i in range(calix[E] - 1, -1, -1):
        d = cal[i]
        if special(d) and d not in files:
            continue
        return d if d in files else None
    return None


entries = {E: file_before(E) for E in reg}

# --- index: the follow picks ---
print("index, follow (mean per trade; last 40% after the frozen cut):")
for s in SIGNALS:
    for hname, n in HOLD.items():
        alls, oos = [], []
        for E, T in entries.items():
            b = bucket[s].get(T) if T else None
            if not b or regix[E] + n - 1 >= len(reg):
                continue
            X = reg[regix[E] + n - 1]
            if E in bars and X in bars:
                x = b * (bars[X][1] / bars[E][0] - 1)
                alls.append(x)
                if E > INDEX_CUT[s]:
                    oos.append(x)
        print(f"  {s} {hname}: all {len(alls)} {1e4 * sum(alls) / len(alls):+.1f} bp; last 40% {len(oos)} "
              f"{1e4 * sum(oos) / len(oos):+.1f} bp, hit {100 * sum(x > 0 for x in oos) / len(oos):.1f}%")

# --- D1 options: the follow trades, gross ₹ per lot ---
sessions = sorted(f"{f[:4]}-{f[4:6]}-{f[6:8]}" for yr in os.listdir(os.path.join(BHAV, "nse"))
                  for f in os.listdir(os.path.join(BHAV, "nse", yr)) if f.endswith(".csv.gz"))
six = {d: i for i, d in enumerate(sessions)}
minute_index = defaultdict(dict)
with gzip.open(os.path.join(X13, "index", "NIFTY.csv.gz"), "rt") as fh:
    for r in csv.DictReader(fh):
        minute_index[r["day"]][int(r["min"])] = float(r["c"])


def valid_session(d):
    b = minute_index.get(d)
    return bool(b) and d in six and d not in MUHURAT and 555 in b and sum(m >= 555 for m in b) >= 370


def nifty_lots(d):
    out = defaultdict(Counter)
    with gzip.open(os.path.join(BHAV, "nse", d[:4], d.replace("-", "") + ".csv.gz"), "rt") as fh:
        for r in csv.DictReader(fh):
            if r["sym"] == "NIFTY" and r["kind"] == "OPT":
                out[r["expiry"]][r["lot"]] += 1
    return out


def chain(d, expiry):
    p = os.path.join(X13, "opt", "NIFTY", f"{d}_{expiry}.csv.gz")
    if not os.path.exists(p):
        return None
    out = defaultdict(dict)
    with gzip.open(p, "rt") as fh:
        for r in csv.DictReader(fh):
            out[(int(r["k"]), r["y"])][int(r["min"])] = (float(r["h"]), float(r["l"]), float(r["c"]))
    return out


def fill(leg, mode):
    entry = next((m for m in (570, 571, 572) if m in leg), None)
    exit_ = next((m for m in range(920, 926) if m in leg), None)
    if entry is None:
        return None
    stale = exit_ is None
    if stale:
        before = [m for m in leg if entry < m < 920]
        if not before:
            return None
        exit_ = max(before)
    buy = leg[entry][0] if mode == "conservative" else leg[entry][2]
    sell = leg[exit_][1] if mode == "conservative" and not stale else leg[exit_][2]
    return buy, sell


pairs, skips = {}, Counter()
for E, T in entries.items():
    if not ("2021-05-24" <= E <= "2026-07-02") or T is None or all(bucket[s].get(T) is None for s in SIGNALS):
        continue
    if not valid_session(E):
        skips["not a valid 1-minute session"] += 1
        continue
    lots = nifty_lots(E)
    expiry = next((e for e in sorted(lots) if e >= E and sum(E < s <= e for s in sessions) >= 2), None)
    ch = chain(E, expiry) if expiry else None
    if ch is None:
        skips["contract missing from the dataset"] += 1
        continue
    level = minute_index[E][max(m for m in minute_index[E] if m <= 569)]
    k = min((k for (k, t) in ch if t == "C" and (k, "P") in ch), key=lambda z: (abs(z - level), z))
    lot = int(lots[expiry].most_common(1)[0][0])
    got = {}
    for mode in ("conservative", "mid"):
        c, p = fill(ch[(k, "C")], mode), fill(ch[(k, "P")], mode)
        if c and p:
            got[mode] = {"C": ((c[1] - c[0]) * lot, c[0] * lot), "P": ((p[1] - p[0]) * lot, p[0] * lot)}
    if len(got) < 2:
        skips["a leg has no bar in the entry window"] += 1
        continue
    pairs[E] = (T, got)

print(f"D1 options, follow (gross ₹ per lot before charges); skips {dict(skips)}:")
for s in SIGNALS:
    for mode in ("conservative", "mid"):
        alls, oos, prem = [], [], []
        for E, (T, got) in sorted(pairs.items()):
            b = bucket[s].get(T)
            if not b:
                continue
            g, pr = got[mode]["C" if b == 1 else "P"]
            alls.append(g)
            prem.append(pr)
            if E > OPTION_CUT[s]:
                oos.append(g)
        print(f"  {s} {mode}: all {len(alls)} {sum(alls) / len(alls):+.0f}; last 40% {len(oos)} {sum(oos) / len(oos):+.0f}; "
              f"premium {sum(prem) / len(prem):.0f}")
