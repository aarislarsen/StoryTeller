/**
 * GM Interface JavaScript
 * Handles storyline management, inject editing, playback, and real-time sync
 */

// ============ Custom Alert/Confirm Modals ============
let confirmCallback = null;

function showAlert(message, title = 'Notice') {
    document.getElementById('alertModalTitle').textContent = title;
    document.getElementById('alertModalMessage').textContent = message;
    document.getElementById('alertModal').classList.add('active');
}

function closeAlertModal() {
    document.getElementById('alertModal').classList.remove('active');
}

function showConfirm(message, title = 'Confirm') {
    return new Promise((resolve) => {
        document.getElementById('confirmModalTitle').textContent = title;
        document.getElementById('confirmModalMessage').textContent = message;
        confirmCallback = resolve;
        document.getElementById('confirmModal').classList.add('active');
    });
}

function closeConfirmModal(result) {
    document.getElementById('confirmModal').classList.remove('active');
    if (confirmCallback) {
        confirmCallback(result);
        confirmCallback = null;
    }
}

// ============ State ============
const socket = io();
let currentStoryline = null;      // Currently selected in dropdown
let activeStoryline = null;       // Currently active for players
let storylinesData = {};
let isPlaying = false;
let editingStorylineId = null;
let currentDisplaySource = 'main';  // What's being shown to players: 'main' or branch_id
let currentDisplayBranchId = null;
let currentDisplayBranchInjectIdx = null;

// Zoom state
let zoomLevel = parseFloat(localStorage.getItem('gmZoomLevel')) || 1.0;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;

// ============ Socket Events ============
socket.on('connect', () => {
    setConnectionStatus(true);
    socket.emit('gm_connected'); // Join GM room
    loadStorylines();
    loadPlayerTypesData(); // Load player types for inject forms
    loadLibrary(); // Load inject library
});

socket.on('disconnect', () => {
    setConnectionStatus(false);
});

socket.on('auth_error', (data) => {
    // Redirect to login if not authenticated
    showAlert('Session expired. Please log in again.', 'Session Expired');
    setTimeout(() => {
        window.location.href = '/gm/login';
    }, 1500);
});

socket.on('block_update', (data) => {
    // Update GM notes panel
    updateGmNotesPanel(data.block);
});

let shouldScrollToNowPlaying = false;

socket.on('state_update', (data) => {
    if (data.current_block !== undefined) {
        document.getElementById('currentBlock').textContent = data.current_block + 1;
    }
    
    // Track what's currently being displayed to players
    currentDisplaySource = data.current_source || 'main';
    currentDisplayBranchId = data.current_branch_id || null;
    currentDisplayBranchInjectIdx = data.current_branch_inject_idx;
    
    // Refresh to update branch active states
    if (data.active_branches !== undefined && currentStoryline) {
        renderStoryline(currentStoryline).then(() => {
            // Only scroll if GM requested it
            if (shouldScrollToNowPlaying) {
                shouldScrollToNowPlaying = false;
                scrollToNowPlaying();
            }
        });
    }
});

socket.on('playback_update', (data) => {
    isPlaying = data.playing;
    updatePlayButton();
    updatePlaybackStatus(data);
    updateCountdownOverlay(data);
});

// ============ Connection Status ============
function setConnectionStatus(connected) {
    const el = document.getElementById('connectionStatus');
    el.className = 'connection-status' + (connected ? ' connected' : '');
    el.innerHTML = `<span class="dot"></span><span>${connected ? 'Connected' : 'Disconnected'}</span>`;
}

// ============ Playback Controls ============
function togglePlayback() {
    // Don't allow playback if no storyline is activated
    if (!activeStoryline) {
        showAlert('Please activate a storyline first', 'No Storyline Active');
        return;
    }
    
    isPlaying = !isPlaying;
    socket.emit('toggle_playback', { playing: isPlaying });
    updatePlayButton();
}

function updatePlayButton() {
    const btn = document.getElementById('playBtn');
    const icon = btn.querySelector('.play-icon');
    
    // Disable play button if no storyline is active
    btn.disabled = !activeStoryline;
    
    if (isPlaying) {
        btn.classList.add('playing');
        icon.textContent = '⏸';
        btn.title = 'Pause auto-play';
    } else {
        btn.classList.remove('playing');
        icon.textContent = '▶';
        btn.title = activeStoryline ? 'Auto-play storyline' : 'Activate a storyline first';
    }
}

function updatePlaybackStatus(data) {
    const status = document.getElementById('playbackStatus');
    
    if (data.playing && data.remaining > 0) {
        status.className = 'playback-status playing';
        status.textContent = `⏱ ${data.remaining}s remaining`;
    } else if (data.playing && data.duration === 0) {
        status.className = 'playback-status playing';
        status.textContent = '▶ Playing (manual)';
    } else if (data.playing) {
        status.className = 'playback-status playing';
        status.textContent = '▶ Playing';
    } else {
        status.className = 'playback-status';
        status.textContent = '';
    }
}

function updateCountdownOverlay(data) {
    // Remove any existing countdown overlays
    document.querySelectorAll('.block-countdown').forEach(el => el.remove());
    
    // Add countdown to the inject currently being shown to players (now-playing)
    if (data.playing && data.remaining > 0) {
        const nowPlayingCard = document.querySelector('.block-card.now-playing');
        if (nowPlayingCard) {
            const overlay = document.createElement('div');
            overlay.className = 'block-countdown';
            overlay.textContent = data.remaining;
            nowPlayingCard.appendChild(overlay);
        }
    }
}

// ============ Storyline Management ============
function loadStorylines() {
    fetch('/api/storylines')
        .then(r => {
            if (r.status === 401) {
                window.location.href = '/gm/login';
                throw new Error('Unauthorized');
            }
            return r.json();
        })
        .then(data => {
            storylinesData = data.storylines;
            activeStoryline = data.active_storyline;
            populateStorylineSelect(data);
            updatePlayButton();
            
            if (data.active_storyline && data.storylines[data.active_storyline]) {
                document.getElementById('storylineSelect').value = data.active_storyline;
                currentStoryline = data.active_storyline;
                renderStoryline(data.active_storyline);
                updateActivateButton();
            }
        })
        .catch(err => {
            if (err.message !== 'Unauthorized') {
                console.error('Error loading storylines:', err);
            }
        });
}

function populateStorylineSelect(data) {
    const select = document.getElementById('storylineSelect');
    select.innerHTML = '<option value="">-- Select --</option>';
    
    Object.keys(data.storylines).forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = data.storylines[id].name;
        if (id === data.active_storyline) {
            opt.textContent += ' (active)';
        }
        select.appendChild(opt);
    });
}

function previewStoryline(id) {
    if (!id) {
        currentStoryline = null;
        showEmptyState();
        updateActivateButton();
        return;
    }
    
    currentStoryline = id;
    renderStoryline(id);
    updateActivateButton();
}

async function activateStoryline() {
    if (!currentStoryline) return;
    
    // If there's already an active storyline and it's different, confirm
    if (activeStoryline && activeStoryline !== currentStoryline) {
        const confirmed = await showConfirm(
            'Changing storylines will reset all progress for players on the current storyline. Are you sure you want to activate this storyline?',
            'Change Storyline?'
        );
        if (!confirmed) return;
    }
    
    fetch('/api/storylines/activate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({storyline_id: currentStoryline})
    }).then(() => {
        activeStoryline = currentStoryline;
        loadStorylines();  // Refresh to update "(active)" label
    });
}

function updateActivateButton() {
    const btn = document.getElementById('activateBtn');
    
    if (!currentStoryline) {
        btn.disabled = true;
        btn.textContent = 'Activate';
    } else if (currentStoryline === activeStoryline) {
        btn.disabled = true;
        btn.textContent = 'Active';
    } else {
        btn.disabled = false;
        btn.textContent = 'Activate';
    }
}

function showEmptyState() {
    document.getElementById('mainContent').innerHTML = `
        <div class="empty-state">
            <div class="icon">📖</div>
            <h3>No storyline selected</h3>
            <p>Create or select a storyline</p>
            <button class="btn" onclick="openStorylineModal()">+ Create</button>
        </div>
    `;
}

// ============ Render Storyline ============
function renderStoryline(id) {
    // Preserve scroll position before re-render
    const wrapper = document.querySelector('.storyline-layout-wrapper');
    const scrollLeft = wrapper ? wrapper.scrollLeft : 0;
    
    return fetch('/api/storylines/' + id)
        .then(r => r.json())
        .then(data => {
            storylinesData[id] = data;
            const blocks = data.blocks || [];
            const idx = data.current_block || 0;
            
            document.getElementById('totalBlocks').textContent = blocks.length;
            document.getElementById('currentBlock').textContent = idx + 1;
            
            document.getElementById('mainContent').innerHTML = buildStorylineHTML(data, blocks, idx);
            
            // Restore scroll position immediately after render
            const newWrapper = document.querySelector('.storyline-layout-wrapper');
            if (newWrapper) {
                newWrapper.scrollLeft = scrollLeft;
            }
            
            initSortable();
            
            // Apply current highlighting after render
            highlightCurrentlyDisplayed(idx, currentDisplaySource, currentDisplayBranchId, currentDisplayBranchInjectIdx);
        });
}

function buildStorylineHTML(data, blocks, currentIdx) {
    const branches = data.branches || [];
    const activeBranches = data.active_branches || [];
    
    // Determine which main inject is "now playing" (only if source is main)
    const mainNowPlaying = currentDisplaySource === 'main' ? currentIdx : -1;
    
    // First pass: calculate width for each block position
    const itemWidths = blocks.map((block, i) => {
        const attachedBranches = branches.filter(b => b.parent_inject_id === block.id);
        if (attachedBranches.length > 0) {
            let maxBranchWidth = 0;
            attachedBranches.forEach(branch => {
                const numInjects = (branch.injects || []).length + 1; // +1 for add button
                const branchWidth = numInjects * 232 + 100; // cards + padding
                maxBranchWidth = Math.max(maxBranchWidth, branchWidth);
            });
            return Math.max(220, maxBranchWidth);
        }
        return 220; // Default block width
    });
    
    // Build main row
    let mainRow = '';
    blocks.forEach((block, i) => {
        const attachedBranches = branches.filter(b => b.parent_inject_id === block.id);
        const hasBranch = attachedBranches.length > 0;
        const hasAutoTriggerBranch = attachedBranches.some(b => b.auto_trigger);
        const showAbove = (i % 2 === 1);
        const itemWidth = itemWidths[i];
        const connectorWidth = itemWidth - 220;
        const isNowPlaying = i === mainNowPlaying;
        
        if (hasBranch) {
            mainRow += `
                <div class="main-block-with-connector ${showAbove ? 'connector-above' : 'connector-below'}" data-block-id="${block.id}" style="width: ${itemWidth}px;">
                    ${buildBlockCard(block, i, i === currentIdx, true, isNowPlaying, hasAutoTriggerBranch)}
                    ${connectorWidth > 0 ? `<div class="connector-horizontal" style="width: ${connectorWidth}px;"></div>` : ''}
                </div>
            `;
        } else {
            mainRow += `<div class="main-block-item" style="width: ${itemWidth}px;">${buildBlockCard(block, i, i === currentIdx, false, isNowPlaying, false)}</div>`;
        }
    });
    
    // Build branch rows (above and below)
    let aboveRowContent = '';
    let belowRowContent = '';
    
    // Check if we need branch rows at all
    const hasBranches = branches.length > 0;
    
    if (hasBranches) {
        blocks.forEach((block, i) => {
            const attachedBranches = branches.filter(b => b.parent_inject_id === block.id);
            const showAbove = (i % 2 === 1);
            const itemWidth = itemWidths[i];
            
            const branchHtml = attachedBranches.length > 0 
                ? attachedBranches.map(branch => {
                    const isActive = activeBranches.includes(branch.id);
                    return buildBranchHTML(branch, isActive);
                }).join('')
                : '';
            
            if (showAbove) {
                if (attachedBranches.length > 0) {
                    aboveRowContent += `<div class="branch-slot" data-parent-id="${block.id}" style="width: ${itemWidth}px;">${branchHtml}</div>`;
                } else {
                    aboveRowContent += `<div class="branch-slot branch-slot-empty" data-parent-id="${block.id}" style="width: ${itemWidth}px;"></div>`;
                }
                belowRowContent += `<div class="branch-slot branch-slot-empty" data-parent-id="${block.id}" style="width: ${itemWidth}px;"></div>`;
            } else {
                aboveRowContent += `<div class="branch-slot branch-slot-empty" data-parent-id="${block.id}" style="width: ${itemWidth}px;"></div>`;
                if (attachedBranches.length > 0) {
                    belowRowContent += `<div class="branch-slot" data-parent-id="${block.id}" style="width: ${itemWidth}px;">${branchHtml}</div>`;
                } else {
                    belowRowContent += `<div class="branch-slot branch-slot-empty" data-parent-id="${block.id}" style="width: ${itemWidth}px;"></div>`;
                }
            }
        });
    }
    
    return `
        <div class="storyline-group active">
            <div class="group-header">
                <div class="group-controls">
                    <button class="btn btn-sm btn-secondary" onclick="scrollBlocks('left')">◀</button>
                    <button class="btn btn-sm btn-secondary" onclick="scrollBlocks('right')">▶</button>
                    <span class="zoom-controls">
                        <button class="btn btn-sm btn-secondary" onclick="zoomOut()" title="Zoom out (-)">−</button>
                        <span class="zoom-level" id="zoomLevel">${Math.round(zoomLevel * 100)}%</span>
                        <button class="btn btn-sm btn-secondary" onclick="zoomIn()" title="Zoom in (+)">+</button>
                        <button class="btn btn-sm btn-secondary" onclick="zoomReset()" title="Reset zoom (0)">⊙</button>
                    </span>
                </div>
                <input type="text" class="group-name" value="${escapeHtml(data.name || 'Storyline')}" 
                       onblur="renameCurrentStoryline(this.value)" 
                       onkeypress="if(event.key==='Enter')this.blur()">
                <span class="group-meta">${blocks.length} inject${blocks.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="storyline-layout-wrapper">
                <div class="storyline-layout" id="blocksContainer" style="transform: scale(${zoomLevel}); transform-origin: top left;">
                    ${hasBranches ? `<div class="branches-row branches-above">${aboveRowContent}</div>` : ''}
                    <div class="main-storyline-row">
                        ${mainRow}
                        <div class="add-block-card" onclick="openBlockModal()">
                            <div class="icon">+</div>
                            <div>Add Inject</div>
                        </div>
                    </div>
                    ${hasBranches ? `<div class="branches-row branches-below">${belowRowContent}</div>` : ''}
                </div>
            </div>
        </div>
    `;
}

function buildBranchHTML(branch, isActive) {
    const injects = branch.injects || [];
    const currentIdx = branch.current_inject || 0;
    
    const triggerBadge = branch.auto_trigger 
        ? '<span class="branch-badge auto">Auto</span>'
        : '<span class="branch-badge manual">Manual</span>';
    
    const playingBadge = isActive 
        ? '<span class="branch-badge playing">Playing</span>' 
        : '';
    
    // Find merge target name if set
    let mergeInfo = '';
    if (branch.merge_to_inject_id) {
        const storyline = storylinesData[currentStoryline];
        if (storyline) {
            const blocks = storyline.blocks || [];
            const targetIdx = blocks.findIndex(b => b.id === branch.merge_to_inject_id);
            if (targetIdx >= 0) {
                mergeInfo = `<span class="branch-badge merge">→ #${targetIdx + 1}</span>`;
            }
        }
    }
    
    // Check if this branch is the one currently being displayed
    const isBranchNowPlaying = currentDisplaySource === 'branch' && currentDisplayBranchId === branch.id;
    
    const injectCards = injects.map((inj, i) => {
        const durationBadge = inj.duration > 0 
            ? `<span class="block-duration">${inj.duration}s</span>` 
            : '';
        
        const isInjectNowPlaying = isBranchNowPlaying && i === currentDisplayBranchInjectIdx;
        const nowBadge = isInjectNowPlaying 
            ? '<span class="now-playing-badge">▶ NOW</span>' 
            : '';
        
        return `
            <div class="block-card branch-block-card ${isActive && i === currentIdx ? 'active' : ''} ${isInjectNowPlaying ? 'now-playing' : ''}" data-id="${inj.id}" data-index="${i}">
                <div class="block-header">
                    <span class="block-number branch-number" onclick="goToBranchInject('${branch.id}', ${i})" title="Jump to inject">#${i + 1}</span>
                    ${durationBadge}
                    ${nowBadge}
                    <div class="block-actions">
                        <button class="btn btn-sm btn-secondary" onclick="editBranchInject('${branch.id}', '${inj.id}')">✎</button>
                        <button class="btn btn-sm btn-danger" onclick="deleteBranchInject('${branch.id}', '${inj.id}')">✕</button>
                    </div>
                </div>
                <div class="block-body">
                    <div class="block-title">${escapeHtml(inj.heading)}</div>
                    ${inj.image ? `<img src="/uploads/${inj.image}" class="block-image">` : ''}
                    ${inj.text ? `<div class="block-text">${escapeHtml(inj.text)}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');
    
    return `
        <div class="branch-group ${isActive ? 'active' : ''}" data-branch-id="${branch.id}">
            <div class="branch-header">
                <input type="text" class="branch-name" value="${escapeHtml(branch.name)}"
                       onblur="renameBranch('${branch.id}', this.value)"
                       onkeypress="if(event.key==='Enter')this.blur()">
                ${triggerBadge}
                ${mergeInfo}
                ${playingBadge}
                <div class="branch-controls">
                    ${isActive 
                        ? `<button class="btn btn-sm btn-secondary" onclick="deactivateBranch('${branch.id}')">⏹ Stop</button>`
                        : `<button class="btn btn-sm btn-activate" onclick="activateBranch('${branch.id}')">▶ Start</button>`
                    }
                    <button class="btn btn-sm btn-secondary" onclick="editBranch('${branch.id}')">✎</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteBranch('${branch.id}')">✕</button>
                </div>
            </div>
            <div class="branch-injects-row">
                ${injectCards}
                <div class="add-branch-inject" onclick="openBranchInjectModal('${branch.id}')">
                    <div>+</div>
                    <div>Add</div>
                </div>
            </div>
        </div>
    `;
}

function buildBlockCard(block, index, isActive, hasBranch = false, isNowPlaying = false, hasAutoTriggerBranch = false) {
    const durationBadge = block.duration > 0 
        ? `<span class="block-duration">${block.duration}s</span>` 
        : '';
    
    // Show branch button, but disable if inject has an auto-trigger branch (can't add more)
    let branchButton;
    if (hasAutoTriggerBranch) {
        branchButton = `<button class="btn btn-sm btn-secondary" disabled title="Auto-trigger branch must be the only branch">⑂</button>`;
    } else {
        branchButton = `<button class="btn btn-sm btn-activate" onclick="openBranchModal('${block.id}')" title="Add Branch">⑂</button>`;
    }
    
    const nowBadge = isNowPlaying 
        ? '<span class="now-playing-badge">▶ NOW</span>' 
        : '';
    
    return `
        <div class="block-card ${isActive ? 'active' : ''} ${isNowPlaying ? 'now-playing' : ''}" data-id="${block.id}" data-index="${index}">
            <div class="block-header">
                <span class="block-number" onclick="goToBlock(${index})" title="Jump to inject">#${index + 1}</span>
                ${durationBadge}
                ${nowBadge}
                <div class="block-actions">
                    ${branchButton}
                    <button class="btn btn-sm btn-secondary" onclick="editBlock('${block.id}')">✎</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteBlock('${block.id}')">✕</button>
                </div>
            </div>
            <div class="block-body">
                <div class="block-title">${escapeHtml(block.heading)}</div>
                ${block.image ? `<img src="/uploads/${block.image}" class="block-image">` : ''}
                ${block.text ? `<div class="block-text">${escapeHtml(block.text)}</div>` : ''}
            </div>
        </div>
    `;
}

function initSortable() {
    // Main storyline inject reordering
    const mainRow = document.querySelector('.main-storyline-row');
    if (mainRow) {
        // Destroy existing sortable if any
        if (mainRow.sortable) {
            mainRow.sortable.destroy();
        }
        
        mainRow.sortable = new Sortable(mainRow, {
            animation: 150,
            ghostClass: 'dragging',
            filter: '.add-block-card, .block-actions, .block-actions *, .block-number',
            draggable: '.main-block-with-connector, .main-block-item',
            onEnd: (evt) => {
                // Only process if item stayed in same container
                if (evt.from !== evt.to) return;
                
                const items = [...mainRow.querySelectorAll(':scope > .main-block-with-connector, :scope > .main-block-item')];
                const ids = items.map(e => {
                    return e.querySelector('.block-card')?.dataset.id;
                }).filter(Boolean);
                
                fetch('/api/blocks/reorder', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({storyline_id: currentStoryline, order: ids})
                }).then(() => renderStoryline(currentStoryline));
            }
        });
    }
    
    // Branch inject reordering within each branch
    document.querySelectorAll('.branch-injects-row').forEach(branchRow => {
        const branchGroup = branchRow.closest('.branch-group');
        const branchId = branchGroup?.dataset.branchId;
        if (!branchId) return;
        
        // Destroy existing sortable if any
        if (branchRow.sortable) {
            branchRow.sortable.destroy();
        }
        
        branchRow.sortable = new Sortable(branchRow, {
            animation: 150,
            ghostClass: 'dragging',
            filter: '.add-branch-inject',
            draggable: '.branch-block-card',
            group: { name: `branch-${branchId}`, pull: false, put: false }, // Prevent cross-branch dragging
            onEnd: (evt) => {
                // Only process if item stayed in same container
                if (evt.from !== evt.to) return;
                
                const ids = [...branchRow.querySelectorAll('.branch-block-card')].map(e => e.dataset.id).filter(Boolean);
                fetch(`/api/branches/${currentStoryline}/${branchId}/reorder`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({order: ids})
                }).then(() => renderStoryline(currentStoryline));
            }
        });
    });
    
    // Branch groups can be dragged to different parent injects
    const branchSlots = document.querySelectorAll('.branch-slot');
    branchSlots.forEach(slot => {
        // Destroy existing sortable if any
        if (slot.sortable) {
            slot.sortable.destroy();
        }
        
        slot.sortable = new Sortable(slot, {
            animation: 150,
            group: { 
                name: 'branch-slots', 
                pull: true, 
                put: (to) => {
                    // Only allow drop if target slot is empty (no branch-group inside)
                    return to.el.querySelectorAll('.branch-group').length === 0;
                }
            },
            ghostClass: 'dragging',
            draggable: '.branch-group',
            onAdd: (evt) => {
                // Branch was moved to a new slot
                const branchGroup = evt.item;
                const branchId = branchGroup.dataset.branchId;
                const newSlot = evt.to;
                const newParentId = newSlot.dataset.parentId;
                
                if (branchId && newParentId) {
                    fetch(`/api/branches/${currentStoryline}/${branchId}`, {
                        method: 'PUT',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({parent_inject_id: newParentId})
                    }).then(() => renderStoryline(currentStoryline));
                }
            }
        });
    });
}

function scrollBlocks(dir) {
    const wrapper = document.querySelector('.storyline-layout-wrapper');
    if (wrapper) {
        wrapper.scrollBy({left: dir === 'left' ? -250 : 250, behavior: 'smooth'});
    }
}

// ============ Zoom Functions ============
function zoomIn() {
    setZoom(Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP));
}

function zoomOut() {
    setZoom(Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP));
}

function zoomReset() {
    setZoom(1.0);
}

function setZoom(level) {
    zoomLevel = Math.round(level * 10) / 10; // Round to 1 decimal
    localStorage.setItem('gmZoomLevel', zoomLevel);
    
    const container = document.getElementById('blocksContainer');
    if (container) {
        container.style.transform = `scale(${zoomLevel})`;
    }
    
    const zoomDisplay = document.getElementById('zoomLevel');
    if (zoomDisplay) {
        zoomDisplay.textContent = `${Math.round(zoomLevel * 100)}%`;
    }
}

function highlightCurrentlyDisplayed(mainIdx, source, branchId, branchInjectIdx) {
    // This function no longer scrolls - scrolling is handled separately by GM actions
}

function scrollToNowPlaying() {
    // Find the now-playing element and scroll to it
    const nowPlaying = document.querySelector('.block-card.now-playing');
    if (nowPlaying) {
        nowPlaying.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'center'
        });
    }
}

// ============ GM Notes Panel ============
function updateGmNotesPanel(block) {
    const panel = document.getElementById('gmNotesPanel');
    const content = document.getElementById('gmNotesContent');
    
    if (!panel || !content) return;
    
    if (block && block.gm_notes && block.gm_notes.trim()) {
        content.innerHTML = `
            <div class="gm-notes-inject-title">${escapeHtml(block.heading)}</div>
            <div class="gm-notes-text">${escapeHtml(block.gm_notes)}</div>
        `;
        panel.style.display = 'flex';
    } else {
        panel.style.display = 'none';
    }
}

// ============ Inject Modal ============
function openBlockModal(data = null) {
    document.getElementById('blockModalTitle').textContent = data ? 'Edit Inject' : 'Add Inject';
    document.getElementById('blockId').value = data?.id || '';
    document.getElementById('blockHeading').value = data?.heading || '';
    document.getElementById('blockText').value = data?.text || '';
    document.getElementById('blockGmNotes').value = data?.gm_notes || '';
    document.getElementById('blockDuration').value = data?.duration || 0;
    document.getElementById('blockDay').value = data?.day || 0;
    document.getElementById('blockTime').value = data?.time || '';
    document.getElementById('existingImage').value = data?.image || '';
    document.getElementById('blockImage').value = '';
    document.getElementById('saveToLibrary').checked = false;
    
    const preview = document.getElementById('imagePreview');
    if (data?.image) {
        preview.src = '/uploads/' + data.image;
        preview.style.display = 'block';
    } else {
        preview.style.display = 'none';
    }
    
    // Populate player types checkboxes
    populatePlayerTypesCheckboxes('blockPlayerTypes', data?.target_player_types || []);
    
    document.getElementById('blockModal').classList.add('active');
    
    // Focus heading field after modal is visible
    setTimeout(() => {
        document.getElementById('blockHeading').focus();
    }, 50);
}

function populatePlayerTypesCheckboxes(containerId, selectedTypes = []) {
    const container = document.getElementById(containerId);
    
    if (playerTypes.length === 0) {
        container.innerHTML = '<span class="form-hint">No player types defined. Create some in "👥 Types" first.</span>';
        return;
    }
    
    container.innerHTML = playerTypes.map(pt => {
        const checked = selectedTypes.includes(pt) ? 'checked' : '';
        const id = `${containerId}_${pt.replace(/\s+/g, '_')}`;
        return `
            <label class="checkbox-label">
                <input type="checkbox" name="${containerId}" value="${escapeHtml(pt)}" ${checked}>
                <span>${escapeHtml(pt)}</span>
            </label>
        `;
    }).join('');
}

function getSelectedPlayerTypes(containerId) {
    const checkboxes = document.querySelectorAll(`input[name="${containerId}"]:checked`);
    return Array.from(checkboxes).map(cb => cb.value);
}

function closeBlockModal() {
    document.getElementById('blockModal').classList.remove('active');
    document.getElementById('blockForm').reset();
    document.getElementById('saveToLibrary').checked = false;
}

function previewImage(input) {
    const preview = document.getElementById('imagePreview');
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = e => {
            preview.src = e.target.result;
            preview.style.display = 'block';
        };
        reader.readAsDataURL(input.files[0]);
    }
}

function editBlock(id) {
    fetch('/api/blocks/' + currentStoryline + '/' + id)
        .then(r => r.json())
        .then(block => openBlockModal(block));
}

async function deleteBlock(id) {
    const confirmed = await showConfirm('Delete this inject?', 'Delete Inject');
    if (!confirmed) return;
    fetch('/api/blocks/' + currentStoryline + '/' + id, {method: 'DELETE'})
        .then(() => {
            loadStorylines();
            renderStoryline(currentStoryline);
        });
}

document.getElementById('blockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentStoryline) {
        showAlert('Select a storyline first', 'No Storyline Selected');
        return;
    }
    
    const formData = new FormData();
    formData.append('storyline_id', currentStoryline);
    formData.append('heading', document.getElementById('blockHeading').value);
    formData.append('text', document.getElementById('blockText').value);
    formData.append('gm_notes', document.getElementById('blockGmNotes').value);
    formData.append('duration', document.getElementById('blockDuration').value || 0);
    formData.append('day', document.getElementById('blockDay').value || 0);
    formData.append('time', document.getElementById('blockTime').value || '');
    formData.append('existing_image', document.getElementById('existingImage').value);
    formData.append('target_player_types', JSON.stringify(getSelectedPlayerTypes('blockPlayerTypes')));
    
    const img = document.getElementById('blockImage').files[0];
    if (img) formData.append('image', img);
    
    const blockId = document.getElementById('blockId').value;
    const isNewInject = !blockId;
    const url = blockId ? '/api/blocks/' + currentStoryline + '/' + blockId : '/api/blocks';
    
    await fetch(url, {method: 'POST', body: formData});
    
    // Also save to library if checkbox is checked
    const saveToLibrary = document.getElementById('saveToLibrary').checked;
    if (saveToLibrary) {
        const libraryFormData = new FormData();
        libraryFormData.append('heading', document.getElementById('blockHeading').value);
        libraryFormData.append('text', document.getElementById('blockText').value);
        libraryFormData.append('gm_notes', document.getElementById('blockGmNotes').value);
        libraryFormData.append('duration', document.getElementById('blockDuration').value || 0);
        libraryFormData.append('day', document.getElementById('blockDay').value || 0);
        libraryFormData.append('time', document.getElementById('blockTime').value || '');
        libraryFormData.append('target_player_types', JSON.stringify(getSelectedPlayerTypes('blockPlayerTypes')));
        
        // Include image: either new upload or existing image filename
        if (img) {
            libraryFormData.append('image', img);
        } else {
            const existingImage = document.getElementById('existingImage').value;
            if (existingImage) {
                libraryFormData.append('copy_image_from', existingImage);
            }
        }
        
        await fetch('/api/library', {method: 'POST', body: libraryFormData});
        loadLibrary();
    }
    
    closeBlockModal();
    loadStorylines();
    await renderStoryline(currentStoryline);
    
    if (isNewInject) {
        // Scroll to the new inject (last one in the list)
        const mainRow = document.querySelector('.main-storyline-row');
        if (mainRow) {
            const lastCard = mainRow.querySelector('.block-card:last-of-type, .main-block-with-connector:last-of-type, .main-block-item:last-of-type');
            if (lastCard) {
                lastCard.scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest',
                    inline: 'center'
                });
            }
        }
    } else {
        // Scroll to the edited inject
        const editedCard = document.querySelector(`.block-card[data-id="${blockId}"]`);
        if (editedCard) {
            editedCard.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'center'
            });
        }
    }
});

// ============ Storyline Modal ============
function openStorylineModal(id = null) {
    editingStorylineId = id;
    const isEdit = id && storylinesData[id];
    document.getElementById('storylineModalTitle').textContent = isEdit ? 'Rename' : 'New Storyline';
    document.getElementById('storylineName').value = isEdit ? storylinesData[id].name : '';
    document.getElementById('storylineModal').classList.add('active');
}

function closeStorylineModal() {
    document.getElementById('storylineModal').classList.remove('active');
    editingStorylineId = null;
}

document.getElementById('storylineForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('storylineName').value;
    
    if (editingStorylineId) {
        await fetch('/api/storylines/' + editingStorylineId, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name})
        });
    } else {
        const r = await fetch('/api/storylines', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name})
        });
        const d = await r.json();
        currentStoryline = d.id;
        activeStoryline = d.id;  // New storylines are auto-activated
    }
    
    closeStorylineModal();
    loadStorylines();
});

function editStoryline() {
    if (!currentStoryline) {
        showAlert('Select a storyline first', 'No Storyline Selected');
        return;
    }
    openStorylineModal(currentStoryline);
}

async function deleteStoryline() {
    if (!currentStoryline) {
        showAlert('Select a storyline first', 'No Storyline Selected');
        return;
    }
    const confirmed = await showConfirm('Delete this storyline and all injects?', 'Delete Storyline');
    if (!confirmed) return;
    
    fetch('/api/storylines/' + currentStoryline, {method: 'DELETE'})
        .then(() => {
            if (currentStoryline === activeStoryline) {
                activeStoryline = null;
            }
            currentStoryline = null;
            document.getElementById('storylineSelect').value = '';
            loadStorylines();
            showEmptyState();
            updateActivateButton();
        });
}

function renameCurrentStoryline(name) {
    if (!currentStoryline || !name.trim()) return;
    fetch('/api/storylines/' + currentStoryline, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: name.trim()})
    }).then(() => loadStorylines());
}

// ============ Navigation ============
function nextBlock() { 
    shouldScrollToNowPlaying = true;
    socket.emit('next_block'); 
}
function previousBlock() { 
    shouldScrollToNowPlaying = true;
    socket.emit('previous_block'); 
}
function goToBlock(idx) { 
    shouldScrollToNowPlaying = true;
    socket.emit('go_to_block', {index: idx}); 
}
function goToBranchInject(branchId, injectIdx) {
    shouldScrollToNowPlaying = true;
    socket.emit('go_to_branch_inject', {branch_id: branchId, inject_index: injectIdx});
}

function resetAll() {
    goToBlock(0);
    const container = document.getElementById('blocksContainer');
    if (container) container.scrollLeft = 0;
    
    // Stop playback when resetting
    if (isPlaying) {
        togglePlayback();
    }
}

// ============ Utilities ============
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

// ============ Branch Management ============
function openBranchModal(parentInjectId, branchData = null) {
    document.getElementById('branchModalTitle').textContent = branchData ? 'Edit Branch' : 'Create Branch';
    document.getElementById('branchId').value = branchData?.id || '';
    document.getElementById('branchParentInjectId').value = parentInjectId;
    document.getElementById('branchName').value = branchData?.name || '';
    
    const autoTriggerCheckbox = document.getElementById('branchAutoTrigger');
    const autoTriggerHint = document.getElementById('branchAutoTriggerHint');
    
    // Check branches on this inject (excluding current branch if editing)
    const storyline = storylinesData[currentStoryline];
    const otherBranches = storyline?.branches?.filter(b => 
        b.parent_inject_id === parentInjectId && 
        b.id !== branchData?.id
    ) || [];
    
    const existingAutoBranch = otherBranches.find(b => b.auto_trigger);
    
    if (otherBranches.length > 0) {
        // Inject has other branches - auto-trigger not allowed
        autoTriggerCheckbox.checked = false;
        autoTriggerCheckbox.disabled = true;
        if (autoTriggerHint) {
            autoTriggerHint.style.display = 'block';
            if (existingAutoBranch) {
                autoTriggerHint.textContent = `Cannot add branches: "${existingAutoBranch.name}" is auto-trigger and must be the only branch`;
            } else {
                autoTriggerHint.textContent = 'This inject has multiple branches. All must use manual trigger.';
            }
        }
    } else {
        // First/only branch - auto-trigger allowed
        autoTriggerCheckbox.disabled = false;
        // Default to auto-trigger for new branches, or use existing value
        autoTriggerCheckbox.checked = branchData ? branchData.auto_trigger : true;
        if (autoTriggerHint) {
            autoTriggerHint.style.display = 'none';
        }
    }
    
    // Show save to library button only when editing an existing branch with injects
    const saveToLibraryBtn = document.getElementById('saveBranchToLibraryBtn');
    if (branchData && branchData.injects && branchData.injects.length > 0) {
        saveToLibraryBtn.style.display = 'block';
    } else {
        saveToLibraryBtn.style.display = 'none';
    }
    
    // Populate merge target dropdown with injects after the parent inject
    const mergeSelect = document.getElementById('branchMergeTarget');
    mergeSelect.innerHTML = '<option value="">-- Continue after branch (no skip) --</option>';
    
    if (storyline && storyline.blocks) {
        const parentIdx = storyline.blocks.findIndex(b => b.id === parentInjectId);
        storyline.blocks.forEach((block, i) => {
            // Only show injects after the parent inject as merge targets
            if (i > parentIdx) {
                const opt = document.createElement('option');
                opt.value = block.id;
                opt.textContent = `#${i + 1}: ${block.heading}`;
                if (branchData?.merge_to_inject_id === block.id) {
                    opt.selected = true;
                }
                mergeSelect.appendChild(opt);
            }
        });
    }
    
    document.getElementById('branchModal').classList.add('active');
    
    // Focus branch name field after modal is visible
    setTimeout(() => {
        document.getElementById('branchName').focus();
    }, 50);
}

function closeBranchModal() {
    document.getElementById('branchModal').classList.remove('active');
    document.getElementById('branchForm').reset();
    document.getElementById('saveBranchToLibraryBtn').style.display = 'none';
}

document.getElementById('branchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentStoryline) return;
    
    const branchId = document.getElementById('branchId').value;
    const data = {
        storyline_id: currentStoryline,
        parent_inject_id: document.getElementById('branchParentInjectId').value,
        name: document.getElementById('branchName').value,
        auto_trigger: document.getElementById('branchAutoTrigger').checked,
        merge_to_inject_id: document.getElementById('branchMergeTarget').value || null
    };
    
    let response;
    if (branchId) {
        response = await fetch(`/api/branches/${currentStoryline}/${branchId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
        });
    } else {
        response = await fetch('/api/branches', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
        });
    }
    
    const result = await response.json();
    if (result.error) {
        showAlert(result.error, 'Error');
        return;
    }
    
    closeBranchModal();
    renderStoryline(currentStoryline);
});

function editBranch(branchId) {
    const data = storylinesData[currentStoryline];
    const branch = (data.branches || []).find(b => b.id === branchId);
    if (branch) {
        openBranchModal(branch.parent_inject_id, branch);
    }
}

async function deleteBranch(branchId) {
    const confirmed = await showConfirm('Delete this branch and all its injects?', 'Delete Branch');
    if (!confirmed) return;
    fetch(`/api/branches/${currentStoryline}/${branchId}`, {method: 'DELETE'})
        .then(() => renderStoryline(currentStoryline));
}

function renameBranch(branchId, name) {
    if (!name.trim()) return;
    fetch(`/api/branches/${currentStoryline}/${branchId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: name.trim()})
    }).then(() => renderStoryline(currentStoryline));
}

function activateBranch(branchId) {
    socket.emit('activate_branch', {branch_id: branchId});
}

function deactivateBranch(branchId) {
    socket.emit('deactivate_branch', {branch_id: branchId});
}

async function saveBranchToLibrary() {
    const branchId = document.getElementById('branchId').value;
    if (!branchId) return;
    
    const branch = storylinesData[currentStoryline]?.branches?.find(b => b.id === branchId);
    const injectCount = branch?.injects?.length || 0;
    
    if (injectCount === 0) {
        showAlert('This branch has no injects to save.', 'No Injects');
        return;
    }
    
    const confirmed = await showConfirm(`Save branch "${branch.name}" with ${injectCount} inject(s) to the library?`, 'Save to Library');
    if (!confirmed) return;
    
    const response = await fetch(`/api/branches/${currentStoryline}/${branchId}/save-to-library`, {
        method: 'POST'
    });
    const result = await response.json();
    
    if (result.success) {
        loadLibrary();
        closeBranchModal();
        showAlert(`Branch "${branch.name}" saved to library.`, 'Saved');
    }
}

// ============ Branch Inject Management ============
function openBranchInjectModal(branchId, injectData = null) {
    document.getElementById('branchInjectModalTitle').textContent = injectData ? 'Edit Branch Inject' : 'Add Branch Inject';
    document.getElementById('branchInjectId').value = injectData?.id || '';
    document.getElementById('branchInjectBranchId').value = branchId;
    document.getElementById('branchInjectHeading').value = injectData?.heading || '';
    document.getElementById('branchInjectText').value = injectData?.text || '';
    document.getElementById('branchInjectGmNotes').value = injectData?.gm_notes || '';
    document.getElementById('branchInjectDuration').value = injectData?.duration || 0;
    document.getElementById('branchInjectDay').value = injectData?.day || 0;
    document.getElementById('branchInjectTime').value = injectData?.time || '';
    document.getElementById('branchInjectExistingImage').value = injectData?.image || '';
    document.getElementById('branchInjectImage').value = '';
    document.getElementById('branchInjectSaveToLibrary').checked = false;
    
    const preview = document.getElementById('branchImagePreview');
    if (injectData?.image) {
        preview.src = '/uploads/' + injectData.image;
        preview.style.display = 'block';
    } else {
        preview.style.display = 'none';
    }
    
    // Populate player types checkboxes
    populatePlayerTypesCheckboxes('branchInjectPlayerTypes', injectData?.target_player_types || []);
    
    document.getElementById('branchInjectModal').classList.add('active');
    
    // Focus heading field after modal is visible
    setTimeout(() => {
        document.getElementById('branchInjectHeading').focus();
    }, 50);
}

function closeBranchInjectModal() {
    document.getElementById('branchInjectModal').classList.remove('active');
    document.getElementById('branchInjectForm').reset();
    document.getElementById('branchInjectSaveToLibrary').checked = false;
}

function previewBranchImage(input) {
    const preview = document.getElementById('branchImagePreview');
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = e => {
            preview.src = e.target.result;
            preview.style.display = 'block';
        };
        reader.readAsDataURL(input.files[0]);
    }
}

function editBranchInject(branchId, injectId) {
    fetch(`/api/branches/${currentStoryline}/${branchId}/injects/${injectId}`)
        .then(r => r.json())
        .then(inject => openBranchInjectModal(branchId, inject));
}

async function deleteBranchInject(branchId, injectId) {
    const confirmed = await showConfirm('Delete this inject?', 'Delete Inject');
    if (!confirmed) return;
    fetch(`/api/branches/${currentStoryline}/${branchId}/injects/${injectId}`, {method: 'DELETE'})
        .then(() => renderStoryline(currentStoryline));
}

document.getElementById('branchInjectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentStoryline) return;
    
    const branchId = document.getElementById('branchInjectBranchId').value;
    const injectId = document.getElementById('branchInjectId').value;
    
    const formData = new FormData();
    formData.append('heading', document.getElementById('branchInjectHeading').value);
    formData.append('text', document.getElementById('branchInjectText').value);
    formData.append('gm_notes', document.getElementById('branchInjectGmNotes').value);
    formData.append('duration', document.getElementById('branchInjectDuration').value || 0);
    formData.append('day', document.getElementById('branchInjectDay').value || 0);
    formData.append('time', document.getElementById('branchInjectTime').value || '');
    formData.append('existing_image', document.getElementById('branchInjectExistingImage').value);
    formData.append('target_player_types', JSON.stringify(getSelectedPlayerTypes('branchInjectPlayerTypes')));
    
    const img = document.getElementById('branchInjectImage').files[0];
    if (img) formData.append('image', img);
    
    const url = injectId 
        ? `/api/branches/${currentStoryline}/${branchId}/injects/${injectId}`
        : `/api/branches/${currentStoryline}/${branchId}/injects`;
    
    await fetch(url, {method: 'POST', body: formData});
    
    // Also save to library if checkbox is checked
    const saveToLibrary = document.getElementById('branchInjectSaveToLibrary').checked;
    if (saveToLibrary) {
        const libraryFormData = new FormData();
        libraryFormData.append('heading', document.getElementById('branchInjectHeading').value);
        libraryFormData.append('text', document.getElementById('branchInjectText').value);
        libraryFormData.append('gm_notes', document.getElementById('branchInjectGmNotes').value);
        libraryFormData.append('duration', document.getElementById('branchInjectDuration').value || 0);
        libraryFormData.append('day', document.getElementById('branchInjectDay').value || 0);
        libraryFormData.append('time', document.getElementById('branchInjectTime').value || '');
        libraryFormData.append('target_player_types', JSON.stringify(getSelectedPlayerTypes('branchInjectPlayerTypes')));
        
        // Include image: either new upload or existing image filename
        if (img) {
            libraryFormData.append('image', img);
        } else {
            const existingImage = document.getElementById('branchInjectExistingImage').value;
            if (existingImage) {
                libraryFormData.append('copy_image_from', existingImage);
            }
        }
        
        await fetch('/api/library', {method: 'POST', body: libraryFormData});
        loadLibrary();
    }
    
    closeBranchInjectModal();
    renderStoryline(currentStoryline);
});

// ============ Keyboard Shortcuts ============
document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in input fields
    if (e.target.matches('input, textarea, select')) return;
    
    // Don't trigger when a modal is open
    const modalOpen = document.querySelector('.modal-overlay.active');
    if (modalOpen) return;
    
    if (e.key === 'a' || e.key === 'A') {
        if (currentStoryline) {
            openBlockModal();
        }
    }
    
    if (e.key === 't' || e.key === 'T') {
        toggleTheme();
    }
    
    // Zoom shortcuts
    if (e.key === '+' || e.key === '=') {
        zoomIn();
    }
    if (e.key === '-' || e.key === '_') {
        zoomOut();
    }
    if (e.key === '0') {
        zoomReset();
    }
    
    // Storyline navigation (only when a storyline is active)
    if (activeStoryline) {
        if (e.key === 'ArrowRight' || e.key === 'PageDown') {
            e.preventDefault();
            nextBlock();
        }
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
            e.preventDefault();
            previousBlock();
        }
    }
});

// ============ Theme Toggle ============
let isDarkMode = true;

function toggleTheme() {
    isDarkMode = !isDarkMode;
    document.body.classList.toggle('light-mode', !isDarkMode);
    
    const themeBtn = document.getElementById('themeBtn');
    themeBtn.textContent = isDarkMode ? '☀️' : '🌙';
    
    // Save preference
    localStorage.setItem('gmTheme', isDarkMode ? 'dark' : 'light');
}

// Load saved theme on startup
(function initTheme() {
    const savedTheme = localStorage.getItem('gmTheme');
    if (savedTheme === 'light') {
        isDarkMode = false;
        document.body.classList.add('light-mode');
        const themeBtn = document.getElementById('themeBtn');
        if (themeBtn) themeBtn.textContent = '🌙';
    }
})();

// ============ Help Modal ============
function openHelpModal() {
    document.getElementById('helpModal').classList.add('active');
}

function closeHelpModal() {
    document.getElementById('helpModal').classList.remove('active');
}

// ============ Player Types ============
let playerTypes = [];

// Load player types data silently (for inject forms)
function loadPlayerTypesData() {
    fetch('/api/player-types')
        .then(r => r.json())
        .then(data => {
            playerTypes = data.player_types || [];
        });
}

function openPlayerTypesModal() {
    document.getElementById('playerTypesModal').classList.add('active');
    document.getElementById('newPlayerType').value = '';
    loadPlayerTypes();
    
    setTimeout(() => {
        document.getElementById('newPlayerType').focus();
    }, 50);
}

function closePlayerTypesModal() {
    document.getElementById('playerTypesModal').classList.remove('active');
}

function loadPlayerTypes() {
    fetch('/api/player-types')
        .then(r => r.json())
        .then(data => {
            playerTypes = data.player_types || [];
            renderPlayerTypesList();
        });
}

function renderPlayerTypesList() {
    const list = document.getElementById('playerTypesList');
    
    if (playerTypes.length === 0) {
        list.innerHTML = '<div class="player-types-empty">No player types defined yet.</div>';
        return;
    }
    
    list.innerHTML = playerTypes.map(pt => `
        <div class="player-type-item">
            <span class="player-type-name">${escapeHtml(pt)}</span>
            <button class="btn btn-sm btn-danger" onclick="deletePlayerType('${escapeHtml(pt).replace(/'/g, "\\'")}')">✕</button>
        </div>
    `).join('');
}

function addPlayerType() {
    const input = document.getElementById('newPlayerType');
    const name = input.value.trim();
    
    if (!name) return;
    
    fetch('/api/player-types', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: name})
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) {
            showAlert(data.error, 'Error');
        } else {
            playerTypes = data.player_types || [];
            renderPlayerTypesList();
            input.value = '';
            input.focus();
        }
    });
}

async function deletePlayerType(name) {
    const confirmed = await showConfirm(`Delete player type "${name}"?`, 'Delete Player Type');
    if (!confirmed) return;
    
    fetch('/api/player-types/' + encodeURIComponent(name), {method: 'DELETE'})
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                showAlert(data.error, 'Error');
            } else {
                playerTypes = data.player_types || [];
                renderPlayerTypesList();
            }
        });
}

// ============ Player Links ============
let playerLinks = {};
let genericPlayerLink = null;

function openPlayerLinksModal() {
    document.getElementById('playerLinksModal').classList.add('active');
    
    // Generate links if needed and load them
    fetch('/api/player-links', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({regenerate: false})
    })
        .then(r => r.json())
        .then(data => {
            playerLinks = data.player_links || {};
            playerTypes = data.player_types || [];
            genericPlayerLink = data.generic_player_link || null;
            renderPlayerLinksList();
        });
}

function closePlayerLinksModal() {
    document.getElementById('playerLinksModal').classList.remove('active');
}

async function regenerateAllLinks() {
    const confirmed = await showConfirm('This will generate new URLs for ALL player links. Existing links will stop working. Continue?', 'Regenerate Links');
    if (!confirmed) return;
    
    fetch('/api/player-links', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({regenerate: true})
    })
        .then(r => r.json())
        .then(data => {
            playerLinks = data.player_links || {};
            playerTypes = data.player_types || [];
            genericPlayerLink = data.generic_player_link || null;
            renderPlayerLinksList();
        });
}

function renderPlayerLinksList() {
    const list = document.getElementById('playerLinksList');
    const baseUrl = window.location.origin;
    
    // Build the generic "All Players" link first
    let html = '';
    
    if (genericPlayerLink) {
        const genericUrl = `${baseUrl}/player/${genericPlayerLink}`;
        html += `
            <div class="player-link-item player-link-generic">
                <span class="player-link-name">🌐 All Players</span>
                <div class="player-link-url-row">
                    <input type="text" class="form-input player-link-url" id="genericPlayerLinkInput" value="${genericUrl}" readonly>
                    <button class="btn btn-sm btn-secondary" onclick="copyPlayerLink('genericPlayerLinkInput')" title="Copy link">📋</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.open('${genericUrl}', '_blank')" title="Open in new tab">↗</button>
                </div>
            </div>
        `;
    }
    
    // Add player type links
    if (playerTypes.length === 0) {
        html += '<div class="player-types-empty">No player types defined. Create some in "👥 Types" first.</div>';
    } else {
        html += playerTypes.map(pt => {
            const linkId = playerLinks[pt] || '';
            const fullUrl = linkId ? `${baseUrl}/player/${linkId}` : '';
            const inputId = `playerLink_${linkId}`;
            
            return `
                <div class="player-link-item">
                    <span class="player-link-name">${escapeHtml(pt)}</span>
                    <div class="player-link-url-row">
                        <input type="text" class="form-input player-link-url" id="${inputId}" value="${fullUrl}" readonly>
                        <button class="btn btn-sm btn-secondary" onclick="copyPlayerLink('${inputId}')" title="Copy link">📋</button>
                        <button class="btn btn-sm btn-secondary" onclick="window.open('${fullUrl}', '_blank')" title="Open in new tab">↗</button>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    list.innerHTML = html;
}

function copyPlayerLink(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    
    input.select();
    input.setSelectionRange(0, 99999); // For mobile
    
    navigator.clipboard.writeText(input.value).then(() => {
        // Brief visual feedback
        const btn = input.nextElementSibling;
        const originalText = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = originalText, 1000);
    }).catch(() => {
        // Fallback for older browsers
        document.execCommand('copy');
    });
}

// ============ Inject Library ============
let libraryInjects = [];
let libraryCollapsed = localStorage.getItem('libraryCollapsed') === 'true';

function toggleLibrary() {
    libraryCollapsed = !libraryCollapsed;
    localStorage.setItem('libraryCollapsed', libraryCollapsed);
    updateLibraryState();
}

function updateLibraryState() {
    const content = document.getElementById('libraryContent');
    const toggle = document.getElementById('libraryToggle');
    const panel = document.getElementById('libraryPanel');
    
    if (libraryCollapsed) {
        content.style.display = 'none';
        toggle.textContent = '▶';
        panel.classList.add('collapsed');
    } else {
        content.style.display = '';
        toggle.textContent = '▼';
        panel.classList.remove('collapsed');
    }
}

function loadLibrary() {
    fetch('/api/library')
        .then(r => r.json())
        .then(data => {
            libraryInjects = data.library || [];
            renderLibrary();
            updateLibraryState();
        });
}

function renderLibrary() {
    const content = document.getElementById('libraryContent');
    const countEl = document.getElementById('libraryCount');
    
    // Update count display
    if (countEl) {
        countEl.textContent = `(${libraryInjects.length})`;
    }
    
    if (libraryInjects.length === 0) {
        content.innerHTML = '<div class="library-empty">No injects in library. Save injects here to reuse them across storylines.</div>';
        return;
    }
    
    content.innerHTML = libraryInjects.map(item => {
        // Check if this is a branch or a single inject
        if (item.type === 'branch') {
            const injectCount = item.injects?.length || 0;
            const firstInject = item.injects?.[0];
            
            return `
                <div class="library-card library-branch-card" 
                     draggable="true"
                     data-library-id="${item.id}"
                     data-library-type="branch"
                     ondragstart="handleLibraryBranchDragStart(event, '${item.id}')"
                     ondragend="handleLibraryBranchDragEnd(event)">
                    <div class="block-header">
                        <span class="block-number library-branch-number">⑂</span>
                        <span class="library-branch-count">${injectCount} injects</span>
                        <div class="block-actions">
                            <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); showLibraryBranchDetails('${item.id}')" title="View details">👁</button>
                            <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteLibraryItem('${item.id}')" title="Delete">✕</button>
                        </div>
                    </div>
                    <div class="block-body">
                        <div class="block-title">${escapeHtml(item.name || 'Unnamed Branch')}</div>
                        ${firstInject?.image ? `<img src="/uploads/${firstInject.image}" class="block-image">` : ''}
                        <div class="block-text">${item.auto_trigger ? '🔄 Auto-trigger' : '👆 Manual trigger'}</div>
                    </div>
                </div>
            `;
        } else {
            // Regular inject
            return `
                <div class="library-card" 
                     draggable="true" 
                     data-library-id="${item.id}"
                     data-library-type="inject"
                     ondragstart="handleLibraryDragStart(event, '${item.id}')"
                     ondragend="handleLibraryDragEnd(event)">
                    <div class="block-header">
                        <div class="block-actions">
                            <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); editLibraryInject('${item.id}')" title="Edit">✎</button>
                            <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); addLibraryInjectToStoryline('${item.id}')" title="Add to storyline">➕</button>
                            <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteLibraryItem('${item.id}')" title="Delete">✕</button>
                        </div>
                    </div>
                    <div class="block-body">
                        <div class="block-title">${escapeHtml(item.heading || 'Untitled')}</div>
                        ${item.image ? `<img src="/uploads/${item.image}" class="block-image">` : ''}
                        ${item.text ? `<div class="block-text">${escapeHtml(item.text)}</div>` : ''}
                    </div>
                </div>
            `;
        }
    }).join('');
}

function openLibraryInjectModal(injectId = null) {
    const modal = document.getElementById('libraryInjectModal');
    const title = document.getElementById('libraryInjectModalTitle');
    
    // Reset form
    document.getElementById('libraryInjectForm').reset();
    document.getElementById('libraryInjectId').value = '';
    document.getElementById('libraryExistingImage').value = '';
    document.getElementById('libraryImagePreview').style.display = 'none';
    
    // Populate player types checkboxes
    populatePlayerTypesCheckboxes('libraryInjectPlayerTypes');
    
    if (injectId) {
        // Edit mode
        title.textContent = 'Edit Library Inject';
        const inject = libraryInjects.find(i => i.id === injectId);
        if (inject) {
            document.getElementById('libraryInjectId').value = inject.id;
            document.getElementById('libraryInjectHeading').value = inject.heading || '';
            document.getElementById('libraryInjectText').value = inject.text || '';
            document.getElementById('libraryInjectGmNotes').value = inject.gm_notes || '';
            document.getElementById('libraryInjectDuration').value = inject.duration || 0;
            
            // Set selected player types
            (inject.target_player_types || []).forEach(pt => {
                const cb = document.querySelector(`#libraryInjectPlayerTypes input[value="${pt}"]`);
                if (cb) cb.checked = true;
            });
            
            if (inject.image) {
                document.getElementById('libraryExistingImage').value = inject.image;
                document.getElementById('libraryImagePreview').src = '/uploads/' + inject.image;
                document.getElementById('libraryImagePreview').style.display = 'block';
            }
        }
    } else {
        title.textContent = 'Add to Library';
    }
    
    modal.classList.add('active');
    document.getElementById('libraryInjectHeading').focus();
}

function closeLibraryInjectModal() {
    document.getElementById('libraryInjectModal').classList.remove('active');
}

function previewLibraryImage(input) {
    const preview = document.getElementById('libraryImagePreview');
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = (e) => {
            preview.src = e.target.result;
            preview.style.display = 'block';
        };
        reader.readAsDataURL(input.files[0]);
    }
}

document.getElementById('libraryInjectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = new FormData();
    formData.append('heading', document.getElementById('libraryInjectHeading').value);
    formData.append('text', document.getElementById('libraryInjectText').value);
    formData.append('gm_notes', document.getElementById('libraryInjectGmNotes').value);
    formData.append('duration', document.getElementById('libraryInjectDuration').value || 0);
    formData.append('target_player_types', JSON.stringify(getSelectedPlayerTypes('libraryInjectPlayerTypes')));
    
    const img = document.getElementById('libraryInjectImage').files[0];
    if (img) formData.append('image', img);
    
    const injectId = document.getElementById('libraryInjectId').value;
    const url = injectId ? `/api/library/${injectId}` : '/api/library';
    
    await fetch(url, {method: 'POST', body: formData});
    closeLibraryInjectModal();
    loadLibrary();
});

function editLibraryInject(injectId) {
    openLibraryInjectModal(injectId);
}

async function deleteLibraryItem(itemId) {
    const item = libraryInjects.find(i => i.id === itemId);
    const itemType = item?.type === 'branch' ? 'branch' : 'inject';
    
    const confirmed = await showConfirm(`Delete this ${itemType} from the library?`, 'Delete from Library');
    if (!confirmed) return;
    
    await fetch(`/api/library/${itemId}`, {method: 'DELETE'});
    loadLibrary();
}

// Keep old function name for backwards compatibility
async function deleteLibraryInject(injectId) {
    await deleteLibraryItem(injectId);
}

function showLibraryBranchDetails(branchId) {
    const branch = libraryInjects.find(i => i.id === branchId && i.type === 'branch');
    if (!branch) return;
    
    // Set branch name
    document.getElementById('libraryBranchDetailsName').textContent = branch.name || 'Unnamed Branch';
    
    // Set trigger info
    document.getElementById('libraryBranchDetailsTrigger').innerHTML = branch.auto_trigger 
        ? '<span class="branch-badge auto">🔄 Auto-trigger</span>' 
        : '<span class="branch-badge manual">👆 Manual trigger</span>';
    
    // Build inject list
    const injectsContainer = document.getElementById('libraryBranchDetailsInjects');
    if (branch.injects && branch.injects.length > 0) {
        injectsContainer.innerHTML = branch.injects.map((inj, i) => `
            <div class="branch-details-inject">
                <div class="branch-details-inject-header">
                    <span class="branch-details-inject-number">#${i + 1}</span>
                    <span class="branch-details-inject-title">${escapeHtml(inj.heading || 'Untitled')}</span>
                    ${inj.duration > 0 ? `<span class="block-duration">${inj.duration}s</span>` : ''}
                </div>
                ${inj.image ? `<img src="/uploads/${inj.image}" class="branch-details-inject-image">` : ''}
                ${inj.text ? `<div class="branch-details-inject-text">${escapeHtml(inj.text)}</div>` : ''}
            </div>
        `).join('');
    } else {
        injectsContainer.innerHTML = '<div class="branch-details-empty">No injects in this branch</div>';
    }
    
    document.getElementById('libraryBranchDetailsModal').classList.add('active');
}

function closeLibraryBranchDetailsModal() {
    document.getElementById('libraryBranchDetailsModal').classList.remove('active');
}

async function addLibraryBranchToStoryline(branchId, parentInjectId) {
    await fetch(`/api/library/${branchId}/add-branch-to-storyline`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            storyline_id: currentStoryline,
            parent_inject_id: parentInjectId
        })
    });
    
    loadStorylines();
    renderStoryline(currentStoryline);
}

async function addLibraryInjectToStoryline(injectId) {
    if (!currentStoryline) {
        showAlert('Please select a storyline first', 'No Storyline Selected');
        return;
    }
    
    await fetch(`/api/library/${injectId}/add-to-storyline`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            storyline_id: currentStoryline
        })
    });
    
    loadStorylines();
    renderStoryline(currentStoryline);
}

// Library drag and drop
let draggedLibraryInjectId = null;

function handleLibraryDragStart(event, injectId) {
    draggedLibraryInjectId = injectId;
    event.target.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', injectId);
}

function handleLibraryDragEnd(event) {
    event.target.classList.remove('dragging');
    draggedLibraryInjectId = null;
    
    // Remove any drop indicators
    document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    document.querySelectorAll('.inject-drop-indicator').forEach(el => el.remove());
    document.querySelectorAll('.inject-drop-target').forEach(el => el.classList.remove('inject-drop-target'));
    document.querySelectorAll('.branch-inject-drop-target').forEach(el => el.classList.remove('branch-inject-drop-target'));
}

// Library branch drag handling
let draggedLibraryBranchId = null;

function handleLibraryBranchDragStart(event, branchId) {
    draggedLibraryBranchId = branchId;
    event.target.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', branchId);
}

function handleLibraryBranchDragEnd(event) {
    event.target.classList.remove('dragging');
    draggedLibraryBranchId = null;
    
    // Remove any drop indicators
    document.querySelectorAll('.branch-drop-target').forEach(el => el.classList.remove('branch-drop-target'));
}

// Add drop zone handling to main storyline row
document.addEventListener('DOMContentLoaded', () => {
    // Set up drop handling on main content area
    const mainContent = document.getElementById('mainContent');
    
    mainContent.addEventListener('dragover', (e) => {
        e.preventDefault();
        
        if (draggedLibraryInjectId) {
            // Dragging an inject - show drop position indicator
            e.dataTransfer.dropEffect = 'copy';
            
            // Remove previous indicators
            document.querySelectorAll('.inject-drop-indicator').forEach(el => el.remove());
            document.querySelectorAll('.inject-drop-target').forEach(el => el.classList.remove('inject-drop-target'));
            document.querySelectorAll('.branch-inject-drop-target').forEach(el => el.classList.remove('branch-inject-drop-target'));
            
            // Check if hovering over a branch row
            const branchRow = e.target.closest('.branch-injects-row');
            if (branchRow) {
                // Hovering over a branch - show indicator in branch
                const branchGroup = branchRow.closest('.branch-group');
                const branchId = branchGroup?.dataset.branchId;
                
                const branchCards = branchRow.querySelectorAll('.branch-block-card');
                let insertBeforeCard = null;
                
                for (let i = 0; i < branchCards.length; i++) {
                    const rect = branchCards[i].getBoundingClientRect();
                    const midX = rect.left + rect.width / 2;
                    
                    if (e.clientX < midX) {
                        insertBeforeCard = branchCards[i];
                        break;
                    }
                }
                
                // Create drop indicator
                const indicator = document.createElement('div');
                indicator.className = 'inject-drop-indicator branch-inject-indicator';
                indicator.dataset.branchId = branchId;
                
                if (insertBeforeCard) {
                    insertBeforeCard.classList.add('branch-inject-drop-target');
                    branchRow.insertBefore(indicator, insertBeforeCard);
                } else {
                    // Insert at end - before add-branch-inject button
                    const addBtn = branchRow.querySelector('.add-branch-inject');
                    if (addBtn) {
                        branchRow.insertBefore(indicator, addBtn);
                    } else {
                        branchRow.appendChild(indicator);
                    }
                }
                return;
            }
            
            // Not over a branch - check main storyline row
            const mainRow = document.querySelector('.main-storyline-row');
            if (!mainRow) return;
            
            // Find the wrapper elements (not the block-cards inside them)
            const wrapperElements = mainRow.querySelectorAll(':scope > .main-block-item, :scope > .main-block-with-connector');
            let insertBeforeWrapper = null;
            let insertPosition = null;
            
            for (let i = 0; i < wrapperElements.length; i++) {
                const rect = wrapperElements[i].getBoundingClientRect();
                const midX = rect.left + rect.width / 2;
                
                if (e.clientX < midX) {
                    insertBeforeWrapper = wrapperElements[i];
                    insertPosition = i;
                    break;
                }
            }
            
            // Create drop indicator
            const indicator = document.createElement('div');
            indicator.className = 'inject-drop-indicator';
            
            if (insertBeforeWrapper) {
                // Insert before this wrapper
                const blockCard = insertBeforeWrapper.querySelector('.block-card');
                if (blockCard) blockCard.classList.add('inject-drop-target');
                mainRow.insertBefore(indicator, insertBeforeWrapper);
            } else if (wrapperElements.length > 0) {
                // Insert at end - after the last wrapper, before add-block-card
                const addBlockCard = mainRow.querySelector('.add-block-card');
                if (addBlockCard) {
                    mainRow.insertBefore(indicator, addBlockCard);
                } else {
                    mainRow.appendChild(indicator);
                }
            } else {
                // Empty storyline
                mainRow.classList.add('drop-target');
            }
        } else if (draggedLibraryBranchId) {
            // Dragging a branch - highlight the inject being hovered over
            e.dataTransfer.dropEffect = 'copy';
            
            // Remove previous highlights
            document.querySelectorAll('.branch-drop-target').forEach(el => el.classList.remove('branch-drop-target'));
            
            // Find the block card under the cursor
            const blockCard = e.target.closest('.block-card');
            if (blockCard && blockCard.closest('.main-storyline-row')) {
                blockCard.classList.add('branch-drop-target');
            }
        }
    });
    
    mainContent.addEventListener('dragleave', (e) => {
        if (draggedLibraryInjectId) {
            // Only clean up if leaving the main content entirely
            if (!mainContent.contains(e.relatedTarget)) {
                document.querySelectorAll('.inject-drop-indicator').forEach(el => el.remove());
                document.querySelectorAll('.inject-drop-target').forEach(el => el.classList.remove('inject-drop-target'));
                document.querySelectorAll('.branch-inject-drop-target').forEach(el => el.classList.remove('branch-inject-drop-target'));
                const mainRow = document.querySelector('.main-storyline-row');
                if (mainRow) {
                    mainRow.classList.remove('drop-target');
                }
            }
        }
    });
    
    mainContent.addEventListener('drop', async (e) => {
        e.preventDefault();
        
        // Clean up all indicators
        document.querySelectorAll('.inject-drop-indicator').forEach(el => el.remove());
        document.querySelectorAll('.inject-drop-target').forEach(el => el.classList.remove('inject-drop-target'));
        document.querySelectorAll('.branch-inject-drop-target').forEach(el => el.classList.remove('branch-inject-drop-target'));
        
        if (draggedLibraryInjectId) {
            // Dropping an inject
            const mainRow = document.querySelector('.main-storyline-row');
            if (mainRow) {
                mainRow.classList.remove('drop-target');
            }
            
            if (!currentStoryline) {
                showAlert('Please select a storyline first', 'No Storyline Selected');
                return;
            }
            
            // Check if dropping onto a branch
            const branchRow = e.target.closest('.branch-injects-row');
            if (branchRow) {
                const branchGroup = branchRow.closest('.branch-group');
                const branchId = branchGroup?.dataset.branchId;
                
                if (!branchId) {
                    showAlert('Could not determine target branch.', 'Error');
                    return;
                }
                
                // Find drop position in branch
                let position = null;
                const branchCards = branchRow.querySelectorAll('.branch-block-card');
                
                for (let i = 0; i < branchCards.length; i++) {
                    const rect = branchCards[i].getBoundingClientRect();
                    const midX = rect.left + rect.width / 2;
                    
                    if (e.clientX < midX) {
                        position = i;
                        break;
                    }
                }
                
                // Add inject to branch
                await fetch(`/api/library/${draggedLibraryInjectId}/add-to-branch`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        storyline_id: currentStoryline,
                        branch_id: branchId,
                        position: position
                    })
                });
                
                loadStorylines();
                renderStoryline(currentStoryline);
                return;
            }
            
            // Dropping onto main storyline
            // Find drop position based on mouse location using wrapper elements
            let position = null;
            const wrapperElements = mainRow?.querySelectorAll(':scope > .main-block-item, :scope > .main-block-with-connector') || [];
            
            for (let i = 0; i < wrapperElements.length; i++) {
                const rect = wrapperElements[i].getBoundingClientRect();
                const midX = rect.left + rect.width / 2;
                
                if (e.clientX < midX) {
                    position = i;
                    break;
                }
            }
            
            // Add inject at position (null = end)
            await fetch(`/api/library/${draggedLibraryInjectId}/add-to-storyline`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    storyline_id: currentStoryline,
                    position: position
                })
            });
            
            loadStorylines();
            renderStoryline(currentStoryline);
        } else if (draggedLibraryBranchId) {
            // Dropping a branch
            document.querySelectorAll('.branch-drop-target').forEach(el => el.classList.remove('branch-drop-target'));
            
            if (!currentStoryline) {
                showAlert('Please select a storyline first', 'No Storyline Selected');
                return;
            }
            
            // Find the block card that was dropped on
            const blockCard = e.target.closest('.block-card');
            if (!blockCard || !blockCard.closest('.main-storyline-row')) {
                showAlert('Drop the branch on a main storyline inject to attach it.', 'Invalid Drop Target');
                return;
            }
            
            const parentInjectId = blockCard.dataset.id;
            if (!parentInjectId) {
                showAlert('Could not determine target inject.', 'Error');
                return;
            }
            
            // Add library branch to storyline
            await addLibraryBranchToStoryline(draggedLibraryBranchId, parentInjectId);
        }
    });
});

// ============ Import Storyline ============
let importData = null;

function openImportModal() {
    document.getElementById('importModal').classList.add('active');
    document.getElementById('importFile').value = '';
    document.getElementById('importPreview').style.display = 'none';
    document.getElementById('importError').style.display = 'none';
    document.getElementById('importConfirmBtn').disabled = true;
    importData = null;
}

function closeImportModal() {
    document.getElementById('importModal').classList.remove('active');
    importData = null;
}

function previewImportFile(input) {
    const previewEl = document.getElementById('importPreview');
    const previewContentEl = document.getElementById('importPreviewContent');
    const errorEl = document.getElementById('importError');
    const confirmBtn = document.getElementById('importConfirmBtn');
    
    previewEl.style.display = 'none';
    errorEl.style.display = 'none';
    confirmBtn.disabled = true;
    importData = null;
    
    if (!input.files || !input.files[0]) {
        return;
    }
    
    const file = input.files[0];
    const reader = new FileReader();
    
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            
            // Validate structure
            if (!data.storylines || typeof data.storylines !== 'object') {
                throw new Error('Invalid format: missing "storylines" object');
            }
            
            const storylineCount = Object.keys(data.storylines).length;
            if (storylineCount === 0) {
                throw new Error('No storylines found in file');
            }
            
            // Build preview
            let previewHtml = `<div class="import-summary">Found <strong>${storylineCount}</strong> storyline(s):</div><ul class="import-list">`;
            
            for (const [id, storyline] of Object.entries(data.storylines)) {
                const blockCount = storyline.blocks?.length || 0;
                const branchCount = storyline.branches?.length || 0;
                previewHtml += `<li>
                    <strong>${escapeHtml(storyline.name || 'Unnamed')}</strong>
                    <span class="import-meta">${blockCount} inject(s), ${branchCount} branch(es)</span>
                </li>`;
            }
            previewHtml += '</ul>';
            
            // Check for player types
            if (data.player_types && data.player_types.length > 0) {
                previewHtml += `<div class="import-summary" style="margin-top: 10px;">Player types: <strong>${data.player_types.join(', ')}</strong></div>`;
            }
            
            // Check for library items
            if (data.inject_library && data.inject_library.length > 0) {
                previewHtml += `<div class="import-summary" style="margin-top: 10px;">Library items: <strong>${data.inject_library.length}</strong></div>`;
            }
            
            previewContentEl.innerHTML = previewHtml;
            previewEl.style.display = 'block';
            confirmBtn.disabled = false;
            importData = data;
            
        } catch (err) {
            errorEl.textContent = `Error: ${err.message}`;
            errorEl.style.display = 'block';
            confirmBtn.disabled = true;
        }
    };
    
    reader.onerror = function() {
        errorEl.textContent = 'Error reading file';
        errorEl.style.display = 'block';
    };
    
    reader.readAsText(file);
}

async function confirmImport() {
    if (!importData) return;
    
    try {
        const response = await fetch('/api/storylines/import', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(importData)
        });
        
        const result = await response.json();
        
        if (result.error) {
            showAlert(`Import failed: ${result.error}`, 'Import Failed');
            return;
        }
        
        closeImportModal();
        loadStorylines();
        
        // Show success message
        const imported = result.imported_storylines || 0;
        const playerTypes = result.imported_player_types || 0;
        const library = result.imported_library_items || 0;
        
        let message = `Successfully imported ${imported} storyline(s)`;
        if (playerTypes > 0) message += `, ${playerTypes} player type(s)`;
        if (library > 0) message += `, ${library} library item(s)`;
        
        showAlert(message, 'Import Complete');
        
    } catch (err) {
        showAlert(`Import failed: ${err.message}`, 'Import Failed');
    }
}
