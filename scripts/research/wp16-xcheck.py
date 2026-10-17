"""WP16: an independent re-computation of the headline numbers, written from scratch in Python.

It shares no code with scripts/research/wp16-put-spreads.ts. From the raw inputs it rebuilds the session calendar
(complete Yahoo bars of either index from 2007, the NSE and BSE bhavcopy dates, the NSE participant-OI file dates and
the Muhurat days), the special sessions (weekends, Muhurat, and WP6's short sessions by NIFTY's option volume), the
weekly expiries, the settlement levels, the eligible expiries and the cuts, and then:
  - H1 family D: every bull put spread and its mirror bear call spread (m x N x management x fill) from the
    bhavcopy closing prices, with the conservative fill (each order pays the engine's full spread) and the mid fill,
    the dated charges and the exercise STT: trades, mean credit and mean net, over all expiries and the last 40%;
  - H1 family M: the same at 15:20 on the 1-minute extract (both legs of a spread in one minute) for the cells the
    main script runs;
  - H2: the turn-of-the-month windows [-1, +3] (count, mean, last 40%) and the mean daily return on window days and
    on the other days.
With --counts-only it stops before any option price, settlement outcome or index return is used and prints the
calendar, the expiries, the samples, the cuts and the per-cell entry counts. With --summary it compares each figure
with the main script's summary.json and prints the largest differences.
Standard library only. Read-only. Run it with python3 -I, because the inputs are downloaded data.

  python3 -I scripts/research/wp16-xcheck.py NSEI_JSON BSESN_JSON VIX_JSON X13_DIR BHAVCOPY_DIR OI_DIR [--counts-only] [--summary SUMMARY_JSON]
"""
import csv
import gzip
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

args = [a for a in sys.argv[1:] if not a.startswith("--")]
NSEI, BSESN, VIXF, X13, BHAV, OI = args[:6]
COUNTS_ONLY = "--counts-only" in sys.argv
SUMMARY = sys.argv[sys.argv.index("--summary") + 1] if "--summary" in sys.argv else None
if SUMMARY in args:
    args.remove(SUMMARY)

# The frozen constants of report section 1.
MUHURAT = {"2007-11-09", "2008-10-28", "2009-10-17", "2010-11-05", "2011-10-26", "2012-11-13", "2013-11-03", "2014-10-23", "2015-11-11",
           "2016-10-30", "2017-10-19", "2018-11-07", "2019-10-27", "2020-11-14", "2021-11-04", "2022-10-24", "2023-11-12", "2024-11-01", "2025-10-21"}
BSE_DAILY_FROM = "2023-05-15"
FIRST_DAY = "2007-01-01"
M_SET = (0.5, 1.0, 1.5)
N_SET = (2, 3, 4)
WIDTH = 0.5
STEP = {"NIFTY": 50, "SENSEX": 100}
EXCH = {"NIFTY": "NSE", "SENSEX": "BSE"}
E_MIN, E_WAIT, X_MIN, X_WAIT = 920, 2, 920, 5
COVERAGE_MIN = 0.9


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
VIX = sorted((d, b[3]) for d, b in yahoo(VIXF).items() if b)
VIX_DAYS = [d for d, _ in VIX]


def days_between(a, b):
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def num(s):
    s = (s or "").strip()
    if s in ("", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def bhav_dates(ex):
    root = os.path.join(BHAV, ex)
    return sorted(f"{f[:4]}-{f[4:6]}-{f[6:8]}" for yr in os.listdir(root) for f in os.listdir(os.path.join(root, yr)) if f.endswith(".csv.gz"))


NSE_DATES = bhav_dates("nse")
BSE_ALL = bhav_dates("bse")
OWN = {"NIFTY": set(NSE_DATES), "SENSEX": {d for d in BSE_ALL if d >= BSE_DAILY_FROM}}


def read_rows(ex, d, sym):
    """The day's rows of one index, with the main script's load filter: futures, or options within 45 days of expiry."""
    out = []
    limit = (date.fromisoformat(d) + timedelta(days=45)).isoformat()
    with gzip.open(os.path.join(BHAV, ex, d[:4], d.replace("-", "") + ".csv.gz"), "rt") as fh:
        rd = csv.reader(fh)
        head = next(rd)
        ix = {h: i for i, h in enumerate(head)}
        i_sym, i_kind, i_exp = ix["sym"], ix["kind"], ix["expiry"]
        for row in rd:
            if row[i_sym] != sym:
                continue
            if row[i_kind] == "OPT" and row[i_exp] > limit:
                continue
            out.append(dict(zip(head, row)))
    return out


cache = {}


def rows_of(sym, d):
    k = (sym, d)
    if k not in cache:
        cache[k] = read_rows("nse" if sym == "NIFTY" else "bse", d, sym)
        if len(cache) > 48:
            cache.pop(next(iter(cache)))
    return cache[k]


# One pass over NIFTY's files: WP6's short sessions, and each day's nearest expiry and NSE underlying close.
vol, near_n, undl, has_n = {}, {}, {}, {}
for d in NSE_DATES:
    rs_ = read_rows("nse", d, "NIFTY")
    has_n[d] = bool(rs_)
    vol[d] = sum(num(r["contracts"]) or 0 for r in rs_ if r["kind"] == "OPT")
    ex = [r["expiry"] for r in rs_ if r["kind"] == "OPT" and r["expiry"] >= d]
    near_n[d] = min(ex) if ex else None
    u = next((num(r["undl"]) for r in rs_ if (num(r["undl"]) or 0) > 0), None)
    undl[d] = u
SHORT = set()
for i, d in enumerate(NSE_DATES):
    around = [vol[x] for x in NSE_DATES[max(0, i - 3):i] + NSE_DATES[i + 1:i + 4]]
    if around and vol[d] < 0.3 * min(around):
        SHORT.add(d)
near_s, empty = {}, set()
for d in sorted(OWN["SENSEX"]):
    rs_ = read_rows("bse", d, "SENSEX")
    if not rs_:
        empty.add(d)
    ex = [r["expiry"] for r in rs_ if r["kind"] == "OPT" and r["expiry"] >= d]
    near_s[d] = min(ex) if ex else None
NEAR = {"NIFTY": near_n, "SENSEX": near_s}
# A header-only file (BSE: 28 Jun and 25 Jul 2023) is no bhavcopy of the index, as in the main script's book.
OWN["NIFTY"] -= {d for d in NSE_DATES if not has_n[d]}
OWN["SENSEX"] -= empty

oi_dates = set()
if os.path.isdir(OI):
    for f in os.listdir(OI):
        if f.startswith("fao_participant_oi_") and f.endswith(".csv"):
            s = f[len("fao_participant_oi_"):-4]
            oi_dates.add(f"{s[4:8]}-{s[2:4]}-{s[0:2]}")
bse_rows = {d for d in BSE_ALL if d in OWN["SENSEX"] or (d < BSE_DAILY_FROM and read_rows("bse", d, "SENSEX"))}
cal = set(oi_dates) | OWN["NIFTY"] | bse_rows | MUHURAT
for sym in BARS:
    cal |= {d for d, b in BARS[sym].items() if b and d >= FIRST_DAY}
CAL = sorted(cal)


def is_special(d):
    return date.fromisoformat(d).weekday() >= 5 or d in MUHURAT or d in SHORT


SESS = [d for d in CAL if not is_special(d)]
SESS_IX = {d: i for i, d in enumerate(SESS)}
SESS_SET = set(SESS)


def nth_before(day, n):
    """The n-th regular session strictly before day."""
    lo, hi = 0, len(SESS)
    while lo < hi:
        mid = (lo + hi) // 2
        if SESS[mid] < day:
            lo = mid + 1
        else:
            hi = mid
    i = lo - n
    return SESS[i] if n >= 1 and i >= 0 else None


def official_close(sym, d):
    if sym == "NIFTY" and undl.get(d):
        return undl[d]
    b = BARS[sym].get(d)
    return b[3] if b else None


def settlement(sym, x):
    xs = sorted(num(r["settle"]) for r in rows_of(sym, x) if r["kind"] == "OPT" and r["expiry"] == x and (num(r["settle"]) or 0) > 0.5 * num(r["strike"]))
    printed = xs[(len(xs) - 1) // 2] if xs else None
    return printed if printed is not None else official_close(sym, x)


def vix_prev(d):
    lo, hi = 0, len(VIX_DAYS)
    while lo < hi:
        mid = (lo + hi) // 2
        if VIX_DAYS[mid] < d:
            lo = mid + 1
        else:
            hi = mid
    return VIX[lo - 1][1] if lo > 0 else None


def weekly_expiries(sym):
    days = sorted(OWN[sym])
    s = {NEAR[sym][d] for d in days if not is_special(d) and NEAR[sym].get(d)}
    return sorted(e for e in s if e <= days[-1])


def strike_beyond(strikes, frm, target, below):
    best = None
    for k in strikes:
        if (below and not k < frm) or (not below and not k > frm):
            continue
        if best is None:
            best = k
            continue
        d, db = abs(k - target), abs(best - target)
        if d < db or (d == db and abs(k - frm) < abs(best - frm)):
            best = k
    return best


def option_rows(sym, d, x):
    """(strike, type) -> row of expiry x on day d."""
    out = {}
    for r in rows_of(sym, d):
        if r["kind"] == "OPT" and r["expiry"] == x:
            out[(round(num(r["strike"]), 4), r["type"])] = r
    return out


def traded(r):
    return r is not None and (num(r["contracts"]) or 0) > 0 and (num(r["close"]) or 0) > 0


def modal_lot(sym, d, x):
    cnt = Counter(num(r["lot"]) for r in rows_of(sym, d) if r["kind"] == "OPT" and r["expiry"] == x and num(r["lot"]) and num(r["lot"]) > 0)
    if not cnt:
        return None
    best = max(cnt.values())
    return max(v for v, n in cnt.items() if n == best)


def plan(sym, x, n, m, level, e):
    """Both spreads' strikes from the traded strikes of the entry day."""
    vix = vix_prev(e)
    if level is None or vix is None:
        return None, "no index close or India VIX"
    em = level * vix / 100 * math.sqrt(n / 252)
    rows = option_rows(sym, e, x)
    out = {}
    for side, t, below in (("put", "PE", True), ("call", "CE", False)):
        ks = sorted(k for (k, y), r in rows.items() if y == t and traded(r))
        sgn = -1 if below else 1
        short = strike_beyond(ks, level, level + sgn * m * em, below)
        long_ = strike_beyond(ks, short, short + sgn * WIDTH * em, below) if short is not None else None
        if short is None or long_ is None:
            return None, "no traded strike for a leg of either spread"
        out[side] = (short, long_, t)
    lot = modal_lot(sym, e, x)
    if lot is None:
        return None, "no lot in the bhavcopy"
    return {"em": em, "lot": lot, "rows": rows, **out}, None


# --- charges (the dated research schedule and the engine's computeCharges) ---
SCHED = [("2016-06-01", 0.05, {"NSE": 0.053, "BSE": 0.053}), ("2023-04-01", 0.0625, {"NSE": 0.05, "BSE": 0.05}),
         ("2024-04-01", 0.0625, {"NSE": 0.0495, "BSE": 0.0495}), ("2024-10-01", 0.1, {"NSE": 0.03503, "BSE": 0.0325}),
         ("2026-04-01", 0.15, {"NSE": 0.03503, "BSE": 0.0325})]


def charges(side, price, qty, exch, d):
    stt_pct, tx = SCHED[0][1], SCHED[0][2]
    for frm, s_, t_ in SCHED:
        if frm <= d:
            stt_pct, tx = s_, t_
    turnover = price * qty
    if turnover <= 0:
        return 0.0
    brokerage = 20.0
    stt = turnover * stt_pct / 100 if side == "SELL" else 0.0
    exch_ = turnover * tx[exch] / 100
    sebi = turnover * 0.0001 / 100
    stamp = turnover * 0.003 / 100 if side == "BUY" else 0.0
    ipft = turnover * 0.0005 / 100
    gst = (brokerage + exch_ + sebi + ipft) * 18 / 100
    # The engine rounds each order's total to the paisa with Math.round (halves up), not Python's round (halves to even).
    return math.floor((brokerage + stt + exch_ + sebi + stamp + ipft + gst) * 100 + 0.5) / 100


def engine_spread(p):
    return max(1, math.ceil(0.004 * p / 0.05 - 1e-9)) * 0.05


def pnl(short_in, long_in, short_out, long_out, settled, lot, exch, d_in, d_out, half):
    """Net per lot of a short + long vertical: half(p) is the half-spread paid per order."""
    sell = max(0.0, short_in - half(short_in))
    buy = long_in + half(long_in)
    ch = charges("SELL", sell, lot, exch, d_in) + charges("BUY", buy, lot, exch, d_in)
    if settled:
        filled = (sell - short_out) * lot + (long_out - buy) * lot
        if long_out > 0:
            ch += long_out * lot * (0.15 if d_out >= "2026-04-01" else 0.125) / 100
    else:
        b2 = short_out + half(short_out)
        s2 = max(0.0, long_out - half(long_out))
        ch += charges("BUY", b2, lot, exch, d_out) + charges("SELL", s2, lot, exch, d_out)
        filled = (sell - b2) * lot + (s2 - buy) * lot
    return filled - ch, (sell - buy) * lot


def intrinsic(t, k, s):
    return max(s - k, 0.0) if t == "CE" else max(k - s, 0.0)


# --- the 1-minute extract ---
manifest = json.load(open(os.path.join(X13, "manifest.json")))


def index_bars(sym):
    out = defaultdict(list)
    with gzip.open(os.path.join(X13, "index", f"{sym}.csv.gz"), "rt") as fh:
        for r in csv.DictReader(fh):
            out[r["day"]].append((int(r["min"]), float(r["c"])))
    return out


chain_cache = {}


def chain(sym, d, x):
    k = (sym, d, x)
    if k not in chain_cache:
        p = os.path.join(X13, "opt", sym, f"{d}_{x}.csv.gz")
        out = None
        if os.path.exists(p):
            out = defaultdict(dict)
            with gzip.open(p, "rt") as fh:
                for r in csv.DictReader(fh):
                    if float(r["v"]) > 0:
                        out[(int(r["k"]), "CE" if r["y"] == "C" else "PE")][int(r["min"])] = (float(r["h"]), float(r["l"]), float(r["c"]))
        chain_cache[k] = out
        if len(chain_cache) > 24:
            chain_cache.pop(next(iter(chain_cache)))
    return chain_cache[k]


def common(a, b, m, wait):
    return next((t for t in range(m, m + wait + 1) if t in a and t in b), None)


def last_upto(bars, m):
    ms = [t for t in bars if t <= m]
    return bars[max(ms)][2] if ms else None


# --- samples ---
def samples():
    out = {}
    for sym in ("NIFTY", "SENSEX"):
        man = manifest[sym]
        idx = index_bars(sym)
        valid = set()
        for d in man["sessions"]:
            ses = [mm for mm, _ in idx.get(d, []) if 555 <= mm < 930]
            if d in OWN[sym] and not is_special(d) and len(ses) >= 370 and min(ses) == 555:
                valid.add(d)
        first_opt = min(k[:10] for k in man["pairs"])
        last = man["sessions"][-1]
        for fam in ("D", "M"):
            el, skips = [], Counter()
            for x in weekly_expiries(sym):
                if fam == "M" and (x > last or x < first_opt):
                    continue
                if x not in SESS_SET:
                    skips["not a session"] += 1
                    continue
                before = [nth_before(x, k) for k in (1, 2, 3, 4, 5)]
                if None in before:
                    skips["calendar"] += 1
                    continue
                if any(d not in OWN[sym] for d in before[:4]) or x not in OWN[sym]:
                    skips["bhavcopy"] += 1
                    continue
                if fam == "M" and (any(d not in valid for d in before[:4]) or any(f"{d}_{x}" not in man["pairs"] for d in before[:4])):
                    skips["1-minute"] += 1
                    continue
                if settlement(sym, x) is None:
                    skips["settlement"] += 1
                    continue
                el.append((x, before[:4]))
            xs = [x for x, _ in el]
            cut = xs[max(0, -(-6 * len(xs) // 10) - 1)] if xs else None
            out[(fam, sym)] = {"el": el, "cut": cut, "skips": skips, "idx": idx, "valid": valid}
    return out


SAMPLES = samples()
print("Calendar:", len(CAL), "sessions;", len(SESS), "regular; short sessions", sorted(SHORT))
for (fam, sym), s in SAMPLES.items():
    print(f"  {fam} {sym}: {len(s['el'])} eligible expiries, cut {s['cut']}, skips {dict(s['skips'])}")

xc = {"runs": {}, "tom": {}}
counts = {}
for (fam, sym), s in SAMPLES.items():
    idx = s["idx"]
    for x, before in s["el"]:
        settle = None if COUNTS_ONLY else settlement(sym, x)
        for mgmt in ("hold", "early"):
            for m in M_SET:
                for n in N_SET:
                    e = nth_before(x, n)
                    exit_day = before[0]
                    key = (fam, sym, mgmt, m, n)
                    if e is None or e not in OWN[sym] or (mgmt == "early" and not exit_day > e):
                        continue
                    if fam == "D":
                        level = official_close(sym, e)
                    else:
                        if e not in s["valid"]:
                            continue
                        lv = [c for mm, c in idx.get(e, []) if 555 <= mm <= E_MIN - 1]
                        level = lv[-1] if lv else None
                    pl, why = plan(sym, x, n, m, level, e)
                    if pl is None:
                        continue
                    if fam == "M":
                        ce = chain(sym, e, x)
                        if ce is None:
                            continue
                        ok = True
                        for side in ("put", "call"):
                            sh, lg, t = pl[side]
                            a, b = ce.get((int(sh), t)), ce.get((int(lg), t))
                            if a is None or b is None or common(a, b, E_MIN, E_WAIT) is None:
                                ok = False
                        if not ok:
                            continue
                    if mgmt == "hold":
                        counts[key] = counts.get(key, 0) + 1
                    if COUNTS_ONLY:
                        continue
                    # --- prices (after the freeze only) ---
                    for mode in ("conservative", "mid"):
                        res = {}
                        for side in ("put", "call"):
                            sh, lg, t = pl[side]
                            if fam == "D":
                                si, li = num(pl["rows"][(sh, t)]["close"]), num(pl["rows"][(lg, t)]["close"])
                                if mgmt == "hold":
                                    so, lo_ = intrinsic(t, sh, settle), intrinsic(t, lg, settle)
                                else:
                                    xr = option_rows(sym, exit_day, x)
                                    a, b = xr.get((sh, t)), xr.get((lg, t))
                                    if a is None or b is None or num(a["close"]) is None or num(b["close"]) is None or num(a["close"]) < 0 or num(b["close"]) < 0:
                                        res = None
                                        break
                                    so, lo_ = num(a["close"]), num(b["close"])
                                half = engine_spread if mode == "conservative" else (lambda p: 0.0)
                            else:
                                ce = chain(sym, e, x)
                                a, b = ce[(int(sh), t)], ce[(int(lg), t)]
                                mm = common(a, b, E_MIN, E_WAIT)
                                si = a[mm][2] if mode == "mid" else a[mm][1]
                                li = b[mm][2] if mode == "mid" else b[mm][0]
                                if mgmt == "hold":
                                    so, lo_ = intrinsic(t, sh, settle), intrinsic(t, lg, settle)
                                else:
                                    cx = chain(sym, exit_day, x)
                                    a2, b2 = (cx.get((int(sh), t)), cx.get((int(lg), t))) if cx else (None, None)
                                    if a2 is None or b2 is None:
                                        res = None
                                        break
                                    m2 = common(a2, b2, X_MIN, X_WAIT)
                                    if m2 is not None:
                                        so = a2[m2][2] if mode == "mid" else a2[m2][0]
                                        lo_ = b2[m2][2] if mode == "mid" else b2[m2][1]
                                    else:
                                        so, lo_ = last_upto(a2, X_MIN), last_upto(b2, X_MIN)
                                        if so is None or lo_ is None:
                                            res = None
                                            break
                                half = lambda p: 0.0
                            net, credit = pnl(si, li, so, lo_, mgmt == "hold", pl["lot"], EXCH[sym], e, x if mgmt == "hold" else exit_day, half)
                            res[side] = (net, credit)
                        if res:
                            xc["runs"].setdefault(key + (mode,), []).append((x, res["put"][0], res["call"][0], res["put"][1]))

print("Per-cell entries with both spreads priced (hold):")
for k in sorted(counts):
    print("  ", k, counts[k])

# --- H2: the turn of the month (window counts from bar presence; returns only without --counts-only) ---
for sym in ("NIFTY", "SENSEX"):
    bars = BARS[sym]
    first = min(d for d, b in bars.items() if b)
    ss = [d for d in SESS if d >= first]
    wins, tom_days = [], set()
    for i in range(len(ss) - 1):
        if ss[i][:7] == ss[i + 1][:7]:
            continue
        a, b = i, i + 3
        if a < 1 or b >= len(ss):
            continue
        days_ = ss[a:b + 1]
        if days_[0][:7] != ss[i][:7] or any(d[:7] != ss[i + 1][:7] for d in days_[1:]):
            continue
        if ss[b] > "2026-10-08":
            continue
        tom_days |= set(days_)
        if bars.get(ss[a - 1]) and bars.get(ss[b]):
            wins.append((ss[b], ss[a - 1]))
    ends = sorted(e for e, _ in wins)
    cut = ends[max(0, -(-6 * len(ends) // 10) - 1)]
    pairs = [(ss[i], ss[i - 1]) for i in range(1, len(ss)) if bars.get(ss[i - 1]) and bars.get(ss[i])]
    n_tom = sum(1 for d, _ in pairs if d in tom_days)
    n_oos = sum(1 for e in ends if e > cut)
    print(f"TOM {sym}: {len(wins)} windows from {first}, cut {cut}, first 60% {len(wins) - n_oos} / last 40% {n_oos}; daily returns: window days {n_tom} / other days {len(pairs) - n_tom}")
    if COUNTS_ONLY:
        continue
    rets = [(e, bars[e][3] / bars[st][3] - 1) for e, st in wins]
    daily = [(d, bars[d][3] / bars[pv][3] - 1, d in tom_days) for d, pv in pairs]
    mean = lambda v: sum(v) / len(v) if v else float("nan")
    oo = [r for e, r in rets if e > cut]
    gap = mean([r for _, r, t in daily if t]) - mean([r for _, r, t in daily if not t])
    gap_oos = mean([r for d, r, t in daily if t and d > cut]) - mean([r for d, r, t in daily if not t and d > cut])
    xc["tom"][sym] = {"n": len(rets), "mean": mean([r for _, r in rets]), "oosN": len(oo), "oosMean": mean(oo), "gap": gap, "gapOos": gap_oos, "cut": cut}
    print(f"TOM {sym}: mean {1e4 * xc['tom'][sym]['mean']:+.2f} bp, last 40% {len(oo)} {1e4 * mean(oo):+.2f} bp; window days - other days {1e4 * gap:+.3f} bp a day (last 40% {1e4 * gap_oos:+.3f})")

if SUMMARY and not COUNTS_ONLY:
    s = json.load(open(SUMMARY))
    worst = Counter()
    compared = Counter()
    for r in s["runs"]:
        k = (r["family"], r["sym"], r["mgmt"], r["m"], r["n"], r["mode"])
        if r["width"] != WIDTH or k not in xc["runs"]:
            continue
        xs = xc["runs"][k]
        cut = SAMPLES[(r["family"], r["sym"])]["cut"]
        oo = [z for z in xs if z[0] > cut]
        mean = lambda v: sum(v) / len(v) if v else float("nan")
        compared[r["family"]] += 1
        worst["trades"] = max(worst["trades"], abs(len(xs) - r["put"]["full"]["n"]))
        worst["oos trades"] = max(worst["oos trades"], abs(len(oo) - r["put"]["oos"]["n"]))
        worst["put net (₹)"] = max(worst["put net (₹)"], abs(mean([z[1] for z in xs]) - r["put"]["full"]["mean"]))
        worst["call net (₹)"] = max(worst["call net (₹)"], abs(mean([z[2] for z in xs]) - r["call"]["full"]["mean"]))
        worst["put oos net (₹)"] = max(worst["put oos net (₹)"], abs(mean([z[1] for z in oo]) - r["put"]["oos"]["mean"]) if oo else 0)
        worst["credit (₹)"] = max(worst["credit (₹)"], abs(mean([z[3] for z in xs]) - r["put"]["econ"]["credit"]))
    for t in s["tom"]:
        x = xc["tom"].get(t["sym"])
        if not x:
            continue
        compared["tom"] += 1
        worst["tom n"] = max(worst["tom n"], abs(x["n"] - t["full"]["n"]), abs(x["oosN"] - t["oos"]["n"]))
        worst["tom mean (bp)"] = max(worst["tom mean (bp)"], 1e4 * abs(x["mean"] - t["full"]["mean"]), 1e4 * abs(x["oosMean"] - t["oos"]["mean"]))
        worst["tom gap (bp a day)"] = max(worst["tom gap (bp a day)"], 1e4 * abs(x["gap"] - t["full"]["gap"]), 1e4 * abs(x["gapOos"] - t["oos"]["gap"]))
    print(f"Compared with {SUMMARY}: {dict(compared)}; largest differences {dict(worst)}")
