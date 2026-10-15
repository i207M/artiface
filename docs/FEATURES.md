# Artiface features

Browse and read artifacts from local and SSH machines in one browser workspace.

## For users

- **Projects and tabs:** Drag opened projects and file tabs to reorder them on desktop, sync project order across devices, and find open files in Overview.
  Project lists sync across your devices; file tabs stay separate on each device.
- **Flexible browsing:** Use list or icon view, sort by name, type, size, or modification time, and filter by filename or file type.
  Browse paths and preferences are remembered, with an option to include files from subfolders.
- **Git history and changes:** Browse a commit graph with branch and tag labels, and compare file changes in inline or side-by-side diff tabs.
- **Live updates:** Refresh files automatically, pause individual readers, or refresh manually.
  Cached previews and reading positions help you switch tabs without starting over.
- **Sharing and downloads:** Copy a file path, share an app link, or download the original file.
- **Comfortable reading:** Use fullscreen, resize or hide the sidebar, and choose themes, text sizes, and compact or comfortable layouts.
  The interface adapts to phones and tablets and can be installed through supported browsers.

| File type | Viewer features |
| --- | --- |
| PDF | Text search, clickable outlines, page thumbnails, zoom, rotation, vertical or horizontal navigation, and optional Compression for large files. |
| Markdown | Rendered and source views, heading outline, tables, task lists, math, and highlighted code blocks. |
| HTML | Interactive reports with project permission, local links opening in app tabs, and confirmation before opening external links. |
| Images and SVG | Fit, zoom, pan, rotate, and preview background choices. |
| Code and text | Syntax highlighting, line numbers, and line wrapping for source, configuration, scripts, and logs. |
| LaTeX and BibTeX | Source viewing and a shortcut to an existing PDF with the same basename. |
| CSV and TSV | Sortable tables, pagination, header controls, and source view. |

Artiface is a viewer; it does not edit files, run code, or compile documents.

## For admins

These controls are also available to the owner in Personal mode.

- **Personal or Team:** Choose a single password for personal use or individual usernames and passwords for a team.
  Manage accounts, reset passwords, and assign project access through `/admin/`.
- **Machines and projects:** Add SSH hosts in the web app or import SSH configuration once from the command line.
  Select project folders, hide or remove sources, and connect through saved jump hosts.
  Remote machines do not need Artiface installed.
- **SSH credentials:** Keep keys and passwords encrypted, unlock them by signing in after a restart, and approve unknown or changed server fingerprints.
  Removing a host removes its saved credentials; SSH connectivity can also be disabled entirely.
- **Report permissions:** Allow JavaScript per project; scripts are blocked by default and reports remain sandboxed.
- **Browsing controls:** Manage shared ignore rules and enable or disable Git status globally or per project.
- **Self-hosting:** Deploy with Docker or natively, mount folders you want to browse, and access the app through an SSH tunnel, LAN IP, or HTTPS reverse proxy.

See the [quick guide](guide-quick.md) to get started, the [full guide](guide-full.md) for controls and limits, and [Deployment](deployment.md) for setup and administration.
