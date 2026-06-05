import argparse
import scraper


def main():
    parser = argparse.ArgumentParser(
        description="Scrape jewelry product names and prices from a store URL."
    )
    parser.add_argument("--url", required=True, help="Store URL to scrape")
    parser.add_argument(
        "--output",
        default=None,
        help="Output CSV file path (default: output/<sitename>.csv)",
    )
    args = parser.parse_args()
    scraper.run(args.url, args.output)


if __name__ == "__main__":
    main()
