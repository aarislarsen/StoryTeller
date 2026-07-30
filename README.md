# StoryTeller

A visual interactive storytelling tool for Game Masters running tabletop RPGs, or any scenario where you need to guide players through a narrative with visual injects.

<img width="1824" height="945" alt="image" src="https://github.com/user-attachments/assets/080eadea-f41e-4166-b1b3-b60c12acf924" />

<img width="956" height="609" alt="image" src="https://github.com/user-attachments/assets/15819f1b-c1b3-4335-b56d-7a4ab25673b6" />

## Features

- **Visual Storyline Builder** - Create and organize story injects with headings, text, and images
- **Real-time Player Sync** - Players see updates instantly via WebSocket
- **Branching Narratives** - Add optional side quests or alternate paths that branch from main storyline
- **Day & Time Display** - Show story progression with optional day numbers and timestamps
- **Auto/Manual Playback** - Set durations for automatic progression or advance manually
- **Player Type Targeting** - Send specific injects to specific player types (e.g., only the Wizard sees magic-related content)
- **Silent Targeting** - Players see no indication when injects not meant for them are played
- **Session Notes** - Capture timestamped observations during play with inject references
- **Inject Library** - Save and reuse injects across storylines; export/import the whole library as JSON (duplicates skipped)
- **Import/Export** - Import/export storylines, player types, and library items as JSON
- **Zoom Controls** - Zoom in/out with auto-fit to show all injects
- **Self-Contained Storage** - All data including images stored in JSON files for easy backup
- **Dark/Light Themes** - Both GM and Player interfaces support theme switching
- **GM Authentication** - Optional password protection for the GM interface
- **Responsive Design** - Works on desktop and mobile devices
- **AI Generation** - Included ChatGPT prompt for generating complete storylines

## Quick Start

```bash
cd storyteller
python app.py
```

With GM password protection:
```bash
python app.py --password your_secret_password
```

- **GM Interface**: http://localhost:5000/gm
- **Player Interface**: Use the Links feature to generate player URLs

## How to Use

### Getting Started

1. **Start the server** with `python app.py`
2. **Open the GM interface** at http://localhost:5000/gm
3. **Create a new storyline** by clicking "+ New"
4. **Add injects** to your storyline using the "+ Add Inject" card
5. **Activate the storyline** by selecting it and clicking "Activate"
6. **Generate player links** via "🔗 Links" button
7. **Share player links** with your players

### Creating Storylines

1. Click **"+ New"** in the control bar
2. Enter a name for your storyline
3. Click **"Create"**

### Adding Injects

Injects are the individual story beats shown to players.

1. Click the **"+ Add Inject"** card in the storyline
2. Fill in the details:
   - **Heading**: Short title (shown prominently to players)
   - **Text**: Main content/description
   - **GM Notes**: Private notes only you can see
   - **Duration**: Auto-advance time in seconds (0 = manual only)
   - **Day**: Optional day number (0 = hidden, 1+ shows as "Day 1", "Day 2", etc.)
   - **Time**: Optional time in HH:MM format (empty = hidden)
   - **Image**: Optional image upload
   - **Target Player Types**: Limit which players see this inject
3. Click **"Save Inject"**

**Day and Time** are displayed to players above the inject heading in orange text, useful for showing story progression (e.g., "Day 1 — 09:00").

### Managing Branches

Branches allow side quests or alternate paths that diverge from the main storyline.

1. Click the **⑂ branch button** on any inject
2. Configure the branch:
   - **Name**: Descriptive name for the branch
   - **Auto-trigger**: Automatically starts when parent inject is reached
   - **Manual trigger**: GM must activate it manually
   - **Merge target**: Where to resume the main storyline after branch completes
3. Add injects to the branch

**Branch Rules:**
- An inject can have ONE auto-trigger branch OR multiple manual branches
- If an inject has an auto-trigger branch, no additional branches can be added
- Multiple manual branches on the same inject allow GM choice during play

**Nested Side-Quests:**
- Any branch inject can itself spawn a sub-branch — click the **⑂ branch button** on a branch inject just like you would on a main inject.
- Nesting is unlimited: a sub-branch can have its own sub-branches, and so on.
- Sub-branches render directly beneath their parent inject, with a connector dropping from the center of the parent inject down to the child — the same visual used between the main storyline and a side-quest.
- Playback descends into a sub-quest when reached and returns to the parent (then eventually the main storyline) when it completes — the same auto/manual/merge rules apply at every level.
- A branch's **Merge target** can be *any* inject in the storyline (main or another branch), giving full control over where play resumes.
- **Reorganize branches by dragging:** grab a side-quest and drop it onto another inject to re-parent it. Drop it on a main inject to make it top-level, or on a branch inject to nest it. (You can't drop a branch into its own sub-tree.)
- Deleting an inject or branch automatically removes any sub-branches hanging off it.

### Player Types

Target specific content to specific players.

1. Click **"👥 Types"** to manage player types
2. Add types like "Wizard", "Knight", "Ranger"
3. When creating injects, select which types should see it
4. Players using type-specific links only see relevant content
5. The "All Players" link sees everything
6. **Silent targeting**: Players see no refresh or indication when an inject not meant for them is played

### Player Links

1. Click **"🔗 Links"** to open the links panel
2. Click **"Generate Links"** to create URLs
3. Share type-specific links with players, or use the "All Players" link
4. **Regenerate** creates new URLs (old links stop working)

### Session Notes

The **Notes for Later** panel lets you capture observations during play.

1. Type a note in the text area
2. Press **Enter** to submit (or **Alt+Enter** for line breaks)
3. Notes are saved with:
   - **Timestamp** - When the note was created
   - **Inject reference** - Which inject was active (e.g., "#4-2 Secret Cave" for branch inject 2 on main inject 4; nested sub-quests extend this, e.g. "#4-2-1")
4. **Export** notes to a text file for post-session review
5. **Clear All** to reset notes for a new session

Session notes are stored separately from storyline data and persist across browser refreshes.

### Running a Session

#### Manual Control
- Use **"◀ Prev"** and **"Next ▶"** buttons to navigate
- Click inject **numbers** to jump directly (works for both main storyline and branch injects)
- Use **keyboard shortcuts**: ← → or Page Up/Down

#### Auto-Play
- Click the **▶ Play button** to start auto-playback
- Injects with durations will auto-advance
- Injects with 0 duration pause until you click Next
- Click **⏸** to pause

#### Branches
- **Auto-trigger branches** activate automatically when you reach their parent inject
- **Manual branches** must be activated by clicking **"▶ Start"** on the branch
- Active branches show with highlighted borders
- Click **"⏹ Stop"** to deactivate a branch - the current inject stays visible to players
- When you click **"Next"** after stopping a branch, playback returns to the main storyline
- When a branch completes naturally, playback returns to the main storyline (or merge target)

#### Branch Controls
- **▶ Start**: Activate the branch (players won't see any change until you advance)
- **⏹ Stop**: Deactivate the branch (players continue seeing current inject until you advance)
- Activating/deactivating branches does NOT refresh the player view - only advancing does

### Zoom Controls

The storyline view supports zooming for better overview:

- **+ / -** buttons or keyboard shortcuts to zoom in/out
- **⊙** button or **0** key to reset to 100%
- **⊡** button or **F** key to auto-fit all injects in view
- When loading a new storyline, zoom automatically adjusts to fit all injects
- Scrollbars appear only when content overflows the visible area

### Import/Export

#### Exporting Storylines
1. Activate the storyline you want to export
2. Click **"📤 Export"**
3. A JSON file will be downloaded containing the storyline and player types

#### Importing Storylines
1. Click **"📥 Import"**
2. Select a JSON file
3. Preview shows what will be imported
4. Click **"Import"** to add to your collection

#### JSON Format
Storylines use this structure:
```json
{
  "storylines": {
    "uuid-here": {
      "name": "Story Name",
      "blocks": [
        {
          "id": "uuid",
          "heading": "Title",
          "text": "Content",
          "gm_notes": "Private notes",
          "duration": 30,
          "day": 1,
          "time": "09:00",
          "target_player_types": ["Wizard"],
          "image": null
        }
      ],
      "branches": [
        {
          "id": "branch-uuid",
          "name": "Side Quest",
          "parent_inject_id": "id of any inject this branches from",
          "auto_trigger": false,
          "merge_to_inject_id": "id of any inject to resume at, or null",
          "current_inject": 0,
          "injects": [ /* same shape as blocks */ ]
        }
      ]
    }
  },
  "player_types": ["Wizard", "Knight", "Ranger"]
}
```

**Branch references and nesting:** `parent_inject_id` may point at **any** inject — a main block *or* another branch's inject. Pointing it at a branch inject creates a **nested side-quest**, and this can go to any depth. Likewise `merge_to_inject_id` may target any inject anywhere in the storyline (or `null` to resume where the branch started). Branches are stored as a flat list; nesting is expressed purely through these id references, so storylines made before nesting existed load unchanged.

See `prompt.txt` for a ChatGPT prompt that generates complete storylines in this format.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| ← / Page Up | Previous inject |
| → / Page Down | Next inject |
| A | Add new inject |
| T | Toggle theme |
| B | Cycle side-quest borders (solid / dashed / none) |
| + / = | Zoom in |
| - | Zoom out |
| 0 | Reset zoom to 100% |
| F | Zoom to fit all injects |

### Inject Library

Save frequently-used injects for reuse across storylines. The library panel is collapsible - click the header to expand or collapse it. The item count is always shown in the header.

#### Saving to Library
- When editing an inject, check **"📚 Save copy to Library"**
- For branches, use **"📚 Save to Library"** button in branch editor

#### Using Library Items
- **Drag** library injects onto the main storyline to add at specific positions
- **Drag** library injects onto a branch to add to that branch
- **Drag** library branches onto a main storyline inject to attach
- Click **➕** to add at the end of the storyline

#### Exporting & Importing the Library
The library has its own export/import, separate from storyline export (which does **not** include the library).

- **📤 Export** downloads the entire library (injects and sidequests, images included) as `inject_library.json`
- **📥 Import** loads a library JSON file and merges it into your current library
- **Duplicates are skipped** automatically — items are matched by content (ignoring their IDs), so re-importing the same file adds nothing, and overlapping libraries only bring in the new items. Imported items receive fresh IDs. A summary shows how many were added vs. skipped.

## Project Structure

```
storyteller/
├── app.py              # Main entry point, Flask app setup
├── config.py           # Configuration constants
├── data.py             # Data persistence
├── routes.py           # HTTP API endpoints
├── socket_handlers.py  # WebSocket event handlers
├── prompt.txt          # ChatGPT prompt for generating storylines
├── templates/
│   ├── gm.html         # Game Master interface
│   ├── player.html     # Player interface
│   └── login.html      # GM login page
├── static/
│   ├── css/
│   │   ├── gm.css      # GM styles
│   │   └── player.css  # Player styles
│   └── js/
│       ├── gm.js       # GM client logic
│       └── player.js   # Player client logic
└── storyline_data/     # Runtime data (created automatically)
    ├── storylines.json # All storyline data (including images as base64)
    └── session_notes.json # Session notes data
```

## API Reference

### Storylines
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/storylines` | List all storylines |
| POST | `/api/storylines` | Create storyline |
| POST | `/api/storylines/import` | Import from JSON |
| POST | `/api/storylines/activate` | Set active storyline |
| GET | `/api/storylines/<id>` | Get storyline |
| PUT | `/api/storylines/<id>` | Update storyline |
| DELETE | `/api/storylines/<id>` | Delete storyline |

### Injects (Blocks)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/blocks` | Create inject |
| GET | `/api/blocks/<storyline>/<id>` | Get inject |
| POST | `/api/blocks/<storyline>/<id>` | Update inject |
| DELETE | `/api/blocks/<storyline>/<id>` | Delete inject |
| POST | `/api/blocks/reorder` | Reorder injects |

### Branches
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/branches` | Create branch |
| GET | `/api/branches/<storyline>/<id>` | Get branch |
| PUT | `/api/branches/<storyline>/<id>` | Update branch |
| DELETE | `/api/branches/<storyline>/<id>` | Delete branch |

### Player Types & Links
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/player-types` | List player types |
| POST | `/api/player-types` | Add player type |
| DELETE | `/api/player-types/<n>` | Remove player type |
| GET | `/api/player-links` | Get player links |
| POST | `/api/player-links` | Generate/regenerate links |

### Library
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/library` | List library items |
| POST | `/api/library` | Add to library |
| POST | `/api/library/import` | Import library items (skips duplicates) |
| POST | `/api/library/<id>/add-to-storyline` | Add library inject to storyline |
| POST | `/api/library/<id>/add-to-branch` | Add library inject to branch |

### Session Notes
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/session-notes` | Get all session notes |
| POST | `/api/session-notes` | Add a session note |
| DELETE | `/api/session-notes/<index>` | Delete a note by index |
| POST | `/api/session-notes/clear` | Clear all session notes |

## WebSocket Events

### Client → Server
| Event | Data | Description |
|-------|------|-------------|
| `gm_connected` | - | GM joins session |
| `player_connected` | `{player_type_id}` | Player joins session |
| `next_block` | - | Advance to next inject |
| `previous_block` | - | Go to previous inject |
| `go_to_block` | `{index}` | Jump to specific main inject |
| `go_to_branch_inject` | `{branch_id, inject_index}` | Jump to specific branch inject |
| `toggle_playback` | `{playing}` | Start/stop auto-play |
| `activate_branch` | `{branch_id}` | Activate a branch |
| `deactivate_branch` | `{branch_id}` | Deactivate a branch |

### Server → Client
| Event | Data | Description |
|-------|------|-------------|
| `block_update` | `{block, current_index, ...}` | Current inject data |
| `state_update` | `{current_block, ...}` | Playback state |
| `playback_update` | `{playing, remaining}` | Timer state |

## Dependencies

- Python 3.8+
- Flask
- Flask-SocketIO
- Werkzeug

Dependencies are auto-installed on first run.

## Tips for Game Masters

1. **Prepare in advance**: Build your storyline before the session
2. **Use GM notes**: Add reminders, questions to ask, or dice roll instructions
3. **Set strategic durations**: Use auto-advance for atmospheric moments, manual for decision points
4. **Create branches for flexibility**: Have side content ready if players go off-script
5. **Use manual branches for choices**: Create multiple manual branches on a decision point inject to give players options
6. **Use merge targets strategically**: Skip ahead in the main storyline after a branch to avoid repetition
7. **Use player types wisely**: Give each player type their moment to shine
8. **Test player links**: Verify links work before the session
9. **Keep a library**: Save reusable elements like tavern descriptions or combat encounters
10. **Branch controls are invisible to players**: Starting/stopping branches won't alert players - only advancing does
11. **Use Day/Time for pacing**: Show story progression with day numbers and timestamps at key moments
12. **Generate with AI**: Use the included `prompt.txt` with ChatGPT to generate complete storylines
13. **Take session notes**: Use the Notes for Later panel to capture observations for post-session review
14. **Export notes after sessions**: Download your session notes before clearing for the next session
15. **Use zoom to fit**: Press F to auto-zoom so all injects are visible at once

## License

MIT License - Feel free to use, modify, and distribute.
