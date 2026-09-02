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