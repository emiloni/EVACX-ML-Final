"""Semantic landmark generation from filtered detections.

Converts raw YOLO detections into meaningful building landmarks:
- Exit signs + nearby doors → EXIT landmark
- Doors/doorways → DOOR landmark
- Stairs → STAIRS landmark
- Elevator → ELEVATOR landmark
- Ramp → RAMP landmark
- Corridor → CORRIDOR landmark

Key rule: exit signs are *evidence* of an exit, not exits themselves.
Multiple exit signs near each other are clustered into one exit.
"""

from __future__ import annotations

import logging
import math
import uuid

logger = logging.getLogger(__name__)

# -------------------------------------------------------
# Clustering distance for exit signs (normalised coords)
# -------------------------------------------------------
EXIT_CLUSTER_RADIUS = 0.20  # 20% of image diagonal


def _center(bbox: list[int]) -> tuple[float, float]:
    x1, y1, x2, y2 = bbox
    return ((x1 + x2) / 2, (y1 + y2) / 2)


def _normalised_center(
    bbox: list[int], img_w: int, img_h: int
) -> tuple[float, float]:
    cx, cy = _center(bbox)
    return (cx / img_w if img_w else 0.5, cy / img_h if img_h else 0.5)


def _dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)


def _is_exit_class(dtype: str) -> bool:
    return dtype in {"exit sign", "exit door", "emergency exit"}


def _is_door_class(dtype: str) -> bool:
    return dtype in {
        "door", "doorway", "entrance",
        "room door", "office door", "wooden door", "glass door",
    }


def _is_vertical(dtype: str) -> bool:
    return dtype in {
        "stairs", "staircase", "stairway",
        "ramp", "wheelchair ramp", "elevator",
    }


# -------------------------------------------------------
# Landmark builder
# -------------------------------------------------------

def _make_landmark(
    dtype: str,
    bbox: list[int],
    confidence: float,
    img_w: int,
    img_h: int,
    landmark_type: str,
) -> dict:
    cx, cy = _normalised_center(bbox, img_w, img_h)
    return {
        "id": uuid.uuid4().hex[:10],
        "type": landmark_type,
        "detection_type": dtype,
        "confidence": round(confidence, 3),
        "center_x": round(cx, 4),
        "center_y": round(cy, 4),
        "bbox": bbox,
        "wheelchair_accessible": dtype not in {
            "stairs", "staircase", "stairway",
        },
    }


def generate_landmarks(
    detections: list[dict],
    img_width: int,
    img_height: int,
) -> list[dict]:
    """Convert filtered detections to semantic landmarks.

    Steps:
    1. Cluster exit signs into exit landmarks.
    2. Pair exits with nearby doors if possible.
    3. Convert remaining doors → DOOR landmarks.
    4. Convert stairs/ramps/elevators → appropriate landmarks.
    5. Convert corridors → CORRIDOR landmarks.
    """
    landmarks: list[dict] = []

    # --- Step 1: Collect exit signs and cluster ---
    exit_signs = [d for d in detections if _is_exit_class(d["type"])]
    other_detections = [d for d in detections if not _is_exit_class(d["type"])]

    # Cluster nearby exit signs
    clusters: list[list[dict]] = []
    used_exit: set[int] = set()

    for i, es in enumerate(exit_signs):
        if i in used_exit:
            continue
        nc_i = _normalised_center(es["bbox"], img_width, img_height)
        cluster = [es]
        used_exit.add(i)
        for j, es2 in enumerate(exit_signs):
            if j in used_exit:
                continue
            nc_j = _normalised_center(es2["bbox"], img_width, img_height)
            if _dist(nc_i, nc_j) < EXIT_CLUSTER_RADIUS:
                cluster.append(es2)
                used_exit.add(j)
        clusters.append(cluster)

    # --- Step 2: Create exit landmarks from clusters ---
    exit_landmarks: list[dict] = []
    for cluster in clusters:
        # Average centre of the cluster
        avg_cx = sum(
            _center(d["bbox"])[0] for d in cluster
        ) / len(cluster)
        avg_cy = sum(
            _center(d["bbox"])[1] for d in cluster
        ) / len(cluster)
        best_conf = max(d["confidence"] for d in cluster)
        best_bbox = max(cluster, key=lambda d: d["confidence"])["bbox"]

        lm = _make_landmark(
            "exit",
            best_bbox,
            best_conf,
            img_width,
            img_height,
            "exit",
        )
        # Override centre to cluster average
        lm["center_x"] = round(
            avg_cx / img_width if img_width else 0.5, 4
        )
        lm["center_y"] = round(
            avg_cy / img_height if img_height else 0.5, 4
        )
        exit_landmarks.append(lm)

    landmarks.extend(exit_landmarks)

    # --- Step 3: Find doors near exit landmarks ---
    # If a door is very close to an exit landmark, mark it
    # as part of that exit (don't create a separate DOOR).
    exit_door_ids: set[str] = set()
    for el in exit_landmarks:
        for d in other_detections:
            if not _is_door_class(d["type"]):
                continue
            nc = _normalised_center(d["bbox"], img_width, img_height)
            el_nc = (el["center_x"], el["center_y"])
            if _dist(nc, el_nc) < 0.15:
                exit_door_ids.add(d["id"] if "id" in d else d["type"])

    # --- Step 4: Remaining detections → landmarks ---
    for d in other_detections:
        dtype = d["type"]

        if _is_door_class(dtype):
            # Skip doors already associated with exits
            door_key = d.get("id", d.get("bbox"))
            # Simple proximity dedup: skip if very close to an exit
            skip = False
            for el in exit_landmarks:
                nc = _normalised_center(d["bbox"], img_width, img_height)
                el_nc = (el["center_x"], el["center_y"])
                if _dist(nc, el_nc) < 0.12:
                    skip = True
                    break
            if skip:
                continue
            landmarks.append(
                _make_landmark(
                    dtype, d["bbox"], d["confidence"],
                    img_width, img_height, "door",
                )
            )

        elif _is_vertical(dtype):
            vtype = "stairs" if "elev" not in dtype else "elevator"
            if "ramp" in dtype:
                vtype = "ramp"
            landmarks.append(
                _make_landmark(
                    dtype, d["bbox"], d["confidence"],
                    img_width, img_height, vtype,
                )
            )

        elif dtype in {"corridor", "hallway"}:
            landmarks.append(
                _make_landmark(
                    dtype, d["bbox"], d["confidence"],
                    img_width, img_height, "corridor",
                )
            )

    # --- Step 5: Scene-aware gap filling ---
    # If we have exits but no doors, infer doors near exits
    # (exits always have doors). If we have a corridor detection
    # but no side elements, add inferred positions.
    has_exit = any(lm["type"] == "exit" for lm in landmarks)
    has_door = any(lm["type"] == "door" for lm in landmarks)
    has_stairs = any(lm["type"] == "stairs" for lm in landmarks)
    has_corridor = any(lm["type"] == "corridor" for lm in landmarks)

    # If exits exist but no doors detected, add doors near exits
    if has_exit and not has_door:
        for el in exit_landmarks:
            door_lm = {
                "id": f"inferred_door_{el['id']}",
                "type": "door",
                "detection_type": "inferred",
                "confidence": 0.20,
                "center_x": el["center_x"],
                "center_y": min(el["center_y"] + 0.05, 0.95),
                "bbox": [0, 0, 0, 0],
                "wheelchair_accessible": True,
            }
            landmarks.append(door_lm)

    # If corridor detected but no doors at all, infer doors
    # on the left wall (typical hallway has doors on left)
    if has_corridor and not has_door and not has_exit:
        for x_frac in [0.15, 0.35, 0.55]:
            landmarks.append({
                "id": f"inferred_door_{x_frac}",
                "type": "door",
                "detection_type": "inferred",
                "confidence": 0.15,
                "center_x": x_frac,
                "center_y": 0.30,
                "bbox": [0, 0, 0, 0],
                "wheelchair_accessible": True,
            })

    logger.info(
        "[AI] Landmarks: %d exit(s), %d total from %d detections",
        len(exit_landmarks),
        len(landmarks),
        len(detections),
    )

    return landmarks
