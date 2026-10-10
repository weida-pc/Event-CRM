"""Standard-library-only photo hint validation; no image imports or network."""
import re
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from .research import _safe_url


def image_url(value):
    """Public HTTPS syntax. Allow sizing parameters, not credentials/signed URLs."""
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("Invalid image URL")
    if any(ord(c) < 33 or ord(c) == 127 for c in value) or "\\" in value:
        raise ValueError("Invalid image URL")
    parts = urlsplit(value)
    base = _safe_url(urlunsplit((parts.scheme, parts.netloc, parts.path, "", "")))
    if parts.fragment:
        raise ValueError("Image fragments are not supported")
    pairs = parse_qsl(parts.query, keep_blank_values=True, strict_parsing=True)
    if len(pairs) > 10 or any(k not in {"w", "h", "width", "height", "fit", "crop", "auto", "format", "fm", "q"}
                              or not re.fullmatch(r"[A-Za-z0-9,._-]{1,40}", v) for k, v in pairs):
        raise ValueError("Use an unsigned image URL without tracking or credentials")
    return base + ("?" + parts.query if parts.query else "")
