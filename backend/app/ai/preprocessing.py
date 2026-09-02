"""Detection preprocessing: confidence filtering + NMS.

Pipeline stage after raw YOLO detection and before landmark generation.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# -------------------------------------------------------
# Configurable confidence thresholds per class
# -------------------------------------------------------

DEFAULT_CONFIDENCE_THRESHOLDS: dict[str, float] = {
    "door": 0.08,
    "doorway": 0.08,
    "room door": 0.08,
    "office door": 0.08,
    "wooden door": 0.08,
    "glass door": 0.08,
    "entrance": 0.08,
    "exit door": 0.20,
    "exit sign": 0.20,
    "emergency exit": 0.20,
    "stairs": 0.15,
    "staircase": 0.15,
    "stairway": 0.15,
    "ramp": 0.15,
    "wheelchair ramp": 0.15,
    "elevator": 0.15,
    "corridor": 0.15,
    "hallway": 0.15,
    "person": 0.15,
    # Hazard classes — keep low so they are not missed
    "fire": 0.05,
    "flames": 0.05,
    "smoke": 0.05,
    "obstacle": 0.08,
    "blocked passage": 0.08,
}

# Default fallback if a class is not in the dict
DEFAULT_THRESHOLD = 0.12

# Absolute minimum — nothing below this passes regardless of class
HARD_CONFIDENCE_FLOOR = 0.10


# -------------------------------------------------------
# IoU computation
# -------------------------------------------------------

def _iou(a: list[int], b: list[int]) -> float:
    """Intersection-over-Union of two [x1, y1, x2, y2] boxes."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b

    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter

    return inter / union if union > 0 else 0.0


# -------------------------------------------------------
# Public API
# -------------------------------------------------------

def filter_by_confidence(
    detections: list[dict],
    thresholds: dict[str, float] | None = None,
) -> list[dict]:
    """Remove detections below per-class confidence thresholds.

    Parameters
    ----------
    detections : raw YOLO output list of dicts with 'type' and 'confidence'.
    thresholds : optional override; falls back to DEFAULT_CONFIDENCE_THRESHOLDS.

    Returns
    -------
    List of detections that pass the threshold.
    """
    th = thresholds or DEFAULT_CONFIDENCE_THRESHOLDS
    filtered = []
    for d in detections:
        cls = d.get("type", "")
        conf = d.get("confidence", 0)
        # Hard floor: nothing below this passes
        if conf < HARD_CONFIDENCE_FLOOR:
            continue
        limit = th.get(cls, DEFAULT_THRESHOLD)
        if conf >= limit:
            filtered.append(d)
    logger.info(
        "[AI] Confidence filter: %d → %d detections",
        len(detections),
        len(filtered),
    )
    return filtered


def nms_by_class(
    detections: list[dict],
    iou_threshold: float = 0.45,
) -> list[dict]:
    """Non-maximum suppression grouped by detection class.

    For each class, sort by confidence descending and suppress
    any detection whose IoU with a higher-confidence detection
    of the same class exceeds *iou_threshold*.
    """
    if not detections:
        return []

    # Group by class
    by_class: dict[str, list[dict]] = {}
    for d in detections:
        cls = d.get("type", "unknown")
        by_class.setdefault(cls, []).append(d)

    kept: list[dict] = []

    for cls, group in by_class.items():
        # Sort by confidence descending
        sorted_group = sorted(
            group, key=lambda g: g.get("confidence", 0), reverse=True
        )
        suppressed: list[bool] = [False] * len(sorted_group)

        for i in range(len(sorted_group)):
            if suppressed[i]:
                continue
            kept.append(sorted_group[i])
            for j in range(i + 1, len(sorted_group)):
                if suppressed[j]:
                    continue
                if _iou(
                    sorted_group[i].get("bbox", [0, 0, 0, 0]),
                    sorted_group[j].get("bbox", [0, 0, 0, 0]),
                ) >= iou_threshold:
                    suppressed[j] = True

    logger.info(
        "[AI] NMS: %d → %d detections",
        len(detections),
        len(kept),
    )
    return kept


def merge_detections(
    yolo_detections: list[dict],
    cv_detections: list[dict],
    iou_threshold: float = 0.35,
) -> list[dict]:
    """Merge YOLO and OpenCV detections.

    Rules:
    1. If both detect the same object (IoU > threshold and same class)
       → keep the higher-confidence one, boost confidence by 0.1
    2. Otherwise keep all detections from both sources.
    """
    merged: list[dict] = []
    used_cv: set[int] = set()

    for yd in yolo_detections:
        best_match_idx = -1
        best_iou = 0.0

        for ci, cd in enumerate(cv_detections):
            if ci in used_cv:
                continue
            if yd.get("type") != cd.get("type"):
                continue
            iou_val = _iou(
                yd.get("bbox", [0, 0, 0, 0]),
                cd.get("bbox", [0, 0, 0, 0]),
            )
            if iou_val > best_iou and iou_val >= iou_threshold:
                best_iou = iou_val
                best_match_idx = ci

        if best_match_idx >= 0:
            # Both detected same object → boost confidence
            used_cv.add(best_match_idx)
            boosted = dict(yd)
            boosted["confidence"] = round(
                min(yd["confidence"] + 0.1, 0.95), 3
            )
            boosted["source"] = "yolo+opencv"
            merged.append(boosted)
        else:
            merged.append(dict(yd))

    # Add remaining OpenCV-only detections
    for ci, cd in enumerate(cv_detections):
        if ci not in used_cv:
            merged.append(dict(cd))

    logger.info(
        "[AI] Merge: %d YOLO + %d OpenCV → %d merged",
        len(yolo_detections),
        len(cv_detections),
        len(merged),
    )
    return merged


def preprocess_detections(
    detections: list[dict],
    thresholds: dict[str, float] | None = None,
    iou_threshold: float = 0.45,
) -> list[dict]:
    """Full preprocessing: confidence filter → NMS."""
    step1 = filter_by_confidence(detections, thresholds)
    step2 = nms_by_class(step1, iou_threshold)
    return step2
