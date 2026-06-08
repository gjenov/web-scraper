#!/usr/bin/env python3
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from strategies import diamond_bluenile


def main():
    parser = argparse.ArgumentParser(description='Blue Nile diamond scraper')
    parser.add_argument('--shape',      nargs='+', default=[], metavar='SHAPE')
    parser.add_argument('--carat-from', type=float, dest='carat_from')
    parser.add_argument('--carat-to',   type=float, dest='carat_to')
    parser.add_argument('--color',      nargs='+', default=[], metavar='GRADE')
    parser.add_argument('--clarity',    nargs='+', default=[], metavar='GRADE')
    parser.add_argument('--cut',        nargs='+', default=[], metavar='GRADE')
    parser.add_argument('--type',       choices=['natural', 'lab'], default='natural',
                        dest='diamond_type')
    parser.add_argument('--output',      required=True)
    parser.add_argument('--full-scrape', action='store_true', dest='full_scrape')
    parser.add_argument('--resume',      action='store_true')
    args = parser.parse_args()

    params = {
        'shape':        args.shape,
        'carat_from':   args.carat_from,
        'carat_to':     args.carat_to,
        'color':        args.color,
        'clarity':      args.clarity,
        'cut':          args.cut,
        'diamond_type': args.diamond_type,
    }

    if args.full_scrape:
        df = diamond_bluenile.scrape_all(params, args.output, resume=args.resume)
    else:
        df = diamond_bluenile.scrape(params)
        if not df.empty:
            os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
            df.to_csv(args.output, index=False)

    if df.empty:
        sys.exit(1)


if __name__ == '__main__':
    main()
