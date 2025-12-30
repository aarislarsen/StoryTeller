# StoryTeller

A visual interactive storytelling tool for Game Masters running tabletop RPGs, educational sessions, or any scenario where you need to guide players through a narrative with visual injects.

## Features

- **Visual Storyline Builder** - Create and organize story injects with headings, text, and images
- **Real-time Player Sync** - Players see updates instantly via WebSocket
- **Branching Narratives** - Add optional side quests or alternate paths that branch from main storyline
- **Day & Time Display** - Show story progression with optional day numbers and timestamps
- **Auto/Manual Playback** - Set durations for automatic progression or advance manually
- **Player Type Targeting** - Send specific injects to specific player types (e.g., only the Wizard sees magic-related content)
- **Inject Library** - Save and reuse injects across storylines
- **Import/Export** - Import storylines from JSON files
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

### Player Types

Target specific content to specific players.

1. Click **"👥 Types"** to manage player types
2. Add types like "Wizard", "Knight", "Ranger"
3. When creating injects, select which types should see it
4. Players using type-specific links only see relevant content
5. The "All Players" link sees everything

### Player Links

1. Click **"🔗 Links"** to open the links panel
2. Click **"Generate Links"** to create URLs
3. Share type-specific links with players, or use the "All Players" link
4. **Regenerate** creates new URLs (old links stop working)

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

### Import/Export

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
      "branches": [...]
    }
  },
  "player_types": ["Wizard", "Knight", "Ranger"]
}
```

See `prompt.txt` for a ChatGPT prompt that generates complete storylines in this format.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| ← / Page Up | Previous inject |
| → / Page Down | Next inject |
| A | Add new inject |
| T | Toggle theme |
| + / = | Zoom in |
| - | Zoom out |
| 0 | Reset zoom |

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
    ├── storylines.json # All storyline data
    └── uploads/        # Uploaded images
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
| DELETE | `/api/player-types/<name>` | Remove player type |
| GET | `/api/player-links` | Get player links |
| POST | `/api/player-links` | Generate/regenerate links |

### Library
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/library` | List library items |
| POST | `/api/library` | Add to library |
| POST | `/api/library/<id>/add-to-storyline` | Add library inject to storyline |
| POST | `/api/library/<id>/add-to-branch` | Add library inject to branch |

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

## License

MIT License - Feel free to use, modify, and distribute.
