# Spicy3D js Demo Plugin

A demonstration plugin for Spicy3D showing the capabilities of the plugin system.

## Features

- **Hello World Command**: A simple command that displays a greeting message
- **Ribbon Integration**: Adds a button to the Tools tab
- **i18n Support**: English

## Project Structure

```
helloworld-js/
├── manifest.json          # Plugin manifest with metadata
├── package.json           # NPM configuration
├── README.md              # This file
├── src/
│   ├── extension.js       # Plugin main class
└── icons/
    └── hello.svg          # Command icon (optional)
```

## Development

Package the plugin (creates .spicyplugin file):

```bash
npm run package
```

The packaging script is cross-platform and works on both Windows (PowerShell) and macOS/Linux.

## Installation

Drag and drop the .spicyplugin file into Spicy3D.

# Demo Plugin for Spicy3D

To run the plugin, you need to start the spicy3d server: at the root of the spicy3d folder, run: `npm run start`. Then, start the plugin server: at the root of the plugin folder, run: `npm run preview`. The plugin server will start on port 8686. The plugin will be available at http://localhost:8080?plugin=http://localhost:8686.