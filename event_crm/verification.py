"""Compare an explicitly authorized HTTPS dashboard to local authoritative state."""
import json
import os
import re
from http.cookiejar import CookieJar
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .store import Store


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Verification refuses redirects; use the exact approved HTTPS origin")


def verify_https(config, url, *, opener=None, token=None):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path != "/api/dashboard" or parsed.query or parsed.fragment):
        raise ValueError("Verification requires the exact HTTPS /api/dashboard endpoint")
    token = token or os.environ.get("EVENT_CRM_VERIFY_TOKEN")
    if not token:
        raise ValueError("Set EVENT_CRM_VERIFY_TOKEN to an authorized dashboard access token")
    origin = f"https://{parsed.netloc}"
    client = opener or build_opener(ProxyHandler({}), NoRedirect(), HTTPCookieProcessor(CookieJar()))
    try:
        request = Request(origin + "/api/login", data=json.dumps({"token": token}).encode(), headers={"Content-Type": "application/json", "Origin": origin}, method="POST")
        with client.open(request, timeout=15) as response:
            if response.geturl() != request.full_url or response.status != 200:
                raise ValueError("Exact HTTPS login failed")
        request = Request(url, headers={"Cache-Control": "no-cache"})
        with client.open(request, timeout=15) as response:
            if response.geturl() != url or response.status != 200 or "no-store" not in response.headers.get("Cache-Control", ""):
                raise ValueError("Exact HTTPS endpoint or no-store policy failed verification")
            raw = response.read(20_000_001)
            if len(raw) > 20_000_000:
                raise ValueError("Dashboard response exceeds size limit")
            actual = json.loads(raw)
        if not isinstance(actual, dict):
            raise ValueError("Unexpected dashboard payload")
        actual.pop("runtime", None)
        store = Store(config)
        expected = store.dashboard()
        if actual != expected:
            raise ValueError("Exact HTTPS dashboard differs from the local authoritative state")
        paths = {g["photo_url"] for a in expected.get("audiences", []) for g in a["records"] if g.get("photo_url")}
        for path in sorted(paths):
            match = re.fullmatch(r"/api/photos/([A-Za-z0-9_-]{24})/([a-f0-9]{64})", path)
            if not match:
                raise ValueError("Unexpected portrait route; no external image request made")
            local = store.photo(*match.groups())
            request = Request(origin + path, headers={"Cache-Control": "no-cache"})
            with client.open(request, timeout=15) as response:
                if (response.geturl() != request.full_url or response.status != 200
                        or response.headers.get("Content-Type", "").split(";", 1)[0] != "image/jpeg"
                        or "no-store" not in response.headers.get("Cache-Control", "")):
                    raise ValueError("Exact HTTPS photo endpoint or privacy policy failed verification")
                if local is None or response.read(512_001) != local:
                    raise ValueError("Published photo differs from the local reviewed asset")
        return {"https_verified": True, "revision": expected["revision"], "captured_at": expected["captured_at"],
                "photo_assets_verified": len(paths), "browser_render_verified": False}
    except HTTPError as exc:
        raise ValueError(f"HTTPS verification failed with HTTP {exc.code}") from None
    except URLError:
        raise ValueError("HTTPS verification connection failed; credentials were not printed") from None
