"""Flask routes for StoryTeller"""

import uuid
import time
import base64
from pathlib import Path
from functools import wraps
from flask import render_template, request, jsonify, session, redirect, url_for, current_app

from data import app_data, save_data


def file_to_data_uri(file):
    """Convert an uploaded file to a base64 data URI."""
    if not file or not file.filename:
        return None
    
    # Read file content
    content = file.read()
    
    # Determine MIME type from filename
    filename = file.filename.lower()
    if filename.endswith('.png'):
        mime_type = 'image/png'
    elif filename.endswith('.gif'):
        mime_type = 'image/gif'
    elif filename.endswith('.webp'):
        mime_type = 'image/webp'
    elif filename.endswith('.svg'):
        mime_type = 'image/svg+xml'
    else:
        # Default to JPEG for jpg, jpeg, and unknown
        mime_type = 'image/jpeg'
    
    # Encode to base64
    b64_content = base64.b64encode(content).decode('utf-8')
    
    return f"data:{mime_type};base64,{b64_content}"


# Login attempt tracking for exponential backoff
# Structure: {ip_address: {'attempts': count, 'lockout_until': timestamp}}
_login_attempts = {}
_MAX_ATTEMPTS = 5
_BASE_LOCKOUT_SECONDS = 5  # 5, 10, 20, 40, 80... seconds


def _get_client_ip():
    """Get client IP address, considering proxies."""
    # Check for forwarded header (if behind proxy)
    if request.headers.get('X-Forwarded-For'):
        return request.headers.get('X-Forwarded-For').split(',')[0].strip()
    return request.remote_addr or 'unknown'


def _check_login_allowed():
    """Check if login attempt is allowed for this IP. Returns (allowed, wait_seconds)."""
    ip = _get_client_ip()
    now = time.time()
    
    if ip not in _login_attempts:
        return True, 0
    
    attempt_info = _login_attempts[ip]
    
    # Check if currently locked out
    if attempt_info.get('lockout_until', 0) > now:
        wait_seconds = int(attempt_info['lockout_until'] - now) + 1
        return False, wait_seconds
    
    return True, 0


def _record_failed_attempt():
    """Record a failed login attempt and apply exponential backoff if needed."""
    ip = _get_client_ip()
    now = time.time()
    
    if ip not in _login_attempts:
        _login_attempts[ip] = {'attempts': 0, 'lockout_until': 0}
    
    _login_attempts[ip]['attempts'] += 1
    attempts = _login_attempts[ip]['attempts']
    
    # Apply exponential backoff after max attempts
    if attempts >= _MAX_ATTEMPTS:
        # Calculate lockout: 5 * 2^(attempts - MAX_ATTEMPTS) seconds
        # 5th fail: 5s, 6th: 10s, 7th: 20s, 8th: 40s, etc.
        lockout_seconds = _BASE_LOCKOUT_SECONDS * (2 ** (attempts - _MAX_ATTEMPTS))
        # Cap at 1 hour
        lockout_seconds = min(lockout_seconds, 3600)
        _login_attempts[ip]['lockout_until'] = now + lockout_seconds


def _clear_login_attempts():
    """Clear login attempts for current IP after successful login."""
    ip = _get_client_ip()
    if ip in _login_attempts:
        del _login_attempts[ip]


def require_gm(f):
    """Decorator to require GM authentication for a route."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # If no password configured, allow access
        if not current_app.config.get('GM_PASSWORD'):
            return f(*args, **kwargs)
        
        # Check if authenticated
        if not session.get('gm_authenticated'):
            # For API routes, return JSON error
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Authentication required'}), 401
            # For page routes, redirect to login
            return redirect(url_for('gm_login'))
        
        return f(*args, **kwargs)
    return decorated_function


def register_routes(app):
    """Register all Flask routes."""
    
    @app.route('/gm/login', methods=['GET', 'POST'])
    def gm_login():
        """GM login page."""
        # If no password configured, redirect to GM page
        if not current_app.config.get('GM_PASSWORD'):
            return redirect(url_for('game_master'))
        
        # If already authenticated, redirect to GM page
        if session.get('gm_authenticated'):
            return redirect(url_for('game_master'))
        
        error = None
        locked_out = False
        wait_seconds = 0
        
        # Check if IP is locked out
        allowed, wait_seconds = _check_login_allowed()
        if not allowed:
            locked_out = True
            error = f'Too many failed attempts. Please wait {wait_seconds} seconds.'
        
        if request.method == 'POST' and not locked_out:
            password = request.form.get('password', '')
            if password == current_app.config['GM_PASSWORD']:
                session.clear()  # Clear old session to prevent session fixation
                session['gm_authenticated'] = True
                session.permanent = True
                _clear_login_attempts()
                return redirect(url_for('game_master'))
            else:
                _record_failed_attempt()
                # Check if now locked out after this attempt
                allowed, wait_seconds = _check_login_allowed()
                if not allowed:
                    error = f'Invalid password. Too many attempts. Please wait {wait_seconds} seconds.'
                else:
                    error = 'Invalid password'
        
        return render_template('login.html', error=error, locked_out=locked_out, wait_seconds=wait_seconds)
    
    @app.route('/gm/logout')
    def gm_logout():
        """GM logout."""
        session.pop('gm_authenticated', None)
        return redirect(url_for('gm_login'))
    
    @app.route('/')
    @app.route('/gm')
    @require_gm
    def game_master():
        return render_template('gm.html')

    @app.route('/player')
    def player():
        """Redirect to login or show error - direct /player access not allowed."""
        # Players must use a valid link
        return render_template('player.html', player_type=None, player_type_id=None, invalid_link=True)
    
    @app.route('/player/<player_type_id>')
    def player_with_type(player_type_id):
        """Player view for a specific player type or generic link."""
        # Check if this is the generic "All Players" link
        if player_type_id == app_data.get('generic_player_link'):
            return render_template('player.html', player_type=None, player_type_id=player_type_id, invalid_link=False)
        
        # Look up player type name from the ID
        player_links = app_data.get('player_links', {})
        player_type_name = None
        
        for name, link_id in player_links.items():
            if link_id == player_type_id:
                player_type_name = name
                break
        
        # If no matching link found, show invalid link message
        if player_type_name is None:
            return render_template('player.html', player_type=None, player_type_id=None, invalid_link=True)
        
        return render_template('player.html', player_type=player_type_name, player_type_id=player_type_id, invalid_link=False)

    # ============ API: Storylines ============
    
    @app.route('/api/storylines', methods=['GET', 'POST'])
    @require_gm
    def storylines():
        if request.method == 'GET':
            return jsonify(app_data)
        
        data = request.get_json()
        storyline_id = str(uuid.uuid4())
        app_data['storylines'][storyline_id] = {
            'name': data['name'],
            'blocks': [],
            'branches': [],  # List of branch objects
            'current_block': 0,
            'active_branches': []  # IDs of currently playing branches
        }
        app_data['active_storyline'] = storyline_id
        save_data(app_data)
        return jsonify({'id': storyline_id})

    @app.route('/api/storylines/import', methods=['POST'])
    @require_gm
    def import_storylines():
        """Import storylines from a JSON file."""
        data = request.get_json()
        
        if not data or 'storylines' not in data:
            return jsonify({'error': 'Invalid import data: missing storylines'}), 400
        
        imported_storylines = 0
        imported_player_types = 0
        imported_library_items = 0
        
        # Import storylines
        for storyline_id, storyline in data.get('storylines', {}).items():
            # Generate a new ID to avoid conflicts
            new_id = str(uuid.uuid4())
            
            # Ensure required fields exist
            new_storyline = {
                'name': storyline.get('name', 'Imported Storyline'),
                'blocks': storyline.get('blocks', []),
                'branches': storyline.get('branches', []),
                'current_block': 0,
                'active_branches': []
            }
            
            # Reset branch positions
            for branch in new_storyline.get('branches', []):
                branch['current_inject'] = 0
            
            app_data['storylines'][new_id] = new_storyline
            imported_storylines += 1
        
        # Import player types (merge, don't replace)
        if 'player_types' in data:
            if 'player_types' not in app_data:
                app_data['player_types'] = []
            for pt in data['player_types']:
                if pt not in app_data['player_types']:
                    app_data['player_types'].append(pt)
                    imported_player_types += 1
        
        # Import library items (append)
        if 'inject_library' in data:
            if 'inject_library' not in app_data:
                app_data['inject_library'] = []
            for item in data['inject_library']:
                # Generate new ID to avoid conflicts
                item['id'] = str(uuid.uuid4())
                # Clear image references since we don't have the actual files
                item['image'] = None
                if item.get('type') == 'branch':
                    for inject in item.get('injects', []):
                        inject['id'] = str(uuid.uuid4())
                        inject['image'] = None
                app_data['inject_library'].append(item)
                imported_library_items += 1
        
        save_data(app_data)
        
        return jsonify({
            'success': True,
            'imported_storylines': imported_storylines,
            'imported_player_types': imported_player_types,
            'imported_library_items': imported_library_items
        })

    @app.route('/api/storylines/activate', methods=['POST'])
    @require_gm
    def activate_storyline():
        data = request.get_json()
        storyline_id = data['storyline_id']
        app_data['active_storyline'] = storyline_id
        
        # Reset storyline to start (same as "Reset to Start" button)
        if storyline_id in app_data['storylines']:
            storyline = app_data['storylines'][storyline_id]
            storyline['current_block'] = 0
            storyline['active_branches'] = []
            
            # Reset all branch positions
            for branch in storyline.get('branches', []):
                branch['current_inject'] = 0
        
        app_data['current_block'] = 0
        save_data(app_data)
        # Note: broadcast_current_block() called from socket_handlers
        return jsonify({'success': True})

    @app.route('/api/storylines/<storyline_id>', methods=['GET', 'PUT', 'DELETE'])
    @require_gm
    def storyline(storyline_id):
        if request.method == 'GET':
            storyline = app_data['storylines'].get(storyline_id, {})
            # Ensure branch fields exist for backward compatibility
            if 'branches' not in storyline:
                storyline['branches'] = []
            if 'active_branches' not in storyline:
                storyline['active_branches'] = []
            return jsonify(storyline)
        
        elif request.method == 'PUT':
            data = request.get_json()
            if storyline_id in app_data['storylines']:
                app_data['storylines'][storyline_id]['name'] = data['name']
                save_data(app_data)
            return jsonify({'success': True})
        
        elif request.method == 'DELETE':
            if storyline_id in app_data['storylines']:
                del app_data['storylines'][storyline_id]
                if app_data['active_storyline'] == storyline_id:
                    app_data['active_storyline'] = None
                save_data(app_data)
            return jsonify({'success': True})

    # ============ API: Injects (Blocks) ============
    
    @app.route('/api/blocks', methods=['POST'])
    @require_gm
    def create_block():
        """Create a new inject."""
        storyline_id = request.form.get('storyline_id')
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        # Parse duration (in seconds), default to 0 (no auto-advance)
        duration = 0
        try:
            duration = int(request.form.get('duration', 0) or 0)
        except ValueError:
            pass
        
        # Parse day (integer, 0 = not set)
        day = 0
        try:
            day = int(request.form.get('day', 0) or 0)
        except ValueError:
            pass
        
        # Parse time (HH:MM format, empty = not set)
        time_value = request.form.get('time', '').strip()
        
        # Parse target_player_types
        target_player_types = []
        try:
            import json
            tpt = request.form.get('target_player_types', '[]')
            target_player_types = json.loads(tpt) if tpt else []
        except (json.JSONDecodeError, ValueError):
            pass
        
        block = {
            'id': str(uuid.uuid4()),
            'heading': request.form.get('heading', ''),
            'text': request.form.get('text', ''),
            'gm_notes': request.form.get('gm_notes', ''),
            'duration': duration,
            'day': day,
            'time': time_value,
            'target_player_types': target_player_types,
            'image': None
        }
        
        if 'image' in request.files:
            file = request.files['image']
            if file.filename:
                block['image'] = file_to_data_uri(file)
        
        app_data['storylines'][storyline_id]['blocks'].append(block)
        save_data(app_data)
        return jsonify(block)

    @app.route('/api/blocks/<storyline_id>/<block_id>', methods=['GET', 'POST', 'DELETE'])
    @require_gm
    def block(storyline_id, block_id):
        """Get, update, or delete an inject."""
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        blocks = app_data['storylines'][storyline_id]['blocks']
        block_idx = next((i for i, b in enumerate(blocks) if b['id'] == block_id), None)
        
        if block_idx is None:
            return jsonify({'error': 'Inject not found'}), 404
        
        if request.method == 'GET':
            return jsonify(blocks[block_idx])
        
        elif request.method == 'POST':
            block = blocks[block_idx]
            block['heading'] = request.form.get('heading', block['heading'])
            block['text'] = request.form.get('text', block['text'])
            block['gm_notes'] = request.form.get('gm_notes', block.get('gm_notes', ''))
            
            # Parse duration
            try:
                block['duration'] = int(request.form.get('duration', 0) or 0)
            except ValueError:
                block['duration'] = 0
            
            # Parse day
            try:
                block['day'] = int(request.form.get('day', 0) or 0)
            except ValueError:
                block['day'] = 0
            
            # Parse time
            block['time'] = request.form.get('time', '').strip()
            
            # Parse target_player_types
            try:
                import json
                tpt = request.form.get('target_player_types', '[]')
                block['target_player_types'] = json.loads(tpt) if tpt else []
            except (json.JSONDecodeError, ValueError):
                block['target_player_types'] = []
            
            if 'image' in request.files:
                file = request.files['image']
                if file.filename:
                    block['image'] = file_to_data_uri(file)
            elif not request.form.get('existing_image'):
                # Remove image if cleared
                block['image'] = None
            
            save_data(app_data)
            return jsonify(block)
        
        elif request.method == 'DELETE':
            blocks.pop(block_idx)
            
            # Adjust current inject index if needed
            current = app_data['storylines'][storyline_id].get('current_block', 0)
            if current >= len(blocks):
                app_data['storylines'][storyline_id]['current_block'] = max(0, len(blocks) - 1)
            
            save_data(app_data)
            return jsonify({'success': True})

    @app.route('/api/blocks/reorder', methods=['POST'])
    @require_gm
    def reorder_blocks():
        data = request.get_json()
        storyline_id = data['storyline_id']
        order = data['order']
        
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        blocks = app_data['storylines'][storyline_id]['blocks']
        block_map = {b['id']: b for b in blocks}
        app_data['storylines'][storyline_id]['blocks'] = [
            block_map[bid] for bid in order if bid in block_map
        ]
        save_data(app_data)
        return jsonify({'success': True})

    # ============ API: Branches ============
    
    @app.route('/api/branches', methods=['POST'])
    @require_gm
    def create_branch():
        """Create a new branch attached to an inject."""
        data = request.get_json()
        storyline_id = data.get('storyline_id')
        parent_inject_id = data.get('parent_inject_id')
        auto_trigger = data.get('auto_trigger', False)
        
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        storyline = app_data['storylines'][storyline_id]
        
        # Ensure branches list exists
        if 'branches' not in storyline:
            storyline['branches'] = []
        if 'active_branches' not in storyline:
            storyline['active_branches'] = []
        
        # Get existing branches for this inject
        existing_branches = [b for b in storyline['branches'] if b['parent_inject_id'] == parent_inject_id]
        
        if existing_branches:
            # Inject already has branches
            existing_auto = next((b for b in existing_branches if b.get('auto_trigger')), None)
            
            if existing_auto:
                # Can't add any branch to an inject that has an auto-trigger branch
                return jsonify({'error': 'Cannot add branch: this inject has an auto-trigger branch which must be the only branch.'}), 400
            
            if auto_trigger:
                # Can't add auto-trigger branch when other branches exist
                return jsonify({'error': 'Cannot create auto-trigger branch: this inject already has other branches. Use manual trigger instead.'}), 400
        
        branch = {
            'id': str(uuid.uuid4()),
            'name': data.get('name', 'New Branch'),
            'parent_inject_id': parent_inject_id,
            'auto_trigger': auto_trigger,
            'merge_to_inject_id': data.get('merge_to_inject_id'),  # ID of inject to skip to after branch
            'injects': [],
            'current_inject': 0
        }
        
        storyline['branches'].append(branch)
        save_data(app_data)
        return jsonify(branch)

    @app.route('/api/branches/<storyline_id>/<branch_id>', methods=['GET', 'PUT', 'DELETE'])
    @require_gm
    def branch(storyline_id, branch_id):
        """Get, update, or delete a branch."""
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        storyline = app_data['storylines'][storyline_id]
        branches = storyline.get('branches', [])
        branch_idx = next((i for i, b in enumerate(branches) if b['id'] == branch_id), None)
        
        if branch_idx is None:
            return jsonify({'error': 'Branch not found'}), 404
        
        if request.method == 'GET':
            return jsonify(branches[branch_idx])
        
        elif request.method == 'PUT':
            data = request.get_json()
            branch = branches[branch_idx]
            
            new_auto_trigger = data.get('auto_trigger', branch.get('auto_trigger', False))
            new_parent_id = data.get('parent_inject_id', branch.get('parent_inject_id'))
            
            # Get other branches on the same inject (excluding this one)
            other_branches = [b for b in branches 
                             if b['parent_inject_id'] == new_parent_id 
                             and b['id'] != branch_id]
            
            if new_auto_trigger and other_branches:
                # Can't enable auto-trigger when other branches exist on same inject
                return jsonify({'error': 'Cannot enable auto-trigger: this inject has other branches. Auto-trigger branches must be the only branch on an inject.'}), 400
            
            if 'name' in data:
                branch['name'] = data['name']
            if 'auto_trigger' in data:
                branch['auto_trigger'] = data['auto_trigger']
            if 'parent_inject_id' in data:
                branch['parent_inject_id'] = data['parent_inject_id']
            if 'merge_to_inject_id' in data:
                branch['merge_to_inject_id'] = data['merge_to_inject_id']
            save_data(app_data)
            return jsonify(branch)
        
        elif request.method == 'DELETE':
            # Remove from active branches if present
            if branch_id in storyline.get('active_branches', []):
                storyline['active_branches'].remove(branch_id)
            
            branches.pop(branch_idx)
            save_data(app_data)
            return jsonify({'success': True})

    @app.route('/api/branches/<storyline_id>/<branch_id>/activate', methods=['POST'])
    @require_gm
    def activate_branch(storyline_id, branch_id):
        """Manually activate a branch."""
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        storyline = app_data['storylines'][storyline_id]
        branches = storyline.get('branches', [])
        branch = next((b for b in branches if b['id'] == branch_id), None)
        
        if not branch:
            return jsonify({'error': 'Branch not found'}), 404
        
        if 'active_branches' not in storyline:
            storyline['active_branches'] = []
        
        if branch_id not in storyline['active_branches']:
            storyline['active_branches'].append(branch_id)
            branch['current_inject'] = 0
        
        save_data(app_data)
        return jsonify({'success': True})

    @app.route('/api/branches/<storyline_id>/<branch_id>/deactivate', methods=['POST'])
    @require_gm
    def deactivate_branch(storyline_id, branch_id):
        """Deactivate a branch."""
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        storyline = app_data['storylines'][storyline_id]
        
        if branch_id in storyline.get('active_branches', []):
            storyline['active_branches'].remove(branch_id)
        
        save_data(app_data)
        return jsonify({'success': True})

    # ============ API: Branch Injects ============
    
    @app.route('/api/branches/<storyline_id>/<branch_id>/injects', methods=['POST'])
    @require_gm
    def create_branch_inject(storyline_id, branch_id):
        """Create a new inject in a branch."""
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        storyline = app_data['storylines'][storyline_id]
        branch = next((b for b in storyline.get('branches', []) if b['id'] == branch_id), None)
        
        if not branch:
            return jsonify({'error': 'Branch not found'}), 404
        
        duration = 0
        try:
            duration = int(request.form.get('duration', 0) or 0)
        except ValueError:
            pass
        
        # Parse day
        day = 0
        try:
            day = int(request.form.get('day', 0) or 0)
        except ValueError:
            pass
        
        # Parse time
        time_value = request.form.get('time', '').strip()
        
        # Parse target_player_types
        target_player_types = []
        try:
            import json
            tpt = request.form.get('target_player_types', '[]')
            target_player_types = json.loads(tpt) if tpt else []
        except (json.JSONDecodeError, ValueError):
            pass
        
        inject = {
            'id': str(uuid.uuid4()),
            'heading': request.form.get('heading', ''),
            'text': request.form.get('text', ''),
            'gm_notes': request.form.get('gm_notes', ''),
            'duration': duration,
            'day': day,
            'time': time_value,
            'target_player_types': target_player_types,
            'image': None
        }
        
        if 'image' in request.files:
            file = request.files['image']
            if file.filename:
                inject['image'] = file_to_data_uri(file)
        
        branch['injects'].append(inject)
        save_data(app_data)
        return jsonify(inject)

    @app.route('/api/branches/<storyline_id>/<branch_id>/injects/<inject_id>', methods=['GET', 'POST', 'DELETE'])
    @require_gm
    def branch_inject(storyline_id, branch_id, inject_id):
        """Get, update, or delete a branch inject."""
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        storyline = app_data['storylines'][storyline_id]
        branch = next((b for b in storyline.get('branches', []) if b['id'] == branch_id), None)
        
        if not branch:
            return jsonify({'error': 'Branch not found'}), 404
        
        injects = branch.get('injects', [])
        inject_idx = next((i for i, inj in enumerate(injects) if inj['id'] == inject_id), None)
        
        if inject_idx is None:
            return jsonify({'error': 'Inject not found'}), 404
        
        if request.method == 'GET':
            return jsonify(injects[inject_idx])
        
        elif request.method == 'POST':
            inject = injects[inject_idx]
            inject['heading'] = request.form.get('heading', inject['heading'])
            inject['text'] = request.form.get('text', inject['text'])
            inject['gm_notes'] = request.form.get('gm_notes', inject.get('gm_notes', ''))
            
            try:
                inject['duration'] = int(request.form.get('duration', 0) or 0)
            except ValueError:
                inject['duration'] = 0
            
            # Parse day
            try:
                inject['day'] = int(request.form.get('day', 0) or 0)
            except ValueError:
                inject['day'] = 0
            
            # Parse time
            inject['time'] = request.form.get('time', '').strip()
            
            # Parse target_player_types
            try:
                import json
                tpt = request.form.get('target_player_types', '[]')
                inject['target_player_types'] = json.loads(tpt) if tpt else []
            except (json.JSONDecodeError, ValueError):
                inject['target_player_types'] = []
            
            if 'image' in request.files:
                file = request.files['image']
                if file.filename:
                    inject['image'] = file_to_data_uri(file)
            elif not request.form.get('existing_image'):
                inject['image'] = None
            
            save_data(app_data)
            return jsonify(inject)
        
        elif request.method == 'DELETE':
            injects.pop(inject_idx)
            
            if branch['current_inject'] >= len(injects):
                branch['current_inject'] = max(0, len(injects) - 1)
            
            save_data(app_data)
            return jsonify({'success': True})

    @app.route('/api/branches/<storyline_id>/<branch_id>/reorder', methods=['POST'])
    @require_gm
    def reorder_branch_injects(storyline_id, branch_id):
        """Reorder injects within a branch."""
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        storyline = app_data['storylines'][storyline_id]
        branch = next((b for b in storyline.get('branches', []) if b['id'] == branch_id), None)
        
        if not branch:
            return jsonify({'error': 'Branch not found'}), 404
        
        data = request.get_json()
        order = data.get('order', [])
        
        injects = branch.get('injects', [])
        inject_map = {inj['id']: inj for inj in injects}
        branch['injects'] = [inject_map[iid] for iid in order if iid in inject_map]
        
        save_data(app_data)
        return jsonify({'success': True})

    # ============ API: Player Types ============
    
    @app.route('/api/player-types', methods=['GET', 'POST'])
    @require_gm
    def player_types():
        """Get all player types or add a new one."""
        if request.method == 'GET':
            return jsonify({'player_types': app_data.get('player_types', [])})
        
        elif request.method == 'POST':
            data = request.get_json()
            name = data.get('name', '').strip()
            
            if not name:
                return jsonify({'error': 'Name is required'}), 400
            
            if 'player_types' not in app_data:
                app_data['player_types'] = []
            
            # Check for duplicates
            if name in app_data['player_types']:
                return jsonify({'error': 'Player type already exists'}), 400
            
            app_data['player_types'].append(name)
            save_data(app_data)
            return jsonify({'success': True, 'player_types': app_data['player_types']})
    
    @app.route('/api/player-types/<path:name>', methods=['DELETE'])
    @require_gm
    def delete_player_type(name):
        """Delete a player type and clean up all references."""
        if 'player_types' not in app_data:
            app_data['player_types'] = []
        
        if name in app_data['player_types']:
            app_data['player_types'].remove(name)
            
            # Remove the player link for this type
            if 'player_links' in app_data and name in app_data['player_links']:
                del app_data['player_links'][name]
            
            # Clean up target_player_types in all injects across all storylines
            for storyline_id, storyline in app_data.get('storylines', {}).items():
                # Clean main blocks/injects
                for block in storyline.get('blocks', []):
                    if 'target_player_types' in block and name in block['target_player_types']:
                        block['target_player_types'].remove(name)
                
                # Clean branch injects
                for branch in storyline.get('branches', []):
                    for inject in branch.get('injects', []):
                        if 'target_player_types' in inject and name in inject['target_player_types']:
                            inject['target_player_types'].remove(name)
            
            save_data(app_data)
        
        return jsonify({'success': True, 'player_types': app_data['player_types']})
    
    @app.route('/api/player-links', methods=['GET', 'POST'])
    @require_gm
    def player_links():
        """Get or generate player links for all player types."""
        import secrets
        
        if request.method == 'GET':
            return jsonify({
                'player_links': app_data.get('player_links', {}),
                'player_types': app_data.get('player_types', []),
                'generic_player_link': app_data.get('generic_player_link')
            })
        
        elif request.method == 'POST':
            data = request.get_json() or {}
            regenerate = data.get('regenerate', False)
            
            if 'player_links' not in app_data:
                app_data['player_links'] = {}
            
            # Generate or regenerate generic "All Players" link
            if regenerate or not app_data.get('generic_player_link'):
                app_data['generic_player_link'] = secrets.token_hex(8)
            
            # Generate or regenerate links for all player types
            for pt in app_data.get('player_types', []):
                if regenerate or pt not in app_data['player_links']:
                    app_data['player_links'][pt] = secrets.token_hex(8)
            
            save_data(app_data)
            return jsonify({
                'success': True,
                'player_links': app_data['player_links'],
                'player_types': app_data.get('player_types', []),
                'generic_player_link': app_data.get('generic_player_link')
            })

    # ============ API: Inject Library ============
    
    @app.route('/api/library', methods=['GET'])
    @require_gm
    def get_library():
        """Get all injects in the library."""
        return jsonify({'library': app_data.get('inject_library', [])})
    
    @app.route('/api/library', methods=['POST'])
    @require_gm
    def add_to_library():
        """Add a new inject to the library."""
        if 'inject_library' not in app_data:
            app_data['inject_library'] = []
        
        # Parse duration
        duration = 0
        try:
            duration = int(request.form.get('duration', 0) or 0)
        except ValueError:
            pass
        
        # Parse day
        day = 0
        try:
            day = int(request.form.get('day', 0) or 0)
        except ValueError:
            pass
        
        # Parse time
        time_value = request.form.get('time', '').strip()
        
        # Parse target_player_types
        target_player_types = []
        try:
            import json
            tpt = request.form.get('target_player_types', '[]')
            target_player_types = json.loads(tpt) if tpt else []
        except (json.JSONDecodeError, ValueError):
            pass
        
        library_inject = {
            'id': str(uuid.uuid4()),
            'heading': request.form.get('heading', ''),
            'text': request.form.get('text', ''),
            'gm_notes': request.form.get('gm_notes', ''),
            'duration': duration,
            'day': day,
            'time': time_value,
            'target_player_types': target_player_types,
            'image': None
        }
        
        if 'image' in request.files:
            file = request.files['image']
            if file.filename:
                library_inject['image'] = file_to_data_uri(file)
        elif request.form.get('copy_image_from'):
            # Copy existing image data URI from storyline inject
            library_inject['image'] = request.form.get('copy_image_from')
        
        app_data['inject_library'].append(library_inject)
        save_data(app_data)
        return jsonify(library_inject)
    
    @app.route('/api/library/<inject_id>', methods=['GET', 'POST', 'DELETE'])
    @require_gm
    def library_inject(inject_id):
        """Get, update, or delete a library inject."""
        if 'inject_library' not in app_data:
            app_data['inject_library'] = []
        
        inject_idx = next((i for i, inj in enumerate(app_data['inject_library']) if inj['id'] == inject_id), None)
        
        if inject_idx is None:
            return jsonify({'error': 'Library inject not found'}), 404
        
        if request.method == 'GET':
            return jsonify(app_data['inject_library'][inject_idx])
        
        elif request.method == 'POST':
            inject = app_data['inject_library'][inject_idx]
            inject['heading'] = request.form.get('heading', inject['heading'])
            inject['text'] = request.form.get('text', inject['text'])
            inject['gm_notes'] = request.form.get('gm_notes', inject.get('gm_notes', ''))
            
            try:
                inject['duration'] = int(request.form.get('duration', inject.get('duration', 0)) or 0)
            except ValueError:
                pass
            
            # Parse target_player_types
            try:
                import json
                tpt = request.form.get('target_player_types', '[]')
                inject['target_player_types'] = json.loads(tpt) if tpt else []
            except (json.JSONDecodeError, ValueError):
                pass
            
            if 'image' in request.files:
                file = request.files['image']
                if file.filename:
                    inject['image'] = file_to_data_uri(file)
            
            save_data(app_data)
            return jsonify(inject)
        
        elif request.method == 'DELETE':
            del app_data['inject_library'][inject_idx]
            save_data(app_data)
            return jsonify({'success': True})
    
    @app.route('/api/library/<inject_id>/add-to-storyline', methods=['POST'])
    @require_gm
    def add_library_inject_to_storyline(inject_id):
        """Add a copy of a library inject to a storyline."""
        data = request.get_json()
        storyline_id = data.get('storyline_id')
        position = data.get('position')  # Optional: index to insert at
        
        if not storyline_id or storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        # Find library inject
        library_inject = next((inj for inj in app_data.get('inject_library', []) if inj['id'] == inject_id), None)
        if not library_inject:
            return jsonify({'error': 'Library inject not found'}), 404
        
        # Create a copy with new ID
        new_inject = {
            'id': str(uuid.uuid4()),
            'heading': library_inject['heading'],
            'text': library_inject['text'],
            'gm_notes': library_inject.get('gm_notes', ''),
            'duration': library_inject.get('duration', 0),
            'day': library_inject.get('day', 0),
            'time': library_inject.get('time', ''),
            'target_player_types': library_inject.get('target_player_types', []).copy(),
            'image': library_inject.get('image')  # Data URI can be copied directly
        }
        
        blocks = app_data['storylines'][storyline_id]['blocks']
        if position is not None and 0 <= position <= len(blocks):
            blocks.insert(position, new_inject)
        else:
            blocks.append(new_inject)
        
        save_data(app_data)
        return jsonify(new_inject)
    
    @app.route('/api/library/<inject_id>/add-to-branch', methods=['POST'])
    @require_gm
    def add_library_inject_to_branch(inject_id):
        """Add a copy of a library inject to a branch."""
        data = request.get_json()
        storyline_id = data.get('storyline_id')
        branch_id = data.get('branch_id')
        position = data.get('position')  # Optional: index to insert at
        
        if not storyline_id or storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        storyline = app_data['storylines'][storyline_id]
        branch = next((b for b in storyline.get('branches', []) if b['id'] == branch_id), None)
        
        if not branch:
            return jsonify({'error': 'Branch not found'}), 404
        
        # Find library inject
        library_inject = next((inj for inj in app_data.get('inject_library', []) if inj['id'] == inject_id), None)
        if not library_inject:
            return jsonify({'error': 'Library inject not found'}), 404
        
        # Create a copy with new ID
        new_inject = {
            'id': str(uuid.uuid4()),
            'heading': library_inject['heading'],
            'text': library_inject['text'],
            'gm_notes': library_inject.get('gm_notes', ''),
            'duration': library_inject.get('duration', 0),
            'day': library_inject.get('day', 0),
            'time': library_inject.get('time', ''),
            'target_player_types': library_inject.get('target_player_types', []).copy(),
            'image': library_inject.get('image')  # Data URI can be copied directly
        }
        
        if 'injects' not in branch:
            branch['injects'] = []
        
        if position is not None and 0 <= position <= len(branch['injects']):
            branch['injects'].insert(position, new_inject)
        else:
            branch['injects'].append(new_inject)
        
        save_data(app_data)
        return jsonify(new_inject)
    
    @app.route('/api/branches/<storyline_id>/<branch_id>/save-to-library', methods=['POST'])
    @require_gm
    def save_branch_to_library(storyline_id, branch_id):
        """Save a branch with all its injects to the library as a group."""
        if storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        storyline = app_data['storylines'][storyline_id]
        branch = next((b for b in storyline.get('branches', []) if b['id'] == branch_id), None)
        
        if not branch:
            return jsonify({'error': 'Branch not found'}), 404
        
        if 'inject_library' not in app_data:
            app_data['inject_library'] = []
        
        # Create copies of all injects with new IDs
        library_injects = []
        for inject in branch.get('injects', []):
            library_inject = {
                'id': str(uuid.uuid4()),
                'heading': inject.get('heading', ''),
                'text': inject.get('text', ''),
                'gm_notes': inject.get('gm_notes', ''),
                'duration': inject.get('duration', 0),
                'target_player_types': inject.get('target_player_types', []).copy(),
                'image': inject.get('image')  # Data URI can be copied directly
            }
            library_injects.append(library_inject)
        
        # Save as a branch group in the library
        library_branch = {
            'id': str(uuid.uuid4()),
            'type': 'branch',
            'name': branch.get('name', 'Unnamed Branch'),
            'auto_trigger': branch.get('auto_trigger', True),
            'injects': library_injects
        }
        
        app_data['inject_library'].append(library_branch)
        save_data(app_data)
        return jsonify({'success': True, 'saved_count': len(library_injects)})
    
    @app.route('/api/library/<library_id>/add-branch-to-storyline', methods=['POST'])
    @require_gm
    def add_library_branch_to_storyline(library_id):
        """Add a copy of a library branch to a storyline."""
        data = request.get_json()
        storyline_id = data.get('storyline_id')
        parent_inject_id = data.get('parent_inject_id')
        
        if not storyline_id or storyline_id not in app_data['storylines']:
            return jsonify({'error': 'Storyline not found'}), 404
        
        if not parent_inject_id:
            return jsonify({'error': 'Parent inject ID required'}), 400
        
        # Find library branch
        library_branch = next((item for item in app_data.get('inject_library', []) 
                               if item['id'] == library_id and item.get('type') == 'branch'), None)
        if not library_branch:
            return jsonify({'error': 'Library branch not found'}), 404
        
        storyline = app_data['storylines'][storyline_id]
        
        # Create copies of all injects with new IDs
        new_injects = []
        for inject in library_branch.get('injects', []):
            new_inject = {
                'id': str(uuid.uuid4()),
                'heading': inject.get('heading', ''),
                'text': inject.get('text', ''),
                'gm_notes': inject.get('gm_notes', ''),
                'duration': inject.get('duration', 0),
                'target_player_types': inject.get('target_player_types', []).copy(),
                'image': inject.get('image')  # Data URI can be copied directly
            }
            new_injects.append(new_inject)
        
        # Create the new branch
        new_branch = {
            'id': str(uuid.uuid4()),
            'name': library_branch.get('name', 'Branch from Library'),
            'parent_inject_id': parent_inject_id,
            'auto_trigger': library_branch.get('auto_trigger', True),
            'merge_to_inject_id': None,
            'current_inject': 0,
            'injects': new_injects
        }
        
        if 'branches' not in storyline:
            storyline['branches'] = []
        storyline['branches'].append(new_branch)
        
        save_data(app_data)
        return jsonify(new_branch)
