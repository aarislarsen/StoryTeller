"""Socket.IO event handlers for StoryTeller with branch support"""

from flask import request
from data import app_data, save_data

# Playback state
playback = {
    'playing': False,
    'remaining': 0,
    'current_source': 'main',  # 'main' or branch_id - top of the navigation stack
    # Parent frames for nested branches. Each frame: {'source', 'inject_idx'}.
    # When we descend into a sub-branch we push the frame we came from so that
    # finishing the sub-branch can resume the parent branch (or main).
    'branch_stack': [],
}

# Track last shown inject per player type (for when inject is targeted to others)
# Key: player_type (or '__generic__' for no type), Value: inject data
last_shown_inject = {}

# Global reference to socketio
_socketio = None

# ---- Collaborative editing presence ----
# Friendly label per connected GM socket: sid -> "GM 1"
gm_labels = {}
_gm_counter = [0]
# Who is editing what: entity_key ("type:id") -> { sid: label }
editing_locks = {}


def _editing_status_payload(entity_key):
    """Build the editing_status payload for a given entity key."""
    entity_type, _, entity_id = entity_key.partition(':')
    return {
        'entity_type': entity_type,
        'entity_id': entity_id,
        'editors': list(editing_locks.get(entity_key, {}).values())
    }


def broadcast_editing_status(entity_key):
    """Tell every GM who is currently editing the given entity."""
    if _socketio is None:
        return
    _socketio.emit('editing_status', _editing_status_payload(entity_key), room='gm')


# ---- Deferred persistence ----
# Writing the (image-heavy) data file is slow. On the playback/navigation hot
# path we don't want that write to block the broadcast, so we persist in a
# background task and coalesce rapid successive calls into a single write.
_save_pending = [False]
_save_running = [False]


def _run_saves():
    while _save_pending[0]:
        _save_pending[0] = False
        save_data(app_data)
    _save_running[0] = False


def schedule_save():
    """Persist app_data without blocking the caller. Coalesces bursts of calls
    (e.g. advance + auto-trigger) into one background write so the UI updates
    immediately."""
    _save_pending[0] = True
    if _save_running[0]:
        return
    if _socketio is None:
        # No event loop yet; fall back to a synchronous write.
        _save_pending[0] = False
        save_data(app_data)
        return
    _save_running[0] = True
    _socketio.start_background_task(_run_saves)


def get_storyline():
    """Get the active storyline or None."""
    storyline_id = app_data.get('active_storyline')
    if storyline_id and storyline_id in app_data['storylines']:
        return app_data['storylines'][storyline_id], storyline_id
    return None, None


def _branch_ancestor_path(storyline, branch_id):
    """Return branch ids from the outermost ancestor branch down to branch_id
    (inclusive). A main-level branch yields [branch_id]. Nested branches yield
    [root_branch, ..., branch_id]."""
    branches = storyline.get('branches', [])
    by_id = {b['id']: b for b in branches}
    path = []
    seen = set()
    current = by_id.get(branch_id)
    while current and current['id'] not in seen:
        seen.add(current['id'])
        path.insert(0, current['id'])
        parent_inject_id = current.get('parent_inject_id')
        parent_branch = None
        for b in branches:
            if any(inj['id'] == parent_inject_id for inj in b.get('injects', [])):
                parent_branch = b
                break
        current = parent_branch
    return path


def find_inject(storyline, inject_id):
    """Find an inject anywhere in the storyline (main blocks OR any branch's
    injects). Returns (inject, kind, container_id, index, ancestor_path):
      kind         'main' or 'branch' (None if not found)
      container_id 'main' or the branch id holding the inject
      index        position within its container
      ancestor_path branch ids root..leaf for the holding branch ([] for main).
    """
    if not storyline or not inject_id:
        return None, None, None, None, []
    for i, b in enumerate(storyline.get('blocks', [])):
        if b['id'] == inject_id:
            return b, 'main', 'main', i, []
    for branch in storyline.get('branches', []):
        for i, inj in enumerate(branch.get('injects', [])):
            if inj['id'] == inject_id:
                return (inj, 'branch', branch['id'], i,
                        _branch_ancestor_path(storyline, branch['id']))
    return None, None, None, None, []


def _get_container_injects(storyline, source):
    """Return (injects_list, current_index) for a source ('main' or branch id)."""
    if source == 'main':
        return storyline.get('blocks', []), storyline.get('current_block', 0)
    branch = next((b for b in storyline.get('branches', []) if b['id'] == source), None)
    if branch:
        return branch.get('injects', []), branch.get('current_inject', 0)
    return [], 0


def _set_container_index(storyline, source, idx):
    """Set the current-inject pointer for a source ('main' or branch id)."""
    if source == 'main':
        storyline['current_block'] = idx
        return
    branch = next((b for b in storyline.get('branches', []) if b['id'] == source), None)
    if branch:
        branch['current_inject'] = idx


def _build_parent_frames(storyline, ancestor_path):
    """Rebuild the parent-frame stack for a target located in the branch at the
    end of ancestor_path (root..leaf branch ids). Returns frames excluding the
    target itself. Empty list for a main-level target."""
    frames = []
    if not ancestor_path:
        return frames
    branches = storyline.get('branches', [])
    by_id = {b['id']: b for b in branches}
    # Frame beneath the root branch: the main block it hangs off of.
    root = by_id.get(ancestor_path[0])
    _, kind, _, idx, _ = find_inject(storyline, root.get('parent_inject_id') if root else None)
    if kind == 'main':
        frames.append({'source': 'main', 'inject_idx': idx})
    # Each intermediate ancestor becomes a frame at the inject that spawned the
    # next branch down the chain.
    for depth in range(1, len(ancestor_path)):
        child = by_id.get(ancestor_path[depth])
        _, _, cid, idx, _ = find_inject(storyline, child.get('parent_inject_id') if child else None)
        if cid == ancestor_path[depth - 1]:
            frames.append({'source': ancestor_path[depth - 1], 'inject_idx': idx})
    return frames


def _position_at(storyline, container_id, idx, ancestor_path):
    """Place playback directly at a specific inject anywhere in the storyline,
    rebuilding the return stack and activating the branch chain leading to it."""
    playback['branch_stack'] = _build_parent_frames(storyline, ancestor_path)
    playback['current_source'] = container_id
    _set_container_index(storyline, container_id, idx)
    if container_id != 'main':
        active = storyline.setdefault('active_branches', [])
        for bid in ancestor_path:
            if bid not in active:
                active.append(bid)


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
        # GM rebuilds structure via /api/storylines on demand; don't ship the
        # whole (image-heavy) storyline on every advance.
        'all_blocks': [],
        'current_index': main_idx,
        'total_blocks': len(blocks),
        'branches': [],
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
        # GM rebuilds structure via /api/storylines on demand; don't ship the
        # whole (image-heavy) storyline on every advance.
        'all_blocks': [],
        'current_index': main_idx,
        'total_blocks': len(blocks),
        'branches': [],
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


def check_auto_trigger_branches(inject_id=None):
    """Auto-activate any auto_trigger branch whose parent is the given inject.
    Works for any inject (main block or a branch inject), enabling nested
    auto-triggers. Defaults to the current main inject for backward compat."""
    storyline, _ = get_storyline()
    if not storyline:
        return

    if inject_id is None:
        blocks = storyline.get('blocks', [])
        current_idx = storyline.get('current_block', 0)
        if not blocks or current_idx >= len(blocks):
            return
        inject_id = blocks[current_idx]['id']

    branches = storyline.get('branches', [])
    active_branches = storyline.get('active_branches', [])

    for branch in branches:
        if (branch.get('auto_trigger') and
            branch.get('parent_inject_id') == inject_id and
            branch['id'] not in active_branches and
            branch.get('injects')):
            # Auto-activate this branch
            active_branches.append(branch['id'])
            branch['current_inject'] = 0

    storyline['active_branches'] = active_branches
    schedule_save()


def advance_to_next():
    """
    Advance to the next inject using a single stack-based rule that works at any
    nesting depth:
      1. If an active (sub-)branch is waiting on the CURRENT inject, descend into
         it (pushing the current frame so we can return later).
      2. Otherwise advance within the current container.
      3. If the current container is a branch that just finished, merge to its
         target (anywhere) or pop back to the parent frame (parent branch/main).
    Returns True if playback moved.
    """
    storyline, _ = get_storyline()
    if not storyline:
        return False

    active_branches = storyline.get('active_branches', [])
    branches = storyline.get('branches', [])
    source = playback.get('current_source', 'main')

    injects, cur_idx = _get_container_injects(storyline, source)
    current_inject_id = injects[cur_idx]['id'] if injects and cur_idx < len(injects) else None

    # 1. Descend into a waiting sub-branch attached to the current inject.
    if current_inject_id is not None:
        for branch_id in active_branches:
            if branch_id == source:
                continue
            branch = next((b for b in branches if b['id'] == branch_id), None)
            if not branch or not branch.get('injects'):
                continue
            idx = branch.get('current_inject', 0)
            if idx < len(branch['injects']) and branch.get('parent_inject_id') == current_inject_id:
                playback.setdefault('branch_stack', []).append(
                    {'source': source, 'inject_idx': cur_idx})
                playback['current_source'] = branch_id
                schedule_save()
                check_auto_trigger_branches(branch['injects'][idx]['id'])
                broadcast_current_block()
                return True

    # 2. On main with nothing waiting -> advance main.
    if source == 'main':
        return advance_main()

    # 3a. Active branch -> advance within it, or finish it.
    if source in active_branches:
        branch = next((b for b in branches if b['id'] == source), None)
        if branch:
            current = branch.get('current_inject', 0)
            if current < len(branch.get('injects', [])) - 1:
                branch['current_inject'] = current + 1
                schedule_save()
                check_auto_trigger_branches(branch['injects'][current + 1]['id'])
                broadcast_current_block()
                return True
            return _finish_branch(storyline, source)

    # 3b. Branch was stopped by the GM -> resume parent (or main) and advance.
    return _resume_parent(storyline)


def _finish_branch(storyline, branch_id):
    """A branch reached its last inject. Deactivate it, then merge to its target
    (any inject) if set, otherwise resume the parent frame."""
    branches = storyline.get('branches', [])
    active_branches = storyline.get('active_branches', [])
    branch = next((b for b in branches if b['id'] == branch_id), None)

    if branch_id in active_branches:
        active_branches.remove(branch_id)
        storyline['active_branches'] = active_branches

    merge_to = branch.get('merge_to_inject_id') if branch else None
    if merge_to:
        target, _, container_id, idx, ancestor_path = find_inject(storyline, merge_to)
        if target is not None:
            _position_at(storyline, container_id, idx, ancestor_path)
            schedule_save()
            check_auto_trigger_branches(target['id'])
            broadcast_current_block()
            return True

    schedule_save()
    return _resume_parent(storyline)


def _resume_parent(storyline):
    """Pop one frame off the navigation stack and continue advancing from the
    parent inject. With an empty stack we're back at the top level (main)."""
    stack = playback.get('branch_stack', [])
    if stack:
        frame = stack.pop()
        playback['current_source'] = frame['source']
        _set_container_index(storyline, frame['source'], frame['inject_idx'])
        schedule_save()
        return advance_to_next()

    playback['current_source'] = 'main'
    return advance_main()


def advance_main():
    """Advance the main storyline (top level)."""
    storyline, _ = get_storyline()
    if not storyline:
        return False

    blocks = storyline.get('blocks', [])
    current = storyline.get('current_block', 0)

    if current < len(blocks) - 1:
        storyline['current_block'] = current + 1
        playback['current_source'] = 'main'
        playback['branch_stack'] = []
        schedule_save()
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

        # Assign a stable friendly label for this connection so other GMs can
        # see "GM 2 is also editing this".
        sid = request.sid
        if sid not in gm_labels:
            _gm_counter[0] += 1
            gm_labels[sid] = f'GM {_gm_counter[0]}'
        emit('gm_identity', {'label': gm_labels[sid]})

        # Send the current editing locks so a freshly-opened GM sees existing
        # edit-in-progress state right away.
        for entity_key in editing_locks:
            emit('editing_status', _editing_status_payload(entity_key))

        broadcast_current_block()

    @socketio.on('start_editing')
    def handle_start_editing(data):
        """A GM opened an edit modal for an existing entity."""
        if not is_gm_authenticated():
            return
        if not data or not data.get('entity_id'):
            return
        entity_key = f"{data.get('entity_type')}:{data.get('entity_id')}"
        editing_locks.setdefault(entity_key, {})[request.sid] = gm_labels.get(request.sid, 'A GM')
        broadcast_editing_status(entity_key)

    @socketio.on('stop_editing')
    def handle_stop_editing(data):
        """A GM closed an edit modal."""
        if not data or not data.get('entity_id'):
            return
        entity_key = f"{data.get('entity_type')}:{data.get('entity_id')}"
        editors = editing_locks.get(entity_key)
        if editors and request.sid in editors:
            del editors[request.sid]
            if not editors:
                del editing_locks[entity_key]
            broadcast_editing_status(entity_key)

    @socketio.on('disconnect')
    def handle_disconnect():
        """Clean up any editing locks held by a departing GM."""
        sid = request.sid
        affected = []
        for entity_key, editors in list(editing_locks.items()):
            if sid in editors:
                del editors[sid]
                affected.append(entity_key)
                if not editors:
                    del editing_locks[entity_key]
        gm_labels.pop(sid, None)
        for entity_key in affected:
            broadcast_editing_status(entity_key)
    
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
                playback['branch_stack'] = []
                schedule_save()
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
                playback['branch_stack'] = []

                # If resetting to start (index 0), also reset all branches
                if index == 0:
                    storyline['active_branches'] = []
                    for branch in storyline.get('branches', []):
                        branch['current_inject'] = 0
                
                schedule_save()
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
                    # Jump directly to this (possibly nested) branch inject,
                    # rebuilding the return stack from its ancestor chain so that
                    # finishing it resumes the correct parent(s).
                    ancestor_path = _branch_ancestor_path(storyline, branch_id)
                    _position_at(storyline, branch_id, inject_index, ancestor_path)
                    schedule_save()
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
                    schedule_save()
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
                schedule_save()
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
