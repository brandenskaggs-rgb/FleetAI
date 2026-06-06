"""
Phase 6: Active learning for Fleet AI.

The stacking meta-learner (Phase 4A) and conformal predictor (Phase 5) get
better as labeled outcomes accumulate.  The bottleneck is human labeling
bandwidth — fleet managers can only review so many alerts per day.

Active learning solves this by selecting the MOST INFORMATIVE predictions for
human review rather than a random sample.  "Most informative" = highest
uncertainty by the margin criterion:

  margin = |p - 0.5|

A margin close to 0 (p ≈ 0.5) means the model is maximally uncertain — this
prediction will teach the meta-learner the most if labeled.  A margin close to
0.5 (p ≈ 0 or p ≈ 1) means the model is confident — labeling this adds little.

In addition to margin-based selection we also track:
  • "oracle" candidates — predictions where Stage 2 and Stage 3 disagree
    (Stage 2 says CONFIRM but Stage 3 says CLEAR, or vice versa).  These
    disagreements reveal the most about where the models differ.
  • Staleness — predictions that have been in the queue too long without
    a label are deprioritized (they may no longer be actionable).

The review queue is an in-memory priority queue (heap) that surfaces candidates
to a dashboard endpoint.  Labeled outcomes route to stack.add_feedback().
"""
from __future__ import annotations

import heapq
import logging
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)

# Queue depth — at most this many vehicles wait for review
MAX_QUEUE_SIZE = 200

# Minimum margin uncertainty to enter the queue (below 0.5 = uncertain)
# A margin of 0.35 means the probability is between 0.15 and 0.85 — worth labeling
UNCERTAINTY_THRESHOLD = 0.35

# Staleness cutoff — candidates older than this are dropped (seconds)
STALENESS_SECONDS = 7 * 24 * 3600  # 7 days


class ReviewCandidate:
    """One prediction queued for human review."""

    __slots__ = (
        "vehicle_id", "org_id", "queued_at", "margin", "stage2_score",
        "stage3_verdict", "risk_probability", "prediction", "stack_features",
        "disagreement", "priority",
    )

    def __init__(
        self,
        vehicle_id: str,
        org_id: str,
        margin: float,
        stage2_score: float,
        stage3_verdict: str,
        risk_probability: float,
        prediction: str,
        stack_features: dict,
        disagreement: bool = False,
        queued_at: float | None = None,
    ) -> None:
        self.vehicle_id      = vehicle_id
        self.org_id          = org_id
        self.queued_at       = queued_at or time.time()
        self.margin          = margin
        self.stage2_score    = stage2_score
        self.stage3_verdict  = stage3_verdict
        self.risk_probability = risk_probability
        self.prediction      = prediction
        self.stack_features  = stack_features
        self.disagreement    = disagreement
        # Lower priority number = higher priority (min-heap)
        # Disagreement candidates get a -1 bonus to jump the queue
        self.priority        = round(margin - (0.10 if disagreement else 0.0), 6)

    # min-heap ordering: lowest margin (highest uncertainty) first
    def __lt__(self, other: "ReviewCandidate") -> bool:
        return self.priority < other.priority

    def to_dict(self) -> dict:
        return {
            "vehicleId":       self.vehicle_id,
            "orgId":           self.org_id,
            "queuedAt":        self.queued_at,
            "margin":          round(self.margin, 4),
            "stage2Score":     round(self.stage2_score, 4),
            "stage3Verdict":   self.stage3_verdict,
            "riskProbability": round(self.risk_probability, 4),
            "prediction":      self.prediction,
            "disagreement":    self.disagreement,
            "priority":        round(self.priority, 4),
        }


class ActiveLearningQueue:
    """
    In-memory priority queue of uncertain predictions pending human review.

    Thread-safe.  One entry per vehicle_id (new arrival replaces old if more
    uncertain).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._heap: list[ReviewCandidate] = []
        # vehicle_id → ReviewCandidate (fast lookup for dedup)
        self._index: dict[str, ReviewCandidate] = {}
        self._labeled_count = 0
        self._total_submitted = 0

    # ── Submit a prediction for possible queuing ──────────────────────────────

    def maybe_enqueue(
        self,
        vehicle_id: str,
        org_id: str,
        risk_probability: float,
        stage2_score: Optional[float],
        stage3_verdict: str,
        prediction: str,
        stack_features: dict,
    ) -> bool:
        """
        Evaluate the prediction and add to the review queue if uncertain.

        Returns True if the vehicle was added or updated in the queue.
        """
        s2 = stage2_score or 0.0
        margin = abs(s2 - 0.5)

        if margin >= UNCERTAINTY_THRESHOLD:
            return False  # model is confident enough — skip

        # Detect Stage 2 / Stage 3 disagreement
        s2_fire    = s2 >= 0.50
        s3_confirm = stage3_verdict == "CONFIRM"
        s3_clear   = stage3_verdict == "CLEAR"
        disagreement = (s2_fire and s3_clear) or (not s2_fire and s3_confirm)

        candidate = ReviewCandidate(
            vehicle_id=vehicle_id,
            org_id=org_id,
            margin=margin,
            stage2_score=s2,
            stage3_verdict=stage3_verdict,
            risk_probability=risk_probability,
            prediction=prediction,
            stack_features=stack_features,
            disagreement=disagreement,
        )

        with self._lock:
            self._total_submitted += 1
            existing = self._index.get(vehicle_id)
            if existing and existing.priority <= candidate.priority:
                return False  # existing entry is already more uncertain
            self._index[vehicle_id] = candidate
            heapq.heappush(self._heap, candidate)
            self._prune_stale()
            return True

    # ── Label a vehicle ───────────────────────────────────────────────────────

    def label(self, vehicle_id: str, outcome: str) -> Optional[dict]:
        """
        Mark a vehicle as labeled with an outcome string.
        Returns the stack features for feeding into stack.add_feedback(), or None.

        outcome: "confirmed_breakdown" | "false_positive" | "normal"
        """
        from .stack import stack_add_feedback

        with self._lock:
            candidate = self._index.pop(vehicle_id, None)
            if candidate is None:
                return None
            self._labeled_count += 1

        stack_add_feedback(candidate.stack_features, outcome)
        logger.info(
            "[active_learning] Labeled %s as '%s' (margin=%.3f)",
            vehicle_id, outcome, candidate.margin,
        )
        return candidate.to_dict()

    # ── Read the queue ────────────────────────────────────────────────────────

    def top_candidates(self, n: int = 20) -> list[dict]:
        """Return the n highest-priority (most uncertain) unlabeled candidates."""
        now = time.time()
        with self._lock:
            live = [
                c for c in self._index.values()
                if now - c.queued_at < STALENESS_SECONDS
            ]
        live.sort()  # sorts by priority (margin, lower = more uncertain)
        return [c.to_dict() for c in live[:n]]

    def queue_size(self) -> int:
        with self._lock:
            return len(self._index)

    def meta(self) -> dict:
        return {
            "queueSize":        self.queue_size(),
            "labeledCount":     self._labeled_count,
            "totalSubmitted":   self._total_submitted,
            "uncertaintyThreshold": UNCERTAINTY_THRESHOLD,
            "stalenessHours":   STALENESS_SECONDS // 3600,
        }

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _prune_stale(self) -> None:
        """Remove stale or superseded entries. Called under lock."""
        now = time.time()
        cutoff = now - STALENESS_SECONDS
        stale = [vid for vid, c in self._index.items() if c.queued_at < cutoff]
        for vid in stale:
            del self._index[vid]
        # Trim heap if oversized (lazy deletion — heap may have phantom entries)
        if len(self._heap) > MAX_QUEUE_SIZE * 3:
            live = [c for c in self._index.values()]
            heapq.heapify(live)
            self._heap = live


# ── Module-level singleton ────────────────────────────────────────────────────

_queue = ActiveLearningQueue()


def al_maybe_enqueue(
    vehicle_id: str,
    org_id: str,
    risk_probability: float,
    stage2_score: Optional[float],
    stage3_verdict: str,
    prediction: str,
    stack_features: dict,
) -> bool:
    return _queue.maybe_enqueue(
        vehicle_id, org_id, risk_probability,
        stage2_score, stage3_verdict, prediction, stack_features,
    )


def al_label(vehicle_id: str, outcome: str) -> Optional[dict]:
    return _queue.label(vehicle_id, outcome)


def al_top_candidates(n: int = 20) -> list[dict]:
    return _queue.top_candidates(n)


def get_al_meta() -> dict:
    return _queue.meta()
