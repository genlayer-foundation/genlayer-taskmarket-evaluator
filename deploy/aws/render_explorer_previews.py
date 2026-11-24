"""Render the network-specific HTML served for shared explorer links."""
from html import escape
from pathlib import Path
import re
import sys


def render_explorers(template, output):
    output.mkdir(parents=True, exist_ok=True)
    for network, name, description in (
        ("tempo-mainnet", "Tempo mainnet", "Follow Internet Court’s rulings on jobs funded with real OUSD. Read the MC-Cash50 jury decision and verify the worker’s rejection fee and the buyer’s refund."),
        ("tempo-testnet", "Tempo testnet", "Follow testnet jobs from enrollment to a final ruling. Read what Internet Court’s AI jury decided and why."),
    ):
        title = name + " decisions | Internet Court × Taskmarket"
        page = re.sub(r"<title>[^<]*</title>", "<title>" + title + "</title>", template, count=1)
        fields = {
            "name=\"description\"": description,
            "property=\"og:title\"": title,
            "property=\"og:description\"": description,
            "property=\"og:url\"": "https://taskmarket.internetcourt.org/explorer?network=" + network,
        }
        for attribute, value in fields.items():
            pattern = '(<meta ' + attribute + ' content=")[^"]*(">)'
            page, count = re.subn(pattern, lambda m: m[1] + escape(value, quote=True) + m[2], page)
            if count != 1:
                raise ValueError("Expected one explorer meta tag with " + attribute)
        (output / (network + ".html")).write_text(page, encoding="utf-8")


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    render_explorers((root / "site/explorer.html").read_text(encoding="utf-8"), Path(sys.argv[1]))
