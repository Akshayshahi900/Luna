"""
Legacy entry shim.

Prefer one of these instead:
  - ``uv run luna``
  - ``python -m luna.cli.chat``

This file only exists so older paths that imported ``luna.core.main`` still work.
"""

from luna.cli.chat import main

if __name__ == "__main__":
    main()
