"""Pydantic models for building structure and navigation."""

from __future__ import annotations

import uuid
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# -------------------------------------------------------
# Enums
# -------------------------------------------------------


class LandmarkType(str, Enum):
    ROOM = "room"
    DOOR = "door"
    CORRIDOR = "corridor"
    JUNCTION = "junction"
    STAIRS = "stairs"
    RAMP = "ramp"
    ELEVATOR = "elevator"
    EXIT = "exit"
    ENTRANCE = "entrance"
    FIRE_EXTINGUISHER = "fire_extinguisher"


class ScaleMode(str, Enum):
    USER_REFERENCE = "user_reference"
    STANDARD_OBJECT = "standard_object"
    RELATIVE = "relative"


class ConfidenceSource(str, Enum):
    DETECTED = "detected"
    INFERRED_FROM_SEQUENCE = "inferred_from_sequence"
    INFERRED_FROM_OVERLAP = "inferred_from_overlap"
    RELATIVE_SIZE_ESTIMATION = "relative_size_estimation"
    STANDARD_DIMENSION = "standard_dimension"
    USER_PROVIDED = "user_provided"


# -------------------------------------------------------
# 2-D coordinate helpers
# -------------------------------------------------------


class Point2D(BaseModel):
    x: float
    y: float


# -------------------------------------------------------
# Spatial landmark (intermediate representation)
# -------------------------------------------------------


class SpatialLandmark(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    type: LandmarkType
    photo_index: int
    relative_position: str = "center"
    connected_photo_indices: list[int] = []
    floor_transition: bool = False
    wheelchair_accessible: bool = True
    confidence: float = 0.5
    confidence_source: ConfidenceSource = ConfidenceSource.DETECTED
    raw_detection_id: Optional[str] = None


# -------------------------------------------------------
# Building graph node / edge
# -------------------------------------------------------


class BuildingNode(BaseModel):
    id: str
    type: LandmarkType
    x: float = 0.0
    y: float = 0.0
    floor: int = 1
    confidence: float = 0.5
    confidence_source: ConfidenceSource = ConfidenceSource.DETECTED
    wheelchair_accessible: bool = True
    label: Optional[str] = None


class BuildingEdge(BaseModel):
    source: str
    target: str
    distance: float = 1.0
    blocked: bool = False
    hazard: float = 0.0
    congestion: float = 0.0
    stairs: bool = False
    wheelchair_accessible: bool = True
    confidence: float = 0.5


# -------------------------------------------------------
# Room estimate
# -------------------------------------------------------


class RoomEstimate(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    door_id: Optional[str] = None
    width: float = 0.0
    length: float = 0.0
    area: float = 0.0
    x: float = 0.0
    y: float = 0.0
    estimated: bool = True
    confidence: float = 0.5
    size_source: str = "relative_estimation"


# -------------------------------------------------------
# Floor plan element (for rendering)
# -------------------------------------------------------


class FloorPlanElement(BaseModel):
    id: str
    type: str
    x: float
    y: float
    width: float = 0.0
    height: float = 0.0
    wheelchair_accessible: bool = True
    label: Optional[str] = None


class FloorPlan(BaseModel):
    floor: int = 1
    elements: list[FloorPlanElement] = []
    rooms: list[RoomEstimate] = []


# -------------------------------------------------------
# Photo overlap info
# -------------------------------------------------------


class PhotoOverlap(BaseModel):
    photo_a: int
    photo_b: int
    overlap_score: float = 0.0
    relationship: str = "sequence_only"


# -------------------------------------------------------
# Navigation graph (intermediate, before routing adapter)
# -------------------------------------------------------


class NavigationGraph(BaseModel):
    nodes: list[BuildingNode] = []
    edges: list[BuildingEdge] = []
