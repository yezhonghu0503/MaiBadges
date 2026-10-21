"""Explicit local MCP entry point. Importing does not create files or start work."""

from __future__ import annotations

import argparse
from pathlib import Path
import sqlite3
import sys
from typing import Optional, Sequence

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from backend.registry import Registry, RegistryError
    from backend.mcp_server import serve
else:
    from .registry import Registry, RegistryError
    from .mcp_server import serve


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="MaiBadges 工牌本地 MCP 服务；不启动或控制桌面应用。")
    parser.add_argument("--state-dir", type=Path, default=None)
    parser.add_argument("--seed-dir", type=Path, default=Path(__file__).resolve().parent.parent / "assets")
    args = parser.parse_args(argv)
    state_dir = args.state_dir if args.state_dir is not None else Path.home() / "Library" / "Application Support" / "MaiBadges"
    try:
        with Registry(state_dir, seed_dir=args.seed_dir) as registry:
            serve(sys.stdin, sys.stdout, registry)
    except (OSError, ValueError, sqlite3.Error, RegistryError):
        print("无法打开工牌本地资料，请检查状态目录。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
