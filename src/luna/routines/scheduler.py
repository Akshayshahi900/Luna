"""
RoutineScheduler — run routines when they are due, inside luna-web.

BEGINNER MAP
------------
luna-web starts one scheduler (server.py lifespan). Every TICK_SECONDS it
asks the store which enabled routines are due and runs them one after the
other (one at a time keeps API usage predictable):

  builtin → builtin.run_builtin   (calls one read-only MCP tool, no LLM)
  agent   → agent.run_agent_routine (runs the prompt on the current agent)

After each run it stores the result, schedules the next run, and calls
``notify`` with a {"type": "routine_result", ...} event, which luna-web
sends to every open tab so the HUD widgets update.

"Run now" in the Control Center calls run_now(), which uses the same path.
A routine that is still running is never started twice.

Routines only run while luna-web runs; a run missed while it was off is
NOT made up later: the next run is simply scheduled from now (D35).

Read next: luna/web/control.py
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Awaitable, Callable
from typing import Any

from luna.routines.builtin import run_builtin
from luna.routines.store import RoutineStore

TICK_SECONDS = 30.0

# routine → (status, summary, data)
Executor = Callable[[dict[str, Any]], Awaitable[tuple[str, str, Any]]]


def make_executor(
    get_tools: Callable[[], dict[str, Any]],
    run_agent: Callable[[dict[str, Any]], Awaitable[tuple[str, str, Any]]],
    store: RoutineStore,
) -> Executor:
    """The usual executor: built-ins call tools, agent routines run the agent."""

    async def execute(routine: dict[str, Any]) -> tuple[str, str, Any]:
        if routine["kind"] == "builtin":
            return await run_builtin(routine["builtin"], get_tools(), store.local_now())
        return await run_agent(routine)

    return execute


class RoutineScheduler:
    """Runs due routines in the background; see the module docstring."""

    def __init__(
        self,
        store: RoutineStore,
        execute: Executor,
        notify: Callable[[dict], None] | None = None,
        tick: float = TICK_SECONDS,
    ) -> None:
        self.store = store
        self.execute = execute
        self.notify = notify
        self.tick_seconds = tick
        self.running: set[int] = set()
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()  # one routine at a time

    @property
    def active(self) -> bool:
        """True while the background loop is running."""
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        """Start the background loop (idempotent)."""
        if not self.active:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        """Stop the loop; a run in progress is cancelled."""
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — keep the scheduler alive
                print(f"Warning: routine scheduler tick failed ({exc}).", file=sys.stderr)
            await asyncio.sleep(self.tick_seconds)

    async def tick(self) -> list[dict[str, Any]]:
        """Run every routine that is due now; returns their run records."""
        done = []
        for routine in self.store.due():
            if routine["id"] in self.running:
                continue
            # Schedule the next run first, so a slow or failing run isn't repeated.
            self.store.schedule_next(routine["id"])
            done.append(await self.run(routine))
        return done

    async def run_now(self, routine_id: int) -> dict[str, Any]:
        """Run one routine immediately (the "Run now" button)."""
        routine = self.store.get(routine_id)
        if routine_id in self.running:
            raise ValueError("That routine is already running.")
        return await self.run(routine)

    async def run(self, routine: dict[str, Any]) -> dict[str, Any]:
        """Run one routine, store the result and tell the browser tabs."""
        self.running.add(routine["id"])
        try:
            async with self._lock:
                run_id = self.store.start_run(routine["id"])
                try:
                    status, summary, data = await self.execute(routine)
                    error = summary if status == "error" else None
                except asyncio.CancelledError:
                    self.store.finish_run(run_id, "error", "Stopped.", None, "Stopped")
                    raise
                except Exception as exc:  # noqa: BLE001 — recorded on the run, shown in the UI
                    status, summary, data, error = "error", str(exc) or type(exc).__name__, None, str(exc)
                record = self.store.finish_run(run_id, status, summary, data, error)
        finally:
            self.running.discard(routine["id"])
        if self.notify is not None:
            self.notify({
                "type": "routine_result",
                "routine": {
                    "id": routine["id"],
                    "name": routine["name"],
                    "kind": routine["kind"],
                    "builtin": routine.get("builtin"),
                    "notify": routine.get("notify", True),
                },
                "run": record,
            })
        return record


__all__ = ["TICK_SECONDS", "RoutineScheduler", "make_executor"]
