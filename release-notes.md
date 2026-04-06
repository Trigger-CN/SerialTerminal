# Release Notes

## [v0.1.5] - 2026-04-06

### Added
- Integrated filter window into the main terminal using a tabbed interface.
- Support for multiple filter tabs to monitor different regex rules simultaneously.
- Automatic highlighting of matched texts in the filter tabs.
- Filter input history with a custom dropdown for quick rule selection.
- Configurable history buffer size and scrollback limits in global preferences.

### Changed
- Refactored serial data parser to process incoming data line by line to prevent truncated keyword matching.

### Fixed
- Autofill background color issue on history dropdowns in Chromium.
- Tab numbering logic when filter tabs are created and closed dynamically.
