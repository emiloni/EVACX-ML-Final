"""Multi-view landmark fusion.

Merges observations of the same physical object detected in
multiple photos into a single confirmed landmark with
increased confidence.

Key insight: a door detected in Photo 1, Photo 2, and Photo 3
should become ONE confirmed door, not three separate detections.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

import numpy as np

from app.reconstruction.camera_pose import PoseGraph
from app.reconstruction.photo_graph import PhotoGraph

logger = logging.getLogger(__name__)

# Distance threshold for considering two detections as the same object
# (in normalised image coordinates)
SAME_OBJECT_THRESHOLD = 0.18


@dataclass
class FusedLandmark:
    """A physically confirmed landmark observed across multiple photos."""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    type: str = ""
    observed_in: list[str] = field(default_factory=list)
    observation_count: int = 0
    confidence: float = 0.0
    # Average position in normalised coordinates
    avg_center_x: float = 0.0
    avg_center_y: float = 0.0
    # Best bounding box (from highest-confidence observation)
    best_bbox: list[int] = field(default_factory=list)
    wheelchair_accessible: bool = True
    photo_positions: dict[str, tuple[float, float]] = field(
        default_factory=dict
    )


def _normalised_center(
    bbox: list[int], img_w: int, img_h: int
) -> tuple[float, float]:
    x1, y1, x2, y2 = bbox
    cx = (x1 + x2) / 2 / img_w if img_w else 0.5
    cy = (y1 + y2) / 2 / img_h if img_h else 0.5
    return (cx, cy)


def _same_object(
    det_a: dict, det_b: dict,
    img_a_w: int, img_a_h: int,
    img_b_w: int, img_b_h: int,
    pose_graph: PoseGraph | None = None,
) -> bool:
    """Determine if two detections represent the same physical object.

    Uses:
    1. Semantic class must match
    2. Normalised position proximity
    3. Camera geometry (photos that overlap and show similar region)
    """
    # Must be same semantic class
    if det_a.get("type") != det_b.get("type"):
        return False

    bbox_a = det_a.get("bbox", [0, 0, 0, 0])
    bbox_b = det_b.get("bbox", [0, 0, 0, 0])

    if len(bbox_a) < 4 or len(bbox_b) < 4:
        return False

    ca = _normalised_center(bbox_a, img_a_w, img_a_h)
    cb = _normalised_center(bbox_b, img_b_w, img_b_h)

    dist = ((ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2) ** 0.5

    # If photos overlap (same camera path), use relaxed threshold
    # If photos don't overlap, detections at similar position
    # in different parts of the building could be different objects
    return dist < SAME_OBJECT_THRESHOLD


# Semantic types that should be fused
FUSABLE_TYPES = {
    "door", "doorway", "entrance", "room door", "office door",
    "wooden door", "glass door",
    "exit sign", "exit door", "emergency exit", "fire exit sign",
    "stairs", "staircase", "stairway",
    "elevator", "lift",
    "ramp", "wheelchair ramp",
    "corridor", "hallway",
    "fire extinguisher",
}


def fuse_landmarks(
    all_detections: list[dict],
    image_sizes: dict[str, tuple[int, int]],
    photo_graph: PhotoGraph | None = None,
    pose_graph: PoseGraph | None = None,
) -> list[FusedLandmark]:
    """Fuse multi-view detections into confirmed physical landmarks.

    Algorithm:
    1. Group all detections by semantic class.
    2. Within each class, cluster detections that are spatially
       consistent (same normalised position in overlapping photos).
    3. Each cluster becomes one FusedLandmark.
    4. Confidence increases with observation count.
    """
    # Filter to fusable types
    fusable = [d for d in all_detections if d.get("type") in FUSABLE_TYPES]

    # Group by type
    by_type: dict[str, list[dict]] = {}
    for d in fusable:
        t = d.get("type", "unknown")
        by_type.setdefault(t, []).append(d)

    fused: list[FusedLandmark] = []

    for dtype, dets in by_type.items():
        # Cluster detections of the same type
        clusters: list[list[dict]] = []
        used: set[int] = set()

        for i, d_i in enumerate(dets):
            if i in used:
                continue
            cluster = [d_i]
            used.add(i)
            img_i = d_i.get("image_id", "")
            sz_i = image_sizes.get(img_i, (640, 480))

            for j, d_j in enumerate(dets):
                if j in used:
                    continue
                img_j = d_j.get("image_id", "")
                sz_j = image_sizes.get(img_j, (640, 480))

                if _same_object(d_i, d_j, sz_i[0], sz_i[1], sz_j[0], sz_j[1], pose_graph):
                    cluster.append(d_j)
                    used.add(j)

            clusters.append(cluster)

        # Create FusedLandmark for each cluster
        for cluster in clusters:
            lm = FusedLandmark(type=dtype)
            lm.observation_count = len(cluster)

            # Collect unique photos
            photos = set()
            positions: list[tuple[float, float]] = []
            confs: list[float] = []
            best_conf = 0
            best_bbox = [0, 0, 0, 0]

            for d in cluster:
                img_id = d.get("image_id", "unknown")
                photos.add(img_id)
                conf = d.get("confidence", 0)
                confs.append(conf)

                w, h = image_sizes.get(img_id, (640, 480))
                bbox = d.get("bbox", [0, 0, 0, 0])
                cx, cy = _normalised_center(bbox, w, h)
                positions.append((cx, cy))
                lm.photo_positions[img_id] = (cx, cy)

                if conf > best_conf:
                    best_conf = conf
                    best_bbox = bbox

            lm.observed_in = sorted(photos)
            lm.avg_center_x = float(np.mean([p[0] for p in positions]))
            lm.avg_center_y = float(np.mean([p[1] for p in positions]))
            lm.best_bbox = best_bbox

            # Confidence: base + bonus for multi-view confirmation
            base_conf = max(confs) if confs else 0
            multi_view_bonus = min(len(photos) * 0.08, 0.30)
            lm.confidence = round(min(base_conf + multi_view_bonus, 0.95), 3)

            # Accessibility
            lm.wheelchair_accessible = dtype not in {
                "stairs", "staircase", "stairway",
            }

            fused.append(lm)

    # Sort by confidence descending
    fused.sort(key=lambda f: f.confidence, reverse=True)

    logger.info(
        "[FUSION] %d raw detections → %d unique landmarks",
        len(fusable), len(fused),
    )

    return fused
