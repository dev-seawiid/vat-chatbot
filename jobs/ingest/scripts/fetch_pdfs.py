import hashlib
import json
import time
from dataclasses import dataclass

import httpx
from ingest.shared.paths import (
    MANIFEST_JSON,
    PDFS_DIR,
    SOURCES_JSON,
    make_arg_parser,
    print_table,
    require_path,
)

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"


@dataclass
class FetchResult:
    id: str
    title: str
    status: str
    sha256: str | None = None
    size: int | None = None
    error: str | None = None


def load_manifest() -> dict:
    if MANIFEST_JSON.exists():
        return json.loads(MANIFEST_JSON.read_text(encoding="utf-8"))
    return {}


def save_manifest(manifest: dict) -> None:
    PDFS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_JSON.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def fetch_one(client: httpx.Client, entry: dict, manifest: dict) -> FetchResult:
    sid = entry["id"]
    title = entry["title"]
    url = entry["url"]
    prev = manifest.get(sid, {})

    headers: dict[str, str] = {}
    if prev.get("etag"):
        headers["If-None-Match"] = prev["etag"]
    if prev.get("last_modified"):
        headers["If-Modified-Since"] = prev["last_modified"]

    try:
        r = client.get(url, headers=headers, follow_redirects=True, timeout=60)
    except httpx.HTTPError as exc:
        return FetchResult(sid, title, "error", error=str(exc))

    if r.status_code == 304 and prev.get("sha256"):
        cached = PDFS_DIR / f"{prev['sha256']}.pdf"
        if cached.exists():
            return FetchResult(sid, title, "cached", prev["sha256"], prev.get("size"))

    if r.status_code != 200:
        return FetchResult(sid, title, "error", error=f"HTTP {r.status_code}")

    body = r.content
    sha = hashlib.sha256(body).hexdigest()
    out = PDFS_DIR / f"{sha}.pdf"
    out.parent.mkdir(parents=True, exist_ok=True)
    if not out.exists():
        out.write_bytes(body)

    status = "unchanged" if prev.get("sha256") == sha else "fetched"
    manifest[sid] = {
        "sha256": sha,
        "size": len(body),
        "url": url,
        "title": title,
        "etag": r.headers.get("etag"),
        "last_modified": r.headers.get("last-modified"),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return FetchResult(sid, title, status, sha, len(body))


def _report(results: list[FetchResult]) -> None:
    rows: list[list[str]] = []
    for r in results:
        size = f"{r.size:,}" if r.size is not None else "-"
        sha_short = r.sha256[:8] if r.sha256 else ""
        title = r.title
        if sha_short:
            title += f"  [{sha_short}]"
        if r.error:
            title += f"  ! {r.error}"
        rows.append([r.id, r.status, size, title])
    print_table(
        headers=["ID", "STATUS", "SIZE", "TITLE"],
        rows=rows,
        widths=[32, 10, -12, 50],
    )


def main() -> int:
    make_arg_parser("Fetch PDF sources into local cache").parse_args()
    require_path(SOURCES_JSON)

    sources = json.loads(SOURCES_JSON.read_text(encoding="utf-8"))
    pdfs = sources.get("pdfs", [])
    if not pdfs:
        print("No pdf entries in sources.json")
        return 0

    manifest = load_manifest()
    results: list[FetchResult] = []
    with httpx.Client(headers={"User-Agent": USER_AGENT}, http2=False) as client:
        for entry in pdfs:
            res = fetch_one(client, entry, manifest)
            results.append(res)
            if res.status in ("fetched", "unchanged"):
                save_manifest(manifest)

    _report(results)
    failed = sum(1 for r in results if r.status == "error")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
