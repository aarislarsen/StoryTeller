"""Configuration constants for StoryTeller"""

from pathlib import Path

# Data storage paths
DATA_DIR = Path(__file__).parent / 'storyline_data'
DATA_FILE = DATA_DIR / 'storylines.json'

# Ensure directories exist
DATA_DIR.mkdir(exist_ok=True)
