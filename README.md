📁 Project Structure

The extension lives at ~/.pi/agent/extensions/pi-boy/ and is auto-discovered by pi.

```
pi-boy/
├── package.json                          # Pi package manifest
└── extensions/gameboy/
    ├── index.ts                          # Main entry — registers /gameboy & /gameboy-config
    ├── config.ts                         # Config management (romDir, saveDir, renderer, etc.)
    ├── input-map.ts                      # Key bindings (WASD/arrows, Z=A, X=B, etc.)
    ├── paths.ts                          # Path resolution utilities
    ├── roms.ts                           # ROM scanning (.gb, .gbc files)
    ├── rom-selector.ts                   # Filterable ROM picker dialog
    ├── saves.ts                          # Save/load SRAM & save states
    ├── gb-core.ts                        # JS wrapper around native Rust core
    ├── gb-session.ts                     # Emulation loop (60fps tick, periodic saves)
    ├── gb-component.ts                   # TUI component (Kitty image or ANSI rendering)
    ├── renderer.ts                       # Kitty/PNG/ANSI frame renderer (160×144)
    └── native/
        ├── gb-core/                      # Rust napi-rs Game Boy core
        │   ├── src/lib.rs                # Native wrapper (loadRom, tick, input, save/load)
        │   ├── index.node                # Compiled binary (~1.7MB)
        │   └── vendor/mizu-core/         # Vendored mizu-core emulator (modified)
        └── kitty-shm/                    # Kitty protocol shared memory transport
            ├── src/lib.rs                # POSIX shared memory via napi-rs
            └── index.node                # Compiled binary (~506KB)
```

🎮 Native Core

Powered by mizu-core v1.3.0 — an accurate DMG (original Game Boy) and CGB (Game Boy Color) emulator in Rust.

Supported mappers: NoMapper, MBC1 (including multicart), MBC2, MBC3 (with RTC), MBC5

Vendored with added SRAM access methods (get_sram, set_sram, save_sram_to_file) and exposed through napi-rs for Node.js.

🕹️ Controls

┌──────────┬────────────────────┐
│ Game Boy │ Keys               │
├──────────┼────────────────────┤
│ D-pad    │ Arrow keys or WASD │
├──────────┼────────────────────┤
│ A button │ Z                  │
├──────────┼────────────────────┤
│ B button │ X                  │
├──────────┼────────────────────┤
│ Start    │ Enter or Space     │
├──────────┼────────────────────┤
│ Select   │ Tab                │
├──────────┼────────────────────┤
│ Detach   │ Ctrl+Q             │
├──────────┼────────────────────┤
│ Quit     │ Q                  │
└──────────┴────────────────────┘

🎨 Rendering

- Kitty-protocol terminals (Ghostty, Kitty, WezTerm) — full image rendering via shared memory or file transport
- Other terminals — falls back to ANSI half-block characters (▀▄)
- Text mode — set "renderer": "text" in config for overlay rendering

💾 Saves

- Battery-backed SRAM is saved to <saveDir>/<rom-name>-<hash>.sav
- Full save states (via GameBoy::save_state) capture CPU, RAM, RTC, etc.

🚀 Commands

┌─────────────────┬─────────────────────────────────────────────┐
│ Command         │ Description                                 │
├─────────────────┼─────────────────────────────────────────────┤
│ /gameboy        │ Pick a ROM or reattach to running session   │
├─────────────────┼─────────────────────────────────────────────┤
│ /gameboy <path> │ Load a specific ROM file                    │
├─────────────────┼─────────────────────────────────────────────┤
│ /gameboy config │ Quick setup wizard (ROM dir + audio)        │
├─────────────────┼─────────────────────────────────────────────┤
│ /gameboy-config │ Toggle audio, quality, and display settings │
└─────────────────┴─────────────────────────────────────────────┘

⚙️ Configuration

Stored at ~/.pi/gameboy/config.json. Default ROM directory: ~/roms/gameboy.

```json
{
  "romDir": "/Users/JARVIS/roms/gameboy",
  "saveDir": "/Users/JARVIS/roms/gameboy/saves",
  "renderer": "image",
  "imageQuality": "balanced",
  "pixelScale": 1.0,
  "isDmg": false
}
```

🔧 Building

The native modules are already compiled. To rebuild if needed:

```bash
cd ~/.pi/agent/extensions/pi-boy/extensions/gameboy/native/gb-core
npm install && npm run build

cd ../kitty-shm
npm install && npm run build
```

📝 Usage

Just run /gameboy in pi! On first run it'll prompt you to set your ROM directory. Drop .gb and .gbc files in ~/roms/gameboy (or your configured directory).
