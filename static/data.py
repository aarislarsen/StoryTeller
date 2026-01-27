"""Data management for StoryTeller"""

import json
from config import DATA_FILE

def load_data():
    """Load storylines from JSON file."""
    if DATA_FILE.exists():
        try:
            with open(DATA_FILE, 'r') as f:
                data = json.load(f)
                # Ensure player_types exists
                if 'player_types' not in data:
                    data['player_types'] = []
                # Ensure inject_library exists
                if 'inject_library' not in data:
                    data['inject_library'] = []
                # Clear active storyline on startup - GM must explicitly activate one
                data['active_storyline'] = None
                return data
        except (json.JSONDecodeError, IOError):
            pass
    return {'storylines': {}, 'active_storyline': None, 'current_block': 0, 'player_types': [], 'inject_library': []}

def save_data(data):
    """Save storylines to JSON file."""
    with open(DATA_FILE, 'w') as f:
        json.dump(data, f, indent=2)

# Global app data - loaded once at startup
app_data = load_data()
