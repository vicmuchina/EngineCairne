#!/usr/bin/env python3
"""Project an imported Artex fact corpus into Cairn's domain layer.

Imported Artex tasks store their findings as facts (`ARTEX FINDING #N — ...`) and mention
assets in `Assets:` lines. The domain layer wants first-class findings and entities, so this
script derives them from evidence that is already recorded — it never scans, probes or invents:

* findings: one per `ARTEX FINDING #` fact, pointing at that fact (title/severity/class parsed
  from the text, summary/evidence preserved);
* entities: hosts/URLs/IPs explicitly named in an `Assets:` line or under `*.sasakonnect.net`,
  each anchored to the fact that mentions it (entity_facts), so coverage is real;
* URL entities are parented to their host, giving the containment graph.

It is idempotent (upsert by kind+key, skip existing findings by fact_id) and API-only, so it
works against any running Cairn without touching the database:

    python scripts/import_artex_domain.py --project proj_005
    python scripts/import_artex_domain.py --project proj_005 --dry-run
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlparse

FINDING_RE = re.compile(r"^ARTEX FINDING #(\d+)\s*[—–-]\s*(.+)")
SEVERITY_RE = re.compile(r"^Severity:\s*(.+)$", re.MULTILINE | re.IGNORECASE)
CLASS_RE = re.compile(r"^Class:\s*(.+)$", re.MULTILINE | re.IGNORECASE)
SUMMARY_RE = re.compile(r"^Summary:\s*(.+?)(?=\n(?:Assets|Evidence|Status|Worker|Impact|Class|Severity):|\Z)", re.MULTILINE | re.IGNORECASE | re.DOTALL)
URL_RE = re.compile(r"https?://[^\s,\"'<>)]+")
SCOPE_HOST_RE = re.compile(r"\b(?:[a-z0-9-]+\.)+sasakonnect\.net\b", re.IGNORECASE)
IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
HOST_RE = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$",
    re.IGNORECASE,
)
BAD_URL_CHARS = set("`*\n\r\t ")


@dataclass
class Asset:
    kind: str
    key: str
    label: str
    parent_key: str | None
    in_scope: bool
    fact_id: str


class Api:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            request.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            raise RuntimeError(f"{method} {path} -> {exc.code}: {detail}") from exc

    def get(self, path: str) -> dict:
        return self._request("GET", path)

    def post(self, path: str, body: dict | None = None) -> dict:
        return self._request("POST", path, body)

    def patch(self, path: str, body: dict) -> dict:
        return self._request("PATCH", path, body)


def clean_url(raw: str) -> str:
    # Evidence text often ends a URL with punctuation, a backtick or a markdown artifact.
    raw = re.split(r"[`\s]", raw, maxsplit=1)[0]
    return raw.rstrip(".,;:)]}>\u201d")


def is_ip(value: str) -> bool:
    return IP_RE.fullmatch(value) is not None


def is_host(value: str) -> bool:
    return HOST_RE.match(value) is not None


def parse_assets(text: str, fact_id: str) -> list[Asset]:
    """Assets explicitly named by a fact. Scope is limited to the recorded corpus."""
    explicit: list[str] = []
    for line in text.splitlines():
        if line.lower().startswith("assets:"):
            explicit.extend(
                token for token in re.split(r"[\s,]+", line.split(":", 1)[1]) if token.strip()
            )

    assets: dict[tuple[str, str], Asset] = {}

    def add_host(host: str, *, scoped: bool) -> None:
        host = host.lower().strip(".")
        if not host or host in {"localhost"}:
            return
        if is_ip(host):
            # A URL can name a bare IP; store it as an IP, not a hostname.
            assets.setdefault(("ip", host), Asset("ip", host, host, None, scoped, fact_id))
            return
        if not is_host(host) or host in {"asset"}:
            return
        assets.setdefault(("host", host), Asset("host", host, host, None, scoped, fact_id))

    def add_url(raw: str) -> None:
        if any(char in raw for char in BAD_URL_CHARS):
            return
        url = clean_url(raw)
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return
        host = parsed.hostname
        if not host:
            return
        if not is_ip(host) and not is_host(host):
            return
        scoped = host.lower().endswith("sasakonnect.net")
        add_host(host, scoped=scoped)
        path = parsed.path or ""
        if path and path != "/":
            assets.setdefault(
                ("url", url),
                Asset("url", url, url, host.lower(), scoped, fact_id),
            )

    for token in explicit:
        if token.startswith("http://") or token.startswith("https://"):
            add_url(token)
        elif IP_RE.fullmatch(token):
            assets.setdefault(("ip", token), Asset("ip", token, token, None, True, fact_id))
        elif is_host(token) or IP_RE.fullmatch(token):
            add_host(token, scoped=token.lower().endswith("sasakonnect.net"))

    for match in URL_RE.finditer(text):
        host = urlparse(clean_url(match.group(0))).hostname or ""
        if host.lower().endswith("sasakonnect.net"):
            add_url(match.group(0))

    for match in SCOPE_HOST_RE.finditer(text):
        add_host(match.group(0), scoped=True)

    return list(assets.values())


def parse_finding(text: str) -> dict | None:
    match = FINDING_RE.match(text)
    if match is None:
        return None
    raw_title = match.group(2).strip().splitlines()[0]
    # Artex's first line often carries severity/CWE prose after the readable title.
    raw_title = re.split(r"\s+\((?:CWE|CVE|CVSS)", raw_title, maxsplit=1)[0]
    title = raw_title[:180].rsplit(" ", 1)[0] + ("…" if len(raw_title) > 180 else "")
    severity = (SEVERITY_RE.search(text).group(1).strip()[:40] if SEVERITY_RE.search(text) else "")
    klass = (CLASS_RE.search(text).group(1).strip()[:160] if CLASS_RE.search(text) else "")
    summary_match = SUMMARY_RE.search(text)
    summary = summary_match.group(1).strip()[:4000] if summary_match else ""
    return {
        "title": title,
        "severity": severity.lower(),
        "klass": klass,
        "summary": summary,
        "evidence": text[:20000],
        "status": "pending",
        "worker": "import",
        "fact_id": None,  # filled by the caller
        "metadata": {"import": "artex", "artex_finding": int(match.group(1))},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="Cairn project id")
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    api = Api(args.api)
    detail = api.get(f"/projects/{args.project}")
    facts = detail.get("facts") or []
    print(f"project {args.project}: {len(facts)} facts")

    existing_entities = {entity["key"]: entity for entity in api.get(f"/projects/{args.project}/entities?limit=5000")}
    existing_findings = {finding["fact_id"]: finding for finding in api.get(f"/projects/{args.project}/findings?limit=5000") if finding.get("fact_id")}

    fact_assets: dict[str, list[Asset]] = {}
    for fact in facts:
        assets = parse_assets(fact.get("description") or "", fact["id"])
        if assets:
            fact_assets[fact["id"]] = assets

    entity_ids: dict[str, str] = {}
    created_entities = 0
    for fact_id, assets in fact_assets.items():
        for asset in assets:
            key = asset.key
            entity = existing_entities.get(key)
            if entity is None:
                created_entities += 1
                if not args.dry_run:
                    payload = {
                        "kind": asset.kind,
                        "key": asset.key,
                        "label": asset.label,
                        "in_scope": asset.in_scope,
                        "source": "import",
                        "facts": [fact_id],
                        "metadata": {"import": "artex"},
                    }
                    if asset.parent_key and existing_entities.get(asset.parent_key):
                        payload["parent_id"] = existing_entities[asset.parent_key]["id"]
                    entity = api.post(f"/projects/{args.project}/entity", payload)
                    existing_entities[key] = entity
                else:
                    entity = {"id": f"dry:{key}"}
                    existing_entities[key] = entity
            entity_ids[key] = entity["id"]
            if not args.dry_run and asset.kind == "url" and asset.parent_key:
                parent = existing_entities.get(asset.parent_key)
                if parent and entity.get("parent_id") != parent["id"]:
                    api.patch(
                        f"/projects/{args.project}/entities/{entity['id']}",
                        {"parent_id": parent["id"]},
                    )
            if not args.dry_run and entity["id"]:
                try:
                    api.post(f"/projects/{args.project}/entities/{entity['id']}/facts?fact_id={fact_id}")
                except RuntimeError:
                    pass

    created_findings = 0
    for fact in facts:
        text = fact.get("description") or ""
        payload = parse_finding(text)
        if payload is None:
            continue
        payload["fact_id"] = fact["id"]
        payload["entities"] = [entity_ids[a.key] for a in fact_assets.get(fact["id"], []) if a.key in entity_ids]
        existing = existing_findings.get(fact["id"])
        if existing is not None:
            if not args.dry_run:
                api.patch(
                    f"/projects/{args.project}/findings/{existing['id']}",
                    {"title": payload["title"], "severity": payload["severity"], "klass": payload["klass"]},
                )
            continue
        created_findings += 1
        if not args.dry_run:
            try:
                api.post(f"/projects/{args.project}/findings", payload)
            except RuntimeError as exc:
                print(f"  finding for {fact['id']} failed: {exc}", file=sys.stderr)

    print(
        f"entities: {len(entity_ids)} total, {created_entities} new; "
        f"findings: {created_findings} new"
        + (" (dry run)" if args.dry_run else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
