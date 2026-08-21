from __future__ import annotations

import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = (
    "manifest.json",
    "bootstrap.js",
    "core.js",
    "figure-peek.js",
    "renderer-bridge.js",
)


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    plugin_id = manifest["applications"]["zotero"]["id"]
    if manifest["manifest_version"] != 2:
        raise SystemExit("manifest_version must be 2 for Zotero bootstrap add-ons")
    if not plugin_id:
        raise SystemExit("Zotero add-on id is missing")

    missing = [name for name in RUNTIME_FILES if not (ROOT / name).is_file()]
    if missing:
        raise SystemExit(f"Missing runtime files: {', '.join(missing)}")

    output_dir = ROOT / "dist"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / f"figure-peek-{version}.xpi"
    if output.exists():
        output.unlink()

    with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name in RUNTIME_FILES:
            info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, (ROOT / name).read_bytes())

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(output)
    print(f"SHA256 {digest}")


if __name__ == "__main__":
    main()
