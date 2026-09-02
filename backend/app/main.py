from fastapi import FastAPI, Form, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import logging
from app.graph.builder import build_graph
from app.graph.routing import calculate_route
from PIL import Image
import io
import numpy as np
from typing import Optional

from app.ai.detector import EnvironmentDetector
from app.ai.preprocessing import preprocess_detections, merge_detections
from app.ai.architectural_detector import detect_architectural
from app.ai.landmarks import generate_landmarks
from app.ai.floorplan_single import generate_floor_plan

logger = logging.getLogger(__name__)


app = FastAPI(
    title="AI Evacuation Twin"
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],

    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


detector = EnvironmentDetector()


@app.get("/")
def root():

    return {
        "name": "AI Evacuation Twin",
        "status": "running"
    }


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...)
):

    contents = await file.read()

    image = Image.open(
        io.BytesIO(contents)
    ).convert("RGB")

    image_np = np.array(image)

    detections = detector.analyze(
        image_np
    )

    return {
        "success": True,
        "filename": file.filename,
        "detections": detections
    }


@app.post("/api/analyze-and-route")
async def analyze_and_route(
    file: UploadFile = File(...),
    mobility: str = "normal"
):

    contents = await file.read()

    image = Image.open(
        io.BytesIO(contents)
    ).convert("RGB")

    image_np = np.array(image)
    img_h, img_w = image_np.shape[:2]

    # -------------------------------
    # 1. RAW YOLO DETECTIONS
    # -------------------------------

    yolo_detections = detector.analyze(image_np)
    logger.info("[AI] YOLO detections: %d", len(yolo_detections))

    # -------------------------------
    # 1b. OPENCV ARCHITECTURAL DETECTIONS
    # -------------------------------

    cv_detections = detect_architectural(image_np)
    logger.info("[AI] OpenCV detections: %d", len(cv_detections))

    # -------------------------------
    # 1c. MERGE DETECTIONS
    # -------------------------------

    raw_detections = merge_detections(yolo_detections, cv_detections)
    logger.info("[AI] After merge: %d", len(raw_detections))

    # -------------------------------
    # 2. CONFIDENCE FILTERING + NMS
    # -------------------------------

    filtered = preprocess_detections(raw_detections)
    logger.info("[AI] After filtering + NMS: %d", len(filtered))

    # -------------------------------
    # 3. SEMANTIC LANDMARKS
    # -------------------------------

    landmarks = generate_landmarks(filtered, img_w, img_h)
    logger.info("[AI] Semantic landmarks: %d", len(landmarks))

    # -------------------------------
    # 4. FLOOR PLAN GENERATION
    # -------------------------------

    floor_plan = generate_floor_plan(landmarks)
    logger.info(
        "[AI] Floor plan elements: %d",
        len(floor_plan["elements"]),
    )

    # -------------------------------
    # 5. BUILD DIGITAL TWIN GRAPH
    # -------------------------------
    # Uses the original unfiltered detections for the graph
    # so the existing routing behaviour is preserved.

    graph, exits = build_graph(raw_detections)
    logger.info(
        "[AI] Digital twin nodes: %d, edges: %d",
        graph.number_of_nodes(),
        graph.number_of_edges(),
    )

    # -------------------------------
    # 6. ROUTING
    # -------------------------------

    route = calculate_route(
        graph,
        mobility=mobility
    )

    # -------------------------------
    # 7. ENVIRONMENT SUMMARY
    # (uses filtered detections for accurate counts)
    # -------------------------------

    people_count = sum(
        1
        for d in filtered
        if d["type"] == "person"
    )

    # Count exits from semantic landmarks (most accurate)
    exit_count = len([lm for lm in landmarks if lm["type"] == "exit"])
    if exit_count == 0:
        # Fallback to graph exits
        exit_count = len(exits)

    hazards = [
        d for d in filtered
        if d["type"] in {
            "fire",
            "smoke",
            "obstacle",
            "blocked passage"
        }
    ]

    # -------------------------------
    # 8. GRAPH NODES + EDGES
    # -------------------------------

    nodes = []
    for node_id, data in graph.nodes(data=True):
        nodes.append({
            "id": node_id,
            "type": data.get("type"),
            "label": data.get("label"),
            "x": data.get("x", 0),
            "y": data.get("y", 0),
            "confidence": data.get("confidence", 1),
        })

    edges = []
    for source, target, data in graph.edges(data=True):
        edges.append({
            "source": source,
            "target": target,
            "distance": round(data.get("distance", 0), 2),
            "blocked": data.get("blocked", False),
        })

    # -------------------------------
    # RESPONSE
    # -------------------------------

    return {
        "success": True,

        "raw_detections": raw_detections,
        "filtered_detections": filtered,
        "landmarks": landmarks,

        "floor_plan": floor_plan,

        "environment": {
            "people": people_count,
            "exits": exit_count,
            "hazards": len(hazards),
            "detections": len(filtered),
        },

        "detections": filtered,

        "digital_twin": {
            "nodes": nodes,
            "edges": edges,
        },

        "route": route,
    }

from app.graph.demo_graph import create_demo_graph


# ==========================================================
# MULTI-PHOTO RECONSTRUCTION PIPELINE
# ==========================================================


@app.post("/api/v1/building/reconstruct")
async def reconstruct_building(
    photos: list[UploadFile] = File(...),
    reference_type: Optional[str] = Form(None),
    reference_value: Optional[float] = Form(None),
    reference_unit: str = Form("meters"),
    floor: int = Form(1),
):
    """Reconstruct a navigable floor plan from multiple overlapping photos.

    Photos should be uploaded in capture order with 40-70% visual overlap.
    """
    from app.reconstruction.reconstruction_pipeline import run_reconstruction
    from app.models.detection_models import ReferenceMeasurement, ReferenceType

    reference = None
    if reference_type and reference_value is not None:
        try:
            rt = ReferenceType(reference_type)
            reference = ReferenceMeasurement(
                reference_type=rt, value=reference_value, unit=reference_unit,
            )
        except (ValueError, KeyError):
            reference = None

    images: list[np.ndarray] = []
    filenames_list: list[str] = []

    for photo in photos:
        contents = await photo.read()
        try:
            img = Image.open(io.BytesIO(contents)).convert("RGB")
            images.append(np.array(img))
            filenames_list.append(photo.filename or f"photo_{len(images)}.jpg")
        except Exception:
            continue

    if not images:
        return {"success": False, "error": "No valid images could be read."}

    result = run_reconstruction(
        images=images,
        filenames=filenames_list,
        reference=reference,
        detector=detector,
        floor=floor,
    )

    return result.to_response()


# ==========================================================
# PHOTO RECONSTRUCTION PIPELINE
# ==========================================================



@app.post("/api/v1/building/photo-reconstruction")
async def photo_reconstruction(
    photos: list[UploadFile] = File(...),
    reference_type: Optional[str] = Form(None),
    reference_value: Optional[float] = Form(None),
    reference_unit: str = Form("meters"),
    floor: int = Form(1),
    mobility: str = Form("normal"),
):
    """Reconstruct an approximate navigable floor plan from
    sequentially-captured building photographs.

    Parameters
    ----------
    photos : list of uploaded images in capture order.
    reference_type : optional, e.g. "door_width", "corridor_width".
    reference_value : optional, real-world measurement in *reference_unit*.
    reference_unit : unit string (default "meters").
    floor : floor number (default 1).
    mobility : mobility profile for routing (default "normal").
    """
    from app.ai.photo_pipeline import run_photo_pipeline
    from app.models.detection_models import ReferenceMeasurement, ReferenceType

    # -- Parse reference measurement --
    reference = None
    if reference_type and reference_value is not None:
        try:
            rt = ReferenceType(reference_type)
            reference = ReferenceMeasurement(
                reference_type=rt,
                value=reference_value,
                unit=reference_unit,
            )
        except ValueError:
            # Unknown reference type → ignore gracefully
            reference = None

    # -- Read all images --
    images: list[np.ndarray] = []
    filenames: list[str] = []

    for photo in photos:
        contents = await photo.read()
        try:
            img = Image.open(io.BytesIO(contents)).convert("RGB")
            images.append(np.array(img))
            filenames.append(photo.filename or f"photo_{len(images)}.jpg")
        except Exception:
            # Skip unreadable files
            continue

    if not images:
        return {
            "success": False,
            "error": "No valid images could be read from the upload.",
        }

    # -- Run the pipeline --
    result = run_photo_pipeline(
        images=images,
        filenames=filenames,
        reference=reference,
        detector=detector,
        floor=floor,
    )

    response = result.to_response()

    # -- Optionally compute a demo route using the generated graph --
    if result.success:
        try:
            from app.routing.graph_adapter import adapt_to_routing_graph
            from app.graph.routing import calculate_route

            nx_graph = adapt_to_routing_graph(result.navigation_graph)
            route = calculate_route(nx_graph, mobility=mobility)
            response["route"] = route
        except Exception:
            response["route"] = None

    return response


@app.post("/api/demo/route")
async def demo_route(
    mobility: str = "normal"
):

    graph = create_demo_graph()

    route = calculate_route(
        graph,
        mobility=mobility
    )

    return {
        "success": True,
        "scenario": "normal",
        "mobility": mobility,
        "route": route
    }

@app.post("/api/demo/fire")
async def demo_fire(
    mobility: str = "normal"
):

    graph = create_demo_graph()

    # =====================================
    # FIRE BLOCKS EXIT A
    # =====================================

    graph["stairs"]["exit_a"][
        "hazard"
    ] = 10

    # =====================================
    # ADD FIRE TO GRAPH
    # =====================================

    graph.nodes["stairs"]["hazard"] = 1

    route = calculate_route(
        graph,
        mobility=mobility
    )

    return {
        "success": True,
        "scenario": "fire",
        "hazard": {
            "type": "fire",
            "location": "EXIT A / STAIRS",
            "severity": "HIGH"
        },
        "mobility": mobility,
        "route": route
    }


# ==========================================================
# SAVE EDITED FLOOR PLAN
# ==========================================================

from pydantic import BaseModel


class FloorPlanSaveRequest(BaseModel):
    width: float
    height: float
    units: str = "relative"
    approximate: bool = True
    confidence: float = 0.5
    elements: list[dict] = []


@app.post("/api/v1/building/save-floor-plan")
async def save_floor_plan(req: FloorPlanSaveRequest):
    """Validate and regenerate the navigation graph from an
    user-edited floor plan."""
    from app.graph.builder import build_graph
    from app.graph.routing import calculate_route

    # Convert floor plan elements to the bbox format build_graph expects
    detections = []
    for el in req.elements:
        el_type = el.get("type", "unknown")
        # Skip rooms — they are not graph nodes, just visual elements
        if el_type == "room":
            continue
        x = el.get("x", 0)
        y = el.get("y", 0)
        w = el.get("width", 10)
        h = el.get("height", 10)
        det = {
            "id": el.get("id", "unknown"),
            "type": el_type,
            "bbox": [x, y, x + w, y + h],
            "confidence": el.get("confidence", 1.0),
            "source": el.get("source", "user_corrected"),
        }
        detections.append(det)

    # Build routing graph from corrected detections
    graph, exit_nodes = build_graph(detections)
    route = calculate_route(graph, mobility="normal")

    # Validate
    issues = []
    elements = req.elements
    corridors = [e for e in elements if e.get("type") == "corridor"]
    exits = [e for e in elements if e.get("type") == "exit"]
    rooms = [e for e in elements if e.get("type") == "room"]

    if not corridors:
        issues.append("No corridor element")
    if not exits:
        issues.append("No exit element")

    # Room overlap check
    for i in range(len(rooms)):
        for j in range(i + 1, len(rooms)):
            a, b = rooms[i], rooms[j]
            ox = max(0, min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]))
            oy = max(0, min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]))
            if ox > 0 and oy > 0:
                issues.append(f"Room overlap: {a.get('id')} and {b.get('id')}")

    return {
        "success": True,
        "floor_plan": {
            "width": req.width,
            "height": req.height,
            "units": req.units,
            "approximate": req.approximate,
            "confidence": req.confidence,
            "elements": req.elements,
        },
        "validation": {
            "valid": len(issues) == 0,
            "issues": issues,
        },
        "digital_twin": {
            "nodes": list(graph.nodes(data=True)),
            "edges": list(graph.edges(data=True)),
        },
        "route": route,
    }


# ==========================================================
# EVACUATION SIMULATION
# ==========================================================

class EvacuationRequest(BaseModel):
    floor_plan: dict  # { width, height, elements: [...] }
    fire_room_id: str
    occupants: list[dict]  # [{ id, name, location_id, mobility }]


@app.post("/api/v1/simulation/evacuate")
async def simulate_evacuation(req: EvacuationRequest):
    """Run a full evacuation simulation.

    1. Builds navigation graph from floor plan.
    2. Applies fire hazard at the selected room.
    3. Routes each occupant considering mobility constraints.
    """
    from app.simulation.evacuation import run_evacuation

    elements = req.floor_plan.get("elements", [])

    result = run_evacuation(
        floor_plan_elements=elements,
        fire_room_id=req.fire_room_id,
        occupants=req.occupants,
    )

    return result


# ==========================================================
# OCCUPANCY DETECTION (YOLO-World)
# ==========================================================

# Lazy-loaded occupancy detector (shared with the main detector)
_occupancy_detector = None


def _get_occupancy_detector():
    global _occupancy_detector
    if _occupancy_detector is None:
        from app.ai.occupancy_detector import OccupancyDetector
        _occupancy_detector = OccupancyDetector(environment_detector=detector)
    return _occupancy_detector


@app.post("/api/v1/occupancy/analyze")
async def analyze_occupancy(
    file: UploadFile = File(...),
    camera_id: str = Form("camera_1"),
    zone_id: str = Form("zone_default"),
    zone_name: str = Form("Default Zone"),
    zone_type: str = Form("corridor"),
    maximum_capacity: int = Form(20),
):
    """Analyze a single frame for occupancy.

    Receives an image from a camera, runs YOLO-World person detection,
    and updates the zone occupancy state.
    """
    occ = _get_occupancy_detector()

    # Auto-register camera if not already mapped
    if camera_id not in occ._camera_zones:
        from app.models.occupancy_models import CameraZoneMapping
        occ.register_camera(CameraZoneMapping(
            camera_id=camera_id,
            zone_id=zone_id,
            zone_name=zone_name,
            zone_type=zone_type,
            maximum_capacity=maximum_capacity,
        ))

    # Read image
    contents = await file.read()
    try:
        image = Image.open(io.BytesIO(contents)).convert("RGB")
        image_np = np.array(image)
    except Exception as e:
        return {"success": False, "error": f"Could not decode image: {e}"}

    # Run occupancy detection
    result = occ.analyze_frame(image_np, camera_id)

    return {
        "success": True,
        "camera_id": result.camera_id,
        "zone_id": result.zone_id,
        "person_count": result.person_count,
        "detections": [
            {"id": d.id, "confidence": d.confidence, "bbox": d.bbox}
            for d in result.detections
        ],
        "occupancy": result.occupancy.model_dump(mode="json") if result.occupancy else None,
    }


@app.get("/api/v1/occupancy/zones")
async def get_zone_occupancy():
    """Get current occupancy for all monitored zones."""
    occ = _get_occupancy_detector()
    overview = occ.get_building_overview()
    return {
        "success": True,
        "overview": overview.model_dump(mode="json"),
        "zones": [z.model_dump(mode="json") for z in occ.get_all_zones()],
    }


@app.post("/api/v1/occupancy/camera/register")
async def register_camera(
    camera_id: str = Form(...),
    zone_id: str = Form(...),
    zone_name: str = Form(...),
    zone_type: str = Form("corridor"),
    maximum_capacity: int = Form(20),
):
    """Register a camera → zone mapping."""
    occ = _get_occupancy_detector()
    from app.models.occupancy_models import CameraZoneMapping
    occ.register_camera(CameraZoneMapping(
        camera_id=camera_id,
        zone_id=zone_id,
        zone_name=zone_name,
        zone_type=zone_type,
        maximum_capacity=maximum_capacity,
    ))
    return {
        "success": True,
        "message": f"Camera {camera_id} registered to zone {zone_id}",
        "mappings": occ.get_camera_mappings(),
    }


@app.get("/api/v1/occupancy/cameras")
async def get_camera_mappings():
    """Get all registered camera → zone mappings."""
    occ = _get_occupancy_detector()
    return {
        "success": True,
        "mappings": occ.get_camera_mappings(),
    }


@app.get("/api/v1/occupancy/congestion")
async def get_congestion_penalties():
    """Get congestion penalties for routing integration."""
    occ = _get_occupancy_detector()
    return {
        "success": True,
        "penalties": occ.get_congestion_penalties(),
        "overview": occ.get_building_overview().model_dump(mode="json"),
    }


@app.post("/api/v1/occupancy/zone/{zone_id}/capacity")
async def set_zone_capacity(zone_id: str, capacity: int = Form(...)):
    """Update the maximum capacity for a zone."""
    occ = _get_occupancy_detector()
    occ.set_zone_capacity(zone_id, capacity)
    zone = occ.get_zone_occupancy(zone_id)
    if zone is None:
        return {"success": False, "error": f"Zone {zone_id} not found"}
    return {
        "success": True,
        "zone": zone.model_dump(mode="json"),
    }


@app.post("/api/v1/occupancy/zone/{zone_id}/count")
async def set_zone_count(zone_id: str, count: int = Form(...)):
    """Manually set the people count for a zone."""
    occ = _get_occupancy_detector()
    occ.manually_set_count(zone_id, count)
    zone = occ.get_zone_occupancy(zone_id)
    if zone is None:
        return {"success": False, "error": f"Zone {zone_id} not found"}
    return {
        "success": True,
        "zone": zone.model_dump(mode="json"),
    }


@app.post("/api/v1/simulation/evacuate-with-occupancy")
async def simulate_evacuation_with_occupancy(req: EvacuationRequest):
    """Run evacuation simulation with live congestion penalties.

    Same as /api/v1/simulation/evacuate but also applies
    real-time congestion multipliers from YOLO occupancy data.
    """
    from app.simulation.evacuation import (
        build_navigation_graph, apply_hazard,
        apply_mobility_constraints, calculate_route_for_occupant,
    )
    import networkx as nx

    elements = req.floor_plan.get("elements", [])

    # Build navigation graph
    graph = build_navigation_graph(elements)

    # Apply fire hazard
    apply_hazard(graph, req.fire_room_id)

    # Apply congestion penalties from live occupancy
    occ = _get_occupancy_detector()
    penalties = occ.get_congestion_penalties()
    for node_id, data in graph.nodes(data=True):
        zone_id = data.get("zone_id", node_id)
        mult = penalties.get(zone_id, 1.0)
        if mult > 1.0:
            # Increase hazard proportionally to congestion
            current_hazard = data.get("hazard", 0)
            data["hazard"] = current_hazard + (mult - 1.0) * 100

    # Route each occupant
    evacuations = []
    for occ_item in req.occupants:
        location = occ_item.get("location_id", "")
        mobility = occ_item.get("mobility", "normal")
        result = calculate_route_for_occupant(graph, location, mobility)
        result["occupant_id"] = occ_item.get("id", "unknown")
        result["occupant_name"] = occ_item.get("name", occ_item.get("id", "unknown"))
        result["location_id"] = location
        evacuations.append(result)

    return {
        "success": True,
        "hazard": {
            "type": "fire",
            "room_id": req.fire_room_id,
        },
        "congestion_penalties": penalties,
        "graph": {
            "nodes": [{"id": n, **d} for n, d in graph.nodes(data=True)],
            "edges": [{"source": u, "target": v, **d} for u, v, d in graph.edges(data=True)],
        },
        "evacuations": evacuations,
    }


# ==========================================================
# SENSOR STORE — CENTRALIZED STATE
# ==========================================================

from app.sensor_store import get_store


@app.post("/api/v1/building/register")
async def register_building(
    building_id: str = Form("building_001"),
    floor_plan: Optional[str] = Form(None),
):
    """Register a building in the sensor store with its floor plan.

    After floor plan upload or photo reconstruction, call this to
    initialize the building state so occupancy monitoring can begin.
    """
    import json

    store = get_store()
    elements = []
    width = 1000.0
    height = 600.0

    if floor_plan:
        try:
            fp_data = json.loads(floor_plan)
            elements = fp_data.get("elements", [])
            width = fp_data.get("width", 1000)
            height = fp_data.get("height", 600)
        except (json.JSONDecodeError, AttributeError):
            pass

    state = store.register_building(
        building_id=building_id,
        floor_plan_elements=elements,
        floor_plan_width=width,
        floor_plan_height=height,
    )

    # Auto-generate zones from floor plan elements
    zones = store.auto_generate_zones(building_id)

    return {
        "success": True,
        "building_id": building_id,
        "zones_generated": len(zones),
        "zones": [z.model_dump(mode="json") for z in zones],
        "elements": len(state.floor_plan_elements),
    }


@app.get("/api/v1/building/{building_id}/state")
async def get_building_state(building_id: str):
    """Get full building state including zones, hazards, and overview."""
    store = get_store()
    state = store.get_building(building_id)
    if state is None:
        return {"success": False, "error": f"Building '{building_id}' not found"}

    overview = store.get_building_overview(building_id)
    return {
        "success": True,
        "building_id": building_id,
        "zones": [z.model_dump(mode="json") for z in store.get_all_zones(building_id)],
        "overview": overview.model_dump(mode="json"),
        "hazards": store.get_hazards(building_id),
        "penalties": store.get_congestion_penalties(building_id),
        "bottleneck_zones": store.get_bottleneck_zones(building_id),
        "floor_plan_elements": len(state.floor_plan_elements),
    }


@app.post("/api/v1/occupancy/update")
async def occupancy_update(
    file: UploadFile = File(...),
    building_id: str = Form("building_001"),
    zone_id: str = Form(...),
):
    """Unified occupancy update pipeline.

    This is the SINGLE endpoint that both uploaded images and future
    CCTV frames use. The pipeline:

        Image → YOLO-World → Person Count → Zone Update → Bottleneck Detection → Routing Update

    For the prototype: uploaded crowd photo
    For production: CCTV camera frame
    Same pipeline, same response format.
    """
    from app.ai.occupancy_service import update_zone_occupancy

    # Read image
    contents = await file.read()
    try:
        image = Image.open(io.BytesIO(contents)).convert("RGB")
        image_np = np.array(image)
    except Exception as e:
        return {"success": False, "error": f"Could not decode image: {e}"}

    # Run the unified pipeline
    result = update_zone_occupancy(
        building_id=building_id,
        zone_id=zone_id,
        image_np=image_np,
        occupancy_detector=_get_occupancy_detector(),
    )

    return result


@app.post("/api/v1/occupancy/zones/auto-generate")
async def auto_generate_zones(
    building_id: str = Form("building_001"),
    floor_plan: str = Form(...),
):
    """Auto-generate monitored zones from floor plan elements.

    Call this after building creation to create zones for each
    navigable element (exits, corridors, stairs, ramps, elevators).
    """
    from app.ai.occupancy_service import auto_generate_zones_from_floor_plan
    import json

    try:
        fp_data = json.loads(floor_plan)
    except (json.JSONDecodeError, AttributeError):
        return {"success": False, "error": "Invalid floor_plan JSON"}

    elements = fp_data.get("elements", [])
    width = fp_data.get("width", 1000)
    height = fp_data.get("height", 600)

    result = auto_generate_zones_from_floor_plan(
        building_id=building_id,
        floor_plan_elements=elements,
        floor_plan_width=width,
        floor_plan_height=height,
    )

    return result


@app.post("/api/v1/building/{building_id}/evacuate-with-occupancy")
async def evacuate_with_building_occupancy(
    building_id: str,
    req: EvacuationRequest,
):
    """Run evacuation using the sensor store's building state.

    This applies both fire hazards AND live congestion penalties
    from the sensor store to the routing graph.
    """
    from app.simulation.evacuation import (
        build_navigation_graph, apply_hazard,
        calculate_route_for_occupant,
    )
    from app.graph.routing import apply_congestion_penalties, apply_hazard_penalties

    store = get_store()
    penalties = store.get_congestion_penalties(building_id)
    hazards = store.get_hazards(building_id)

    elements = req.floor_plan.get("elements", [])
    graph = build_navigation_graph(elements)

    # Apply fire hazard if specified
    if req.fire_room_id:
        apply_hazard(graph, req.fire_room_id)

    # Apply congestion penalties from sensor store
    apply_congestion_penalties(graph, penalties)

    # Apply hazard penalties from sensor store
    apply_hazard_penalties(graph, hazards)

    # Route each occupant
    evacuations = []
    for occ_item in req.occupants:
        location = occ_item.get("location_id", "")
        mobility = occ_item.get("mobility", "normal")
        route_result = calculate_route_for_occupant(graph, location, mobility)
        route_result["occupant_id"] = occ_item.get("id", "unknown")
        route_result["occupant_name"] = occ_item.get("name", occ_item.get("id", "unknown"))
        route_result["location_id"] = location
        evacuations.append(route_result)

    return {
        "success": True,
        "building_id": building_id,
        "hazard": {
            "type": "fire",
            "room_id": req.fire_room_id,
        },
        "congestion_penalties": penalties,
        "bottleneck_zones": store.get_bottleneck_zones(building_id),
        "hazard_zones": list(hazards.keys()),
        "evacuations": evacuations,
    }