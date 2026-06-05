import re


_CURRENCY_SYMBOLS = re.compile(r'[A-Z]{3}|[$£€¥]', re.IGNORECASE)
_NUMBER = re.compile(r'[\d,]+(?:\.\d+)?')


def normalize_price(raw: str) -> float | None:
    if not raw:
        return None
    cleaned = _CURRENCY_SYMBOLS.sub('', raw).strip()
    numbers = _NUMBER.findall(cleaned)
    if not numbers:
        return None
    # For price ranges take the lower (first) value
    try:
        return float(numbers[0].replace(',', ''))
    except ValueError:
        return None
