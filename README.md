# Kian's Obsidian Tweaks

Kian's Obsidian Tweaks bundles a few opinionated visual and workflow tweaks for Obsidian:

- Retro heading font and glow effects
- Matrix-style idle lock screen
- Vault edit notification dots for files changed outside Obsidian

## Features

### Heading Tweaks

- Uses a mono heading font stack based on DepartureMono/BlexMono
- Adds subtle pulsing glow to headings
- Adds an H1 block cursor and chromatic offset
- Adds a terminal-style `//` suffix to H2 headings

### Matrix Lock Screen

- Locks file-backed views after a configurable idle timeout
- Collapses sidebars when the lock starts
- Corrupts the current page with Matrix-style falling glyphs
- Requires a configurable password to unlock

This is a visual/privacy lock only. It is not encryption, access control, or a security boundary. The passcode is stored in plugin settings and should not be reused as a real password.

Default password:

```text
matrix
```

### Vault Edit Notifications

- Shows dots in the file explorer for files changed outside Obsidian
- Supports watched folders
- Can clear notifications when files are opened
- Lets you customize dot color and opacity

## Installation

Until this plugin is available in Obsidian's community plugin browser:

1. Download `manifest.json`, `main.js`, and `styles.css` from the latest release.
2. Create this folder in your vault:

   ```text
   .obsidian/plugins/kian-obsidian-tweaks/
   ```

3. Place the three files in that folder.
4. Reload Obsidian.
5. Enable `Kian's Obsidian Tweaks` under Community plugins.

## Settings

The plugin has one settings page with sections for:

- Heading Tweaks
- Matrix Lock Screen
- Vault Edit Notifications

## License

MIT
