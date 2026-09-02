"""Approximate floor plan generator.

Converts the navigation skeleton into 2-D floor plan coordinates
with rooms, corridors, doors, stairs, ramps, elevators, and exits.

Uses a deterministic layout algorithm:
1. Place main corridor as the primary axis (horizontal).
2. Attach doors to corridor boundaries.
3. Generate approximate rooms on the opposite side of doors.
4. Place stairs / ramps / elevators at detected locations.
5. Place exits at corridor endpoints.
6. Run simple collision resolution.
"""

from __future__ import annotations

import logging

from app.models.building_models import (
    BuildingNode,
    FloorPlan,
    FloorPlanElement,
    LandmarkType,
    NavigationGraph,
    RoomEstimate,
    ScaleMode,
)

logger = logging.getLogger(__name__)

# Default room dimensions in metres
DEFAULT_ROOM_WIDTH = 4.0
DEFAULT_ROOM_LENGTH = 5.0
DEFAULT_CORRIDOR_WIDTH = 2.0
DEFAULT_CORRIDOR_SEGMENT_LENGTH = 10.0


def _element_type_string(lt: LandmarkType) -> str:
    return lt.value


def generate_floor_plan(
    graph: NavigationGraph,
    scale_mode: ScaleMode = ScaleMode.RELATIVE,
) -> FloorPlan:
    """Generate a 2-D floor plan from the navigation skeleton."""
    elements: list[FloorPlanElement] = []
    rooms: list[RoomEstimate] = []

    # Classify nodes by type
    corridors = [n for n in graph.nodes if n.type == LandmarkType.CORRIDOR]
    doors = [n for n in graph.nodes if n.type == LandmarkType.DOOR]
    stairs = [n for n in graph.nodes if n.type == LandmarkType.STAIRS]
    ramps = [n for n in graph.nodes if n.type == LandmarkType.RAMP]
    elevators = [n for n in graph.nodes if n.type == LandmarkType.ELEVATOR]
    exits = [n for n in graph.nodes if n.type == LandmarkType.EXIT]
    entrances = [n for n in graph.nodes if n.type == LandmarkType.ENTRANCE]
    junctions = [n for n in graph.nodes if n.type == LandmarkType.JUNCTION]

    # -- Corridor segments --
    for i, c in enumerate(corridors):
        seg_len = DEFAULT_CORRIDOR_SEGMENT_LENGTH
        if i > 0:
            prev = corridors[i - 1]
            dx = c.x - prev.x
            seg_len = max(abs(dx), DEFAULT_CORRIDOR_SEGMENT_LENGTH)
        elements.append(
            FloorPlanElement(
                id=c.id,
                type="corridor",
                x=c.x - seg_len / 2,
                y=c.y - DEFAULT_CORRIDOR_WIDTH / 2,
                width=seg_len,
                height=DEFAULT_CORRIDOR_WIDTH,
                label=c.label or f"Corridor {i + 1}",
                wheelchair_accessible=True,
            )
        )

    # -- Doors + attached rooms --
    for d in doors:
        elements.append(
            FloorPlanElement(
                id=d.id,
                type="door",
                x=d.x,
                y=d.y,
                width=0.9,
                height=0.2,
                label=d.label or "Door",
                wheelchair_accessible=d.wheelchair_accessible,
            )
        )

        # Generate an approximate room behind each door
        room_id = f"room_{d.id}"
        room_side = -1.0 if d.y <= 0 else 1.0
        rx = d.x - DEFAULT_ROOM_WIDTH / 2
        ry = d.y + room_side * (0.2 + DEFAULT_ROOM_LENGTH / 2)

        rooms.append(
            RoomEstimate(
                id=room_id,
                door_id=d.id,
                width=DEFAULT_ROOM_WIDTH,
                length=DEFAULT_ROOM_LENGTH,
                area=DEFAULT_ROOM_WIDTH * DEFAULT_ROOM_LENGTH,
                x=rx,
                y=ry,
                estimated=True,
                confidence=d.confidence * 0.6,
                size_source="default_dimension",
            )
        )
        elements.append(
            FloorPlanElement(
                id=room_id,
                type="room",
                x=rx,
                y=ry - DEFAULT_ROOM_LENGTH / 2,
                width=DEFAULT_ROOM_WIDTH,
                height=DEFAULT_ROOM_LENGTH,
                label=f"Room ({d.label or d.id})",
            )
        )

    # -- Vertical transitions --
    for s in stairs:
        elements.append(
            FloorPlanElement(
                id=s.id,
                type="stairs",
                x=s.x - 0.6,
                y=s.y - 0.6,
                width=1.2,
                height=1.2,
                label=s.label or "Stairs",
                wheelchair_accessible=False,
            )
        )
    for r in ramps:
        elements.append(
            FloorPlanElement(
                id=r.id,
                type="ramp",
                x=r.x - 0.6,
                y=r.y - 0.6,
                width=1.2,
                height=1.2,
                label=r.label or "Ramp",
                wheelchair_accessible=True,
            )
        )
    for e in elevators:
        elements.append(
            FloorPlanElement(
                id=e.id,
                type="elevator",
                x=e.x - 0.55,
                y=e.y - 0.55,
                width=1.1,
                height=1.1,
                label=e.label or "Elevator",
                wheelchair_accessible=True,
            )
        )

    # -- Exits --
    for ex in exits:
        elements.append(
            FloorPlanElement(
                id=ex.id,
                type="exit",
                x=ex.x - 0.5,
                y=ex.y - 0.5,
                width=1.0,
                height=1.0,
                label=ex.label or "Exit",
                wheelchair_accessible=True,
            )
        )

    for en in entrances:
        elements.append(
            FloorPlanElement(
                id=en.id,
                type="entrance",
                x=en.x - 0.5,
                y=en.y - 0.5,
                width=1.0,
                height=1.0,
                label=en.label or "Entrance",
                wheelchair_accessible=en.wheelchair_accessible,
            )
        )

    logger.info(
        "Floor plan: %d elements, %d rooms",
        len(elements),
        len(rooms),
    )

    return FloorPlan(floor=1, elements=elements, rooms=rooms)
