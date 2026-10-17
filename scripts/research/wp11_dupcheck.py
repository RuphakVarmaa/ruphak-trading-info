"""WP11 data check: are the dataset's repeated (day, strike, type, minute) rows exact copies?

    python3 -I scripts/research/wp11_dupcheck.py --pylib <dir> --raw <dir with options/<SYM>/*.parquet> [--symbols NIFTY,SENSEX]

Prints, per symbol, the rows, the rows sharing a key with another row, and how many of those differ
from their twin in any price, volume or open-interest field (conflicting duplicates). Untrusted input:
run with python3 -I.
"""
import argparse
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pylib", required=True)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--symbols", default="NIFTY,SENSEX")
    a = ap.parse_args()
    sys.path.insert(0, a.pylib)
    import pyarrow.parquet as pq

    key = ["trading_day", "strike", "option_type", "timestamp"]
    full = key + ["open", "high", "low", "close", "volume", "open_interest"]
    for sym in a.symbols.split(","):
        d = os.path.join(a.raw, "options", sym)
        tot = dup_rows = conflict = files_with_dups = files_with_conflicts = 0
        for f in sorted(os.listdir(d)):
            if not f.endswith(".parquet"):
                continue
            df = pq.read_table(os.path.join(d, f), columns=full).to_pandas()
            tot += len(df)
            in_dup = df.duplicated(key, keep=False)
            n_dup = int(in_dup.sum())
            if n_dup:
                files_with_dups += 1
                dup_rows += n_dup
                sub = df[in_dup]
                # a conflicting group has more than one distinct full row
                distinct = sub.drop_duplicates(full).groupby(key).size()
                c = int((distinct > 1).sum())
                if c:
                    files_with_conflicts += 1
                    conflict += c
                    print(f"  {sym} {f}: {c} key groups with differing rows", flush=True)
        print(f"{sym}: {tot} rows; {dup_rows} rows share a key with another row in {files_with_dups} files; "
              f"{conflict} key groups with differing values in {files_with_conflicts} files", flush=True)


if __name__ == "__main__":
    main()
