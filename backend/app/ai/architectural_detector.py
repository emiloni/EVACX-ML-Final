"""OpenCV-based architectural detectors.

Supplements YOLO-World with specialized computer vision:
- EXIT sign detection via HSV green color filtering
- Door detection via edge detection + rectangle finding
- Stairs detection via parallel horizontal line detection
"""

from __future__ import annotations

import logging

import cv2
import numpy as np

logger = logging.getLogger(__name__)


# -------------------------------------------------------
# A. EXIT sign detector (green HSV filter)
# -------------------------------------------------------

def detect_exit_signs(
    image_rgb: np.ndarray,
    min_area: int = 500,
    max_area_ratio: float = 0.15,
) -> list[dict]:
    """Detect green EXIT signs using HSV color filtering.

    EXIT signs are bright green rectangles on walls.
    """
    h, w = image_rgb.shape[:2]
    max_area = h * w * max_area_ratio

    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)

    # Green range for EXIT signs (covers both bright and dark green)
    mask1 = cv2.inRange(hsv, (35, 60, 60), (85, 255, 255))
    # Also catch darker green signs
    mask2 = cv2.inRange(hsv, (40, 40, 40), (80, 200, 200))
    mask = cv2.bitwise_or(mask1, mask2)

    # Clean up mask
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(
        mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    detections: list[dict] = []

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area or area > max_area:
            continue

        x, y, bw, bh = cv2.boundingRect(cnt)
        aspect = bw / bh if bh > 0 else 0

        # EXIT signs are roughly rectangular (aspect 0.3 to 4.0)
        if aspect < 0.2 or aspect > 5.0:
            continue

        # Confidence based on area and solidity
        hull_area = cv2.contourArea(cv2.convexHull(cnt))
        solidity = area / hull_area if hull_area > 0 else 0
        conf = min(0.35 + solidity * 0.3 + (area / max_area) * 0.2, 0.85)

        detections.append({
            "type": "exit sign",
            "confidence": round(conf, 3),
            "bbox": [x, y, x + bw, y + bh],
            "source": "opencv_hsv",
        })

    logger.info("[OpenCV] EXIT sign detections: %d", len(detections))
    return detections


# -------------------------------------------------------
# B. Door detector (edge + rectangle detection)
# -------------------------------------------------------

def detect_doors(
    image_rgb: np.ndarray,
    min_area: int = 8000,
    max_area_ratio: float = 0.08,
) -> list[dict]:
    """Detect doors via Canny edge detection + contour rectangle filtering.

    Doors are tall rectangles on walls with specific aspect ratios.
    """
    h, w = image_rgb.shape[:2]
    max_area = h * w * max_area_ratio
    img_area = h * w

    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)

    # CLAHE for better edge detection on dark doors
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    # Edge detection
    edges = cv2.Canny(gray, 40, 130)

    # Dilate to connect broken edges
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 5))
    edges = cv2.dilate(edges, kernel, iterations=2)
    edges = cv2.erode(edges, kernel, iterations=1)

    contours, _ = cv2.findContours(
        edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    detections: list[dict] = []

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area or area > max_area:
            continue

        x, y, bw, bh = cv2.boundingRect(cnt)
        aspect = bh / bw if bw > 0 else 0  # vertical aspect (tall = door)

        # Doors are tall rectangles: aspect ~1.5 to 3.0
        if aspect < 1.5 or aspect > 3.5:
            continue

        # Door must be tall enough (> 15% of image height)
        if bh < h * 0.15:
            continue

        # Area should be reasonable relative to image
        area_ratio = area / img_area
        if area_ratio < 0.015 or area_ratio > 0.08:
            continue

        # Check rectangularity (how close to a rectangle)
        rect_area = bw * bh
        rectangularity = area / rect_area if rect_area > 0 else 0
        if rectangularity < 0.55:
            continue

        # Confidence based on rectangularity and aspect
        conf = min(0.20 + rectangularity * 0.3 + min(aspect / 3.0, 0.3), 0.75)

        detections.append({
            "type": "door",
            "confidence": round(conf, 3),
            "bbox": [x, y, x + bw, y + bh],
            "source": "opencv_edge",
        })

    logger.info("[OpenCV] Door detections: %d", len(detections))
    return detections


# -------------------------------------------------------
# C. Stairs detector (parallel horizontal lines)
# -------------------------------------------------------

def detect_stairs(
    image_rgb: np.ndarray,
    min_lines: int = 8,
) -> list[dict]:
    """Detect stairs via parallel horizontal line detection.

    Stairs produce many parallel horizontal lines with consistent spacing.
    """
    h, w = image_rgb.shape[:2]
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)

    edges = cv2.Canny(gray, 50, 150)

    # Only look for long, roughly horizontal lines
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=50,
        minLineLength=w * 0.12,
        maxLineGap=10,
    )

    if lines is None or len(lines) < min_lines:
        return []

    # Group lines by y-position (lines on same stairs have similar y)
    horizontal_lines = []
    for line in lines:
        x1, y1, x2, y2 = line[0] if line.ndim == 2 else line
        angle = abs(np.arctan2(y2 - y1, x2 - x1))
        # Must be roughly horizontal (angle < 15 degrees)
        if angle < np.pi / 12:
            avg_y = (y1 + y2) / 2
            avg_x = (x1 + x2) / 2
            length = np.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
            horizontal_lines.append((avg_x, avg_y, length))

    if len(horizontal_lines) < min_lines:
        return []

    # Sort by y-position
    horizontal_lines.sort(key=lambda l: l[1])

    # Find clusters of parallel lines with consistent spacing
    detections: list[dict] = []
    used: set[int] = set()

    for i in range(len(horizontal_lines)):
        if i in used:
            continue

        cluster = [horizontal_lines[i]]
        used.add(i)

        for j in range(i + 1, len(horizontal_lines)):
            if j in used:
                continue
            # Check y-spacing consistency (within 25px)
            gap = horizontal_lines[j][1] - cluster[-1][1]
            if gap < 8 or gap > 50:
                continue
            if len(cluster) >= 2:
                prev_gap = cluster[-1][1] - cluster[-2][1]
                if abs(gap - prev_gap) > 25:
                    continue
            # Lines in same stair cluster should have similar length
            ref_len = cluster[-1][2]
            curr_len = horizontal_lines[j][2]
            if abs(curr_len - ref_len) > ref_len * 0.5:
                continue
            cluster.append(horizontal_lines[j])
            used.add(j)

        if len(cluster) >= min_lines:
            # Compute bounding box of the cluster
            ys = [l[1] for l in cluster]
            xs_min = min(l[0] - l[2] / 2 for l in cluster)
            xs_max = max(l[0] + l[2] / 2 for l in cluster)

            bx = int(max(0, xs_min - 10))
            by = int(max(0, min(ys) - 20))
            bw = int(min(w, xs_max - xs_min + 20))
            bh = int(min(h - by, max(ys) - min(ys) + 40))

            # Stairs must be reasonably large
            if bw < 60 or bh < 60:
                continue

            conf = min(0.25 + len(cluster) * 0.05, 0.70)

            detections.append({
                "type": "stairs",
                "confidence": round(conf, 3),
                "bbox": [bx, by, bx + bw, by + bh],
                "source": "opencv_lines",
            })

    logger.info("[OpenCV] Stairs detections: %d", len(detections))
    return detections


# -------------------------------------------------------
# Run all architectural detectors
# -------------------------------------------------------

def detect_architectural(image_rgb: np.ndarray) -> list[dict]:
    """Run all OpenCV architectural detectors and return combined list."""
    results: list[dict] = []
    results.extend(detect_exit_signs(image_rgb))
    results.extend(detect_doors(image_rgb))
    results.extend(detect_stairs(image_rgb))
    logger.info(
        "[OpenCV] Total architectural detections: %d", len(results)
    )
    return results
