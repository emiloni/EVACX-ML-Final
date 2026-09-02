"""Occupancy detection service using YOLO-World.

Wraps the existing ``EnvironmentDetector`` to count people in camera
frames and map detections to building zones.

Key design decisions:
- Reuses the existing YOLO-World model (no duplicate loading).
- People-only detection for occupancy (filters out architectural classes).
- Per-camera → zone mapping for spatial awareness.
- Congestion status calculation from occupancy ratio.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

import numpy as np

from app.models.occupancy_models import (
    BuildingOccupancyOverview,
    CameraZoneMapping,
    CameraStatus,
    CongestionStatus,
    OccupancyAnalysisResult,
    PersonDetection,
    ZoneOccupancy,
)

logger = logging.getLogger(__name__)

# Congestion thresholds (configurable)
THRESHOLD_HIGH_OCCUPANCY = 0.5
THRESHOLD_CONGESTED = 0.8
THRESHOLD_BOTTLENECK = 1.0


class OccupancyDetector:
    """Service that uses YOLO-World to monitor building occupancy.

    Maintains:
    - A shared ``EnvironmentDetector`` instance (already loaded model).
    - Camera → zone mappings.
    - Per-zone occupancy state.
    """

    def __init__(self, environment_detector=None):
        """Initialise with a shared EnvironmentDetector.

        Parameters
        ----------
        environment_detector : optional
            An existing ``EnvironmentDetector`` instance.  If None,
            a new one will be created (which loads the YOLO model).
        """
        if environment_detector is not None:
            self._detector = environment_detector
        else:
            from app.ai.detector import EnvironmentDetector
            self._detector = EnvironmentDetector()

        # Camera → zone mappings
        self._camera_zones: dict[str, CameraZoneMapping] = {}

        # Zone occupancy state
        self._zone_occupancy: dict[str, ZoneOccupancy] = {}

        # Building overview
        self._overview = BuildingOccupancyOverview()

        logger.info("[OCCUPANCY] OccupancyDetector initialised")

    # -------------------------------------------------------
    # Camera zone management
    # -------------------------------------------------------

    def register_camera(self, mapping: CameraZoneMapping) -> None:
        """Register or update a camera→zone mapping."""
        self._camera_zones[mapping.camera_id] = mapping

        # Ensure zone occupancy exists
        if mapping.zone_id not in self._zone_occupancy:
            self._zone_occupancy[mapping.zone_id] = ZoneOccupancy(
                zone_id=mapping.zone_id,
                zone_name=mapping.zone_name,
                zone_type=mapping.zone_type,
                maximum_capacity=mapping.maximum_capacity,
                camera_ids=[mapping.camera_id],
            )
        else:
            zone = self._zone_occupancy[mapping.zone_id]
            if mapping.camera_id not in zone.camera_ids:
                zone.camera_ids.append(mapping.camera_id)
            zone.maximum_capacity = max(zone.maximum_capacity, mapping.maximum_capacity)

        logger.info(
            "[OCCUPANCY] Camera %s registered → zone %s (%s)",
            mapping.camera_id, mapping.zone_id, mapping.zone_name,
        )

    def unregister_camera(self, camera_id: str) -> None:
        """Remove a camera mapping."""
        mapping = self._camera_zones.pop(camera_id, None)
        if mapping and mapping.zone_id in self._zone_occupancy:
            zone = self._zone_occupancy[mapping.zone_id]
            if camera_id in zone.camera_ids:
                zone.camera_ids.remove(camera_id)

    def get_camera_mappings(self) -> list[dict]:
        """Return all registered camera→zone mappings."""
        return [m.model_dump() for m in self._camera_zones.values()]

    # -------------------------------------------------------
    # Frame analysis
    # -------------------------------------------------------

    def analyze_frame(
        self,
        image_np: np.ndarray,
        camera_id: str,
    ) -> OccupancyAnalysisResult:
        """Run YOLO-World on a frame and update zone occupancy.

        Parameters
        ----------
        image_np : RGB numpy array from the camera frame.
        camera_id : which camera captured this frame.

        Returns
        -------
        OccupancyAnalysisResult with person count and updated zone state.
        """
        mapping = self._camera_zones.get(camera_id)
        if mapping is None:
            logger.warning("[OCCUPANCY] Unknown camera: %s", camera_id)
            return OccupancyAnalysisResult(
                camera_id=camera_id,
                zone_id="unknown",
                person_count=0,
            )

        zone_id = mapping.zone_id

        # Run YOLO-World detection
        try:
            raw_detections = self._detector.analyze(image_np)
        except Exception as exc:
            logger.error("[OCCUPANCY] Detection failed for camera %s: %s", camera_id, exc)
            return OccupancyAnalysisResult(
                camera_id=camera_id,
                zone_id=zone_id,
                person_count=0,
            )

        # Filter to people only
        person_detections = []
        for det in raw_detections:
            if det.get("type") == "person":
                bbox = det.get("bbox", [0, 0, 0, 0])
                cx = (bbox[0] + bbox[2]) / 2
                cy = (bbox[1] + bbox[3]) / 2
                person_detections.append(PersonDetection(
                    confidence=det.get("confidence", 0),
                    bbox=bbox,
                    center_x=cx,
                    center_y=cy,
                ))

        person_count = len(person_detections)

        # Update zone occupancy
        if zone_id in self._zone_occupancy:
            zone = self._zone_occupancy[zone_id]
            zone.update_counts(person_count)
        else:
            zone = ZoneOccupancy(
                zone_id=zone_id,
                zone_name=mapping.zone_name,
                zone_type=mapping.zone_type,
                current_people=person_count,
                maximum_capacity=mapping.maximum_capacity,
                camera_ids=[camera_id],
            )
            zone.update_counts(person_count)
            self._zone_occupancy[zone_id] = zone

        logger.info(
            "[OCCUPANCY] Camera %s → zone %s: %d people, status=%s",
            camera_id, zone_id, person_count, zone.congestion_status.value,
        )

        return OccupancyAnalysisResult(
            camera_id=camera_id,
            zone_id=zone_id,
            detections=person_detections,
            person_count=person_count,
            occupancy=zone,
            frame_timestamp=datetime.now(),
        )

    # -------------------------------------------------------
    # Occupancy state access
    # -------------------------------------------------------

    def get_zone_occupancy(self, zone_id: str) -> Optional[ZoneOccupancy]:
        """Get current occupancy for a zone."""
        return self._zone_occupancy.get(zone_id)

    def get_all_zones(self) -> list[ZoneOccupancy]:
        """Get occupancy for all zones."""
        return list(self._zone_occupancy.values())

    def get_building_overview(self) -> BuildingOccupancyOverview:
        """Get aggregate building occupancy."""
        self._overview.zones = list(self._zone_occupancy.values())
        self._overview.recalculate()
        return self._overview

    def get_congestion_penalties(self) -> dict[str, float]:
        """Return a mapping of zone_id → congestion multiplier for routing.

        The multiplier scales edge costs in the routing graph:
        - NORMAL: 1.0 (no penalty)
        - HIGH_OCCUPANCY: 1.5
        - CONGESTED: 3.0
        - BOTTLENECK: 8.0
        """
        penalties = {}
        for zone_id, zone in self._zone_occupancy.items():
            status = zone.congestion_status
            if status == CongestionStatus.BOTTLENECK:
                penalties[zone_id] = 8.0
            elif status == CongestionStatus.CONGESTED:
                penalties[zone_id] = 3.0
            elif status == CongestionStatus.HIGH_OCCUPANCY:
                penalties[zone_id] = 1.5
            else:
                penalties[zone_id] = 1.0
        return penalties

    def set_zone_capacity(self, zone_id: str, capacity: int) -> None:
        """Update the maximum capacity for a zone."""
        if zone_id in self._zone_occupancy:
            self._zone_occupancy[zone_id].maximum_capacity = max(capacity, 1)
            # Recalculate congestion
            z = self._zone_occupancy[zone_id]
            z.update_counts(z.current_people)

    def manually_set_count(self, zone_id: str, count: int) -> None:
        """Manually override the people count for a zone (e.g. from UI)."""
        if zone_id in self._zone_occupancy:
            self._zone_occupancy[zone_id].update_counts(count)
