from __future__ import annotations

import random

from cairn.dispatcher.config import WorkerConfig


def choose_worker(candidates: list[WorkerConfig], running_counts: dict[str, int]) -> list[WorkerConfig]:
    grouped = sorted(
        candidates,
        key=lambda worker: (
            worker.priority,
            running_counts.get(worker.name, 0),
            random.random(),
        ),
    )
    return grouped


def select_unclaimed_intent(intents: list):
    """Pick the next unclaimed intent: ``priority DESC, created_at ASC, id ASC``.

    v2 used ``max(key=(priority, created_at))``, which picked the *newest* intent among
    equal priorities and ignored the id, so ties were resolved by list order. This ordering
    is total and deterministic: highest priority first, oldest first, then id.
    """
    if not intents:
        raise ValueError("select_unclaimed_intent requires at least one intent")
    return sorted(
        intents,
        key=lambda intent: (-int(getattr(intent, "priority", 0) or 0), intent.created_at, intent.id),
    )[0]
