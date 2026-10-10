"""WP15: an independent re-computation of the headline numbers, written from scratch in Python.

It shares no code with scripts/research/wp15-overnight-drift.ts. From the raw inputs it rebuilds the session calendar
(complete Yahoo bars of either index, the NSE and BSE bhavcopy dates, the NSE participant-OI file dates and the
Muhurat days), the special sessions (weekends, Muhurat, and WP6's short sessions by NIFTY's option volume), the nights
between consecutive regular sessions, and then:
  - index: every night subset of report section 1.3 for NIFTY and SENSEX, as n, mean per night and hit rate, over all
    nights and the last 40% (the frozen cut dates of report section 2), and E's open -> close on the same nights;
  - options (family B): every variant of report section 1.4 (filter x entry x exit x strike x fill), as trades, mean
    premium and mean gross rupees per lot before charges, over all nights and the last 40%;
  - R6's C1 synthetic long and C1-B long call (15:25 -> 09:30 at the forward's strike), gross per lot, both fills.
With --summary it compares each figure with the main script's summary.json (gross = its net plus its charges per
trade) and prints the largest differences.
Standard library only. Read-only. Run it with python3 -I, because the inputs are downloaded data.

  python3 -I scripts/research/wp15-xcheck.py NSEI_JSON BSESN_JSON X13_DIR BHAVCOPY_DIR OI_DIR [--summary SUMMARY_JSON]
"""
import csv
import gzip
import json
import os
import statistics
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

args = [a for a in sys.argv[1:] if not a.startswith("--")]
NSEI, BSESN, X13, BHAV, OI = args[:5]
SUMMARY = sys.argv[sys.argv.index("--summary") + 1] if "--summary" in sys.argv else None
# The frozen constants of report section 1 and the cut dates of section 2.
MUHURAT = {"2011-10-26", "2012-11-13", "2013-11-03", "2014-10-23", "2015-11-11", "2016-10-30", "2017-10-19", "2018-11-07",
           "2019-10-27", "2020-11-14", "2021-11-04", "2022-10-24", "2023-11-12", "2024-11-01", "2025-10-21"}
INDEX_CUT = {"NIFTY": "2020-07-15", "SENSEX": "2020-07-01"}
OPTION_CUT = {"NIFTY": "2024-05-15", "SENSEX": "2025-04-09"}
BSE_DAILY_FROM = "2023-05-15"
FIRST_NIGHT = "2011-01-01"
SELLOFF = -0.01


def hm(s):
    return int(s[:2]) * 60 + int(s[3:])


def ist_day(ts):
    return (datetime.fromtimestamp(ts, timezone.utc) + timedelta(hours=5, minutes=30)).date().isoformat()


def yahoo(path):
    y = json.load(open(path))["chart"]["result"][0]
    q = y["indicators"]["quote"][0]
    out = {}
    for i, ts in enumerate(y["timestamp"]):
        vals = (q["open"][i], q["high"][i], q["low"][i], q["close"][i])
        out[ist_day(ts)] = vals if all(v is not None and v > 0 for v in vals) else None
    return out


BARS = {"NIFTY": yahoo(NSEI), "SENSEX": yahoo(BSESN)}


def bhav_dates(ex):
    root = os.path.join(BHAV, ex)
    return sorted(f"{f[:4]}-{f[4:6]}-{f[6:8]}" for yr in os.listdir(root) for f in os.listdir(os.path.join(root, yr)) if f.endswith(".csv.gz"))


def bhav_rows(ex, d):
    with gzip.open(os.path.join(BHAV, ex, d[:4], d.replace("-", "") + ".csv.gz"), "rt") as fh:
        return list(csv.DictReader(fh))


NSE_DATES = bhav_dates("nse")
BSE_DATES = bhav_dates("bse")
NSE_SET, BSE_SET = set(NSE_DATES), set(BSE_DATES)
nse_rows_cache, bse_rows_cache = {}, {}


def rows_of(sym, d):
    cache, ex = (nse_rows_cache, "nse") if sym == "NIFTY" else (bse_rows_cache, "bse")
    if d not in cache:
        cache[d] = [r for r in bhav_rows(ex, d) if r["sym"] == sym]
        if len(cache) > 64:
            cache.pop(next(iter(cache)))
    return cache[d]


def days_between(a, b):
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


# WP6's short sessions: NIFTY option contracts (expiries within 45 days) below 0.3 x the quietest of 3 sessions each side.
vol = {}
for d in NSE_DATES:
    vol[d] = sum(float(r["contracts"] or 0) for r in rows_of("NIFTY", d) if r["kind"] == "OPT" and days_between(d, r["expiry"]) <= 45)
SHORT = set()
for i, d in enumerate(NSE_DATES):
    around = [vol[x] for x in NSE_DATES[max(0, i - 3):i] + NSE_DATES[i + 1:i + 4]]
    if around and vol[d] < 0.3 * min(around):
        SHORT.add(d)

oi_dates = set()
for f in os.listdir(OI):
    if f.startswith("fao_participant_oi_") and f.endswith(".csv"):
        s = f[len("fao_participant_oi_"):-4]
        oi_dates.add(f"{s[4:8]}-{s[2:4]}-{s[0:2]}")
cal = set(oi_dates) | NSE_SET | BSE_SET | MUHURAT
for sym in BARS:
    cal |= {d for d, b in BARS[sym].items() if b and d >= "2010-12-01"}
CAL = sorted(cal)


def is_special(d):
    return date.fromisoformat(d).weekday() >= 5 or d in MUHURAT or d in SHORT


REG = [d for d in CAL if not is_special(d)]
REG_IX = {d: i for i, d in enumerate(REG)}


def nights_of(calendar):
    """Consecutive regular sessions (D, E) and whether a special session lies between them."""
    out, prev, spans = [], None, False
    for d in calendar:
        if is_special(d):
            if prev is not None:
                spans = True
            continue
        if prev is not None:
            out.append((prev, d, spans))
        prev, spans = d, False
    return out


def kind(d, e):
    n = days_between(d, e)
    if n == 1:
        return "weekday"
    mids = [date.fromisoformat(d) + timedelta(days=i) for i in range(1, n)]
    return "weekend" if all(x.weekday() >= 5 for x in mids) else "holiday"


def prev_close(sym, d):
    i = REG_IX.get(d)
    if i is None or i == 0:
        return None
    b = BARS[sym].get(REG[i - 1])
    return b[3] if b else None


NIGHTS = nights_of(CAL)

# --- A. index nights ---
SUBSETS = {
    "all": lambda o: True,
    "weekday": lambda o: o["kind"] == "weekday",
    "weekend": lambda o: o["kind"] != "weekday",
    "down": lambda o: o["change"] is not None and o["change"] < 0,
    "up": lambda o: o["change"] is not None and o["change"] > 0,
    "selloff": lambda o: o["change"] is not None and o["change"] <= SELLOFF,
}
xc = {"index": {}, "options": {}}
print("A. index nights (bp per night; hit; E's open -> close):")
for sym in ("NIFTY", "SENSEX"):
    obs, skips = [], Counter()
    for d, e, spans in NIGHTS:
        if d < FIRST_NIGHT:
            continue
        if spans:
            skips["spans"] += 1
            continue
        a, b = BARS[sym].get(d), BARS[sym].get(e)
        if not a or not b:
            skips["no bar"] += 1
            continue
        if abs(b[0] - a[3]) < 1e-9:
            skips["stale"] += 1
            continue
        pc = prev_close(sym, d)
        obs.append({"d": d, "e": e, "kind": kind(d, e), "r": b[0] / a[3] - 1, "p": b[3] / b[0] - 1, "change": a[3] / pc - 1 if pc else None})
    cut = sorted(o["d"] for o in obs)[max(0, -(-6 * len(obs) // 10) - 1)]
    print(f"  {sym}: {len(obs)} nights, skips {dict(skips)}, cut {cut} (frozen {INDEX_CUT[sym]})")
    for name, f in SUBSETS.items():
        al = [o for o in obs if f(o)]
        oo = [o for o in al if o["d"] > INDEX_CUT[sym]]
        m = lambda xs: 1e4 * sum(xs) / len(xs) if xs else float("nan")
        row = {"n": len(al), "mean": m([o["r"] for o in al]), "hit": sum(o["r"] > 0 for o in al) / len(al), "day": m([o["p"] for o in al]),
               "oosN": len(oo), "oosMean": m([o["r"] for o in oo]), "oosHit": sum(o["r"] > 0 for o in oo) / len(oo)}
        xc["index"][(sym, name)] = row
        print(f"    {name:8s} all {row['n']:5d} {row['mean']:+7.2f} bp hit {100 * row['hit']:.1f}% day {row['day']:+7.2f} bp | last 40% {row['oosN']:5d} {row['oosMean']:+7.2f} bp hit {100 * row['oosHit']:.1f}%")

# --- B and C. options on the 1-minute extract ---
manifest = json.load(open(os.path.join(X13, "manifest.json")))
ENTRY_B, EXIT_B, STEPS_B = (hm("15:20"), hm("15:25")), (hm("09:15"), hm("09:16"), hm("09:20")), (0, 1)
C_IN, C_OUT = hm("15:25"), hm("09:30")


def index_bars(sym):
    out = defaultdict(dict)
    with gzip.open(os.path.join(X13, "index", f"{sym}.csv.gz"), "rt") as fh:
        for r in csv.DictReader(fh):
            m = int(r["min"])
            if 555 <= m <= 930:
                out[r["day"]][m] = (float(r["o"]), float(r["c"]))
    return out


def chain(sym, d, expiry):
    p = os.path.join(X13, "opt", sym, f"{d}_{expiry}.csv.gz")
    if not os.path.exists(p):
        return None
    out = defaultdict(dict)
    with gzip.open(p, "rt") as fh:
        for r in csv.DictReader(fh):
            if float(r["v"]) > 0:
                out[(int(r["k"]), r["y"])][int(r["min"])] = (float(r["h"]), float(r["l"]), float(r["c"]))
    return out


def last_upto(bars, m):
    ms = [x for x in bars if x <= m]
    return max(ms) if ms else None


def leg(series_d, series_e, entry, exit_, mode, side):
    """Per-unit (entry, exit) fills of one leg, or None."""
    em = next((m for m in range(entry, entry + 3) if m in series_d), None)
    if em is None or series_e is None:
        return None
    xm = next((m for m in range(exit_, exit_ + 6) if m in series_e), None)
    buy_first = side == "long"
    h, l, c = series_d[em]
    px_in = c if mode == "mid" else (h if buy_first else l)
    if xm is not None:
        h2, l2, c2 = series_e[xm]
        px_out = c2 if mode == "mid" else (l2 if buy_first else h2)
    else:
        prev = last_upto(series_e, exit_)
        if prev is None:
            return None
        px_out = series_e[prev][2]
    return px_in, px_out


def sessions_to_expiry(d, e):
    n = sum(1 for x in NSE_DATES if d < x <= e)
    last = NSE_DATES[-1]
    if e > last:
        x = date.fromisoformat(last) + timedelta(days=1)
        while x.isoformat() <= e:
            n += x.weekday() < 5
            x += timedelta(days=1)
    return n


def modal_lot(rows, expiry):
    cnt = Counter(int(float(r["lot"])) for r in rows if r["kind"] == "OPT" and r["expiry"] == expiry and r["lot"])
    if not cnt:
        return None
    best = max(cnt.values())
    return max(v for v, n in cnt.items() if n == best)


print("B. options (gross ₹ per lot before charges; premium ₹; all nights | last 40%):")
for sym in ("NIFTY", "SENSEX"):
    man = manifest[sym]
    idx = index_bars(sym)
    own = NSE_SET if sym == "NIFTY" else {d for d in BSE_SET if d >= BSE_DAILY_FROM}
    valid = {d for d in man["sessions"] if d in own and not is_special(d) and 555 in idx.get(d, {}) and sum(1 for m in idx[d] if 555 <= m < 930) >= 370}
    first = min(k[:10] for k in man["pairs"])
    last = man["sessions"][-1]
    results = defaultdict(list)  # key -> list of (D, gross, premium)
    skips = Counter()
    for d, e, spans in nights_of([x for x in CAL if first <= x <= last]):
        if spans:
            skips["spans"] += 1
            continue
        if d not in valid or e not in valid:
            skips["not valid"] += 1
            continue
        rows = rows_of(sym, d)
        expiries = sorted({r["expiry"] for r in rows if r["kind"] == "OPT" and r["expiry"] >= d})
        expiry = next((x for x in expiries if sessions_to_expiry(d, x) >= 2), None)
        cd = chain(sym, d, expiry) if expiry else None
        ce = chain(sym, e, expiry) if expiry else None
        if cd is None or ce is None:
            skips["contract missing"] += 1
            continue
        lot = modal_lot(rows, expiry)
        if lot is None:
            skips["no lot"] += 1
            continue
        strikes = sorted({k for (k, y) in cd if y == "C" and (k, "P") in cd})
        pc = prev_close(sym, d)
        k_ = kind(d, e)
        for entry in sorted(set(ENTRY_B) | {C_IN}):
            lm = last_upto(idx[d], entry - 1)
            if lm is None or not strikes:
                continue
            level = idx[d][lm][1]
            atm = min(strikes, key=lambda z: (abs(z - level), z))
            change = level / pc - 1 if pc else None
            if entry in ENTRY_B:
                for steps in STEPS_B:
                    i = strikes.index(atm)
                    kc = strikes[i - steps] if 0 <= i - steps < len(strikes) else None
                    kp = strikes[i + steps] if 0 <= i + steps < len(strikes) else None
                    for exit_ in EXIT_B:
                        for mode in ("conservative", "mid"):
                            c_ = leg(cd[(kc, "C")], ce.get((kc, "C")), entry, exit_, mode, "long") if kc is not None and (kc, "C") in cd else None
                            p_ = leg(cd[(kp, "P")], ce.get((kp, "P")), entry, exit_, mode, "long") if kp is not None and (kp, "P") in cd else None
                            if not c_ or not p_:
                                continue
                            for f in ("all", "weekday", "down", "selloff"):
                                if f in ("down", "selloff") and change is None:
                                    continue
                                ok = f == "all" or (f == "weekday" and k_ == "weekday") or (f == "down" and change < 0) or (f == "selloff" and change <= SELLOFF)
                                if ok:
                                    results[("B", f, entry, exit_, steps, mode)].append((d, (c_[1] - c_[0]) * lot, c_[0] * lot))
            if entry == C_IN:
                near = sorted(strikes, key=lambda z: (abs(z - level), z))[:3]
                est = []
                for k in near:
                    cm, pm = last_upto(cd[(k, "C")], entry - 1), last_upto(cd[(k, "P")], entry - 1)
                    if cm is not None and pm is not None and cm >= entry - 5 and pm >= entry - 5:
                        est.append(k + cd[(k, "C")][cm][2] - cd[(k, "P")][pm][2])
                if not est:
                    continue
                kf = min(strikes, key=lambda z: (abs(z - statistics.median(est)), z))
                for mode in ("conservative", "mid"):
                    cl = leg(cd[(kf, "C")], ce.get((kf, "C")), C_IN, C_OUT, mode, "long")
                    ps = leg(cd[(kf, "P")], ce.get((kf, "P")), C_IN, C_OUT, mode, "short")
                    if not cl or not ps:
                        continue
                    results[("C1B", mode)].append((d, (cl[1] - cl[0]) * lot, cl[0] * lot))
                    results[("C1", mode)].append((d, (cl[1] - cl[0] + ps[0] - ps[1]) * lot, cl[0] * lot))
    print(f"  {sym}: skips {dict(skips)}")
    for key_, xs in sorted(results.items(), key=lambda z: str(z[0])):
        oo = [x for x in xs if x[0] > OPTION_CUT[sym]]
        row = {"n": len(xs), "gross": sum(x[1] for x in xs) / len(xs), "premium": sum(x[2] for x in xs) / len(xs), "oosN": len(oo), "oosGross": sum(x[1] for x in oo) / len(oo) if oo else float("nan")}
        xc["options"][(sym,) + key_] = row
    base = xc["options"].get((sym, "B", "all", hm("15:20"), hm("09:15"), 0, "conservative"))
    if base:
        cut = sorted(x[0] for x in results[("B", "all", hm("15:20"), hm("09:15"), 0, "conservative")])
        print(f"    base B (all, ATM 15:20 -> 09:15, conservative): {base['n']} trades, cut {cut[max(0, -(-6 * len(cut) // 10) - 1)]} (frozen {OPTION_CUT[sym]})")
    for k_, v in sorted(xc["options"].items(), key=lambda z: str(z[0])):
        if k_[0] == sym and (k_[1] in ("C1", "C1B") or (k_[2] == "all" and k_[5] == 0)):
            print(f"    {' '.join(str(z) for z in k_[1:])}: {v['n']} trades, gross {v['gross']:+.0f}, premium {v['premium']:.0f} | last 40% {v['oosN']} {v['oosGross']:+.0f}")

if SUMMARY:
    s = json.load(open(SUMMARY))
    worst = {"index mean (bp)": 0.0, "index n": 0, "option gross (₹)": 0.0, "option n": 0, "option premium (₹)": 0.0}
    names = {"all": "all nights", "weekday": "weekday nights", "weekend": "weekend and holiday nights", "down": "after a down day", "up": "after an up day", "selloff": "after a sell-off"}
    compared = Counter()
    for r in s["index"]:
        k = (r["sym"], r["subset"])
        if k not in xc["index"]:
            continue
        x = xc["index"][k]
        compared["index"] += 1
        worst["index n"] = max(worst["index n"], abs(x["n"] - r["full"]["n"]), abs(x["oosN"] - r["oos"]["n"]))
        worst["index mean (bp)"] = max(worst["index mean (bp)"], abs(x["mean"] - 1e4 * r["full"]["mean"]), abs(x["oosMean"] - 1e4 * r["oos"]["mean"]))
    for r in s["options"]:
        if r["family"] == "B":
            k = (r["sym"], "B", r["filter"], hm(r["entry"]), hm(r["exit"]), r["steps"], r["mode"])
        elif r["family"] in ("C1", "C1B") and r["entry"] == "15:25" and r["exit"] == "09:30" and r["steps"] == 0:
            k = (r["sym"], r["family"], r["mode"])
        else:
            continue
        if k not in xc["options"]:
            continue
        x = xc["options"][k]
        compared["options"] += 1
        gross = r["full"]["mean"] + r["charges"]
        worst["option n"] = max(worst["option n"], abs(x["n"] - r["full"]["n"]))
        worst["option gross (₹)"] = max(worst["option gross (₹)"], abs(x["gross"] - gross))
        worst["option premium (₹)"] = max(worst["option premium (₹)"], abs(x["premium"] - r["premium"]))
    print(f"Compared with {SUMMARY}: {dict(compared)}; largest differences {worst}")
