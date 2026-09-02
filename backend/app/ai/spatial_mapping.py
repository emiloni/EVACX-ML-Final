"""Spatial mapping — converts raw detections into building landmarks.

This module:

1. Groups detections from multiple photos into spatial landmarks.
2. Infers corridor segments and junctions from photo sequences.
3. Infers connectivity from overlap + sequence order.
"""

from __future__ import annotations

import logging
from collections import defaultdict

from app.models.building_models import (
    BuildingEdge,
    BuildingNode,
    ConfidenceSource,
    LandmarkType,
    PhotoOverlap,
    SpatialLandmark,
)
from app.models.detection_models import EvacClass, PhotoAnalysis

logger = logging.getLogger(__name__)

# Evac classes that represent architectural elements (not people/fire)
ARCHITECTURAL_CLASSES = {
    EvacClass.DOOR,
    EvacClass.EXIT_DOOR,
    EvacClass.EMERGENCY_EXIT,
    EvacClass.EXIT_SIGN,
    EvacClass.STAIRS,
    EvacClass.ELEVATOR,
    EvacClass.RAMP,
    EvacClass.CORRIDOR,
}

# Which evac classes map to which landmark types
_EVAC_TO_LANDMARK: dict[EvacClass, LandmarkType] = {
    EvacClass.DOOR: LandmarkType.DOOR,
    EvacClass.EXIT_DOOR: LandmarkType.EXIT,
    EvacClass.EMERGENCY_EXIT: LandmarkType.EXIT,
    EvacClass.EXIT_SIGN: LandmarkType.EXIT,
    EvacClass.STAIRS: LandmarkType.STAIRS,
    EvacClass.ELEVATOR: LandmarkType.ELEVATOR,
    EvacClass.RAMP: LandmarkType.RAMP,
    EvacClass.CORRIDOR: LandmarkType.CORRIDOR,
    EvacClass.FIRE_EXTINGUISHER: LandmarkType.FIRE_EXTINGUISHER,
}

# Which landmark types are NOT wheelchair-accessible by default
_NOT_ACCESSIBLE = {LandmarkType.STAIRS}


def _make_landmark(
    det,
    photo_index: int,
    landmark_type: LandmarkType,
    confidence_source: ConfidenceSource,
) -> SpatialLandmark:
    return SpatialLandmark(
        type=landmark_type,
        photo_index=photo_index,
        relative_position=det.relative_position or "center",
        floor_transition=landmark_type == LandmarkType.STAIRS,
        wheelchair_accessible=landmark_type not in _NOT_ACCESSIBLE,
        confidence=det.confidence,
        confidence_source=confidence_source,
        raw_detection_id=det.id,
    )


def detections_to_landmarks(
    analyses: list[PhotoAnalysis],
) -> list[SpatialLandmark]:
    """Convert per-photo detections into a flat landmark list."""
    landmarks: list[SpatialLandmark] = []

    for analysis in analyses:
        for det in analysis.detections:
            if det.evac_class not in ARCHITECTURAL_CLASSES:
                continue
            lt = _EVAC_TO_LANDMARK.get(det.evac_class)
            if lt is None:
                continue
            landmarks.append(
                _make_landmark(
                    det, analysis.photo_index, lt, ConfidenceSource.DETECTED
                )
            )

    return landmarks


def infer_corridor_segments(
    analyses: list[PhotoAnalysis],
) -> list[SpatialLandmark]:
    """Infer corridor-segment landmarks from photos.

    Always generates a corridor segment for every photo so the
    pipeline always produces a navigable skeleton, even when
    YOLO detections are sparse or absent.
    """
    segments: list[SpatialLandmark] = []

    # Check if ANY photo had architectural detections
    total_architectural = sum(
        1
        for a in analyses
        if any(d.evac_class in ARCHITECTURAL_CLASSES for d in a.detections)
    )
    total_corridor_dets = sum(
        1
        for a in analyses
        if any(d.evac_class == EvacClass.CORRIDOR for d in a.detections)
    )

    for analysis in analyses:
        has_corridor = any(
            d.evac_class == EvacClass.CORRIDOR
            for d in analysis.detections
        )
        has_architectural = any(
            d.evac_class in ARCHITECTURAL_CLASSES
            for d in analysis.detections
        )

        # Always generate a corridor segment for every photo.
        # Photos with corridor detections get higher confidence.
        # Photos with no detections at all get low confidence
        # but still produce a node so the skeleton is complete.
        if has_corridor:
            conf = 0.7
        elif has_architectural:
            conf = 0.5
        elif total_corridor_dets > 0 or total_architectural > 0:
            conf = 0.35  # other photos had detections, this one probably shows corridor
        else:
            conf = 0.2   # pure sequence-based fallback

        segments.append(
            SpatialLandmark(
                type=LandmarkType.CORRIDOR,
                photo_index=analysis.photo_index,
                relative_position="center",
                confidence=conf,
                confidence_source=ConfidenceSource.INFERRED_FROM_SEQUENCE,
            )
        )

    return segments


def _is_floor_transition(landmark: SpatialLandmark) -> bool:
    return landmark.type in {LandmarkType.STAIRS, LandmarkType.RAMP, LandmarkType.ELEVATOR}


def infer_connectivity(
    landmarks: list[SpatialLandmark],
    overlaps: list[PhotoOverlap],
    analyses: list[PhotoAnalysis],
) -> list[BuildingEdge]:
    """Infer navigable connections between landmarks.

    Connection rules:

    1. Same photo → elements are connected (they were visible together).
    2. Overlapping photos → elements from photo A connect to photo B.
    3. Consecutive photos (even without overlap) → weak connection
       assumed between corridor segments.
    """
    edges: list[BuildingEdge] = []
    seen = set()

    # --- Rule 1: same-photo connections ---
    by_photo: dict[int, list[SpatialLandmark]] = defaultdict(list)
    for lm in landmarks:
        by_photo[lm.photo_index].append(lm)

    for photo_idx, group in by_photo.items():
        if len(group) < 2:
            continue
        # Connect corridor to everything else in the same photo
        corridors = [g for g in group if g.type == LandmarkType.CORRIDOR]
        others = [g for g in group if g.type != LandmarkType.CORRIDOR]

        if corridors:
            for c in corridors:
                for o in others:
                    key = tuple(sorted([c.id, o.id]))
                    if key not in seen:
                        seen.add(key)
                        edges.append(
                            BuildingEdge(
                                source=c.id,
                                target=o.id,
                                distance=1.0,
                                confidence=c.confidence * o.confidence,
                                stairs=_is_floor_transition(o),
                                wheelchair_accessible=o.wheelchair_accessible,
                            )
                        )
        elif len(group) <= 4:
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    key = tuple(sorted([group[i].id, group[j].id]))
                    if key not in seen:
                        seen.add(key)
                        edges.append(
                            BuildingEdge(
                                source=group[i].id,
                                target=group[j].id,
                                distance=1.0,
                                confidence=0.4,
                            )
                        )

    # --- Rule 2: overlapping photo connections ---
    overlap_set = {
        (o.photo_a, o.photo_b)
        for o in overlaps
        if o.relationship == "likely_connected"
    }

    for pa, pb in overlap_set:
        group_a = by_photo.get(pa, [])
        group_b = by_photo.get(pb, [])
        for a in group_a:
            for b in group_b:
                key = tuple(sorted([a.id, b.id]))
                if key not in seen:
                    seen.add(key)
                    edges.append(
                        BuildingEdge(
                            source=a.id,
                            target=b.id,
                            distance=1.5,
                            confidence=0.35,
                        )
                    )

    # --- Rule 3: consecutive photo corridor chaining ---
    sorted_photos = sorted(by_photo.keys())
    for i in range(len(sorted_photos) - 1):
        p_a = sorted_photos[i]
        p_b = sorted_photos[i + 1]
        corridors_a = [
            g for g in by_photo[p_a] if g.type == LandmarkType.CORRIDOR
        ]
        corridors_b = [
            g for g in by_photo[p_b] if g.type == LandmarkType.CORRIDOR
        ]
        for ca in corridors_a:
            for cb in corridors_b:
                key = tuple(sorted([ca.id, cb.id]))
                if key not in seen:
                    seen.add(key)
                    edges.append(
                        BuildingEdge(
                            source=ca.id,
                            target=cb.id,
                            distance=2.0,
                            confidence=0.3,
                        )
                    )

    return edges


def build_landmarks_and_edges(
    analyses: list[PhotoAnalysis],
    overlaps: list[PhotoOverlap],
) -> tuple[list[SpatialLandmark], list[BuildingEdge]]:
    """Full spatial mapping pipeline.

    Returns
    -------
    landmarks : list[SpatialLandmark]
    edges     : list[BuildingEdge]
    """
    # 1. Raw detections → landmarks
    landmarks = detections_to_landmarks(analyses)

    # 2. Infer corridor segments
    corridors = infer_corridor_segments(analyses)
    landmarks.extend(corridors)

    logger.info(
        "Spatial mapping: %d landmarks from %d photos",
        len(landmarks),
        len(analyses),
    )

    # 3. Infer connectivity
    edges = infer_connectivity(landmarks, overlaps, analyses)

    logger.info("Spatial mapping: %d inferred edges", len(edges))

    return landmarks, edges
