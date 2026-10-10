"""Cooperative progress reporting and cancellation for one recognition run.

The pipeline calls :func:`stage` at coarse boundaries and :func:`advance` inside
long loops. Without an active reporter (CLI, tests) every call is a no-op. The
reporter belongs to the calling thread, so worker threads/processes never see it;
only the orchestrating thread reports and may be cancelled.
"""
from __future__ import annotations

from contextlib import contextmanager
import threading


class Cancelled(Exception):
    """Raised at a checkpoint after the user cancelled the run."""


_local = threading.local()


@contextmanager
def reporting(callback):
    """Route checkpoints of this thread to ``callback(stage, fraction)``.

    ``callback`` raises :class:`Cancelled` to stop the run.
    """
    previous = getattr(_local, "state", None)
    _local.state = {"callback": callback, "stage": "", "low": 0., "high": 0.}
    try:
        yield
    finally:
        _local.state = previous


def stage(name, low, high):
    """Enter a named stage covering overall progress ``low``..``high``."""
    state = getattr(_local, "state", None)
    if state is None:
        return
    state.update(stage=name, low=float(low), high=float(high))
    state["callback"](name, float(low))


def advance(fraction):
    """Report progress ``fraction`` (0..1) within the current stage."""
    state = getattr(_local, "state", None)
    if state is None:
        return
    fraction = min(1., max(0., float(fraction)))
    state["callback"](state["stage"], state["low"] + (state["high"] - state["low"]) * fraction)


def check():
    """Cancellation checkpoint without changing the reported fraction."""
    state = getattr(_local, "state", None)
    if state is not None:
        state["callback"](state["stage"], None)
