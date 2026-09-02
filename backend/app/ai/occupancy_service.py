"""Unified occupancy update pipeline.

This is the SINGLE pipeline that both the prototype (uploaded images)
and future production (CCTV frames) use for occupancy monitoring.

    IMAGE / CAMERA FRAME
            ↓
    YOLO-WORLD DETECTION
            ↓
    PERSON COUNT
            ↓
    ZONE OCCUPANCY UPDATE
            ↓
    BOTTLENECK DETECTION
            ↓
    ROUTING GRAPH UPDATE
            ↓
    AUTOMATIC REROUTING
            ↓
    RETURN UPDATED STATE

The only thing that changes between prototype and production
is the INPUT SOURCE:

    Prototype:  uploaded photo → numpy array
    Production: CCTV frame → numpy array

Both enter this service through `update_zone_occupancy()`.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

import numpy as np

from app.models.occupancy_models import CongestionStatus
from app.sensor_store import SensorStore, get_store

logger = logging.getLogger(__name__)


# ============================================================
# Core pipeline
# ============================================================

def update_zone_occupancy(
    building_id: str,
    zone_id: str,
    image_np: np.ndarray,
    occupancy_detector=None,
    sensor_store: Optional[SensorStore] = None,
) -> dict:
    """Unified occupancy update: image → YOLO → count → zone → bottleneck → routing.

    This is the single function that both uploaded images and CCTV frames
    call. The input source is abstracted away — only the numpy array matters.

    Parameters
    ----------
    building_id : str
        The building to update.
    zone_id : str
        The zone this image represents.
    image_np : np.ndarray
        RGB image (from uploaded photo or CCTV frame).
    occupancy_detector : optional
        The OccupancyDetector instance (reuses shared YOLO model).
    sensor_store : optional
        The SensorStore instance.  Defaults to the global singleton.

    Returns
    -------
    dict with full update results including:
        - people_detected
        - zone occupancy state
        - congestion_status
        - was_bottleneck (bool: status changed to bottleneck/congested)
        - rerouting_required (bool)
        - penalties (current congestion penalties for routing)
        - bottleneck_zones (list of bottleneck zone IDs)
    """
    store = sensor_store or get_store()
    state = store.get_building(building_id)
    if state is None:
        return {
            "success": False,
            "error": f"Building '{building_id}' not found. Register it first.",
        }

    # Ensure zone exists
    zone = store.get_zone(building_id, zone_id)
    if zone is None:
        # Auto-create zone from floor plan element if available
        element = _find_element(state.floor_plan_elements, zone_id)
        if element:
            from app.sensor_store import _default_capacity
            zone = store.register_zone(
                building_id=building_id,
                zone_id=zone_id,
                zone_name=f"{element.get('type', 'zone').replace('_', ' ').title()}",
                zone_type=element.get("type", "corridor"),
                capacity=_default_capacity(element.get("type", "corridor")),
            )
        else:
            zone = store.register_zone(
                building_id=building_id,
                zone_id=zone_id,
                zone_name=zone_id,
                zone_type="corridor",
                capacity=15,
            )

    # Track old status before update
    old_status = zone.congestion_status

    # ---- Step 1: YOLO-WORLD DETECTION ----
    person_count = 0
    detections = []

    if occupancy_detector is not None:
        try:
            raw_detections = occupancy_detector._detector.analyze(image_np)
            # Filter to people only
            for det in raw_detections:
                if det.get("type") == "person":
                    person_count += 1
                    bbox = det.get("bbox", [0, 0, 0, 0])
                    detections.append({
                        "confidence": det.get("confidence", 0),
                        "bbox": bbox,
                    })
        except Exception as exc:
            logger.error("[OCCUPANCY-SVC] YOLO detection failed: %s", exc)
            return {
                "success": False,
                "error": f"YOLO detection failed: {exc}",
            }
    else:
        return {
            "success": False,
            "error": "No occupancy detector available.",
        }

    # ---- Step 2: UPDATE ZONE OCCUPANCY ----
    zone = store.update_zone_occupancy(building_id, zone_id, person_count)
    if zone is None:
        return {
            "success": False,
            "error": f"Failed to update zone '{zone_id}'.",
        }

    # ---- Step 3: BOTTLENECK DETECTION ----
    new_status = zone.congestion_status
    status_changed = new_status != old_status
    was_bottleneck = new_status in (
        CongestionStatus.BOTTLENECK,
        CongestionStatus.CONGESTED,
    ) and old_status not in (CongestionStatus.BOTTLENECK, CongestionStatus.CONGESTED)

    # ---- Step 4: GET ROUTING PENALTIES ----
    penalties = store.get_congestion_penalties(building_id)
    bottleneck_zones = store.get_bottleneck_zones(building_id)
    hazards = store.get_hazards(building_id)

    # ---- Step 5: DETERMINE IF REROUTING NEEDED ----
    rerouting_required = was_bottleneck or status_changed

    logger.info(
        "[OCCUPANCY-SVC] Building=%s zone=%s people=%d/%d status=%s (was=%s) reroute=%s",
        building_id, zone_id, person_count, zone.maximum_capacity,
        new_status.value, old_status.value, rerouting_required,
    )

    # ---- Step 6: EXIT IMPACT ANALYSIS ----
    exit_impact = analyze_exit_impact(building_id, zone_id, sensor_store=store)

    # ---- Step 7: BUILD RESPONSE ----
    return {
        "success": True,
        "building_id": building_id,
        "zone_id": zone_id,
        "people_detected": person_count,
        "detection_count": len(detections),
        "detections": detections[:20],  # limit for response size
        "capacity": zone.maximum_capacity,
        "occupancy_ratio": round(zone.occupancy_ratio, 3),
        "occupancy_percentage": round(zone.occupancy_ratio * 100, 1),
        "congestion_status": new_status.value,
        "status_changed": status_changed,
        "was_bottleneck": was_bottleneck,
        "rerouting_required": rerouting_required,
        "penalties": penalties,
        "bottleneck_zones": bottleneck_zones,
        "hazard_zones": list(hazards.keys()),
        "zone": zone.model_dump(mode="json"),
        # Exit impact analysis
        "affected_exits": exit_impact["affected_exits"],
        "available_exits": exit_impact["available_exits"],
        "recommended_exit": exit_impact["recommended_exit"],
        "affected_zone": exit_impact["affected_zone"],
        "timestamp": datetime.now().isoformat(),
    }


# ============================================================
# Zone registration from floor plan
# ============================================================

def auto_generate_zones_from_floor_plan(
    building_id: str,
    floor_plan_elements: list[dict],
    floor_plan_width: float = 1000,
    floor_plan_height: float = 600,
    sensor_store: Optional[SensorStore] = None,
) -> dict:
    """Auto-generate monitored zones from floor plan elements.

    After a building is created (via floor plan upload or photo
    reconstruction), this function creates zones for each navigable
    element so the user can immediately start monitoring occupancy.
    """
    store = sensor_store or get_store()

    # Register the building with its floor plan
    state = store.register_building(
        building_id=building_id,
        floor_plan_elements=floor_plan_elements,
        floor_plan_width=floor_plan_width,
        floor_plan_height=floor_plan_height,
    )

    # Auto-generate zones
    zones = store.auto_generate_zones(building_id)

    return {
        "success": True,
        "building_id": building_id,
        "zones_generated": len(zones),
        "zones": [z.model_dump(mode="json") for z in zones],
        "floor_plan_elements": len(floor_plan_elements),
    }


# ============================================================
# Exit impact analysis
# ============================================================

def analyze_exit_impact(
    building_id: str,
    updated_zone_id: str,
    sensor_store: Optional[SensorStore] = None,
) -> dict:
    """Determine which exits are affected by congestion and which is recommended.

    Uses the floor plan element positions to determine spatial connectivity:
    - An exit is AVOID if it is itself congested, or if its nearest corridor
      is congested (the corridor is the only path to reach the exit).
    - An exit is BLOCKED if there is a hazard in the exit's zone.
    - An exit is RECOMMENDED if it is the nearest available exit with the
      lowest congestion penalty.
    """
    store = sensor_store or get_store()
    state = store.get_building(building_id)
    if state is None:
        return {"affected_exits": [], "recommended_exit": None}

    all_zones = state.zones
    hazards = state.hazards
    elements = state.floor_plan_elements

    # Find all exit elements
    exit_elements = [e for e in elements if e.get("type") == "exit"]
    corridor_elements = [e for e in elements if e.get("type") == "corridor"]

    affected_exits = []
    available_exits = []

    for exit_el in exit_elements:
        exit_id = exit_el.get("id", "")
        exit_zone = all_zones.get(exit_id)

        # 1. Check if exit itself is congested
        if exit_zone and exit_zone.congestion_status in (
            CongestionStatus.BOTTLENECK, CongestionStatus.CONGGESTED
        ):
            affected_exits.append({
                "exit_id": exit_id,
                "exit_name": exit_zone.zone_name,
                "availability": "AVOID",
                "reason": f"Exit itself is {exit_zone.congestion_status.value} ({exit_zone.current_people}/{exit_zone.maximum_capacity})",
                "congestion_status": exit_zone.congestion_status.value,
            })
            continue

        # 2. Check if hazard blocks this exit
        if exit_id in hazards and hazards[exit_id].get("active"):
            affected_exits.append({
                "exit_id": exit_id,
                "exit_name": exit_zone.zone_name if exit_zone else exit_id,
                "availability": "BLOCKED",
                "reason": f"Blocked by {hazards[exit_id].get('type', 'hazard')}",
                "congestion_status": "BLOCKED",
            })
            continue

        # 3. Find nearest corridor to this exit
        nearest_corridor = _find_nearest_element(exit_el, corridor_elements)
        if nearest_corridor:
            corr_zone = all_zones.get(nearest_corridor.get("id", ""))
            if corr_zone and corr_zone.congestion_status in (
                CongestionStatus.BOTTLENECK, CongestionStatus.CONGGESTED
            ):
                affected_exits.append({
                    "exit_id": exit_id,
                    "exit_name": exit_zone.zone_name if exit_zone else exit_id,
                    "availability": "AVOID",
                    "reason": f"Approach corridor ({corr_zone.zone_name}) is {corr_zone.congestion_status.value}",
                    "congestion_status": corr_zone.congestion_status.value,
                })
                continue

        # 4. Check if any corridor near exit has hazard
        if nearest_corridor:
            nc_id = nearest_corridor.get("id", "")
            if nc_id in hazards and hazards[nc_id].get("active"):
                affected_exits.append({
                    "exit_id": exit_id,
                    "exit_name": exit_zone.zone_name if exit_zone else exit_id,
                    "availability": "BLOCKED",
                    "reason": f"Approach corridor blocked by hazard",
                    "congestion_status": "BLOCKED",
                })
                continue

        # 5. Exit is available — compute congestion score for ranking
        score = 0.0
        if exit_zone:
            score += exit_zone.occupancy_ratio * 2.0
        if nearest_corridor:
            corr_zone = all_zones.get(nearest_corridor.get("id", ""))
            if corr_zone:
                score += corr_zone.occupancy_ratio * 3.0  # corridor matters more

        available_exits.append({
            "exit_id": exit_id,
            "exit_name": exit_zone.zone_name if exit_zone else exit_id,
            "availability": "RECOMMENDED" if score < 0.5 else "AVAILABLE",
            "reason": "Safe route available" if score < 0.5 else "Available but moderate traffic",
            "congestion_status": (exit_zone.congestion_status.value if exit_zone else "NORMAL"),
            "score": round(score, 3),
        })

    # Sort available exits by score (lowest = best)
    available_exits.sort(key=lambda e: e.get("score", 999))

    # Mark best available exit as RECOMMENDED
    if available_exits:
        available_exits[0]["availability"] = "RECOMMENDED"
        available_exits[0]["reason"] = "Safest available exit"
        for e in available_exits[1:]:
            if e["availability"] == "RECOMMENDED":
                e["availability"] = "AVAILABLE"
                e["reason"] = "Available but not the最优 route"

    # Determine the congestion zone that triggered the update
    updated_zone = all_zones.get(updated_zone_id)
    affected_zone_info = None
    if updated_zone and updated_zone.congestion_status in (
        CongestionStatus.BOTTLENECK, CongestionStatus.CONGGESTED, CongestionStatus.HIGH_OCCUPANCY
    ):
        affected_zone_info = {
            "zone_id": updated_zone_id,
            "zone_name": updated_zone.zone_name,
            "status": updated_zone.congestion_status.value,
            "people": updated_zone.current_people,
            "capacity": updated_zone.maximum_capacity,
            "percentage": round(updated_zone.occupancy_ratio * 100, 1),
        }

    recommended = next((e for e in available_exits if e["availability"] == "RECOMMENDED"), None)

    return {
        "affected_exits": affected_exits,
        "available_exits": available_exits,
        "recommended_exit": recommended,
        "affected_zone": affected_zone_info,
    }


def _find_nearest_element(
    target: dict, candidates: list[dict]
) -> Optional[dict]:
    """Find the nearest element by edge-to-edge distance."""
    if not candidates:
        return None
    best = None
    best_dist = float("inf")
    tx, ty = target.get("x", 0), target.get("y", 0)
    tw, th = target.get("width", 0), target.get("height", 0)
    for c in candidates:
        cx, cy = c.get("x", 0), c.get("y", 0)
        cw, ch = c.get("width", 0), c.get("height", 0)
        dx = max(0, max(tx, cx) - min(tx + tw, cx + cw))
        dy = max(0, max(ty, cy) - min(ty + th, cy + ch))
        d = (dx ** 2 + dy ** 2) ** 0.5
        if d < best_dist:
            best_dist = d
            best = c
    return best


# ============================================================
# Helpers
# ============================================================

def _find_element(elements: list[dict], element_id: str) -> Optional[dict]:
    """Find a floor plan element by ID."""
    for el in elements:
        if el.get("id") == element_id:
            return el
    return None
