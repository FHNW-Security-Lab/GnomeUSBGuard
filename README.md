# GnomeUSBGuard

GNOME Shell extension for USBGuard that gives interactive USB authorization with
good hub behavior and practical policy management.

Supported GNOME Shell version: `49`  
Extension UUID: `usbguard-prompt@blacksheeep`

## What It Does

The extension listens to USBGuard D-Bus events and lets you decide how newly
connected USB devices are handled.

Decisions map to USBGuard policy actions:

- `Allow once`
- `Allow permanent`
- `Block once`
- `Block permanent`

It supports both USBGuard D-Bus variants:

- `org.usbguard1` (newer)
- `org.usbguard` (legacy)

## Feature List

- Real-time USB insertion handling from USBGuard D-Bus (`DevicePresenceChanged`)
- Actionable GNOME notifications with allow/block choices
- Optional tray icon workflow with per-device/group quick actions
- Optional "tray only" mode (disable notifications while tray icon is enabled)
- Topology-aware grouping to reduce prompt spam for multi-function USB-C hubs
- Controlled merge behavior for hub infrastructure (hubs/billboard and related
  internal functions), while keeping standalone endpoints separate
- Late child inheritance: devices that enumerate shortly after hub allow can
  inherit the same decision automatically
- Cross-port separation: same hardware on different host ports is treated as a
  separate context
- Duplicate insert suppression for repeated near-identical insert signals
- Lock-screen behavior: newly inserted devices are blocked once while locked and
  queued for handling after unlock
- Preferences UI with connected devices, permanent rules, and System-Devices
  sections
- Per-device policy changes from preferences and tray menu
- System-Devices baseline workflow
- Nix flake support for dev, install, packaging, and reproducible release zip

## How To Operate

## Runtime Flow

1. Plug in a new USB device.
2. Approve/deny via notification or tray menu.
3. Use permanent actions for trusted hardware you do not want to re-approve.

## Tray Menu

- Shows non-System device groups with topology tree rendering.
- Each group has actions:
  - `Allow once`
  - `Allow permanent`
  - `Block once`
  - `Block permanent`
- Selected state is shown with a checkmark when group state is consistent.

## Preferences (`gnome-extensions prefs usbguard-prompt@blacksheeep`)

- `Connected Devices`: currently active non-permanent devices, current status,
  quick change actions.
- `Permanent Rules`: current persistent USBGuard rules, with change/remove.
- `System-Devices`: trusted baseline category with same management controls.
- `Set baseline`: marks currently connected devices as System-Devices and
  applies permanent allow.
- Tray settings:
  - enable/disable tray icon
  - optionally disable notifications when tray icon is enabled

## Install

## Prerequisites

- GNOME Shell `49`
- USBGuard service running with D-Bus enabled
- User authorized to call USBGuard policy methods

## Quick Install From Repo

```bash
./scripts/install-extension.sh
gnome-extensions enable usbguard-prompt@blacksheeep
```

## Install With Nix Flake App

```bash
nix run "path:$PWD#install"
gnome-extensions enable usbguard-prompt@blacksheeep
```

If GNOME Shell does not pick up changes immediately, restart GNOME Shell or
log out/in.

## NixOS USBGuard Example

```nix
services.usbguard = {
  enable = true;
  dbus.enable = true;

  presentDevicePolicy = "allow";
  insertedDevicePolicy = "apply-policy";

  IPCAllowedUsers = [ "root" "your-user" ];
  IPCAllowedGroups = [ "wheel" ];

  rules = null;
  ruleFile = "/var/lib/usbguard/rules.conf";
};
```

Notes:

- `presentDevicePolicy = "allow"` keeps devices already connected at startup
  usable.
- `insertedDevicePolicy = "apply-policy"` means new inserts require matching
  rules or interactive decisions.
- This extension does not hardcode immutable USBGuard rules. It manages policy
  through USBGuard APIs and your rule file.

## Build And Release

## Build Extension Package

```bash
nix build "path:$PWD#default"
```

This builds an installable extension derivation into the Nix store.

## Build Release Zip

```bash
nix run "path:$PWD#release-zip"
```

What this does:

- resolves packaging dependencies via Nix
- packages extension files from `extension/`
- writes release zip to `build/<uuid>-v<metadata.version>.zip`
- removes older zip files for the same UUID in `build/`
- uses temporary directories and cleans up automatically

This zip is suitable for GNOME extension distribution workflows.

## Development

Enter dev shell:

```bash
nix develop "path:$PWD"
```

Useful commands:

```bash
gnome-extensions prefs usbguard-prompt@blacksheeep
journalctl --user -f | rg usbguard-prompt
```

## Project Structure

- `extension/extension.js`: runtime logic (D-Bus events, prompt/tray actions,
  grouping, policy application)
- `extension/prefs.js`: preferences UI and policy/rule management
- `extension/metadata.json`: extension metadata
- `scripts/install-extension.sh`: local installer
- `scripts/release-zip.sh`: release zip builder
- `flake.nix`: Nix flake outputs (`default`, `install`, `release-zip`, dev
  shell)

## License

GNU GPL v3.0 (`GPL-3.0-only`)
