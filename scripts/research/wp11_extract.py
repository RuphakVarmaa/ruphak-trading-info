"""WP11 step 0: compact extracts of the TradeMarkk 1-minute NIFTY/SENSEX data (reports/wp11-real-intraday.md).

Source: Hugging Face dataset "India Index & Options - 1-minute OHLC" by TradeMarkk,
repo thetrademarkk/india-index-options-1m, revision 0f4800e43e6f96cec0794369d78eb4d3c4211ef5,
licence CC-BY-NC-4.0 (non-commercial research use only). Raw data is never committed.

The downloads are untrusted data: run this with `python3 -I`, from outside the data folders, with a
vendored pyarrow/pandas on --pylib:

    python3 -I scripts/research/wp11_extract.py --pylib <dir with pyarrow+pandas> \
        --raw <dir holding index/*.parquet and options/{NIFTY,SENSEX}/*.parquet> \
        --daily <bhavcopy cache>/index-daily.json --out <extract dir>

What it keeps (everything else is dropped):
  index/<SYM>.csv.gz        every 1-minute index bar from 09:00 to 15:59 IST: day,min,o,h,l,c
  opt/<SYM>/<day>_<expiry>.csv.gz
                            for every session `day` with index bars, only the two weekly contracts a
                            day trader uses (A: nearest expiry on or after the day; B: nearest expiry
                            strictly after it), only the strikes within max(6.5 strike steps,
                            2.6 daily expected moves + 1 step) of the day's index range (ATM +- 6 strikes
                            at every minute of the day, plus the iron fly's wings out to 2.4 expected
                            moves), and only bars starting 09:15..15:30: min,k,y,o,h,l,c,v,oi
  manifest.json             per symbol: expiries, per (day, expiry) the strike window, rows, strikes;
                            per expiry file: data checks (duplicates, day/timestamp mismatches, bars
                            outside the session, OHLC violations)
`min` is the IST minute of the day of the bar's start (09:15 = 555). Expected move = index open x
(India VIX close of the previous session)/100 x sqrt(1/252), from Yahoo's ^INDIAVIX daily series.
"""
import argparse
import bisect
import gzip
import json
import math
import os
import sys

STEP = {"NIFTY": 50, "SENSEX": 100}
SESSION_FIRST, SESSION_LAST = 9 * 60 + 15, 15 * 60 + 30  # option bars kept: starts 09:15 .. 15:30
INDEX_FIRST, INDEX_LAST = 9 * 60, 15 * 60 + 59


def ist_minutes(ts_series):
    """IST minute of the day and IST date (YYYY-MM-DD) of tz-aware timestamps, without slow strftime."""
    ns = ts_series.astype("int64").to_numpy()
    secs = ns // 1_000_000_000 + 19_800
    minute = (secs % 86_400) // 60
    days = secs // 86_400
    return minute, days


def epoch_day_str(d):
    import datetime as _dt

    return (_dt.date(1970, 1, 1) + _dt.timedelta(days=int(d))).isoformat()


def load_vix(path):
    raw = json.load(open(path))
    out = {}
    for c in raw["series"].get("^INDIAVIX", []):
        day = epoch_day_str((c["t"] // 1000 + 19_800) // 86_400)
        if c.get("c") and c["c"] > 0:
            out[day] = c["c"]
    days = sorted(out)
    return days, out


def vix_before(vdays, vix, day):
    i = bisect.bisect_left(vdays, day) - 1
    return vix[vdays[i]] if i >= 0 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pylib", required=True)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--daily", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--symbols", default="NIFTY,SENSEX")
    a = ap.parse_args()
    sys.path.insert(0, a.pylib)
    import numpy as np
    import pyarrow.parquet as pq

    vdays, vix = load_vix(a.daily)
    manifest = {}
    for sym in a.symbols.split(","):
        step = STEP[sym]
        # ---- index ----
        idx = pq.read_table(os.path.join(a.raw, "index", f"{sym}.parquet"), columns=["timestamp", "open", "high", "low", "close", "trading_day"]).to_pandas()
        minute, eday = ist_minutes(idx["timestamp"])
        idx["min"] = minute
        # IST date per row (through a small lookup of the unique epoch days)
        uniq = np.unique(eday)
        lut = {d: epoch_day_str(d) for d in uniq}
        idx["eday"] = [lut[d] for d in eday]
        checks = {"rows": int(len(idx)), "day_mismatch": int((idx["eday"] != idx["trading_day"]).sum())}
        idx = idx[(idx["min"] >= INDEX_FIRST) & (idx["min"] <= INDEX_LAST) & (idx["eday"] == idx["trading_day"])]
        dup = idx.duplicated(["trading_day", "min"])
        checks["dup_minutes"] = int(dup.sum())
        idx = idx[~dup].sort_values(["trading_day", "min"])
        os.makedirs(os.path.join(a.out, "index"), exist_ok=True)
        out = idx[["trading_day", "min", "open", "high", "low", "close"]].rename(columns={"trading_day": "day", "open": "o", "high": "h", "low": "l", "close": "c"})
        with gzip.open(os.path.join(a.out, "index", f"{sym}.csv.gz"), "wt") as f:
            out.to_csv(f, index=False, float_format="%.2f")
        sess = idx[(idx["min"] >= SESSION_FIRST) & (idx["min"] <= SESSION_LAST)]
        g = sess.groupby("trading_day")
        day_lo = g["low"].min().to_dict()
        day_hi = g["high"].max().to_dict()
        first = sess[sess["min"] == SESSION_FIRST].set_index("trading_day")["open"].to_dict()
        days = sorted(day_lo)
        print(f"{sym}: index {len(idx)} bars kept, {len(days)} sessions {days[0]}..{days[-1]}; checks {checks}", flush=True)

        # ---- expiries and the two contracts per day ----
        opt_dir = os.path.join(a.raw, "options", sym)
        expiries = sorted(f[:-8] for f in os.listdir(opt_dir) if f.endswith(".parquet"))
        gaps = [(expiries[i], expiries[i + 1]) for i in range(len(expiries) - 1)
                if (np.datetime64(expiries[i + 1]) - np.datetime64(expiries[i])).astype(int) > 8]
        want = {}  # (day, expiry) -> role
        for d in days:
            ia = bisect.bisect_left(expiries, d)
            if ia < len(expiries):
                want[(d, expiries[ia])] = "A" if expiries[ia] != d else "A0"
            ib = bisect.bisect_right(expiries, d)
            if ib < len(expiries):
                key = (d, expiries[ib])
                want[key] = "AB" if key in want else "B"
        windows = {}
        for d in days:
            o = first.get(d) or (day_lo[d] + day_hi[d]) / 2
            v = vix_before(vdays, vix, d) or 30.0
            em = o * v / 100 * math.sqrt(1 / 252)
            w = max(6.5 * step, 2.6 * em + step)
            windows[d] = (day_lo[d] - w, day_hi[d] + w, round(em, 2), v)

        out_dir = os.path.join(a.out, "opt", sym)
        os.makedirs(out_dir, exist_ok=True)
        files = {}
        pairs = {}
        for e in expiries:
            t = pq.read_table(os.path.join(opt_dir, f"{e}.parquet"), columns=["timestamp", "open", "high", "low", "close", "volume", "open_interest", "trading_day", "symbol", "strike", "option_type", "expiry"])
            df = t.to_pandas()
            mn, ed = ist_minutes(df["timestamp"])
            df["min"] = mn
            lut = {d: epoch_day_str(d) for d in np.unique(ed)}
            df["eday"] = [lut[d] for d in ed]
            fc = {
                "rows": int(len(df)),
                "days": int(df["trading_day"].nunique()),
                "first_day": str(df["trading_day"].min()),
                "last_day": str(df["trading_day"].max()),
                "strikes": int(df["strike"].nunique()),
                "bad_expiry": int((df["expiry"] != e).sum()),
                "bad_symbol": int((df["symbol"] != sym).sum()),
                "day_mismatch": int((df["eday"] != df["trading_day"]).sum()),
                "outside_session": int(((df["min"] < SESSION_FIRST) | (df["min"] > SESSION_LAST)).sum()),
                "ohlc_violations": int(((df["low"] > df[["open", "close"]].min(axis=1) + 1e-9) | (df["high"] < df[["open", "close"]].max(axis=1) - 1e-9) | (df["low"] <= 0)).sum()),
                "zero_volume": int((df["volume"] <= 0).sum()),
            }
            df = df[(df["min"] >= SESSION_FIRST) & (df["min"] <= SESSION_LAST) & (df["eday"] == df["trading_day"]) & (df["expiry"] == e) & (df["symbol"] == sym)]
            dup = df.duplicated(["trading_day", "strike", "option_type", "min"])
            fc["duplicates"] = int(dup.sum())
            df = df[~dup]
            kept_days = 0
            for d, part in df.groupby("trading_day"):
                role = want.get((d, e))
                if role is None:
                    continue
                lo, hi, em, v = windows[d]
                part = part[(part["strike"] >= lo) & (part["strike"] <= hi)].sort_values(["strike", "option_type", "min"])
                if len(part) == 0:
                    continue
                rows = part[["min", "strike", "option_type", "open", "high", "low", "close", "volume", "open_interest"]].rename(
                    columns={"strike": "k", "option_type": "y", "open": "o", "high": "h", "low": "l", "close": "c", "volume": "v", "open_interest": "oi"})
                rows["y"] = rows["y"].str[0]
                rows["k"] = rows["k"].astype("int64")
                with gzip.open(os.path.join(out_dir, f"{d}_{e}.csv.gz"), "wt", compresslevel=6) as f:
                    rows.to_csv(f, index=False, float_format="%.2f")
                pairs[f"{d}_{e}"] = {"role": role, "rows": int(len(part)), "strikes": int(part["strike"].nunique()),
                                     "kmin": int(part["strike"].min()), "kmax": int(part["strike"].max()), "window": [round(lo, 2), round(hi, 2)], "em": em, "vixPrev": v}
                kept_days += 1
            fc["kept_day_files"] = kept_days
            files[e] = fc
            print(f"  {sym} {e}: {fc['rows']} rows, {fc['days']} days, kept {kept_days}; dup {fc['duplicates']}, outside {fc['outside_session']}, ohlc {fc['ohlc_violations']}", flush=True)
        missing = sorted(k for k in want if f"{k[0]}_{k[1]}" not in pairs)
        manifest[sym] = {"step": step, "sessions": days, "expiries": expiries, "expiry_gaps_over_8_days": gaps, "index_checks": checks,
                         "files": files, "pairs": pairs, "missing_pairs": [f"{d}_{e}" for d, e in missing]}
        print(f"{sym}: {len(pairs)} day-contract files; {len(missing)} wanted (day, expiry) pairs absent; expiry gaps > 8 days: {gaps}", flush=True)
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        json.dump(manifest, f)


if __name__ == "__main__":
    main()
