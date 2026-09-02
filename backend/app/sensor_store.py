"""Centralized state store for the EVAC-X digital twin.

Manages the in-memory state of:
- Buildings (floor plan elements, graph, metadata)
- Zones (occupancy, capacity, congestion status)
- Hazards (fire, smoke, blocked passages)
- Active evacuation routes

This store is the single source of truth for all sensor/occupancy/hazard
state. Both the prototype (uploaded images) and future production (CCTV)
write to the same store through the same pipeline.

Design:
    FIRE SENSOR → update_hazard()  → routing update
    SMOKE SENSOR → update_hazard() → routing update
    YOLO / CAMERA → update_zone_occupancy() → routing update
    UPLOADED PHOTO → update_zone_occupancy() → routing update

    Same pipeline, different input sources.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Optional

from app.models.occupancy_models import (
    BuildingOccupancyOverview,
    CongestionStatus,
    ZoneOccupancy,
)

logger = logging.getLogger(__name__)


# ============================================================
# Building state
# ============================================================

class BuildingState:
    """Full in-memory state for a single building."""

    def __init__(
        self,
        building_id: str,
        floor_plan_elements: list[dict] | None = None,
        floor_plan_width: float = 1000,
        floor_plan_height: float = 600,
    ):
        self.building_id = building_id
        self.floor_plan_elements: list[dict] = floor_plan_elements or []
        self.floor_plan_width = floor_plan_width
        self.floor_plan_height = floor_plan_height
        self.created_at = datetime.now()
        self.updated_at = datetime.now()

        # Zones: zone_id → ZoneOccupancy
        self.zones: dict[str, ZoneOccupancy] = {}

        # Active hazards: zone_id → hazard info
        self.hazards: dict[str, dict] = {}

        # Last computed routes (for rerouting comparison)
        self.last_routes: dict = {}

        # Routing graph (NetworkX, lazily built)
        self._routing_graph = None

    def touch(self) -> None:
        self.updated_at = datetime.now()


# ============================================================
# Global store
# ============================================================

class SensorStore:
    """Global in-memory state store.

    Thread-safe for the single-worker prototype.
    For multi-worker production, replace with Redis/DB.
    """

    def __init__(self):
        self._buildings: dict[str, BuildingState] = {}
        logger.info("[STORE] SensorStore initialised")

    # -------------------------------------------------------
    # Building management
    # -------------------------------------------------------

    def register_building(
        self,
        building_id: str,
        floor_plan_elements: list[dict] | None = None,
        floor_plan_width: float = 1000,
        floor_plan_height: float = 600,
    ) -> BuildingState:
        """Register a new building or update an existing one."""
        if building_id in self._buildings:
            state = self._buildings[building_id]
            if floor_plan_elements is not None:
                state.floor_plan_elements = floor_plan_elements
            state.floor_plan_width = floor_plan_width
            state.floor_plan_height = floor_plan_height
            state.touch()
        else:
            state = BuildingState(
                building_id=building_id,
                floor_plan_elements=floor_plan_elements,
                floor_plan_width=floor_plan_width,
                floor_plan_height=floor_plan_height,
            )
            self._buildings[building_id] = state

        logger.info(
            "[STORE] Building %s registered with %d elements",
            building_id, len(state.floor_plan_elements),
        )
        return state

    def get_building(self, building_id: str) -> Optional[BuildingState]:
        return self._buildings.get(building_id)

    def get_or_create_building(self, building_id: str) -> BuildingState:
        if building_id not in self._buildings:
            self._buildings[building_id] = BuildingState(building_id=building_id)
        return self._buildings[building_id]

    def list_buildings(self) -> list[str]:
        return list(self._buildings.keys())

    # -------------------------------------------------------
    # Zone management
    # -------------------------------------------------------

    def auto_generate_zones(self, building_id: str) -> list[ZoneOccupancy]:
        """Auto-generate zones from the building's floor plan elements.

        Maps each navigable element (exits, corridors, stairs, ramps,
        elevators) to a zone with a default capacity.
        """
        state = self.get_building(building_id)
        if state is None:
            return []

        zones = []
        for el in state.floor_plan_elements:
            el_type = el.get("type", "")
            el_id = el.get("id", "")
            if not el_id:
                continue

            # Only create zones for navigable elements
            if el_type not in {"exit", "corridor", "stairs", "ramp", "elevator", "door"}:
                continue

            # Default capacity by type
            capacity = _default_capacity(el_type)

            zone = ZoneOccupancy(
                zone_id=el_id,
                zone_name=f"{el_type.replace('_', ' ').title()} {el_id[:8]}",
                zone_type=el_type,
                maximum_capacity=capacity,
            )
            state.zones[el_id] = zone
            zones.append(zone)

        state.touch()
        logger.info(
            "[STORE] Auto-generated %d zones for building %s",
            len(zones), building_id,
        )
        return zones

    def register_zone(
        self,
        building_id: str,
        zone_id: str,
        zone_name: str,
        zone_type: str = "corridor",
        capacity: int = 20,
    ) -> ZoneOccupancy:
        """Register or update a single zone."""
        state = self.get_or_create_building(building_id)
        if zone_id in state.zones:
            zone = state.zones[zone_id]
            zone.zone_name = zone_name
            zone.zone_type = zone_type
            zone.maximum_capacity = max(capacity, 1)
        else:
            zone = ZoneOccupancy(
                zone_id=zone_id,
                zone_name=zone_name,
                zone_type=zone_type,
                maximum_capacity=capacity,
            )
            state.zones[zone_id] = zone
        state.touch()
        return zone

    def update_zone_occupancy(
        self,
        building_id: str,
        zone_id: str,
        people_count: int,
    ) -> Optional[ZoneOccupancy]:
        """Update the occupancy count for a zone and recalculate congestion."""
        state = self.get_building(building_id)
        if state is None or zone_id not in state.zones:
            return None

        zone = state.zones[zone_id]
        old_status = zone.congestion_status
        zone.update_counts(people_count)
        state.touch()

        if zone.congestion_status != old_status:
            logger.info(
                "[STORE] Zone %s status changed: %s → %s (people=%d/%d)",
                zone_id, old_status.value, zone.congestion_status.value,
                zone.current_people, zone.maximum_capacity,
            )

        return zone

    def get_zone(self, building_id: str, zone_id: str) -> Optional[ZoneOccupancy]:
        state = self.get_building(building_id)
        if state is None:
            return None
        return state.zones.get(zone_id)

    def get_all_zones(self, building_id: str) -> list[ZoneOccupancy]:
        state = self.get_building(building_id)
        if state is None:
            return []
        return list(state.zones.values())

    def get_building_overview(self, building_id: str) -> BuildingOccupancyOverview:
        state = self.get_building(building_id)
        if state is None:
            return BuildingOccupancyOverview(building_id=building_id)

        overview = BuildingOccupancyOverview(
            building_id=building_id,
            zones=list(state.zones.values()),
        )
        overview.recalculate()
        return overview

    # -------------------------------------------------------
    # Hazard management
    # -------------------------------------------------------

    def update_hazard(
        self,
        building_id: str,
        zone_id: str,
        hazard_type: str = "fire",
        severity: str = "HIGH",
        active: bool = True,
    ) -> None:
        """Update hazard state for a zone."""
        state = self.get_building(building_id)
        if state is None:
            return

        if active:
            state.hazards[zone_id] = {
                "type": hazard_type,
                "severity": severity,
                "zone_id": zone_id,
                "active": True,
                "updated_at": datetime.now().isoformat(),
            }
        else:
            state.hazards.pop(zone_id, None)

        state.touch()
        logger.info(
            "[STORE] Hazard %s at zone %s: %s (active=%s)",
            hazard_type, zone_id, severity, active,
        )

    def get_hazards(self, building_id: str) -> dict[str, dict]:
        state = self.get_building(building_id)
        if state is None:
            return {}
        return dict(state.hazards)

    # -------------------------------------------------------
    # Congestion penalties for routing
    # -------------------------------------------------------

    def get_congestion_penalties(self, building_id: str) -> dict[str, float]:
        """Return zone_id → congestion multiplier for routing.

        NORMAL: 1.0 (no penalty)
        HIGH_OCCUPANCY: 1.5
        CONGESTED: 3.0
        BOTTLENECK: 8.0
        """
        state = self.get_building(building_id)
        if state is None:
            return {}

        penalties = {}
        for zone_id, zone in state.zones.items():
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

    def get_bottleneck_zones(self, building_id: str) -> list[str]:
        """Return list of zone IDs that are bottlenecks or congested."""
        state = self.get_building(building_id)
        if state is None:
            return []
        return [
            z.zone_id for z in state.zones.values()
            if z.congestion_status in (
                CongestionStatus.BOTTLENECK,
                CongestionStatus.CONGESTED,
            )
        ]


# ============================================================
# Helpers
# ============================================================

def _default_capacity(element_type: str) -> int:
    """Default capacity by building element type."""
    capacities = {
        "exit": 15,
        "corridor": 20,
        "stairs": 10,
        "ramp": 12,
        "elevator": 8,
        "door": 5,
        "room": 8,
    }
    return capacities.get(element_type, 15)


# ============================================================
# Singleton
# ============================================================

_store: Optional[SensorStore] = None


def get_store() -> SensorStore:
    """Get or create the global sensor store singleton."""
    global _store
    if _store is None:
        _store = SensorStore()
    return _store
