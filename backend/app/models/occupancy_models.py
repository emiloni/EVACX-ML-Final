"""Pydantic models for live occupancy detection and congestion monitoring.

The occupancy system uses YOLO-World to detect people in camera/video
frames and maps detections to building zones via camera→zone associations.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# -------------------------------------------------------
# Enums
# -------------------------------------------------------

class CongestionStatus(str, Enum):
    NORMAL = "NORMAL"
    HIGH_OCCUPANCY = "HIGH_OCCUPANCY"
    CONGESTED = "CONGESTED"
    BOTTLENECK = "BOTTLENECK"


class CameraStatus(str, Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    ERROR = "error"


# -------------------------------------------------------
# Camera → Zone mapping
# -------------------------------------------------------

class CameraZoneMapping(BaseModel):
    """Maps a camera/video source to a building zone."""
    camera_id: str
    zone_id: str
    zone_name: str
    zone_type: str = "corridor"  # corridor, room, stairs, etc.
    maximum_capacity: int = 20
    camera_status: CameraStatus = CameraStatus.ACTIVE


# -------------------------------------------------------
# Zone occupancy
# -------------------------------------------------------

class ZoneOccupancy(BaseModel):
    """Real-time occupancy state for a single building zone."""
    zone_id: str
    zone_name: str
    zone_type: str
    current_people: int = 0
    maximum_capacity: int = 20
    occupancy_ratio: float = 0.0
    congestion_status: CongestionStatus = CongestionStatus.NORMAL
    last_updated: datetime = Field(default_factory=datetime.now)
    camera_ids: list[str] = []

    def update_counts(self, people_count: int) -> None:
        """Recalculate occupancy from a new detection count."""
        self.current_people = people_count
        self.maximum_capacity = max(self.maximum_capacity, 1)
        self.occupancy_ratio = self.current_people / self.maximum_capacity
        self.last_updated = datetime.now()

        if self.occupancy_ratio > 1.0:
            self.congestion_status = CongestionStatus.BOTTLENECK
        elif self.occupancy_ratio > 0.8:
            self.congestion_status = CongestionStatus.CONGESTED
        elif self.occupancy_ratio > 0.5:
            self.congestion_status = CongestionStatus.HIGH_OCCUPANCY
        else:
            self.congestion_status = CongestionStatus.NORMAL


# -------------------------------------------------------
# Detection result
# -------------------------------------------------------

class PersonDetection(BaseModel):
    """A single person detection from YOLO-World."""
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    confidence: float
    bbox: list[float]  # [x1, y1, x2, y2]
    center_x: float = 0.0
    center_y: float = 0.0


class OccupancyAnalysisResult(BaseModel):
    """Result of analyzing a single frame for occupancy."""
    camera_id: str
    zone_id: str
    detections: list[PersonDetection] = []
    person_count: int = 0
    occupancy: Optional[ZoneOccupancy] = None
    frame_timestamp: datetime = Field(default_factory=datetime.now)


# -------------------------------------------------------
# Building occupancy overview
# -------------------------------------------------------

class BuildingOccupancyOverview(BaseModel):
    """Aggregate occupancy across all monitored zones in a building."""
    building_id: str = "default"
    zones: list[ZoneOccupancy] = []
    total_people: int = 0
    total_capacity: int = 0
    overall_congestion: CongestionStatus = CongestionStatus.NORMAL
    bottleneck_zones: list[str] = []
    last_updated: datetime = Field(default_factory=datetime.now)

    def recalculate(self) -> None:
        """Recompute aggregate stats from zone data."""
        self.total_people = sum(z.current_people for z in self.zones)
        self.total_capacity = sum(z.maximum_capacity for z in self.zones)
        self.bottleneck_zones = [
            z.zone_id for z in self.zones
            if z.congestion_status in (CongestionStatus.BOTTLENECK, CongestionStatus.CONGESTED)
        ]
        if self.bottleneck_zones:
            self.overall_congestion = CongestionStatus.BOTTLENECK
        elif any(z.congestion_status == CongestionStatus.HIGH_OCCUPANCY for z in self.zones):
            self.overall_congestion = CongestionStatus.HIGH_OCCUPANCY
        else:
            self.overall_congestion = CongestionStatus.NORMAL
        self.last_updated = datetime.now()
