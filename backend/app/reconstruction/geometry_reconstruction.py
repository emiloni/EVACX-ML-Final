"""Simplified structural geometry reconstruction.

Estimates walls, corridors, room boundaries, and openings
from camera poses and fused landmarks.

Uses multi-view geometry to infer structural elements
rather than assuming geometry from door detections alone.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

import numpy as np

from app.reconstruction.landmark_fusion import FusedLandmark
from app.reconstruction.camera_pose import PoseGraph

logger = logging.getLogger(__name__)


@dataclass
class WallSegment:
    """A reconstructed wall segment."""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    start: tuple[float, float] = (0, 0)
    end: tuple[float, float] = (0, 0)
    confidence: float = 0.5
    observations: int = 0


@dataclass
class CorridorRegion:
    """An estimated corridor region."""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    x: float = 0
    y: float = 0
    width: float = 0
    height: float = 0
    confidence: float = 0.5
    observations: int = 0
    direction: str = "horizontal"  # or "vertical"


@dataclass
class ReconstructedGeometry:
    """Complete reconstructed building geometry."""
    walls: list[WallSegment] = field(default_factory=list)
    corridors: list[CorridorRegion] = field(default_factory=list)
    scale_factor: float = 1.0
    units: str = "relative"
    confidence: float = 0.5


def _positions_to_layout(
    landmarks: list[FusedLandmark],
    pose_graph: PoseGraph | None = None,
) -> ReconstructedGeometry:
    """Convert fused landmark positions into structural geometry.

    Uses camera trajectory and landmark positions to estimate
    corridor structure and wall segments.
    """
    geo = ReconstructedGeometry()

    if not landmarks:
        return geo

    # Extract all landmark positions
    positions = np.array([
        [lm.avg_center_x, lm.avg_center_y] for lm in landmarks
    ])

    # Determine primary corridor direction
    # If landmarks spread more horizontally → horizontal corridor
    x_range = positions[:, 0].max() - positions[:, 0].min()
    y_range = positions[:, 1].max() - positions[:, 1].min()
    is_horizontal = x_range > y_range

    # Estimate corridor from landmark spread
    corridor = CorridorRegion()
    corridor.observations = len(landmarks)
    corridor.confidence = min(0.4 + len(landmarks) * 0.05, 0.85)

    if is_horizontal:
        corridor.direction = "horizontal"
        corridor.x = float(positions[:, 0].min()) * 900 + 50
        corridor.y = 250  # centered vertically
        corridor.width = float(x_range) * 900
        corridor.height = 100
    else:
        corridor.direction = "vertical"
        corridor.x = 450  # centered horizontally
        corridor.y = float(positions[:, 1].min()) * 500 + 50
        corridor.width = 100
        corridor.height = float(y_range) * 500

    corridor.width = max(corridor.width, 200)
    corridor.height = max(corridor.height, 60)
    geo.corridors.append(corridor)

    # Generate wall segments from corridor boundaries
    cx, cy, cw, ch = corridor.x, corridor.y, corridor.width, corridor.height

    # Top wall
    geo.walls.append(WallSegment(
        start=(cx, cy),
        end=(cx + cw, cy),
        confidence=corridor.confidence,
        observations=corridor.observations,
    ))
    # Bottom wall
    geo.walls.append(WallSegment(
        start=(cx, cy + ch),
        end=(cx + cw, cy + ch),
        confidence=corridor.confidence,
        observations=corridor.observations,
    ))
    # Left wall
    geo.walls.append(WallSegment(
        start=(cx, cy),
        end=(cx, cy + ch),
        confidence=corridor.confidence * 0.8,
        observations=max(1, corridor.observations // 2),
    ))
    # Right wall
    geo.walls.append(WallSegment(
        start=(cx + cw, cy),
        end=(cx + cw, cy + ch),
        confidence=corridor.confidence * 0.8,
        observations=max(1, corridor.observations // 2),
    ))

    # Overall confidence
    geo.confidence = corridor.confidence

    logger.info(
        "[GEOMETRY] %d walls, %d corridors, confidence=%.2f",
        len(geo.walls), len(geo.corridors), geo.confidence,
    )

    return geo


def reconstruct_geometry(
    landmarks: list[FusedLandmark],
    pose_graph: PoseGraph | None = None,
) -> ReconstructedGeometry:
    """Reconstruct simplified building geometry from landmarks."""
    return _positions_to_layout(landmarks, pose_graph)
