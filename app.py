#!/usr/bin/env python3
"""
StoryTeller - Main Application Entry Point
Run with: python app.py [--password <gm_password>]
"""

import argparse
import subprocess
import sys
import signal
import secrets

# Dependency check
REQUIRED = {'flask': 'flask', 'flask_socketio': 'flask-socketio', 'werkzeug': 'werkzeug'}
missing = [pkg for mod, pkg in REQUIRED.items() if not __import__(mod, globals(), locals(), [], 0) or False]
# Simple import test
for mod in REQUIRED:
    try:
        __import__(mod)
    except ImportError:
        missing.append(REQUIRED[mod])

if missing:
    print(f"Installing: {', '.join(set(missing))}")
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--break-system-packages', *set(missing)])
    print("Restart the application.")
    sys.exit(0)

from flask import Flask
from flask_socketio import SocketIO

from config import DATA_DIR
from data import load_data, save_data, app_data
from routes import register_routes
from socket_handlers import register_socket_handlers

def create_app(gm_password=None):
    """Create and configure the Flask application."""
    app = Flask(__name__)
    app.config['SECRET_KEY'] = secrets.token_hex(32)
    app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB
    app.config['GM_PASSWORD'] = gm_password  # None means no auth required
    
    return app

def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    print("\n\nShutting down gracefully...")
    sys.exit(0)

if __name__ == '__main__':
    # Parse command line arguments
    parser = argparse.ArgumentParser(description='StoryTeller - Game Master Tool')
    parser.add_argument('--password', '-p', type=str, default=None,
                        help='GM password for authentication (optional)')
    args = parser.parse_args()
    
    # Create app with password config
    app = create_app(gm_password=args.password)
    socketio = SocketIO(app, cors_allowed_origins="*")
    
    # Register routes and socket handlers
    register_routes(app)
    register_socket_handlers(socketio, app)
    
    # Register signal handler for clean exit
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    print("\n" + "="*60)
    print("  STORYTELLER - Game Master Tool")
    print("="*60)
    print(f"\n  Data directory: {DATA_DIR}")
    print(f"\n  Game Master: http://localhost:5000/gm")
    print(f"  Player:      http://localhost:5000/player")
    if args.password:
        print(f"\n  GM Password:  ENABLED")
    else:
        print(f"\n  GM Password:  DISABLED (use --password to enable)")
    print("\n  Press Ctrl+C to stop")
    print("="*60 + "\n")
    
    try:
        socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)
    except KeyboardInterrupt:
        print("\n\nShutting down gracefully...")
    except SystemExit:
        pass
