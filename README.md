# Elementor Class Lock

A WordPress plugin that adds session-scoped locks to Elementor V4 global CSS classes, preventing accidental edits to locked classes during your editing session.

## Features

- **Lock/Unlock UI**: Click padlock icons in the Class Manager to protect global classes from editing
- **Visual Feedback**: Locked classes are clearly marked and editor controls are disabled
- **Session-Based**: Locks persist within your browser session and reset when you leave/return
- **REST API Protection**: Server-side validation prevents locked class modifications
- **Elementor V4 Compatible**: Built specifically for Elementor's Atomic Elements experiment

## Requirements

- WordPress 6.4+
- PHP 8.0+
- Elementor (core) with **Atomic Elements experiment enabled**

## Installation

1. Download the [latest release](https://github.com/ashbryant/elementor-class-lock-public/releases/latest)
2. Go to WordPress Admin → Plugins → Add New → Upload Plugin
3. Choose the downloaded ZIP file
4. Click "Install Now" and then "Activate"
5. Ensure Elementor's Atomic Elements experiment is enabled

## Usage

1. Open any page in Elementor editor
2. Open the Class Manager panel
3. Click the padlock icon next to any global class to lock/unlock it
4. Locked classes cannot be edited until unlocked

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history and release notes.

## Support

- **Issues**: [Report bugs or request features](https://github.com/ashbryant/elementor-class-lock-public/issues)
- **Discussions**: [Ask questions or share feedback](https://github.com/ashbryant/elementor-class-lock-public/discussions)

## License

This plugin is released under the GPL v2 or later.

## Credits

Developed by [Ash Bryant](https://github.com/ashbryant)
