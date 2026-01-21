"""Socket.IO event handlers for StoryTeller with branch support"""

from flask import request
from data import app_data, save_data

# Playback state
playback = {
    'playing': False,
    'remaining': 0,
    'current_source': 'main',  # 'main' or branch_id - what's currently showing
}

# Track last shown inject per player type (for when inject is targeted to others)
# Key: player_type (or '__generic__' for no type), Value: inject data
last_shown_inject = {}

# Global reference to socketio
_socketio = None


def get_storyline():
    """Get the active storyline or None."""
    storyline_id = app_data.get('active_storyline')
    if storyline_id and storyline_id in app_data['storylines']:
        return app_data['storylines'][storyline_id], storyline_id
    return None, None


def get_current_inject():
    """
    Get the current inject to show to players.
    Always show main storyline inject first, then branch injects.
    Returns: (inject, source_type, source_name)
    """
    storyline, _ = get_storyline()
    if not storyline:
        return None, 'main', None
    
    blocks = storyline.get('blocks', [])
    current_idx = storyline.get('current_block', 0)
    active_branches = storyline.get('active_branches', [])
    branches = storyline.get('branches', [])
    
    current_source = playback.get('current_source', 'main')
    
    # If we're currently in a branch (active or stopped), show branch inject
    if current_source != 'main':
        branch = next((b for b in branches if b['id'] == current_source), None)
        if branch and branch.get('injects'):
            idx = branch.get('current_inject', 0)
            if idx < len(branch['injects']):
                return branch['injects'][idx], 'branch', branch.get('name', 'Branch')
    
    # If current_source is 'main', show main inject
    # Branches will start after advancing from main
    if current_source == 'main':
        if blocks and current_idx < len(blocks):
            return blocks[current_idx], 'main', None
    
    # Fallback: check if any branch should be playing
    for branch_id in active_branches:
        branch = next((b for b in branches if b['id'] == branch_id), None)
        if branch and branch.get('injects'):
            idx = branch.get('current_inject', 0)
            if idx < len(branch['injects']):
                playback['current_source'] = branch_id
                return branch['injects'][idx], 'branch', branch.get('name', 'Branch')
    
    # No branch, show main
    playback['current_source'] = 'main'
    if blocks and current_idx < len(blocks):
        return blocks[current_idx], 'main', None
    
    return None, 'main', None


def get_player_type_from_id(player_type_id):
    """Look up player type name from the short ID."""
    if not player_type_id:
        return None
    player_links = app_data.get('player_links', {})
    for name, link_id in player_links.items():
        if link_id == player_type_id:
            return name
    return None


def should_show_inject_to_player_type(inject, player_type):
    """Check if an inject should be shown to a specific player type."""
    if not inject:
        return True  # No inject = show waiting state to all
    
    target_types = inject.get('target_player_types', [])
    
    # If no target types specified, show to everyone
    if not target_types:
        return True
    
    # If player has no type (generic /player URL), they see everything
    if not player_type:
        return True
    
    # Check if player's type is in the target list
    return player_type in target_types


def sanitize_block_for_player(block):
    """Remove GM-only fields from block before sending to players."""
    if not block:
        return None
    
    # Create a copy without sensitive fields
    return {
        'id': block.get('id'),
        'heading': block.get('heading', ''),
        'text': block.get('text', ''),
        'image': block.get('image'),
        'duration': block.get('duration', 0),
        'day': block.get('day', 0),
        'time': block.get('time', ''),
        # Explicitly exclude: gm_notes, target_player_types
    }


def broadcast_current_block():
    """Send current block state to all connected clients, filtered by player type."""
    global last_shown_inject
    if _socketio is None:
        return
    
    storyline, storyline_id = get_storyline()
    
    # Build base state for GM
    if not storyline:
        empty_state = {
            'block': None,
            'all_blocks': [],
            'current_index': 0,
            'total_blocks': 0,
            'branches': [],
            'active_branches': [],
            'current_source': 'main',
            'source_name': None,
            'current_branch_inject_idx': None
        }
        _socketio.emit('block_update', empty_state)
        return
    
    blocks = storyline.get('blocks', [])
    main_idx = storyline.get('current_block', 0)
    branches = storyline.get('branches', [])
    active_branches = storyline.get('active_branches', [])
    
    # Get the current inject
    current_inject, source_type, source_name = get_current_inject()
    
    # Get current branch inject index if showing branch
    current_branch_id = None
    current_branch_inject_idx = None
    if source_type == 'branch':
        current_branch_id = playback.get('current_source')
        if current_branch_id and current_branch_id != 'main':
            branch = next((b for b in branches if b['id'] == current_branch_id), None)
            if branch:
                current_branch_inject_idx = branch.get('current_inject', 0)
    
    # Send full data to GM (room='gm')
    gm_data = {
        'block': current_inject,
        'all_blocks': blocks,
        'current_index': main_idx,
        'total_blocks': len(blocks),
        'branches': branches,
        'active_branches': active_branches,
        'current_source': source_type,
        'source_name': source_name,
        'current_branch_id': current_branch_id,
        'current_branch_inject_idx': current_branch_inject_idx
    }
    _socketio.emit('block_update', gm_data, room='gm')
    _socketio.emit('state_update', {
        'current_block': main_idx,
        'active_branches': active_branches,
        'current_source': source_type,
        'current_branch_id': current_branch_id,
        'current_branch_inject_idx': current_branch_inject_idx
    }, room='gm')
    
    # Get all player types plus generic
    player_types = app_data.get('player_types', [])
    all_player_rooms = ['player_generic'] + [f'player_{pt}' for pt in player_types]
    
    # For each player type room, determine what to send
    for room in all_player_rooms:
        if room == 'player_generic':
            player_type = None
        else:
            player_type = room[7:]  # Remove 'player_' prefix
        
        # Determine what inject to show this player type
        if should_show_inject_to_player_type(current_inject, player_type):
            # Show current inject and update last_shown
            inject_to_send = current_inject
            previous_inject = last_shown_inject.get(room)
            last_shown_inject[room] = current_inject
            
            # Only emit if the inject actually changed for this player
            # Compare by inject id to detect actual changes
            previous_id = previous_inject.get('id') if previous_inject else None
            current_id = inject_to_send.get('id') if inject_to_send else None
            
            if previous_id != current_id:
                # Sanitize before sending (remove GM notes, target info)
                safe_inject = sanitize_block_for_player(inject_to_send)
                
                player_data = {
                    'block': safe_inject,
                    'all_blocks': [],  # Don't send all blocks to players
                    'current_index': main_idx,
                    'total_blocks': len(blocks),
                    'branches': [],  # Don't send branch structure to players
                    'active_branches': [],
                    'current_source': source_type,
                    'source_name': source_name,
                    'current_branch_id': current_branch_id,
                    'current_branch_inject_idx': current_branch_inject_idx
                }
                _socketio.emit('block_update', player_data, room=room)
        # If player shouldn't see this inject, don't emit anything - they keep their current view


def broadcast_state_to_gm_only():
    """Send state update to GM only, without notifying players."""
    if _socketio is None:
        return
    
    storyline, storyline_id = get_storyline()
    
    if not storyline:
        return
    
    blocks = storyline.get('blocks', [])
    main_idx = storyline.get('current_block', 0)
    branches = storyline.get('branches', [])
    active_branches = storyline.get('active_branches', [])
    
    # Get the current inject
    current_inject, source_type, source_name = get_current_inject()
    
    # Get current branch inject index if showing branch
    current_branch_id = None
    current_branch_inject_idx = None
    if source_type == 'branch':
        current_branch_id = playback.get('current_source')
        if current_branch_id and current_branch_id != 'main':
            branch = next((b for b in branches if b['id'] == current_branch_id), None)
            if branch:
                current_branch_inject_idx = branch.get('current_inject', 0)
    
    # Send to GM only
    gm_data = {
        'block': current_inject,
        'all_blocks': blocks,
        'current_index': main_idx,
        'total_blocks': len(blocks),
        'branches': branches,
        'active_branches': active_branches,
        'current_source': source_type,
        'source_name': source_name,
        'current_branch_id': current_branch_id,
        'current_branch_inject_idx': current_branch_inject_idx
    }
    _socketio.emit('block_update', gm_data, room='gm')
    _socketio.emit('state_update', {
        'current_block': main_idx,
        'active_branches': active_branches,
        'current_source': source_type,
        'current_branch_id': current_branch_id,
        'current_branch_inject_idx': current_branch_inject_idx
    }, room='gm')


def broadcast_to_single_player(player_type):
    """Send current state to a specific player type (used on connect)."""
    if _socketio is None:
        return
    
    from flask_socketio import emit
    
    storyline, _ = get_storyline()
    if not storyline:
        emit('block_update', {
            'block': None,
            'all_blocks': [],
            'current_index': 0,
            'total_blocks': 0,
            'branches': [],
            'active_branches': [],
            'current_source': 'main',
            'source_name': None,
            'current_branch_inject_idx': None
        })
        return
    
    blocks = storyline.get('blocks', [])
    main_idx = storyline.get('current_block', 0)
    branches = storyline.get('branches', [])
    
    current_inject, source_type, source_name = get_current_inject()
    
    current_branch_id = None
    current_branch_inject_idx = None
    if source_type == 'branch':
        current_branch_id = playback.get('current_source')
        if current_branch_id and current_branch_id != 'main':
            branch = next((b for b in branches if b['id'] == current_branch_id), None)
            if branch:
                current_branch_inject_idx = branch.get('current_inject', 0)
    
    # Determine room for this player
    room = f'player_{player_type}' if player_type else 'player_generic'
    
    # Determine what inject to show
    if should_show_inject_to_player_type(current_inject, player_type):
        inject_to_send = current_inject
        last_shown_inject[room] = current_inject
    else:
        inject_to_send = last_shown_inject.get(room)
    
    safe_inject = sanitize_block_for_player(inject_to_send)
    
    emit('block_update', {
        'block': safe_inject,
        'all_blocks': [],
        'current_index': main_idx,
        'total_blocks': len(blocks),
        'branches': [],
        'active_branches': [],
        'current_source': source_type,
        'source_name': source_name,
        'current_branch_id': current_branch_id,
        'current_branch_inject_idx': current_branch_inject_idx
    })


def check_auto_trigger_branches():
    """Check if any branches should auto-trigger at current main inject."""
    storyline, _ = get_storyline()
    if not storyline:
        return
    
    blocks = storyline.get('blocks', [])
    current_idx = storyline.get('current_block', 0)
    
    if not blocks or current_idx >= len(blocks):
        return
    
    current_block_id = blocks[current_idx]['id']
    branches = storyline.get('branches', [])
    active_branches = storyline.get('active_branches', [])
    
    for branch in branches:
        if (branch.get('auto_trigger') and 
            branch.get('parent_inject_id') == current_block_id and
            branch['id'] not in active_branches and
            branch.get('injects')):
            # Auto-activate this branch
            active_branches.append(branch['id'])
            branch['current_inject'] = 0
    
    storyline['active_branches'] = active_branches
    save_data(app_data)


def advance_to_next():
    """
    Advance to the next inject.
    If on main and branch is waiting, switch to branch.
    If in branch, advance branch. If branch done, merge to target or continue main.
    Returns True if advanced successfully.
    """
    storyline, _ = get_storyline()
    if not storyline:
        return False
    
    active_branches = storyline.get('active_branches', [])
    branches = storyline.get('branches', [])
    current_source = playback.get('current_source', 'main')
    blocks = storyline.get('blocks', [])
    current_main_idx = storyline.get('current_block', 0)
    
    # If we're currently showing main, check if we should switch to a branch
    if current_source == 'main':
        # Check if any active branch is waiting to play that's attached to the CURRENT main inject
        current_block_id = blocks[current_main_idx]['id'] if blocks and current_main_idx < len(blocks) else None
        
        for branch_id in active_branches:
            branch = next((b for b in branches if b['id'] == branch_id), None)
            if branch and branch.get('injects'):
                idx = branch.get('current_inject', 0)
                # Only switch to branch if it's attached to current main inject
                if idx < len(branch['injects']) and branch.get('parent_inject_id') == current_block_id:
                    # Switch to this branch
                    playback['current_source'] = branch_id
                    broadcast_current_block()
                    return True
        
        # No branch waiting for current inject, advance main storyline
        return advance_main()
    
    # We're showing a branch - check if it's still active
    if current_source in active_branches:
        # Branch is active, try to advance it
        branch = next((b for b in branches if b['id'] == current_source), None)
        if branch:
            current = branch.get('current_inject', 0)
            if current < len(branch.get('injects', [])) - 1:
                # More injects in this branch
                branch['current_inject'] = current + 1
                save_data(app_data)
                broadcast_current_block()
                return True
            else:
                # Branch finished, deactivate it
                active_branches.remove(current_source)
                storyline['active_branches'] = active_branches
                
                # Check if branch has a merge target
                merge_to = branch.get('merge_to_inject_id')
                if merge_to:
                    # Jump main storyline to merge target
                    merge_idx = next((i for i, b in enumerate(blocks) if b['id'] == merge_to), None)
                    if merge_idx is not None:
                        storyline['current_block'] = merge_idx
                        playback['current_source'] = 'main'
                        save_data(app_data)
                        check_auto_trigger_branches()
                        broadcast_current_block()
                        return True
                
                save_data(app_data)
                
                # Check if another branch is waiting for the current main inject
                current_block_id = blocks[current_main_idx]['id'] if blocks and current_main_idx < len(blocks) else None
                for branch_id in active_branches:
                    other_branch = next((b for b in branches if b['id'] == branch_id), None)
                    if other_branch and other_branch.get('injects'):
                        idx = other_branch.get('current_inject', 0)
                        if idx < len(other_branch['injects']) and other_branch.get('parent_inject_id') == current_block_id:
                            # Switch to this branch
                            playback['current_source'] = branch_id
                            broadcast_current_block()
                            return True
                
                # No more branches for current inject, go back to main and advance
                playback['current_source'] = 'main'
                return advance_main()
    else:
        # Branch was stopped (not in active_branches), go back to main and advance
        playback['current_source'] = 'main'
        return advance_main()
    
    # Fallback: advance main
    return advance_main()


def advance_main():
    """Advance the main storyline."""
    storyline, _ = get_storyline()
    if not storyline:
        return False
    
    blocks = storyline.get('blocks', [])
    current = storyline.get('current_block', 0)
    
    if current < len(blocks) - 1:
        storyline['current_block'] = current + 1
        playback['current_source'] = 'main'
        save_data(app_data)
        check_auto_trigger_branches()
        broadcast_current_block()
        return True
    
    return False


def register_socket_handlers(socketio, app=None):
    """Register all Socket.IO event handlers."""
    global _socketio
    _socketio = socketio
    
    def is_gm_authenticated():
        """Check if the current session is GM authenticated."""
        from flask import session, current_app
        # If no password configured, everyone is "authenticated"
        if not current_app.config.get('GM_PASSWORD'):
            return True
        return session.get('gm_authenticated', False)
    
    @socketio.on('connect')
    def handle_connect():
        # Default: don't join any room yet, wait for identification
        pass
    
    @socketio.on('gm_connected')
    def handle_gm_connected():
        """GM client identifies itself and joins the GM room."""
        from flask_socketio import join_room, emit
        
        # Verify GM is authenticated
        if not is_gm_authenticated():
            emit('auth_error', {'error': 'Not authenticated as GM'})
            return
        
        join_room('gm')
        broadcast_current_block()
    
    @socketio.on('player_connected')
    def handle_player_connected(data=None):
        """Player client identifies itself with optional player_type_id."""
        from flask_socketio import join_room
        
        player_type = None
        if data and data.get('player_type_id'):
            player_type = get_player_type_from_id(data['player_type_id'])
        
        # Join appropriate room
        if player_type:
            join_room(f'player_{player_type}')
        else:
            join_room('player_generic')
        
        # Send current state to this player
        broadcast_to_single_player(player_type)
    
    @socketio.on('next_block')
    def handle_next_block():
        if not is_gm_authenticated():
            return
        if advance_to_next():
            if playback['playing']:
                start_inject_timer()
    
    @socketio.on('previous_block')
    def handle_previous_block():
        if not is_gm_authenticated():
            return
        storyline, _ = get_storyline()
        if storyline:
            current = storyline.get('current_block', 0)
            if current > 0:
                storyline['current_block'] = current - 1
                playback['current_source'] = 'main'
                save_data(app_data)
        broadcast_current_block()
        if playback['playing']:
            start_inject_timer()
    
    @socketio.on('go_to_block')
    def handle_go_to_block(data):
        if not is_gm_authenticated():
            return
        storyline, _ = get_storyline()
        if storyline:
            blocks = storyline.get('blocks', [])
            index = data.get('index', 0)
            if 0 <= index < len(blocks):
                storyline['current_block'] = index
                playback['current_source'] = 'main'
                
                # If resetting to start (index 0), also reset all branches
                if index == 0:
                    storyline['active_branches'] = []
                    for branch in storyline.get('branches', []):
                        branch['current_inject'] = 0
                
                save_data(app_data)
                check_auto_trigger_branches()
        broadcast_current_block()
        if playback['playing']:
            start_inject_timer()
    
    @socketio.on('go_to_branch_inject')
    def handle_go_to_branch_inject(data):
        if not is_gm_authenticated():
            return
        storyline, _ = get_storyline()
        if storyline:
            branch_id = data.get('branch_id')
            inject_index = data.get('inject_index', 0)
            
            branches = storyline.get('branches', [])
            branch = next((b for b in branches if b['id'] == branch_id), None)
            
            if branch:
                injects = branch.get('injects', [])
                if 0 <= inject_index < len(injects):
                    # Set the branch's current inject
                    branch['current_inject'] = inject_index
                    
                    # Activate the branch if not already active
                    active_branches = storyline.get('active_branches', [])
                    if branch_id not in active_branches:
                        active_branches.append(branch_id)
                        storyline['active_branches'] = active_branches
                    
                    # Switch playback to this branch
                    playback['current_source'] = branch_id
                    
                    save_data(app_data)
        broadcast_current_block()
        if playback['playing']:
            start_inject_timer()
    
    @socketio.on('toggle_playback')
    def handle_toggle_playback(data):
        if not is_gm_authenticated():
            return
        # Only allow playback if a storyline is activated
        if not app_data.get('active_storyline'):
            socketio.emit('playback_update', {'playing': False, 'remaining': 0, 'error': 'No storyline activated'}, room='gm')
            return
        
        playback['playing'] = data.get('playing', False)
        if playback['playing']:
            check_auto_trigger_branches()
            start_inject_timer()
        else:
            playback['remaining'] = 0
            socketio.emit('playback_update', {'playing': False, 'remaining': 0}, room='gm')
    
    @socketio.on('activate_branch')
    def handle_activate_branch(data):
        if not is_gm_authenticated():
            return
        branch_id = data.get('branch_id')
        storyline, _ = get_storyline()
        if storyline and branch_id:
            branch = next((b for b in storyline.get('branches', []) if b['id'] == branch_id), None)
            if branch:
                if 'active_branches' not in storyline:
                    storyline['active_branches'] = []
                if branch_id not in storyline['active_branches']:
                    # Just activate the branch - it will play when its parent inject is reached
                    storyline['active_branches'].append(branch_id)
                    branch['current_inject'] = 0
                    save_data(app_data)
        # Only notify GM, not players - branch activation is a GM-only state change
        broadcast_state_to_gm_only()
    
    @socketio.on('deactivate_branch')
    def handle_deactivate_branch(data):
        if not is_gm_authenticated():
            return
        branch_id = data.get('branch_id')
        storyline, _ = get_storyline()
        if storyline and branch_id:
            if branch_id in storyline.get('active_branches', []):
                storyline['active_branches'].remove(branch_id)
                # Don't change playback source - stay on current branch inject
                # Next action will handle returning to main storyline
                save_data(app_data)
                # Only notify GM - players keep seeing the same inject
                broadcast_state_to_gm_only()


def get_current_inject_duration():
    """Get duration of current inject."""
    inject, _, _ = get_current_inject()
    if inject:
        return inject.get('duration', 0) or 0
    return 0


# Timer ID to track current timer and cancel old ones
_timer_id = [0]

def start_inject_timer():
    """Start the timer for the current inject's duration."""
    duration = get_current_inject_duration()
    playback['remaining'] = duration
    
    # Increment timer ID to invalidate any running timers
    _timer_id[0] += 1
    current_timer_id = _timer_id[0]
    
    _socketio.emit('playback_update', {
        'playing': playback['playing'],
        'remaining': playback['remaining'],
        'duration': duration
    }, room='gm')
    
    if duration > 0 and playback['playing']:
        _socketio.start_background_task(inject_timer_loop, current_timer_id)


def inject_timer_loop(timer_id):
    """Background task for inject duration countdown."""
    while playback['playing'] and playback['remaining'] > 0:
        _socketio.sleep(1)
        
        # Check if this timer is still valid (hasn't been superseded)
        if timer_id != _timer_id[0]:
            return  # Another timer has started, exit this one
        
        if not playback['playing']:
            break
        
        playback['remaining'] -= 1
        _socketio.emit('playback_update', {
            'playing': playback['playing'],
            'remaining': playback['remaining']
        }, room='gm')
        
        if playback['remaining'] <= 0 and playback['playing']:
            # Check again if this timer is still valid
            if timer_id != _timer_id[0]:
                return
            
            if advance_to_next():
                start_inject_timer()
            else:
                playback['playing'] = False
                _socketio.emit('playback_update', {'playing': False, 'remaining': 0}, room='gm')
