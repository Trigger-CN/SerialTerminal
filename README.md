# Serial Terminal

A modern, cross-platform serial port terminal application built with Electron.

## Features

*   **🔌 Serial Communication**: robust connection handling with customizable baud rates (standard & custom), data bits, stop bits, parity, and flow control.
*   **💻 Terminal Emulation**: Full-featured terminal interface powered by **xterm.js**, supporting ANSI escape sequences and proper text rendering.
*   **🚀 Send Functions**:
    *   **Auto Send**: Automatically send text at user-defined intervals. Supports multi-line input.
    *   **Quick Send**: Create a custom list of frequently used commands. Supports multi-line content, editing, and reordering.
*   **📝 Log Management**:
    *   Automatic logging of all serial input/output.
    *   **Smart Buffering**: Logs are buffered in memory and flushed to disk only on disconnect or exit to minimize disk I/O.
    *   Customizable log file naming formats (e.g., `%Y-%m-%d`) and storage paths.
*   **🎨 Keyword Highlighting**: Real-time highlighting of specific text patterns using Regular Expressions (Regex) with customizable colors.
*   **🔍 Filter Window**: Open a separate window to view filtered output (e.g., only show lines containing "ERROR") without affecting the main terminal view.
*   **⚙️ Customization**:
    *   Dark theme UI.
    *   Configurable fonts (Consolas, Fira Code, etc.), font sizes, and colors.
    *   Settings are persisted automatically.
*   **🖥️ Cross-Platform**: Ready for Windows and Linux.

## Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/yourusername/serial-terminal.git
    cd serial-terminal
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

    *Note: This project uses native modules (`serialport`, `node-pty`). Ensure you have the necessary build tools installed for your OS (e.g., Visual Studio Build Tools for Windows, `build-essential` for Linux).*

3.  **Rebuild native modules** (if you encounter version mismatch errors)
    ```bash
    npm run rebuild
    ```

## Usage

### Development
Start the application in development mode with hot-reload support (if configured) or standard Electron launch:

```bash
npm start
```

### Packaging / Build

Use `electron-builder` to create specific installers/executables for your platform.

**For Windows (creates installer & portable exe):**
```bash
npm run dist:win
```

**For Linux (creates AppImage & deb):**
```bash
npm run dist:linux
```

> **Note**: Native modules must be compiled for the target platform. It is recommended to build Windows versions on Windows and Linux versions on Linux.

## Project Structure

*   `main.js` - Electron main process (lifecycle, window management, IPC handling).
*   `renderer.js` - Main window renderer logic (UI interactions, serial logic).
*   `index.html` - Main application layout.
*   `preferences.html/js` - Settings window implementation.
*   `filter.html/js` - Filter window implementation.

## License

ISC
