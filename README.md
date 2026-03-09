# Writing Annotations

An Obsidian plugin that lets you highlight text and leave inline editing comments — like Google Docs, but in your vault.

## How it works

- Select any text in a note → add a comment
- Annotated text is wrapped in `==highlights==` (native Obsidian highlighting)
- Comments are stored in the note's YAML frontmatter — no external database, no extra files
- A side panel shows all annotations for the current note
- Export all annotations for AI review (paste into any AI tool for editing feedback)

## Example frontmatter

```yaml
annotations:
  - text: "Hanging with Colton was cool."
    note: "Make this punchier — lead with the insight."
    created: "2026-03-08"
```

## Installation

### From Obsidian Community Plugins
Search for **Writing Annotations** in Settings → Community plugins.

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/perrisaquino/writing-annotations/releases)
2. Create a folder `writing-annotations` inside your vault's `.obsidian/plugins/` directory
3. Move the downloaded files into that folder
4. Enable the plugin in Settings → Community plugins

## Author

Built by [Perris Aquino](https://github.com/perrisaquino)
