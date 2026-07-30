#!/usr/bin/env python3
"""
StoryTeller - Main Application Entry Point
Run with: python app.py [--password <gm_password>]
"""

import subprocess
import sys
import warnings

# Eventlet is imported below (and again by flask-socketio); silence its
# "Eventlet is deprecated" DeprecationWarning so startup output stays clean.
# Matched by message because eventlet raises it with stacklevel pointing here.
warnings.filterwarnings('ignore', category=DeprecationWarning,
                        message=r'(?s)^\s*Eventlet is deprecated')

# Dependency check - install missing packages before importing them
REQUIRED = {
    'flask': 'flask',
    'flask_socketio': 'flask-socketio',
    'werkzeug': 'werkzeug',
    'eventlet': 'eventlet'
}

missing = []
for mod, pkg in REQUIRED.items():
    try:
        __import__(mod)
    except ImportError:
        missing.append(pkg)

if missing:
    print(f"Installing missing dependencies: {', '.join(missing)}")
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', *missing])
    print("Dependencies installed. Restarting...")
    # Re-exec the script to pick up newly installed packages
    import os
    os.execv(sys.executable, [sys.executable] + sys.argv)

import argparse
import re
import signal
import secrets

from flask import Flask
from flask_socketio import SocketIO

from config import DATA_DIR
from routes import register_routes
from socket_handlers import register_socket_handlers


# Control chars (excluding tab/newline/carriage-return) signal a non-HTTP probe,
# e.g. an HTTPS/TLS handshake hitting our plaintext port.
_CTRL_CHARS = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')


def _is_console_noise(line):
    """True for the 'Bad request' spam produced when junk/TLS hits the HTTP port."""
    if 'Bad request' in line or 'code 400, message' in line:
        return True
    # The follow-up line echoes the raw (binary) request line verbatim.
    return bool(_CTRL_CHARS.search(line))


class _FilteredStderr:
    """Line-buffering stderr wrapper that drops malformed-request noise while
    passing every other message through untouched. Installed once at startup so
    it catches output whether it arrives via the logging module or a direct
    stderr write."""

    def __init__(self, real):
        self._real = real
        self._buf = ''

    def write(self, text):
        self._buf += text
        while '\n' in self._buf:
            line, self._buf = self._buf.split('\n', 1)
            if not _is_console_noise(line):
                self._real.write(line + '\n')
        return len(text)

    def flush(self):
        self._real.flush()

    def __getattr__(self, name):
        return getattr(self._real, name)


def install_console_filter():
    """Silence 'Bad request' / TLS-probe log spam on the console."""
    if not isinstance(sys.stderr, _FilteredStderr):
        sys.stderr = _FilteredStderr(sys.stderr)

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
    
    # Keep the console clean: drop TLS/garbage-probe "Bad request" spam.
    install_console_filter()

    # Create app with password config
    app = create_app(gm_password=args.password)
    socketio = SocketIO(app, cors_allowed_origins="*")
    
    # Register routes and socket handlers
    register_routes(app, socketio)
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
