"""2D floor plan generator from reconstructed geometry.

Converts reconstructed geometry + fused landmarks into
a renderable floor plan with walls, rooms, doors, exits,
stairs, elevators, and ramps.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

import numpy as np

from app.reconstruction.geometry_reconstruction import ReconstructedGeometry
from app.reconstruction.landmark_fusion import FusedLandmark

logger = logging.getLogger(__name__)

# Floor plan coordinate space
FP_WIDTH = 1000
FP_HEIGHT = 600

# Default dimensions
DEFAULT_CORRIDOR_H = 100
DEFAULT_ROOM_W = 160
DEFAULT_ROOM_H = 130
DEFAULT_DOOR_W = 50
DEFAULT_DOOR_H = 10
DEFAULT_EXIT_SIZE = 55
DEFAULT_VERTICAL_SIZE = 100


@dataclass
class FloorPlanElement:
    """A single element in the floor plan."""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    type: str = ""
    x: float = 0
    y: float = 0
    width: float = 0
    height: float = 0
    confidence: float = 0.5
    wheelchair_accessible: bool = True
    estimated: bool = False
    connected_door_id: str = ""
    label: str = ""

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "type": self.type,
            "x": round(self.x),
            "y": round(self.y),
            "width": round(self.width),
            "height": round(self.height),
            "confidence": round(self.confidence, 3),
            "wheelchair_accessible": self.wheelchair_accessible,
        }
        if self.estimated:
            d["estimated"] = True
        if self.connected_door_id:
            d["connected_door_id"] = self.connected_door_id
        if self.label:
            d["label"] = self.label
        return d


@dataclass
class GeneratedFloorPlan:
    """Complete generated floor plan."""
    width: int = FP_WIDTH
    height: int = FP_HEIGHT
    units: str = "relative"
    approximate: bool = True
    confidence: float = 0.5
    elements: list[FloorPlanElement] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "width": self.width,
            "height": self.height,
            "units": self.units,
            "approximate": self.approximate,
            "confidence": round(self.confidence, 3),
            "elements": [e.to_dict() for e in self.elements],
        }


def _fp_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(v, hi))


def generate_floor_plan(
    geometry: ReconstructedGeometry,
    landmarks: list[FusedLandmark],
) -> GeneratedFloorPlan:
    """Generate a 2D floor plan from reconstructed geometry + landmarks.

    Priority:
    1. Use reconstructed corridor geometry
    2. Place landmarks (doors, exits, stairs) on corridor borders
    3. Generate rooms behind doors
    4. Validate and adjust
    """
    fp = GeneratedFloorPlan()
    fp.confidence = geometry.confidence

    # --- 1. Place corridor(s) ---
    if geometry.corridors:
        for corr in geometry.corridors:
            fp.elements.append(FloorPlanElement(
                id=corr.id,
                type="corridor",
                x=corr.x,
                y=corr.y,
                width=corr.width,
                height=corr.height,
                confidence=corr.confidence,
                wheelchair_accessible=True,
            ))
    else:
        # Default corridor
        fp.elements.append(FloorPlanElement(
            id=_fp_id("corridor"),
            type="corridor",
            x=50, y=250,
            width=900, height=DEFAULT_CORRIDOR_H,
            confidence=0.3,
            wheelchair_accessible=True,
        ))

    # Get corridor bounds
    corr_el = next(
        (e for e in fp.elements if e.type == "corridor"),
        fp.elements[0] if fp.elements else None,
    )
    if corr_el is None:
        return fp

    corr_x = corr_el.x
    corr_y = corr_el.y
    corr_w = corr_el.width
    corr_h = corr_el.height
    corr_mid_y = corr_y + corr_h / 2

    # --- 2. Place landmarks ---
    doors = [lm for lm in landmarks if lm.type in {
        "door", "doorway", "entrance", "room door",
        "office door", "wooden door", "glass door",
    }]
    exits = [lm for lm in landmarks if lm.type in {
        "exit sign", "exit door", "emergency exit", "fire exit sign",
    }]
    stairs = [lm for lm in landmarks if lm.type in {
        "stairs", "staircase", "stairway",
    }]
    elevators = [lm for lm in landmarks if lm.type in {
        "elevator", "lift",
    }]
    ramps = [lm for lm in landmarks if lm.type in {
        "ramp", "wheelchair ramp",
    }]

    # Sort doors by x position
    doors_sorted = sorted(doors, key=lambda d: d.avg_center_x)
    used_x: list[float] = []

    # Place doors + rooms
    for i, door in enumerate(doors_sorted):
        side = "above" if i % 2 == 0 else "below"
        door_x = corr_x + door.avg_center_x * corr_w - DEFAULT_DOOR_W / 2

        # Avoid overlap
        for ux in used_x:
            if abs(door_x - ux) < DEFAULT_DOOR_W + 20:
                door_x = ux + DEFAULT_DOOR_W + 25
        used_x.append(door_x)
        door_x = _clamp(door_x, corr_x + 10, corr_x + corr_w - DEFAULT_DOOR_W - 10)

        # Door on corridor wall
        door_y = corr_y - DEFAULT_DOOR_H if side == "above" else corr_y + corr_h
        door_id = _fp_id("door")

        fp.elements.append(FloorPlanElement(
            id=door_id, type="door",
            x=door_x, y=door_y,
            width=DEFAULT_DOOR_W, height=DEFAULT_DOOR_H,
            confidence=door.confidence,
            wheelchair_accessible=True,
        ))

        # Room behind door
        room_y = door_y - 8 - DEFAULT_ROOM_H if side == "above" else door_y + DEFAULT_DOOR_H + 8
        fp.elements.append(FloorPlanElement(
            id=_fp_id("room"), type="room",
            x=door_x - (DEFAULT_ROOM_W - DEFAULT_DOOR_W) // 2,
            y=room_y,
            width=DEFAULT_ROOM_W, height=DEFAULT_ROOM_H,
            confidence=door.confidence * 0.7,
            estimated=True,
            connected_door_id=door_id,
        ))

    # Place exits
    for ex in exits:
        cx = ex.avg_center_x
        cy = ex.avg_center_y
        if cx > 0.6:
            ex_x = corr_x + corr_w + 5
            ex_y = corr_mid_y - DEFAULT_EXIT_SIZE / 2
        elif cy < 0.5:
            ex_x = corr_x + cx * corr_w - DEFAULT_EXIT_SIZE / 2
            ex_y = corr_y - DEFAULT_EXIT_SIZE - 8
        else:
            ex_x = corr_x + cx * corr_w - DEFAULT_EXIT_SIZE / 2
            ex_y = corr_y + corr_h + 8

        ex_x = _clamp(ex_x, 10, corr_x + corr_w + 30)
        fp.elements.append(FloorPlanElement(
            id=_fp_id("exit"), type="exit",
            x=ex_x, y=ex_y,
            width=DEFAULT_EXIT_SIZE, height=DEFAULT_EXIT_SIZE,
            confidence=ex.confidence,
            wheelchair_accessible=True,
        ))

    # Default exit if none detected
    has_exit = any(e.type == "exit" for e in fp.elements)
    if not has_exit:
        fp.elements.append(FloorPlanElement(
            id=_fp_id("exit"), type="exit",
            x=corr_x + corr_w + 5,
            y=corr_mid_y - DEFAULT_EXIT_SIZE / 2,
            width=DEFAULT_EXIT_SIZE, height=DEFAULT_EXIT_SIZE,
            confidence=0.15,
            wheelchair_accessible=True,
        ))

    # Place stairs / elevators / ramps
    for v in stairs + elevators + ramps:
        vx = corr_x + v.avg_center_x * corr_w - DEFAULT_VERTICAL_SIZE / 2
        vy = corr_y - DEFAULT_VERTICAL_SIZE - 15 if v.avg_center_y < 0.5 else corr_y + corr_h + 15
        vx = _clamp(vx, corr_x, corr_x + corr_w - DEFAULT_VERTICAL_SIZE)

        fp.elements.append(FloorPlanElement(
            id=_fp_id(v.type), type=v.type,
            x=vx, y=vy,
            width=DEFAULT_VERTICAL_SIZE, height=DEFAULT_VERTICAL_SIZE,
            confidence=v.confidence,
            wheelchair_accessible=v.wheelchair_accessible,
        ))

    # Ensure minimum viable plan
    if len(fp.elements) <= 1:
        for i, xf in enumerate([0.2, 0.5, 0.8]):
            side = "above" if i % 2 == 0 else "below"
            dx = corr_x + xf * corr_w - DEFAULT_DOOR_W / 2
            dy = corr_y - DEFAULT_DOOR_H if side == "above" else corr_y + corr_h
            did = _fp_id("door")
            fp.elements.append(FloorPlanElement(
                id=did, type="door",
                x=dx, y=dy,
                width=DEFAULT_DOOR_W, height=DEFAULT_DOOR_H,
                confidence=0.15, wheelchair_accessible=True,
            ))
            ry = dy - 8 - DEFAULT_ROOM_H if side == "above" else dy + DEFAULT_DOOR_H + 8
            fp.elements.append(FloorPlanElement(
                id=_fp_id("room"), type="room",
                x=dx - (DEFAULT_ROOM_W - DEFAULT_DOOR_W) // 2, y=ry,
                width=DEFAULT_ROOM_W, height=DEFAULT_ROOM_H,
                confidence=0.1, estimated=True, connected_door_id=did,
            ))

    logger.info(
        "[FLOOR PLAN] %d elements generated, confidence=%.2f",
        len(fp.elements), fp.confidence,
    )

    return fp
