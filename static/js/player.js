/**
 * Player Interface JavaScript
 * Handles story display, history panel, and real-time updates
 */

// ============ State ============
const socket = io();
let allBlocks = [];
let currentIndex = 0;
let historyOpen = false;
let currentSource = 'main';
let sourceName = null;
let shownHistory = []; // Array of all injects shown to player {block, source, sourceName}
let lastShownBlock = null; // Track what's currently displayed

// Player type ID from server (set in HTML)
const playerTypeId = window.PLAYER_TYPE_ID || null;

// ============ Socket Events ============
socket.on('connect', () => {
    setConnectionStatus(true);
    // Send player_type_id to server so it can join the correct room
    socket.emit('player_connected', { player_type_id: playerTypeId });
});

socket.on('disconnect', () => {
    setConnectionStatus(false);
});

socket.on('block_update', (data) => {
    allBlocks = data.all_blocks || [];
    currentIndex = data.current_index || 0;
    const total = data.total_blocks || 0;
    currentSource = data.current_source || 'main';
    sourceName = data.source_name || null;
    
    // Server handles filtering - we just display what we receive
    const block = data.block;
    
    if (block) {
        // Add to history if this is a new inject
        const lastEntry = shownHistory[shownHistory.length - 1];
        const isNewInject = !lastEntry || 
            lastEntry.block.id !== block.id ||
            lastEntry.source !== currentSource;
        
        if (isNewInject) {
            shownHistory.push({
                block: block,
                source: currentSource,
                sourceName: sourceName
            });
        }
        
        lastShownBlock = block;
    }
    
    // Render current card (server already filtered for our player type)
    renderCurrentCard(block, currentIndex, total);
    
    // Update progress bar (only for main storyline progress)
    updateProgressBar(currentIndex, total);
    
    // Update history if open
    if (historyOpen) {
        renderHistory();
    }
    
    // Update history button
    updateHistoryButton();
});

// ============ Connection Status ============
function setConnectionStatus(connected) {
    const el = document.getElementById('connectionStatus');
    el.className = 'connection-status' + (connected ? ' connected' : '');
    el.innerHTML = `<span class="dot"></span><span>${connected ? 'Connected' : 'Reconnecting...'}</span>`;
}

// ============ Progress Bar ============
function updateProgressBar(current, total) {
    const percent = total > 0 ? ((current + 1) / total) * 100 : 0;
    document.getElementById('progressFill').style.width = percent + '%';
}

// ============ Current Card ============
function renderCurrentCard(block, index, total) {
    const card = document.getElementById('currentCard');
    
    if (!block) {
        card.innerHTML = `
            <div class="waiting">
                <div class="waiting-icon">🎲</div>
                <div class="waiting-title">Awaiting the Story...</div>
                <div class="waiting-text">The Game Master will reveal the tale shortly.</div>
            </div>
        `;
        return;
    }
    
    // Build day/time display
    let dayTimeHtml = '';
    const dayPart = block.day > 0 ? `Day ${block.day}` : '';
    const timePart = block.time || '';
    
    if (dayPart || timePart) {
        const combined = [dayPart, timePart].filter(Boolean).join(' — ');
        dayTimeHtml = `<div class="card-day-time">${escapeHtml(combined)}</div>`;
    }
    
    // Display inject the same way regardless of source (main or branch)
    card.innerHTML = `
        ${block.image ? `
            <div class="card-image-container">
                <img src="/uploads/${block.image}" class="card-image">
            </div>
        ` : ''}
        <div class="card-content">
            ${dayTimeHtml}
            <h1 class="card-title">${escapeHtml(block.heading)}</h1>
            ${block.text ? `<div class="card-text">${escapeHtml(block.text)}</div>` : ''}
        </div>
    `;
    
    // Trigger animation
    triggerCardAnimation(card);
}

function triggerCardAnimation(card) {
    card.style.animation = 'none';
    card.offsetHeight; // Force reflow
    card.style.animation = 'cardFadeIn 0.5s ease';
}

// ============ History Panel ============
function toggleHistory() {
    historyOpen = !historyOpen;
    
    const panel = document.getElementById('historyPanel');
    const btn = document.getElementById('historyBtn');
    const mainView = document.getElementById('mainView');
    
    if (historyOpen) {
        panel.classList.add('show');
        btn.classList.add('active');
        mainView.classList.add('hidden');
        renderHistory();
    } else {
        panel.classList.remove('show');
        btn.classList.remove('active');
        mainView.classList.remove('hidden');
    }
}

function renderHistory() {
    const list = document.getElementById('historyList');
    
    if (shownHistory.length === 0) {
        list.innerHTML = '<div class="history-empty">No story blocks yet</div>';
        return;
    }
    
    list.innerHTML = shownHistory.map((entry, i) => buildHistoryItem(entry, i, i === shownHistory.length - 1)).join('');
    
    // Scroll to current item
    const currentItem = list.querySelector('.current');
    if (currentItem) {
        currentItem.scrollIntoView({behavior: 'smooth', block: 'center'});
    }
}

function buildHistoryItem(entry, index, isCurrent) {
    const block = entry.block;
    
    return `
        <div class="history-item ${isCurrent ? 'current' : ''}" onclick="viewHistoryItem(${index})">
            <div class="history-item-content">
                ${block.image ? `<img src="/uploads/${block.image}" class="history-item-image">` : ''}
                <div class="history-item-text">
                    <div class="history-item-title">${escapeHtml(block.heading)}</div>
                    ${block.text ? `<div class="history-item-preview">${escapeHtml(block.text)}</div>` : ''}
                </div>
            </div>
        </div>
    `;
}

function viewHistoryItem(index) {
    if (index >= 0 && index < shownHistory.length) {
        const entry = shownHistory[index];
        toggleHistory();
        renderCurrentCard(entry.block, index, shownHistory.length);
    }
}

function updateHistoryButton() {
    document.getElementById('historyBtn').innerHTML = 
        `<span>📜</span><span>History (${shownHistory.length})</span>`;
}

// ============ Utilities ============
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

// ============ Keyboard Shortcuts ============
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && historyOpen) {
        toggleHistory();
    }
    if (e.key === 'h' || e.key === 'H') {
        toggleHistory();
    }
    if (e.key === 't' || e.key === 'T') {
        toggleTheme();
    }
});

// ============ Theme Toggle ============
let isDarkMode = true;

function toggleTheme() {
    isDarkMode = !isDarkMode;
    document.body.classList.toggle('light-mode', !isDarkMode);
    
    const themeBtn = document.getElementById('themeBtn');
    const themeIcon = document.getElementById('themeIcon');
    
    if (isDarkMode) {
        themeIcon.textContent = '☀️';
        themeBtn.querySelector('span:last-child').textContent = 'Light';
    } else {
        themeIcon.textContent = '🌙';
        themeBtn.querySelector('span:last-child').textContent = 'Dark';
    }
    
    // Save preference
    localStorage.setItem('playerTheme', isDarkMode ? 'dark' : 'light');
}

// Load saved theme on startup
(function initTheme() {
    const savedTheme = localStorage.getItem('playerTheme');
    if (savedTheme === 'light') {
        isDarkMode = false;
        document.body.classList.add('light-mode');
        document.getElementById('themeIcon').textContent = '🌙';
        document.getElementById('themeBtn').querySelector('span:last-child').textContent = 'Dark';
    }
})();
