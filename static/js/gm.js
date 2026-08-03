/**
 * GM Interface JavaScript
 * Handles storyline management, inject editing, playback, and real-time sync
 */

// ============ Dynamic Layout Adjustment ============
function adjustLayoutForControlBar() {
    const controlBar = document.querySelector('.controls-bar');
    if (!controlBar) return;
    
    const height = controlBar.offsetHeight;
    document.documentElement.style.setProperty('--control-bar-height', height + 'px');
    document.body.style.paddingTop = height + 'px';
}

// Adjust on load and resize
window.addEventListener('load', adjustLayoutForControlBar);
window.addEventListener('resize', adjustLayoutForControlBar);

// Also adjust after fonts load (can change heights)
document.fonts?.ready?.then(adjustLayoutForControlBar);

// ============ Custom Alert/Confirm Modals ============
let confirmCallback = null;

function showAlert(message, title = 'Notice') {
    document.getElementById('alertModalTitle').textContent = title;
    document.getElementById('alertModalMessage').textContent = message;
    document.getElementById('alertModal').classList.add('active');
}

function closeAlertModal() {
    document.getElementById('alertModal').classList.remove('active');
    flushPendingRefresh();
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
    flushPendingRefresh();
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

// Stopwatch state
let stopwatchStartTime = null;
let stopwatchInterval = null;

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
let lastActiveBranchesKey = null;

socket.on('state_update', (data) => {
    if (data.current_block !== undefined) {
        document.getElementById('currentBlock').textContent = data.current_block + 1;
    }

    // Track what's currently being displayed to players
    currentDisplaySource = data.current_source || 'main';
    currentDisplayBranchId = data.current_branch_id || null;
    currentDisplayBranchInjectIdx = data.current_branch_inject_idx;

    // Keep the cached storyline position in sync so highlighting and other
    // features stay correct without re-fetching the whole storyline.
    if (currentStoryline && storylinesData[currentStoryline]) {
        if (data.current_block !== undefined) {
            storylinesData[currentStoryline].current_block = data.current_block;
        }
        if (data.active_branches !== undefined) {
            storylinesData[currentStoryline].active_branches = data.active_branches;
        }
    }

    // Playback state only applies to the active storyline. If the GM is viewing
    // a different storyline, there's nothing in view to re-highlight.
    if (data.active_branches !== undefined && currentStoryline &&
        currentStoryline === activeStoryline) {
        const scrollIfRequested = () => {
            if (shouldScrollToNowPlaying) {
                shouldScrollToNowPlaying = false;
                scrollToNowPlaying();
            }
        };

        // Only a change to *which* branches are active affects structure
        // (Start/Stop buttons, Playing badges). A plain advance does not, so we
        // skip the costly fetch + full DOM rebuild and just move the highlight.
        const branchesKey = JSON.stringify(data.active_branches);
        const branchesChanged = branchesKey !== lastActiveBranchesKey;
        lastActiveBranchesKey = branchesKey;

        if (branchesChanged) {
            renderStoryline(currentStoryline).then(scrollIfRequested);
        } else {
            highlightCurrentlyDisplayed(
                data.current_block || 0,
                currentDisplaySource,
                currentDisplayBranchId,
                currentDisplayBranchInjectIdx
            );
            scrollIfRequested();
        }
    }
});

socket.on('playback_update', (data) => {
    isPlaying = data.playing;
    updatePlayButton();
    updatePlaybackStatus(data);
    updateCountdownOverlay(data);
});

socket.on('session_notes_updated', (data) => {
    sessionNotes = data.notes || [];
    renderSessionNotes();
});

// ============ Live Multi-GM Sync ============
// Another GM changed something. Refresh the affected view so we don't need a
// manual reload. If a modal is open we defer the refresh until it closes so we
// don't yank the rug out from under an in-progress edit.
let pendingRefresh = { storyline: false, library: false, playerTypes: false };

function isAnyModalOpen() {
    return !!document.querySelector('.modal-overlay.active');
}

function doRefresh(scope) {
    if (scope === 'storyline') {
        loadStorylines();
        if (currentStoryline) renderStoryline(currentStoryline);
    } else if (scope === 'library') {
        loadLibrary();
    } else if (scope === 'playerTypes') {
        loadPlayerTypesData();
        // Refresh the management lists only if those modals are open.
        if (document.getElementById('playerTypesModal')?.classList.contains('active')) {
            loadPlayerTypes();
        }
        if (document.getElementById('playerLinksModal')?.classList.contains('active')) {
            fetch('/api/player-links')
                .then(r => r.json())
                .then(data => {
                    playerLinks = data.player_links || {};
                    playerTypes = data.player_types || [];
                    genericPlayerLink = data.generic_player_link || null;
                    renderPlayerLinksList();
                });
        }
    }
}

function handleRemoteChange(scope) {
    if (isAnyModalOpen()) {
        pendingRefresh[scope] = true;
        return;
    }
    doRefresh(scope);
}

function flushPendingRefresh() {
    if (isAnyModalOpen()) return;
    Object.keys(pendingRefresh).forEach(scope => {
        if (pendingRefresh[scope]) {
            pendingRefresh[scope] = false;
            doRefresh(scope);
        }
    });
}

socket.on('storyline_changed', () => handleRemoteChange('storyline'));
socket.on('library_changed', () => handleRemoteChange('library'));
socket.on('player_types_changed', () => handleRemoteChange('playerTypes'));

// ============ Collaborative Editing Presence ============
// Warn a GM when another GM has the same item's editor open, so they know a
// save may overwrite the other person's changes.
let myGmLabel = null;
let currentEditingLock = null; // { entity_type, entity_id }

socket.on('gm_identity', (data) => {
    myGmLabel = data.label;
});

socket.on('editing_status', (data) => {
    if (!currentEditingLock) return;
    if (data.entity_type === currentEditingLock.entity_type &&
        String(data.entity_id) === String(currentEditingLock.entity_id)) {
        const others = (data.editors || []).filter(label => label !== myGmLabel);
        showEditingConflict(others);
    }
});

function startEditingLock(entityType, entityId) {
    // Only existing entities can be co-edited (and thus overwritten).
    if (!entityId) {
        currentEditingLock = null;
        showEditingConflict([]);
        return;
    }
    currentEditingLock = { entity_type: entityType, entity_id: String(entityId) };
    showEditingConflict([]); // reset banner; server will report current editors
    socket.emit('start_editing', currentEditingLock);
}

function stopEditingLock() {
    if (currentEditingLock) {
        socket.emit('stop_editing', currentEditingLock);
        currentEditingLock = null;
    }
    showEditingConflict([]);
    flushPendingRefresh();
}

function showEditingConflict(others) {
    const banners = document.querySelectorAll('.editing-conflict-banner');
    banners.forEach(banner => {
        if (others && others.length > 0) {
            const who = others.length === 1
                ? `${others[0]} is`
                : `${others.join(', ')} are`;
            banner.textContent = `⚠️ ${who} also editing this. Saving will overwrite their changes.`;
            banner.style.display = 'block';
        } else {
            banner.style.display = 'none';
        }
    });
}

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
    
    const isNewStoryline = currentStoryline !== id;
    currentStoryline = id;
    renderStoryline(id).then(() => {
        if (isNewStoryline) {
            // Zoom to fit when loading a new storyline
            setTimeout(() => zoomToFit(), 50); // Small delay to ensure DOM is ready
        } else {
            // Just update scrollbar visibility for re-renders
            updateScrollbarVisibility();
        }
    });
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
    // Preserve scroll position across the re-render (both axes) so adding or
    // removing an inject doesn't jump the viewport back to the top-left. The
    // browser clamps these if the content got smaller.
    const wrapper = document.querySelector('.storyline-layout-wrapper');
    const scrollLeft = wrapper ? wrapper.scrollLeft : 0;
    const scrollTop = wrapper ? wrapper.scrollTop : 0;

    return fetch('/api/storylines/' + id)
        .then(r => r.json())
        .then(data => {
            storylinesData[id] = data;
            const blocks = data.blocks || [];
            const idx = data.current_block || 0;

            document.getElementById('totalBlocks').textContent = blocks.length;
            document.getElementById('currentBlock').textContent = idx + 1;

            document.getElementById('mainContent').innerHTML = buildStorylineHTML(data, blocks, idx);

            // Size branch columns to their real (measured) content before
            // wiring drag & scrollbars, so nested side quests don't overflow.
            fitBranchColumns();

            // Draw each branch's connector from its parent card to its first card.
            fitBranchConnectors();

            initSortable();

            // Apply current highlighting after render
            highlightCurrentlyDisplayed(idx, currentDisplaySource, currentDisplayBranchId, currentDisplayBranchInjectIdx);

            // Re-evaluate scrollbars for the new content so adding/removing a
            // side quest doesn't leave a pointless scrollbar behind.
            updateScrollbarVisibility();

            // Restore the scroll position now that widths/heights are final
            // (overflow has been set). The browser clamps to the new bounds.
            const newWrapper = document.querySelector('.storyline-layout-wrapper');
            if (newWrapper) {
                newWrapper.scrollLeft = scrollLeft;
                newWrapper.scrollTop = scrollTop;
            }
        });
}

// After the storyline is in the DOM, measure each top-level branch's real
// rendered width (including nested sub-branches, which the build-time estimate
// can't know) and widen its main-storyline column + branch slots to match. This
// keeps the above/below branch rows column-aligned with the main row and stops
// a branch box from overflowing (which showed an inner scrollbar).
function fitBranchColumns() {
    const layout = document.getElementById('blocksContainer');
    if (!layout) return;
    const mainRow = layout.querySelector('.main-storyline-row');
    if (!mainRow) return;
    const aboveRow = layout.querySelector('.branches-above');
    const belowRow = layout.querySelector('.branches-below');
    const rows = [aboveRow, belowRow].filter(Boolean);
    const PAD = 8; // small slack (offsetWidth already includes padding + border)

    const mainItems = [...mainRow.querySelectorAll(':scope > .main-block-with-connector, :scope > .main-block-item')];
    mainItems.forEach(item => {
        const blockId = item.querySelector('.block-card')?.dataset.id;
        if (!blockId) return;

        // Widest branch (above or below) attached to this inject. Measure with
        // the group free to take its natural width so nested sub-branch headers
        // and cards report their true size, then restore.
        let branchWidth = 0;
        rows.forEach(row => {
            const slot = row.querySelector(`.branch-slot[data-parent-id="${blockId}"]`);
            if (!slot) return;
            // An inject may carry several branches (stacked) — fit the widest.
            slot.querySelectorAll(':scope > .branch-group').forEach(group => {
                const prev = group.style.width;
                group.style.width = 'max-content';
                const natural = group.offsetWidth;
                group.style.width = prev;
                branchWidth = Math.max(branchWidth, natural + PAD);
            });
        });

        const width = Math.max(220, branchWidth);
        item.style.width = width + 'px';
        const connector = item.querySelector('.connector-horizontal');
        if (connector) connector.style.width = Math.max(0, width - 220) + 'px';
        rows.forEach(row => {
            const slot = row.querySelector(`.branch-slot[data-parent-id="${blockId}"]`);
            if (slot) slot.style.width = width + 'px';
        });
    });

    // Second pass (after all widths are set): stretch each horizontal connector
    // so it reaches the NEXT inject card instead of stopping at its own column
    // edge, closing the inter-inject gap. The card is flex-shrink:0, so the
    // connector simply overflows into the row gap without disturbing layout.
    const zoom = zoomLevel || 1;
    mainItems.forEach(item => {
        const connector = item.querySelector(':scope > .connector-horizontal');
        if (!connector) return;
        const next = item.nextElementSibling;
        const nextCard = next && (next.matches('.add-block-card') ? next : next.querySelector('.block-card'));
        if (!nextCard) return;
        const c = connector.getBoundingClientRect();
        const n = nextCard.getBoundingClientRect();
        const w = (n.left - c.left) / zoom;
        if (w > 0) connector.style.width = w + 'px';
    });

    // Same for the horizontal connectors between injects INSIDE side-quests.
    document.querySelectorAll('.branch-connector-h').forEach(connector => {
        const col = connector.closest('.branch-inject-col');
        const nextCol = col && col.nextElementSibling;
        if (!nextCol) return;
        const nextCard = nextCol.matches('.add-branch-inject')
            ? nextCol
            : nextCol.querySelector(':scope > .branch-card-band > .branch-block-card');
        if (!nextCard) return;
        const c = connector.getBoundingClientRect();
        const n = nextCard.getBoundingClientRect();
        const w = (n.left - c.left) / zoom;
        if (w > 0) connector.style.width = w + 'px';
    });
}

// Draw each branch's vertical connector as a short stub bridging the gap from
// the parent inject card (a main inject for a top-level side quest, or a branch
// inject for a nested one) to the edge of that branch's box — no more. Sized
// here in unscaled units (/zoom).
function fitBranchConnectors() {
    const zoom = zoomLevel || 1;
    const storyline = storylinesData[currentStoryline];
    if (!storyline) return;
    const byId = {};
    (storyline.branches || []).forEach(b => { byId[b.id] = b; });

    document.querySelectorAll('.branch-connector-v').forEach(conn => {
        const group = conn.nextElementSibling;         // the branch this belongs to
        const cont = conn.parentElement;               // positioning context
        const branch = byId[conn.dataset.for];
        const parentCard = branch && document.querySelector(`.block-card[data-id="${branch.parent_inject_id}"]`);
        if (!cont || !parentCard || !group || !group.classList.contains('branch-group')) { conn.style.display = 'none'; return; }
        conn.style.display = '';

        const cr = cont.getBoundingClientRect();
        const pc = parentCard.getBoundingClientRect();
        const g = group.getBoundingClientRect();
        const below = pc.top <= g.top; // branches sit below the card?

        // When an inject has several side quests they stack in one slot. Connect
        // each to the ADJACENT box on the card side (or the card for the nearest
        // one) so a connector only ever spans an empty gap — never crossing
        // through another side-quest box.
        let neighbor = null;
        if (below) {
            let el = conn.previousElementSibling;
            while (el && !el.classList.contains('branch-group')) el = el.previousElementSibling;
            neighbor = el;
        } else {
            let el = group.nextElementSibling;
            while (el && !el.classList.contains('branch-group')) el = el.nextElementSibling;
            neighbor = el;
        }
        const src = neighbor ? neighbor.getBoundingClientRect() : pc;

        const topPx = below ? src.bottom : g.bottom;
        const botPx = below ? g.top : src.top;

        conn.style.top = (topPx - cr.top) / zoom + 'px';
        conn.style.height = Math.max(0, (botPx - topPx) / zoom) + 'px';
        // Center the line under the parent card, regardless of any offset.
        conn.style.left = ((pc.left + pc.width / 2 - cr.left) / zoom - 1.5) + 'px';
    });
}

// Recursively measure how wide a branch (including any nested sub-branches)
// needs to be, so the main row can reserve horizontal space above/below.
function branchSubtreeWidth(branch, branches) {
    const injects = branch.injects || [];
    let total = 0;
    injects.forEach(inj => {
        // 220 card + 2px border + 12px flex gap = 234 actual laid-out width.
        let colWidth = 234;
        const children = branches.filter(b => b.parent_inject_id === inj.id);
        if (children.length > 0) {
            // Children stack vertically under the inject; the column is as wide
            // as the widest child subtree (plus indent), or the card.
            let childMax = 0;
            children.forEach(c => {
                childMax = Math.max(childMax, branchSubtreeWidth(c, branches));
            });
            colWidth = Math.max(colWidth, childMax + 40);
        }
        total += colWidth;
    });
    // add button (84) + branch-group padding (20) + a few px slack so the
    // .branch-injects-row never overflows its own box by a hair (which would
    // otherwise show an inner horizontal scrollbar).
    total += 120;
    return Math.max(234, total);
}

function buildStorylineHTML(data, blocks, currentIdx) {
    const branches = data.branches || [];
    const activeBranches = data.active_branches || [];

    // Determine which main inject is "now playing" (only if source is main)
    const mainNowPlaying = currentDisplaySource === 'main' ? currentIdx : -1;

    // First pass: calculate width for each block position. Only TOP-LEVEL
    // branches (parent is a main block) get a slot here; nested sub-branches are
    // rendered inside their parent branch and measured via branchSubtreeWidth.
    const itemWidths = blocks.map((block, i) => {
        const attachedBranches = branches.filter(b => b.parent_inject_id === block.id);
        if (attachedBranches.length > 0) {
            let maxBranchWidth = 0;
            attachedBranches.forEach(branch => {
                maxBranchWidth = Math.max(maxBranchWidth, branchSubtreeWidth(branch, branches));
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
    // Only render a branch row (above/below) that actually holds branches, so an
    // unused row doesn't reserve ~45px of dead vertical space and trip a scrollbar.
    let hasAboveBranches = false;
    let hasBelowBranches = false;

    if (hasBranches) {
        blocks.forEach((block, i) => {
            const attachedBranches = branches.filter(b => b.parent_inject_id === block.id);
            const showAbove = (i % 2 === 1);
            const itemWidth = itemWidths[i];
            if (attachedBranches.length > 0) {
                if (showAbove) hasAboveBranches = true; else hasBelowBranches = true;
            }
            
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
                        <button class="btn btn-sm btn-secondary" onclick="zoomToFit()" title="Zoom to fit (F)">⊡</button>
                        <button class="btn btn-sm btn-secondary" id="branchBorderBtn" onclick="cycleBranchBorder()" title="Side-quest borders: ${localStorage.getItem('branchBorderMode') || 'solid'} — click to change (B)">⬚</button>
                    </span>
                </div>
                <input type="text" class="group-name" value="${escapeHtml(data.name || 'Storyline')}" 
                       onblur="renameCurrentStoryline(this.value)" 
                       onkeypress="if(event.key==='Enter')this.blur()">
                <span class="group-meta">${blocks.length} inject${blocks.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="storyline-layout-wrapper">
                <div class="storyline-layout" id="blocksContainer" style="transform: scale(${zoomLevel}); transform-origin: top left;">
                    ${hasAboveBranches ? `<div class="branches-row branches-above">${aboveRowContent}</div>` : ''}
                    <div class="main-storyline-row">
                        ${mainRow}
                        <div class="add-block-card" onclick="openBlockModal()">
                            <div class="icon">+</div>
                            <div>Add Inject</div>
                        </div>
                    </div>
                    ${hasBelowBranches ? `<div class="branches-row branches-below">${belowRowContent}</div>` : ''}
                </div>
            </div>
        </div>
    `;
}

function buildBranchHTML(branch, isActive, depth = 0) {
    const storyline = storylinesData[currentStoryline];
    const allBranches = storyline?.branches || [];
    const activeBranches = storyline?.active_branches || [];
    const injects = branch.injects || [];
    const currentIdx = branch.current_inject || 0;

    const triggerBadge = branch.auto_trigger
        ? '<span class="branch-badge auto">Auto</span>'
        : '<span class="branch-badge manual">Manual</span>';

    const playingBadge = isActive
        ? '<span class="branch-badge playing">Playing</span>'
        : '';

    // Find merge target name if set (target may be a main block OR a branch inject)
    let mergeInfo = '';
    if (branch.merge_to_inject_id) {
        const ref = injectRefLabel(storyline, branch.merge_to_inject_id);
        if (ref) {
            mergeInfo = `<span class="branch-badge merge">→ ${ref}</span>`;
        }
    }

    // Check if this branch is the one currently being displayed
    const isBranchNowPlaying = currentDisplaySource === 'branch' && currentDisplayBranchId === branch.id;

    const injectCols = injects.map((inj, i) => {
        const durationBadge = inj.duration > 0
            ? `<span class="block-duration">${inj.duration}s</span>`
            : '';

        const isInjectNowPlaying = isBranchNowPlaying && i === currentDisplayBranchInjectIdx;
        const nowBadge = isInjectNowPlaying
            ? '<span class="now-playing-badge">▶ NOW</span>'
            : '';

        // Sub-branches hanging off this branch inject. Alternate the side they
        // render on (above/below the inject) by index parity, mirroring how the
        // main storyline alternates its side quests.
        const childBranches = allBranches.filter(b => b.parent_inject_id === inj.id);
        const hasAutoChild = childBranches.some(b => b.auto_trigger);
        const branchBtn = hasAutoChild
            ? `<button class="btn btn-sm btn-secondary" disabled title="Auto-trigger sub-branch must be the only branch">⑂</button>`
            : `<button class="btn btn-sm btn-activate" onclick="openBranchModal('${inj.id}')" title="Add sub-branch">⑂</button>`;

        const showAbove = (i % 2 === 1);
        const groupsHtml = childBranches.map(cb =>
            buildBranchHTML(cb, activeBranches.includes(cb.id), depth + 1)
        ).join('');
        // Always render the children container so it can act as a drop target
        // for reparenting a branch under this inject (even when currently empty).
        // The vertical connector itself lives inside each sub-quest branch-group
        // (see below) and is sized by fitBranchConnectors().
        const childrenHtml = `<div class="branch-children ${showAbove ? 'branch-children-above' : 'branch-children-below'} ${childBranches.length ? 'has-children' : ''}" data-parent-id="${inj.id}">${groupsHtml}</div>`;

        const cardHtml = `
                <div class="block-card branch-block-card ${isActive && i === currentIdx ? 'active' : ''} ${isInjectNowPlaying ? 'now-playing' : ''}" data-id="${inj.id}" data-index="${i}">
                    <div class="block-header">
                        <span class="block-number branch-number" onclick="goToBranchInject('${branch.id}', ${i})" title="Jump to inject">#${i + 1}</span>
                        ${durationBadge}
                        ${nowBadge}
                        <div class="block-actions">
                            ${branchBtn}
                            <button class="btn btn-sm btn-secondary" onclick="editBranchInject('${branch.id}', '${inj.id}')">✎</button>
                            <button class="btn btn-sm btn-danger" onclick="deleteBranchInject('${branch.id}', '${inj.id}')">✕</button>
                        </div>
                    </div>
                    <div class="block-body">
                        <div class="block-title">${escapeHtml(inj.heading)}</div>
                        ${inj.image ? `<img src="${inj.image}" class="block-image">` : ''}
                        ${inj.text ? `<div class="block-text">${escapeHtml(inj.text)}</div>` : ''}
                    </div>
                </div>`;

        // The card sits in a band with a horizontal connector running off its
        // right edge when it has a sub-quest — matching the main storyline's
        // card→side-quest connector (horizontal line + vertical stub).
        const cardBand = `<div class="branch-card-band">${cardHtml}${childBranches.length ? '<div class="branch-connector-h"></div>' : ''}</div>`;

        // Three stacked cells (above-band / card-band / below-band) so every
        // inject card lines up on one row while its sub-branch sits above or
        // below by parity — the same banded look as the main storyline.
        return `
            <div class="branch-inject-col">
                <div class="branch-cell branch-cell-above">${showAbove ? childrenHtml : ''}</div>
                ${cardBand}
                <div class="branch-cell branch-cell-below">${showAbove ? '' : childrenHtml}</div>
            </div>
        `;
    }).join('');

    // The connector is a SIBLING before the group (not a child) so it paints
    // behind the group's border, background and text instead of over them.
    return `
        <div class="branch-connector-v" data-for="${branch.id}"></div>
        <div class="branch-group ${isActive ? 'active' : ''} ${depth > 0 ? 'branch-group-nested' : ''}" data-branch-id="${branch.id}" data-depth="${depth}">
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
                ${injectCols}
                <div class="add-branch-inject" onclick="openBranchInjectModal('${branch.id}')">
                    <div>+</div>
                    <div>Add</div>
                </div>
            </div>
        </div>
    `;
}

// Human-readable reference for any inject anywhere in a storyline.
// Main block -> "#3". Branch inject -> "#3-2". Nested -> "#3-2-1".
function injectRefLabel(storyline, injectId) {
    if (!storyline || !injectId) return '';
    const blocks = storyline.blocks || [];
    const mainIdx = blocks.findIndex(b => b.id === injectId);
    if (mainIdx >= 0) return `#${mainIdx + 1}`;

    const branches = storyline.branches || [];
    for (const branch of branches) {
        const idx = (branch.injects || []).findIndex(inj => inj.id === injectId);
        if (idx >= 0) {
            const parentRef = injectRefLabel(storyline, branch.parent_inject_id);
            return parentRef ? `${parentRef}-${idx + 1}` : `#?-${idx + 1}`;
        }
    }
    return '';
}

// Flat list of every inject in a storyline, each with a path ref + heading.
// Used to populate the "merge target" picker (merge can target any inject).
function enumerateAllInjects(storyline) {
    const out = [];
    (storyline.blocks || []).forEach((b, i) => {
        out.push({ id: b.id, label: `#${i + 1}: ${b.heading || '(untitled)'}` });
    });
    (storyline.branches || []).forEach(branch => {
        (branch.injects || []).forEach(inj => {
            const ref = injectRefLabel(storyline, inj.id);
            out.push({ id: inj.id, label: `${ref} (${branch.name}): ${inj.heading || '(untitled)'}` });
        });
    });
    return out;
}

// True if injectId lives inside branchId or any of its descendant branches.
// Used to reject dropping a branch into its own subtree (which would loop).
function injectInBranchSubtree(storyline, branchId, injectId) {
    const branch = (storyline.branches || []).find(b => b.id === branchId);
    if (!branch) return false;
    const injects = branch.injects || [];
    if (injects.some(i => i.id === injectId)) return true;
    const injectIds = new Set(injects.map(i => i.id));
    const childBranches = (storyline.branches || []).filter(cb => injectIds.has(cb.parent_inject_id));
    return childBranches.some(cb => injectInBranchSubtree(storyline, cb.id, injectId));
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
                ${block.image ? `<img src="${block.image}" class="block-image">` : ''}
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
            draggable: '.branch-inject-col',
            group: { name: `branch-${branchId}`, pull: false, put: false }, // Prevent cross-branch dragging
            onEnd: (evt) => {
                // Only process if item stayed in same container
                if (evt.from !== evt.to) return;

                // Only DIRECT injects of this branch (exclude nested sub-branch cards)
                const ids = [...branchRow.querySelectorAll(':scope > .branch-inject-col > .branch-card-band > .branch-block-card')].map(e => e.dataset.id).filter(Boolean);
                fetch(`/api/branches/${currentStoryline}/${branchId}/reorder`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({order: ids})
                }).then(() => renderStoryline(currentStoryline));
            }
        });
    });
    
    // Branch groups can be dragged to a different parent inject — both onto a
    // main inject (top-level .branch-slot) and onto a branch inject to nest it
    // (.branch-children). All share one Sortable group so a branch can move
    // freely between any level.
    const dropZones = [
        ...document.querySelectorAll('.branch-slot'),
        ...document.querySelectorAll('.branch-children'),
    ];
    dropZones.forEach(zone => {
        if (zone.sortable) {
            zone.sortable.destroy();
        }

        zone.sortable = new Sortable(zone, {
            animation: 150,
            // Larger empty-insert distance so it's easy to drop into a zone
            // (and thus target the intended card) without pixel-perfect aim.
            emptyInsertThreshold: 28,
            group: {
                name: 'branch-slots',
                pull: true,
                put: (to, from, dragEl) => {
                    const draggedBranchId = dragEl.dataset.branchId;
                    const targetParentId = to.el.dataset.parentId;
                    if (!draggedBranchId || !targetParentId) return false;
                    // Don't drop a branch into its own subtree (would orphan/loop).
                    const storyline = storylinesData[currentStoryline];
                    if (storyline && injectInBranchSubtree(storyline, draggedBranchId, targetParentId)) {
                        return false;
                    }
                    return true;
                }
            },
            ghostClass: 'dragging',
            draggable: '.branch-group',
            // Only the branch-group directly in THIS zone is draggable from here,
            // not sub-branches nested deeper inside it.
            onStart: () => document.body.classList.add('branch-dragging'),
            onEnd: () => document.body.classList.remove('branch-dragging'),
            onAdd: (evt) => {
                const branchId = evt.item.dataset.branchId;
                const newParentId = evt.to.dataset.parentId;
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
    setZoom(Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP), true);
}

function zoomOut() {
    setZoom(Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP), true);
}

function zoomReset() {
    setZoom(1.0, true);
}

function zoomToFit() {
    const wrapper = document.querySelector('.storyline-layout-wrapper');
    const container = document.getElementById('blocksContainer');

    if (!wrapper || !container) return;

    // Capture the CURRENT view before we rescale to measure — measuring at
    // scale(1) can clamp the scroll, so grab these first to keep the point the
    // GM is looking at centered after the fit.
    const oldZoom = zoomLevel;
    const preLeft = wrapper.scrollLeft;
    const preTop = wrapper.scrollTop;
    const preClientW = wrapper.clientWidth;
    const preClientH = wrapper.clientHeight;

    // Temporarily reset zoom to measure actual content size
    container.style.transform = 'scale(1)';

    // Get the actual content dimensions at 100% zoom
    const contentHeight = container.scrollHeight;
    const contentWidth = container.scrollWidth;

    // Get the available space in the wrapper
    const availableHeight = wrapper.clientHeight - 20; // Account for padding
    const availableWidth = wrapper.clientWidth - 20;

    // Zoom needed to fit the content height into the given space.
    const fitFor = (availH) => contentHeight > availH ? availH / contentHeight : 1.0;
    let newZoom = fitFor(availableHeight);
    // If the content is still wider than the viewport at that zoom, a horizontal
    // scrollbar will appear and eat some height — reserve room for it.
    if (contentWidth * newZoom > availableWidth) {
        newZoom = fitFor(availableHeight - 16);
    }

    // Clamp, then FLOOR (never round up, or the last row is pushed out of view).
    newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
    newZoom = Math.floor(newZoom * 100) / 100;

    setZoom(newZoom);

    // Keep the pre-fit viewport center fixed (center on the current view, not
    // the middle of the whole storyline). Vertically the content now fills the
    // height, so this mainly recenters horizontally.
    if (oldZoom > 0) {
        const ratio = newZoom / oldZoom;
        wrapper.scrollLeft = (preLeft + preClientW / 2) * ratio - wrapper.clientWidth / 2;
        wrapper.scrollTop = (preTop + preClientH / 2) * ratio - wrapper.clientHeight / 2;
    }
}

function setZoom(level, focusCenter = false) {
    // Capture the pre-zoom viewport so we can keep a chosen point fixed.
    const wrapper = document.querySelector('.storyline-layout-wrapper');
    const oldZoom = zoomLevel;
    const preLeft = wrapper ? wrapper.scrollLeft : 0;
    const preTop = wrapper ? wrapper.scrollTop : 0;
    const preClientW = wrapper ? wrapper.clientWidth : 0;
    const preClientH = wrapper ? wrapper.clientHeight : 0;

    // Round to 2 decimals so zoom-to-fit's precise value survives (manual zoom
    // still steps in clean 0.1 increments).
    zoomLevel = Math.round(level * 100) / 100;
    localStorage.setItem('gmZoomLevel', zoomLevel);

    const container = document.getElementById('blocksContainer');
    if (container) {
        container.style.transform = `scale(${zoomLevel})`;
    }

    const zoomDisplay = document.getElementById('zoomLevel');
    if (zoomDisplay) {
        zoomDisplay.textContent = `${Math.round(zoomLevel * 100)}%`;
    }

    // Update scrollbar visibility after zoom change
    updateScrollbarVisibility();

    // Keep the center of the viewport fixed while zooming (transform-origin is
    // top-left, so scrolling has to compensate). scrollLeft directly shifts the
    // scaled content, so scaling the center point by the zoom ratio works.
    if (focusCenter && wrapper && oldZoom > 0) {
        const ratio = zoomLevel / oldZoom;
        wrapper.scrollLeft = (preLeft + preClientW / 2) * ratio - wrapper.clientWidth / 2;
        wrapper.scrollTop = (preTop + preClientH / 2) * ratio - wrapper.clientHeight / 2;
    }
}

function updateScrollbarVisibility() {
    const wrapper = document.querySelector('.storyline-layout-wrapper');
    const container = document.getElementById('blocksContainer');

    if (!wrapper || !container) return;

    // Measure the available space with scrollbars hidden. A scrollbar that is
    // already showing eats ~15px of the wrapper's client size, and measuring
    // against that shrunken size keeps re-triggering the scrollbar even when the
    // content would actually fit — the "phantom scrollbar" the GM sees when a
    // side quest is added. Hiding both axes first breaks that feedback loop.
    wrapper.style.overflowX = 'hidden';
    wrapper.style.overflowY = 'hidden';

    // Scaled content dimensions.
    const scaledHeight = container.scrollHeight * zoomLevel;
    const scaledWidth = container.scrollWidth * zoomLevel;

    // Full available space (no scrollbar consuming it right now).
    const availableHeight = wrapper.clientHeight;
    const availableWidth = wrapper.clientWidth;

    // Ignore sub-pixel / rounding overflow so a stray couple of pixels doesn't
    // put up a scrollbar for nothing.
    const TOLERANCE = 2;
    const needsVerticalScroll = scaledHeight > availableHeight + TOLERANCE;
    const needsHorizontalScroll = scaledWidth > availableWidth + TOLERANCE;

    wrapper.style.overflowY = needsVerticalScroll ? 'auto' : 'hidden';
    wrapper.style.overflowX = needsHorizontalScroll ? 'auto' : 'hidden';

    // If an axis is no longer scrollable, snap it back to the start. transform:
    // scale() doesn't shrink the layout box, so a stale scrollTop/Left would
    // otherwise keep the content pushed out of view with no scrollbar to recover
    // it — e.g. zoom-to-fit while scrolled down would hide the top of the story.
    if (!needsVerticalScroll) wrapper.scrollTop = 0;
    if (!needsHorizontalScroll) wrapper.scrollLeft = 0;
}

function highlightCurrentlyDisplayed(mainIdx, source, branchId, branchInjectIdx) {
    // Move the "now playing" red border + ▶ NOW badge and the current-position
    // markers purely via DOM class toggles — no fetch, no innerHTML rebuild.
    // Structure (cards, branches) is assumed already rendered.

    // Clear previous dynamic markers everywhere.
    document.querySelectorAll('.block-card.now-playing').forEach(c => c.classList.remove('now-playing'));
    document.querySelectorAll('.now-playing-badge').forEach(b => b.remove());
    document.querySelectorAll('.block-card.active').forEach(c => c.classList.remove('active'));

    // Main pointer: the main block at mainIdx is always the current main inject.
    const mainRow = document.querySelector('.main-storyline-row');
    const mainCard = mainRow
        ? mainRow.querySelector(`.block-card[data-index="${mainIdx}"]`)
        : null;
    if (mainCard) mainCard.classList.add('active');

    // Re-apply each active branch's current-inject marker.
    const storyline = storylinesData[currentStoryline] || {};
    const activeBranchIds = storyline.active_branches || [];
    (storyline.branches || []).forEach(branch => {
        if (!activeBranchIds.includes(branch.id)) return;
        const group = document.querySelector(`.branch-group[data-branch-id="${branch.id}"]`);
        if (!group) return;
        // Fresh index for the branch currently playing; cached value otherwise.
        const idx = (source === 'branch' && branch.id === branchId)
            ? branchInjectIdx
            : (branch.current_inject || 0);
        // Scope to THIS branch's own injects, not cards in nested sub-branches.
        const card = group.querySelector(`:scope > .branch-injects-row > .branch-inject-col > .branch-card-band > .block-card[data-index="${idx}"]`);
        if (card) card.classList.add('active');
    });

    // Determine the single "now playing" target card.
    let target = mainCard;
    if (source === 'branch' && branchId != null) {
        const group = document.querySelector(`.branch-group[data-branch-id="${branchId}"]`);
        target = group
            ? group.querySelector(`:scope > .branch-injects-row > .branch-inject-col > .branch-card-band > .block-card[data-index="${branchInjectIdx}"]`)
            : null;
    }

    if (target) {
        target.classList.add('now-playing');
        const header = target.querySelector('.block-header');
        if (header) {
            const badge = document.createElement('span');
            badge.className = 'now-playing-badge';
            badge.textContent = '▶ NOW';
            const actions = header.querySelector('.block-actions');
            if (actions) header.insertBefore(badge, actions);
            else header.appendChild(badge);
        }
    }
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
    
    // Always show the panel
    panel.style.display = 'flex';
    
    if (block && block.gm_notes && block.gm_notes.trim()) {
        content.innerHTML = `
            <div class="gm-notes-inject-title">${escapeHtml(block.heading)}</div>
            <div class="gm-notes-text">${escapeHtml(block.gm_notes)}</div>
        `;
    } else {
        content.innerHTML = '';
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
        preview.src = data.image;
        preview.style.display = 'block';
    } else {
        preview.style.display = 'none';
    }
    
    // Populate player types checkboxes
    populatePlayerTypesCheckboxes('blockPlayerTypes', data?.target_player_types || []);
    
    document.getElementById('blockModal').classList.add('active');
    startEditingLock('inject', data?.id);

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
    stopEditingLock();
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

// Downscale large raster images in-browser before upload (cuts transit + storage).
// GIF/SVG are left untouched. Falls back to the original file on any failure.
async function scaleImageForUpload(file, maxDim = 1600, quality = 0.82, thresholdBytes = 500 * 1024) {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;
    if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
    try {
        const bitmap = await createImageBitmap(file);
        const longest = Math.max(bitmap.width, bitmap.height);
        const scale = Math.min(1, maxDim / longest);
        // Already small in both dimensions and bytes -> leave as-is.
        if (scale === 1 && file.size <= thresholdBytes) {
            if (bitmap.close) bitmap.close();
            return file;
        }
        const w = Math.round(bitmap.width * scale);
        const h = Math.round(bitmap.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        if (bitmap.close) bitmap.close();
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
        if (!blob || blob.size >= file.size) return file; // no gain -> keep original
        const name = (file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
        return new File([blob], name, { type: 'image/jpeg' });
    } catch (err) {
        console.warn('Image scale failed, uploading original:', err);
        return file;
    }
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
    
    let img = document.getElementById('blockImage').files[0];
    if (img) img = await scaleImageForUpload(img);
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
    // D2: avoid refetching the entire app_data; renderStoryline refreshes this
    // storyline (and storylinesData[currentStoryline]) on its own.
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
    startEditingLock('storyline', isEdit ? id : null);
}

function closeStorylineModal() {
    document.getElementById('storylineModal').classList.remove('active');
    editingStorylineId = null;
    stopEditingLock();
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
    startStopwatch();
    socket.emit('next_block'); 
}
function previousBlock() { 
    shouldScrollToNowPlaying = true;
    startStopwatch();
    socket.emit('previous_block'); 
}
function goToBlock(idx) { 
    shouldScrollToNowPlaying = true;
    startStopwatch();
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
    
    // Reset the stopwatch
    resetStopwatch();
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
    
    // Populate merge target dropdown. A branch may merge to ANY inject in the
    // storyline (main or another branch), except its own injects (self-loop).
    const mergeSelect = document.getElementById('branchMergeTarget');
    mergeSelect.innerHTML = '<option value="">-- Continue after branch (no skip) --</option>';

    if (storyline) {
        const ownInjectIds = new Set((branchData?.injects || []).map(inj => inj.id));
        enumerateAllInjects(storyline).forEach(({ id, label }) => {
            if (ownInjectIds.has(id)) return; // can't merge into itself
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = label;
            if (branchData?.merge_to_inject_id === id) {
                opt.selected = true;
            }
            mergeSelect.appendChild(opt);
        });
    }
    
    document.getElementById('branchModal').classList.add('active');
    startEditingLock('branch', branchData?.id);

    // Focus branch name field after modal is visible
    setTimeout(() => {
        document.getElementById('branchName').focus();
    }, 50);
}

function closeBranchModal() {
    document.getElementById('branchModal').classList.remove('active');
    document.getElementById('branchForm').reset();
    document.getElementById('saveBranchToLibraryBtn').style.display = 'none';
    stopEditingLock();
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
        preview.src = injectData.image;
        preview.style.display = 'block';
    } else {
        preview.style.display = 'none';
    }
    
    // Populate player types checkboxes
    populatePlayerTypesCheckboxes('branchInjectPlayerTypes', injectData?.target_player_types || []);
    
    document.getElementById('branchInjectModal').classList.add('active');
    startEditingLock('branch_inject', injectData?.id);

    // Focus heading field after modal is visible
    setTimeout(() => {
        document.getElementById('branchInjectHeading').focus();
    }, 50);
}

function closeBranchInjectModal() {
    document.getElementById('branchInjectModal').classList.remove('active');
    document.getElementById('branchInjectForm').reset();
    document.getElementById('branchInjectSaveToLibrary').checked = false;
    stopEditingLock();
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
    
    let img = document.getElementById('branchInjectImage').files[0];
    if (img) img = await scaleImageForUpload(img);
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

    if (e.key === 'b' || e.key === 'B') {
        cycleBranchBorder();
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
    if (e.key === 'f' || e.key === 'F') {
        zoomToFit();
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

// ============ Theme Switcher ============
// Clicking (or pressing T) cycles through the themes in order.
const THEMES = [
    { id: 'dark',   cls: '',             icon: '🌙', label: 'Dark' },
    { id: 'light',  cls: 'light-mode',   icon: '☀️', label: 'Light' },
    { id: 'orange', cls: 'theme-orange', icon: '🟠', label: 'Orange' },
    { id: 'dnd',    cls: 'theme-dnd',    icon: '⚔️', label: 'D&D' },
];

function applyTheme(id) {
    const theme = THEMES.find(t => t.id === id) || THEMES[0];
    document.body.classList.remove('light-mode', 'theme-orange', 'theme-dnd');
    if (theme.cls) document.body.classList.add(theme.cls);
    const themeBtn = document.getElementById('themeBtn');
    if (themeBtn) {
        themeBtn.textContent = theme.icon;
        themeBtn.title = `Theme: ${theme.label} — click to change`;
    }
    localStorage.setItem('gmTheme', theme.id);
}

function toggleTheme() {
    const current = localStorage.getItem('gmTheme') || 'dark';
    const idx = THEMES.findIndex(t => t.id === current);
    applyTheme(THEMES[(idx + 1) % THEMES.length].id);
}

// Load saved theme on startup (old 'dark'/'light' values still valid)
(function initTheme() {
    applyTheme(localStorage.getItem('gmTheme') || 'dark');
})();

// ============ Side-quest border style ============
// Cycle the side-quest (branch) box borders: solid -> dashed -> none.
const BRANCH_BORDER_MODES = ['solid', 'dashed', 'none'];

function applyBranchBorderMode(mode) {
    if (!BRANCH_BORDER_MODES.includes(mode)) mode = 'solid';
    document.body.classList.remove('branch-border-dashed', 'branch-border-none');
    if (mode === 'dashed') document.body.classList.add('branch-border-dashed');
    else if (mode === 'none') document.body.classList.add('branch-border-none');
    localStorage.setItem('branchBorderMode', mode);
    const btn = document.getElementById('branchBorderBtn');
    if (btn) btn.title = `Side-quest borders: ${mode} — click to change (B)`;
}

function cycleBranchBorder() {
    const current = localStorage.getItem('branchBorderMode') || 'solid';
    const idx = BRANCH_BORDER_MODES.indexOf(current);
    applyBranchBorderMode(BRANCH_BORDER_MODES[(idx + 1) % BRANCH_BORDER_MODES.length]);
}

(function initBranchBorder() {
    applyBranchBorderMode(localStorage.getItem('branchBorderMode') || 'solid');
})();

// ============ Help Modal ============
function openHelpModal() {
    document.getElementById('helpModal').classList.add('active');
}

function closeHelpModal() {
    document.getElementById('helpModal').classList.remove('active');
    flushPendingRefresh();
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
    flushPendingRefresh();
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
    flushPendingRefresh();
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

// Resize the library cards (scales size, text and images) via the header slider.
function setLibraryCardZoom(value) {
    const z = parseFloat(value) || 1;
    document.documentElement.style.setProperty('--lib-card-zoom', z);
    localStorage.setItem('libraryCardZoom', z);
}

(function initLibraryCardZoom() {
    const saved = parseFloat(localStorage.getItem('libraryCardZoom')) || 1;
    document.documentElement.style.setProperty('--lib-card-zoom', saved);
    const slider = document.getElementById('libraryZoom');
    if (slider) slider.value = saved;
})();

// Drag the top edge of the library to resize its height.
(function initLibraryResize() {
    const handle = document.getElementById('libraryResizeHandle');
    const content = document.getElementById('libraryContent');
    if (!handle || !content) return;

    const saved = parseInt(localStorage.getItem('libraryContentHeight'), 10);
    if (saved) document.documentElement.style.setProperty('--library-content-height', saved + 'px');

    let startY = 0, startH = 0;
    const onMove = (e) => {
        const dy = startY - e.clientY; // drag up => taller (library sits at bottom)
        const h = Math.max(120, Math.min(window.innerHeight * 0.85, startH + dy));
        document.documentElement.style.setProperty('--library-content-height', h + 'px');
    };
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        localStorage.setItem('libraryContentHeight', Math.round(content.getBoundingClientRect().height));
    };
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startY = e.clientY;
        startH = content.getBoundingClientRect().height;
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
})();

// Drag the divider to change the injects/sidequests column split.
(function initLibraryDivider() {
    const divider = document.getElementById('libraryDivider');
    const content = document.getElementById('libraryContent');
    if (!divider || !content) return;

    const saved = parseFloat(localStorage.getItem('librarySplit'));
    if (saved) document.documentElement.style.setProperty('--library-split', saved + '%');

    const onMove = (e) => {
        const rect = content.getBoundingClientRect();
        let pct = ((e.clientX - rect.left) / rect.width) * 100;
        pct = Math.max(20, Math.min(80, pct));
        document.documentElement.style.setProperty('--library-split', pct + '%');
    };
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        const pct = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--library-split'));
        if (pct) localStorage.setItem('librarySplit', pct);
    };
    divider.addEventListener('mousedown', (e) => {
        e.preventDefault();
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
})();

// Export the whole inject library to a JSON file (import-compatible format).
function exportLibrary() {
    if (!libraryInjects || libraryInjects.length === 0) {
        showAlert('The library is empty — nothing to export.', 'Empty Library');
        return;
    }
    const blob = new Blob([JSON.stringify({ inject_library: libraryInjects }, null, 2)],
        { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'inject_library.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Import a library JSON file, merging in new items and skipping duplicates.
function importLibrary() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            let data;
            try {
                data = JSON.parse(reader.result);
            } catch (e) {
                showAlert('That file is not valid JSON.', 'Import Failed');
                return;
            }
            fetch('/api/library/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            })
                .then(r => r.json())
                .then(res => {
                    if (res.error) {
                        showAlert(res.error, 'Import Failed');
                        return;
                    }
                    loadLibrary();
                    showAlert(`Imported ${res.added} item${res.added === 1 ? '' : 's'}. ` +
                        `Skipped ${res.skipped} duplicate${res.skipped === 1 ? '' : 's'}.`,
                        'Library Imported');
                })
                .catch(() => showAlert('Import failed.', 'Error'));
        };
        reader.readAsText(file);
    };
    input.click();
}

function renderLibrary() {
    const injectsWrap = document.getElementById('libraryInjectsCards');
    const branchesWrap = document.getElementById('librarySidequestsCards');
    const countEl = document.getElementById('libraryCount');
    const injCountEl = document.getElementById('libraryInjectsCount');
    const sqCountEl = document.getElementById('librarySidequestsCount');
    if (!injectsWrap || !branchesWrap) return;

    const injects = libraryInjects.filter(item => item.type !== 'branch');
    const branches = libraryInjects.filter(item => item.type === 'branch');

    if (countEl) countEl.textContent = `(${libraryInjects.length})`;
    if (injCountEl) injCountEl.textContent = `(${injects.length})`;
    if (sqCountEl) sqCountEl.textContent = `(${branches.length})`;

    injectsWrap.innerHTML = injects.length
        ? injects.map(buildLibraryInjectCard).join('')
        : '<div class="library-empty">No injects yet. Save an inject here to reuse it.</div>';

    branchesWrap.innerHTML = branches.length
        ? branches.map(buildLibraryBranchCard).join('')
        : '<div class="library-empty">No sidequests yet. Save a branch here to reuse it.</div>';
}

// A reusable single inject. Keeps the .library-card class so the timeline-style
// hover preview applies (see initInjectPreviewHover).
function buildLibraryInjectCard(item) {
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
                ${item.image ? `<img src="${item.image}" class="block-image">` : ''}
                ${item.text ? `<div class="block-text">${escapeHtml(item.text)}</div>` : ''}
            </div>
        </div>
    `;
}

// A reusable sidequest (branch). No hover preview — handled by the type check
// in initInjectPreviewHover.
function buildLibraryBranchCard(item) {
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
                ${firstInject?.image ? `<img src="${firstInject.image}" class="block-image">` : ''}
                <div class="block-text">${item.auto_trigger ? '🔄 Auto-trigger' : '👆 Manual trigger'}</div>
            </div>
        </div>
    `;
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
                document.getElementById('libraryImagePreview').src = inject.image;
                document.getElementById('libraryImagePreview').style.display = 'block';
            }
        }
    } else {
        title.textContent = 'Add to Library';
    }
    
    modal.classList.add('active');
    startEditingLock('library', injectId);
    document.getElementById('libraryInjectHeading').focus();
}

function closeLibraryInjectModal() {
    document.getElementById('libraryInjectModal').classList.remove('active');
    stopEditingLock();
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
    
    let img = document.getElementById('libraryInjectImage').files[0];
    if (img) img = await scaleImageForUpload(img);
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
                ${inj.image ? `<img src="${inj.image}" class="branch-details-inject-image">` : ''}
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
    flushPendingRefresh();
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
    clearLibraryReorderIndicator();

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
    clearLibraryReorderIndicator();

    // Remove any drop indicators
    document.querySelectorAll('.branch-drop-target').forEach(el => el.classList.remove('branch-drop-target'));
}

// ============ Library Reordering (within a column) ============
// Reordering is native HTML5 DnD scoped to the library columns, so it coexists
// with the existing "drag a library item onto the timeline" behaviour: dropping
// inside a column reorders; dropping on the timeline still adds to the story.
function clearLibraryReorderIndicator() {
    document.querySelectorAll('.library-card.lib-reorder-target')
        .forEach(c => c.classList.remove('lib-reorder-target'));
}

function libraryColumnForDrag(target) {
    const column = target.closest('.library-column');
    if (!column) return null;
    // Injects can only reorder among injects; sidequests among sidequests.
    if (draggedLibraryInjectId && column.id === 'libraryInjectsColumn') return column;
    if (draggedLibraryBranchId && column.id === 'librarySidequestsColumn') return column;
    return null;
}

function initLibraryReorder() {
    const container = document.getElementById('libraryContent');
    if (!container) return;

    container.addEventListener('dragover', (e) => {
        if (!draggedLibraryInjectId && !draggedLibraryBranchId) return;
        if (!libraryColumnForDrag(e.target)) return;
        e.preventDefault();
        // Must match effectAllowed='copy' set in the dragstart handlers, or the
        // browser will reset the operation to 'none' and the drop won't fire.
        e.dataTransfer.dropEffect = 'copy';
        clearLibraryReorderIndicator();
        const targetCard = e.target.closest('.library-card');
        if (targetCard && !targetCard.classList.contains('dragging')) {
            targetCard.classList.add('lib-reorder-target');
        }
    });

    container.addEventListener('dragleave', (e) => {
        const targetCard = e.target.closest('.library-card');
        if (targetCard) targetCard.classList.remove('lib-reorder-target');
    });

    container.addEventListener('drop', (e) => {
        if (!draggedLibraryInjectId && !draggedLibraryBranchId) return;
        if (!libraryColumnForDrag(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        const draggedId = draggedLibraryInjectId || draggedLibraryBranchId;
        const targetCard = e.target.closest('.library-card');
        const targetId = targetCard ? targetCard.dataset.libraryId : null;
        clearLibraryReorderIndicator();
        reorderLibraryItem(draggedId, targetId);
    });
}

function reorderLibraryItem(draggedId, targetId) {
    if (!draggedId || draggedId === targetId) return;
    const dragged = libraryInjects.find(it => it.id === draggedId);
    if (!dragged) return;

    const injectIds = libraryInjects.filter(it => it.type !== 'branch').map(it => it.id);
    const branchIds = libraryInjects.filter(it => it.type === 'branch').map(it => it.id);
    const list = dragged.type === 'branch' ? branchIds : injectIds;

    const from = list.indexOf(draggedId);
    if (from === -1) return;
    list.splice(from, 1);

    if (targetId && targetId !== draggedId) {
        const to = list.indexOf(targetId);
        list.splice(to === -1 ? list.length : to, 0, draggedId);
    } else {
        list.push(draggedId); // dropped on empty space -> end of column
    }

    const order = [...injectIds, ...branchIds];
    fetch('/api/library/reorder', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ order })
    }).then(() => loadLibrary());
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

// ============ Export Storyline ============
function exportStoryline() {
    if (!activeStoryline) {
        showAlert('Please activate a storyline first before exporting.', 'No Active Storyline');
        return;
    }
    
    const storylineData = storylinesData[activeStoryline];
    if (!storylineData) {
        showAlert('Could not find storyline data.', 'Error');
        return;
    }
    
    // Create export format matching import format
    const exportData = {
        storylines: {
            [activeStoryline]: {
                name: storylineData.name,
                blocks: storylineData.blocks || [],
                branches: storylineData.branches || []
            }
        },
        player_types: playerTypes || []
    };
    
    // Create and download the file
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    // Clean filename from storyline name
    const safeName = storylineData.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    a.download = `storyline_${safeName}.json`;
    
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

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
    flushPendingRefresh();
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

// ============ Session Notes ============
let sessionNotes = [];

function handleSessionNoteKeydown(event) {
    // Submit on Enter (without Alt)
    if (event.key === 'Enter' && !event.altKey) {
        event.preventDefault();
        addSessionNote();
    }
    // Alt+Enter allows normal line break (default behavior)
}

function loadSessionNotes() {
    fetch('/api/session-notes')
        .then(r => r.json())
        .then(data => {
            sessionNotes = data.notes || [];
            renderSessionNotes();
        })
        .catch(err => console.error('Failed to load session notes:', err));
}

function renderSessionNotes() {
    const list = document.getElementById('sessionNotesList');
    if (!list) return;
    
    if (sessionNotes.length === 0) {
        list.innerHTML = '<div class="session-notes-empty" style="color: #6e7681; font-size: 12px; text-align: center; padding: 10px;">No notes yet</div>';
        return;
    }
    
    list.innerHTML = sessionNotes.map((note, index) => `
        <div class="session-note-item">
            <div class="session-note-meta">
                <span class="session-note-timestamp">${escapeHtml(note.timestamp)}</span>
                <button class="session-note-delete" onclick="deleteSessionNote(${index})" title="Delete note">✕</button>
            </div>
            ${note.inject ? `<div class="session-note-inject">@ ${escapeHtml(note.inject)}</div>` : ''}
            <div class="session-note-text">${escapeHtml(note.text)}</div>
        </div>
    `).join('');
}

function addSessionNote() {
    const textarea = document.getElementById('sessionNoteText');
    const text = textarea.value.trim();
    
    if (!text) {
        showAlert('Please enter a note', 'Empty Note');
        return;
    }
    
    // Get current inject info with numbering
    let injectName = '';
    if (activeStoryline && storylinesData[activeStoryline]) {
        const data = storylinesData[activeStoryline];
        const currentIdx = data.current_block || 0;
        const mainInjectNum = currentIdx + 1;
        
        // Check if we're showing a branch inject (possibly nested)
        if (currentDisplaySource !== 'main' && currentDisplayBranchId) {
            // Find the branch
            const branch = (data.branches || []).find(b => b.id === currentDisplayBranchId);
            if (branch) {
                const branchInject = branch.injects && branch.injects[currentDisplayBranchInjectIdx];
                const ref = branchInject ? injectRefLabel(data, branchInject.id) : '';
                const branchInjectHeading = branchInject ? branchInject.heading : '';
                injectName = `${ref} ${branchInjectHeading}`.trim();
            }
        } else {
            // Main storyline inject
            const heading = data.blocks && data.blocks[currentIdx] ? data.blocks[currentIdx].heading : '';
            injectName = `#${mainInjectNum} ${heading}`.trim();
        }
    }
    
    fetch('/api/session-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text: text,
            inject: injectName
        })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            sessionNotes = data.notes || [];
            renderSessionNotes();
            textarea.value = '';
        }
    })
    .catch(err => console.error('Failed to add session note:', err));
}

function deleteSessionNote(index) {
    fetch(`/api/session-notes/${index}`, {
        method: 'DELETE'
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            sessionNotes = data.notes || [];
            renderSessionNotes();
        }
    })
    .catch(err => console.error('Failed to delete session note:', err));
}

function exportSessionNotes() {
    if (sessionNotes.length === 0) {
        showAlert('No notes to export', 'Export Notes');
        return;
    }
    
    // Create a readable text format
    let content = 'SESSION NOTES\n';
    content += '='.repeat(50) + '\n\n';
    
    // Add storyline name if available
    if (activeStoryline && storylinesData[activeStoryline]) {
        content += `Storyline: ${storylinesData[activeStoryline].name}\n`;
        content += `Exported: ${new Date().toLocaleString()}\n\n`;
        content += '-'.repeat(50) + '\n\n';
    }
    
    sessionNotes.forEach((note, index) => {
        content += `[${note.timestamp}]`;
        if (note.inject) {
            content += ` @ ${note.inject}`;
        }
        content += '\n';
        content += note.text + '\n\n';
    });
    
    // Create and download the file
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    // Generate filename with date
    const date = new Date().toISOString().split('T')[0];
    const storylineName = activeStoryline && storylinesData[activeStoryline] 
        ? storylinesData[activeStoryline].name.replace(/[^a-z0-9]/gi, '_').toLowerCase()
        : 'session';
    a.download = `${storylineName}_notes_${date}.txt`;
    
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function clearSessionNotes() {
    if (sessionNotes.length === 0) {
        showAlert('No notes to clear', 'Clear Notes');
        return;
    }
    
    showConfirm('Are you sure you want to delete all session notes? This cannot be undone.', 'Clear All Notes')
        .then(confirmed => {
            if (!confirmed) return;
            
            fetch('/api/session-notes/clear', {
                method: 'POST'
            })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    sessionNotes = [];
                    renderSessionNotes();
                }
            })
            .catch(err => console.error('Failed to clear session notes:', err));
        });
}

// ============ Clocks ============
function updateCurrentTimeClock() {
    const clock = document.getElementById('currentTimeClock');
    if (!clock) return;
    
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    clock.textContent = `${hours}:${minutes}:${seconds}`;
}

function updateStopwatch() {
    const clock = document.getElementById('stopwatchClock');
    if (!clock || !stopwatchStartTime) return;
    
    const elapsed = Date.now() - stopwatchStartTime;
    const totalSeconds = Math.floor(elapsed / 1000);
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    clock.textContent = `${hours}:${minutes}:${seconds}`;
}

function startStopwatch() {
    if (stopwatchStartTime) return; // Already running
    
    stopwatchStartTime = Date.now();
    stopwatchInterval = setInterval(updateStopwatch, 1000);
    updateStopwatch();
}

function resetStopwatch() {
    stopwatchStartTime = null;
    if (stopwatchInterval) {
        clearInterval(stopwatchInterval);
        stopwatchInterval = null;
    }
    const clock = document.getElementById('stopwatchClock');
    if (clock) clock.textContent = '00:00:00';
}

function initClocks() {
    updateCurrentTimeClock();
    setInterval(updateCurrentTimeClock, 1000);
}

// ============ Inject Preview Hover ============
let previewTimeout = null;
// Library previews are forced above the cursor (the library is at the bottom of
// the screen); storyline previews keep their default below/auto placement.
let previewAboveCursor = false;

function showInjectPreview(event, block) {
    const previewCard = document.getElementById('injectPreviewCard');
    if (!previewCard || !block) return;
    
    // Set content
    const daytimeEl = document.getElementById('previewDaytime');
    const headingEl = document.getElementById('previewHeading');
    const imageContainer = document.getElementById('previewImageContainer');
    const textEl = document.getElementById('previewText');
    const gmNotesEl = document.getElementById('previewGmNotes');
    
    // Day/Time
    let daytime = '';
    if (block.day && block.day > 0) {
        daytime = `Day ${block.day}`;
        if (block.time) daytime += ` — ${block.time}`;
    } else if (block.time) {
        daytime = block.time;
    }
    daytimeEl.textContent = daytime;
    
    // Heading
    headingEl.textContent = block.heading || 'Untitled';
    
    // Image
    if (block.image) {
        imageContainer.innerHTML = `<img src="${block.image}" alt="">`;
    } else {
        imageContainer.innerHTML = '';
    }
    
    // Text
    textEl.textContent = block.text || '';
    
    // GM Notes
    gmNotesEl.textContent = block.gm_notes || '';
    
    // Show the card first (it's display:none until .visible) so it has real
    // dimensions, then position it. Both happen in one tick — no flash, and the
    // height is now correct for the library "above the cursor" placement.
    previewCard.classList.add('visible');
    positionPreviewCard(event, previewCard);
}

// Hover preview for a library side-quest: shows the cards it contains.
function showBranchPreview(event, branch) {
    const card = document.getElementById('branchPreviewCard');
    if (!card || !branch) return;

    document.getElementById('branchPreviewHeading').textContent = branch.name || 'Unnamed Side-Quest';

    const wrap = document.getElementById('branchPreviewInjects');
    const injects = branch.injects || [];
    wrap.innerHTML = injects.length
        ? injects.map((inj, i) => `
            <div class="branch-details-inject">
                <div class="branch-details-inject-header">
                    <span class="branch-details-inject-number">#${i + 1}</span>
                    <span class="branch-details-inject-title">${escapeHtml(inj.heading || 'Untitled')}</span>
                    ${inj.duration > 0 ? `<span class="block-duration">${inj.duration}s</span>` : ''}
                </div>
                ${inj.image ? `<img src="${inj.image}" class="branch-details-inject-image">` : ''}
                ${inj.text ? `<div class="branch-details-inject-text">${escapeHtml(inj.text)}</div>` : ''}
            </div>
        `).join('')
        : '<div class="branch-details-empty">No injects in this side-quest</div>';

    card.classList.add('visible');
    positionPreviewCard(event, card);
}

function positionPreviewCard(event, previewCard) {
    if (!previewCard) return;
    
    const padding = 15;
    const cardRect = previewCard.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    let left = event.clientX + padding;
    let top = event.clientY + padding;
    
    // Adjust if card would go off right edge
    if (left + cardRect.width > viewportWidth - padding) {
        left = event.clientX - cardRect.width - padding;
    }
    
    if (previewAboveCursor) {
        // Library previews: always above the cursor so they don't run off the
        // bottom of the screen.
        top = event.clientY - cardRect.height - padding;
    } else if (top + cardRect.height > viewportHeight - padding) {
        // Storyline previews: default below, flip above only if off the bottom.
        top = event.clientY - cardRect.height - padding;
    }

    // Ensure not off left or top edge
    left = Math.max(padding, left);
    top = Math.max(padding, top);
    
    previewCard.style.left = left + 'px';
    previewCard.style.top = top + 'px';
}

function hideInjectPreview() {
    document.getElementById('injectPreviewCard')?.classList.remove('visible');
    document.getElementById('branchPreviewCard')?.classList.remove('visible');
}

function initInjectPreviewHover() {
    document.addEventListener('mouseover', function(e) {
        const blockCard = e.target.closest('.block-card, .branch-block-card, .library-card');
        if (!blockCard) return;
        
        // Don't show preview if hovering over action buttons
        if (e.target.closest('.block-actions, .branch-actions, .library-card-actions')) return;
        
        // Get the block ID - library cards use data-library-id, others use data-id
        const blockId = blockCard.dataset.id || blockCard.dataset.libraryId;
        if (!blockId) return;

        let block = null;
        // Force library previews above the cursor; leave storyline previews as-is.
        previewAboveCursor = blockCard.classList.contains('library-card');

        // Check if this is a library card
        if (blockCard.classList.contains('library-card')) {
            const item = libraryInjects.find(item => item.id === blockId);
            if (item && item.type === 'branch') {
                // Side-quest: preview the cards inside it.
                previewTimeout = setTimeout(() => showBranchPreview(e, item), 700);
                return;
            }
            if (item) {
                block = item; // a plain library inject
            }
        } else {
            // Find in storyline data
            if (!activeStoryline || !storylinesData[activeStoryline]) return;
            
            const data = storylinesData[activeStoryline];
            
            // Find the block in main storyline or branches
            block = (data.blocks || []).find(b => b.id === blockId);
            
            if (!block) {
                // Search in branches
                for (const branch of (data.branches || [])) {
                    block = (branch.injects || []).find(inj => inj.id === blockId);
                    if (block) break;
                }
            }
        }
        
        if (block) {
            // Delay before showing
            previewTimeout = setTimeout(() => showInjectPreview(e, block), 700);
        }
    });
    
    document.addEventListener('mouseout', function(e) {
        const blockCard = e.target.closest('.block-card, .branch-block-card, .library-card');
        if (blockCard) {
            if (previewTimeout) {
                clearTimeout(previewTimeout);
                previewTimeout = null;
            }
            hideInjectPreview();
        }
    });
    
    // Update position on mouse move while hovering
    document.addEventListener('mousemove', function(e) {
        const inj = document.getElementById('injectPreviewCard');
        const br = document.getElementById('branchPreviewCard');
        const visible = (inj && inj.classList.contains('visible')) ? inj
            : (br && br.classList.contains('visible')) ? br : null;
        if (visible) {
            const blockCard = e.target.closest('.block-card, .branch-block-card, .library-card');
            if (blockCard && !e.target.closest('.block-actions, .branch-actions, .library-card-actions')) {
                positionPreviewCard(e, visible);
            }
        }
    });
}

// Close the topmost open modal when Escape is pressed. Uses each modal's own
// close function so its cleanup (form reset, editing-lock release, etc.) runs.
function initModalEscToClose() {
    const closers = {
        blockModal: closeBlockModal,
        storylineModal: closeStorylineModal,
        branchModal: closeBranchModal,
        branchInjectModal: closeBranchInjectModal,
        playerTypesModal: closePlayerTypesModal,
        playerLinksModal: closePlayerLinksModal,
        helpModal: closeHelpModal,
        libraryInjectModal: closeLibraryInjectModal,
        libraryBranchDetailsModal: closeLibraryBranchDetailsModal,
        importModal: closeImportModal,
        alertModal: closeAlertModal,
        confirmModal: () => closeConfirmModal(false), // Esc = cancel
    };

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const open = document.querySelectorAll('.modal-overlay.active');
        if (open.length === 0) return;
        const top = open[open.length - 1]; // last in DOM = topmost
        const close = closers[top.id];
        if (close) close();
        else top.classList.remove('active');
    });
}

// Load session notes on startup
document.addEventListener('DOMContentLoaded', function() {
    loadSessionNotes();
    adjustLayoutForControlBar();
    initClocks();
    initInjectPreviewHover();
    initLibraryReorder();
    initModalEscToClose();
});
