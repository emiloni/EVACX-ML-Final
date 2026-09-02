"""Pydantic models for photo-based detection and reconstruction."""

from __future__ import annotations

import uuid
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# -------------------------------------------------------
# Reference measurement
# -------------------------------------------------------


class ReferenceType(str, Enum):
    DOOR_WIDTH = "door_width"
    CORRIDOR_WIDTH = "corridor_width"
    ENTRANCE_WIDTH = "entrance_width"
    STAIR_WIDTH = "stair_width"
    FLOOR_HEIGHT = "floor_height"
    CUSTOM = "custom"


class ReferenceMeasurement(BaseModel):
    reference_type: ReferenceType
    value: float
    unit: str = "meters"


# -------------------------------------------------------
# Bounding box
# -------------------------------------------------------


class BoundingBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1

    @property
    def center_x(self) -> float:
        return (self.x1 + self.x2) / 2

    @property
    def center_y(self) -> float:
        return (self.y1 + self.y2) / 2

    @property
    def area(self) -> float:
        return self.width * self.height


# -------------------------------------------------------
# Evacuation-relevant class taxonomy
# -------------------------------------------------------


class EvacClass(str, Enum):
    DOOR = "door"
    EXIT_DOOR = "exit_door"
    EMERGENCY_EXIT = "emergency_exit"
    EXIT_SIGN = "exit_sign"
    STAIRS = "stairs"
    ELEVATOR = "elevator"
    RAMP = "ramp"
    CORRIDOR = "corridor"
    ROOM_ENTRANCE = "room_entrance"
    FIRE_EXTINGUISHER = "fire_extinguisher"
    PERSON = "person"


# Maps raw YOLO-World class names to canonical EvacClass values.
YOLO_TO_EVAC: dict[str, EvacClass] = {
    "door": EvacClass.DOOR,
    "doorway": EvacClass.DOOR,
    "entrance": EvacClass.DOOR,
    "exit door": EvacClass.EXIT_DOOR,
    "emergency exit": EvacClass.EMERGENCY_EXIT,
    "exit sign": EvacClass.EXIT_SIGN,
    "stairs": EvacClass.STAIRS,
    "staircase": EvacClass.STAIRS,
    "stairway": EvacClass.STAIRS,
    "elevator": EvacClass.ELEVATOR,
    "ramp": EvacClass.RAMP,
    "wheelchair ramp": EvacClass.RAMP,
    "corridor": EvacClass.CORRIDOR,
    "hallway": EvacClass.CORRIDOR,
    "fire_extinguisher": EvacClass.FIRE_EXTINGUISHER,
    "person": EvacClass.PERSON,
}


# -------------------------------------------------------
# Single detected object
# -------------------------------------------------------


class DetectedObject(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    photo_index: int
    class_name: str
    evac_class: EvacClass
    confidence: float
    bounding_box: BoundingBox
    center_x: float = 0.0
    center_y: float = 0.0
    relative_position: Optional[str] = None  # left / right / center

    def model_post_init(self, __context: object) -> None:
        if not self.center_x and not self.center_y:
            self.center_x = self.bounding_box.center_x
            self.center_y = self.bounding_box.center_y


# -------------------------------------------------------
# Per-photo analysis result
# -------------------------------------------------------


class PhotoAnalysis(BaseModel):
    photo_index: int
    filename: str
    detections: list[DetectedObject] = []
    image_width: int = 0
    image_height: int = 0
    has_useful_detections: bool = False
