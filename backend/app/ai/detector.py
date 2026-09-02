from ultralytics import YOLOWorld
import cv2
import numpy as np


class EnvironmentDetector:

    def __init__(self):

        print("Loading YOLO-World...")

        # Better current model for custom vocabulary
        self.model = YOLOWorld("yolov8s-worldv2.pt")

        # Use concrete visual descriptions.
        # These generally work better than abstract concepts.
        self.classes = [
            "person",
            "door",
            "doorway",
            "room door",
            "office door",
            "wooden door",
            "glass door",
            "entrance",
            "exit door",
            "emergency exit",
            "exit sign",
            "fire exit sign",
            "stairs",
            "staircase",
            "stairway",
            "ramp",
            "wheelchair ramp",
            "elevator",
            "lift",
            "corridor",
            "hallway",
            "fire",
            "flames",
            "smoke",
            "obstacle",
            "blocked passage",
            "fire extinguisher"
        ]

        self.model.set_classes(self.classes)

        print("YOLO-World ready.")

    def _preprocess(self, image: np.ndarray) -> np.ndarray:
        """Enhance image for better detection of interior features.

        CLAHE contrast boost helps dark doors on white walls.
        Bilateral filter preserves edges while reducing noise.
        """
        lab = cv2.cvtColor(image, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        l = clahe.apply(l)
        enhanced = cv2.cvtColor(
            cv2.merge([l, a, b]), cv2.COLOR_LAB2RGB
        )
        enhanced = cv2.bilateralFilter(enhanced, 9, 75, 75)
        return enhanced

    def analyze(self, image):

        # Preprocess to improve detection of interior features
        image = self._preprocess(image)

        results = self.model.predict(
            image,
            conf=0.03,
            iou=0.45,
            imgsz=1280,
            verbose=False
        )

        detections = []

        result = results[0]

        if result.boxes is None:
            return detections

        for box in result.boxes:

            xyxy = box.xyxy[0].cpu().numpy()

            confidence = float(
                box.conf[0].cpu().numpy()
            )

            class_id = int(
                box.cls[0].cpu().numpy()
            )

            # IMPORTANT:
            # Use the model's actual class mapping.
            class_name = self.classes[class_id]

            x1, y1, x2, y2 = map(
                int,
                xyxy
            )

            detections.append({
                "type": class_name,
                "confidence": round(
                    confidence,
                    3
                ),
                "bbox": [
                    x1,
                    y1,
                    x2,
                    y2
                ]
            })

        return detections