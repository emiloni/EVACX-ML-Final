def infer_layout():

    """
    Demo environment abstraction.

    This represents the navigational structure
    inferred from the visual scene.

    No floor plan is uploaded by the user.
    """

    return {
        "nodes": [
            {
                "id": "start",
                "type": "current_position",
                "label": "YOU ARE HERE",
                "x": 470,
                "y": 480
            },

            {
                "id": "corridor",
                "type": "corridor",
                "label": "CORRIDOR",
                "x": 700,
                "y": 470
            },

            {
                "id": "stairs",
                "type": "stairs",
                "label": "STAIRS",
                "x": 450,
                "y": 350
            },

            {
                "id": "ramp",
                "type": "ramp",
                "label": "ACCESSIBLE RAMP",
                "x": 600,
                "y": 600
            },

            {
                "id": "exit_left",
                "type": "exit",
                "label": "EXIT A",
                "x": 190,
                "y": 290
            },

            {
                "id": "exit_center",
                "type": "exit",
                "label": "EXIT B",
                "x": 710,
                "y": 270
            },

            {
                "id": "exit_right",
                "type": "exit",
                "label": "EXIT C",
                "x": 1150,
                "y": 300
            }
        ],

        "edges": [
            {
                "from": "start",
                "to": "stairs",
                "distance": 20,
                "stairs": True
            },

            {
                "from": "stairs",
                "to": "exit_left",
                "distance": 25,
                "stairs": True
            },

            {
                "from": "start",
                "to": "corridor",
                "distance": 25,
                "stairs": False
            },

            {
                "from": "corridor",
                "to": "exit_center",
                "distance": 30,
                "stairs": False
            },

            {
                "from": "corridor",
                "to": "exit_right",
                "distance": 40,
                "stairs": False
            },

            {
                "from": "start",
                "to": "ramp",
                "distance": 30,
                "stairs": False
            },

            {
                "from": "ramp",
                "to": "exit_right",
                "distance": 35,
                "stairs": False
            }
        ]
    }