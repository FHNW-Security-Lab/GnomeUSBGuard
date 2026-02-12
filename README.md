# GNOME USBGuard Prompt Extension (GNOME 49)

This repository contains a GNOME Shell extension that listens to USBGuard over
system D-Bus and prompts when USB devices are inserted.

Each prompt provides:

- `Block once`
- `Allow once`
- `Allow always`

The action buttons map to `org.usbguard.Devices.applyDevicePolicy(...)`.

## Behavior

- The extension subscribes to `DevicePresenceChanged` on `org.usbguard.Devices`.
- It auto-detects both USBGuard D-Bus variants (`org.usbguard1` and legacy
  `org.usbguard`).
- It only reacts to `Insert` events.
- For hubs, notifications are de-duplicated so a single hub insertion does not
  flood you with many prompts.
- Companion USB2/USB3 function devices from one physical plug event (for
  example hub + card reader functions) are grouped into one prompt burst.
- Grouping is time-window based; later devices added to the same hub are
  prompted again.
- Devices connected through the hub later are prompted again as separate
  devices.
- If the screen is locked, newly inserted devices are immediately **blocked once**
  and queued; after unlock, you get approval prompts for those queued devices.

## Project Layout

- `extension/metadata.json`: GNOME extension metadata (`shell-version = 49`)
- `extension/extension.js`: USBGuard D-Bus listener + notification actions
- `extension/prefs.js`: Preferences UI for editing/removing device rules
- `flake.nix`: Nix flake (package + dev shell + install app)
- `scripts/install-extension.sh`: local install helper

## Nix / Build

Build package:

```bash
nix build "path:$PWD#default"
```

Enter development shell:

```bash
nix develop "path:$PWD"
```

## Install

Install from repo checkout:

```bash
./scripts/install-extension.sh
```

Or install from flake source:

```bash
nix run "path:$PWD#install"
```

Enable extension:

```bash
gnome-extensions enable usbguard-prompt@blacksheeep
```

On Wayland, log out and back in if GNOME Shell does not pick up the extension
immediately.

Open preferences UI:

```bash
gnome-extensions prefs usbguard-prompt@blacksheeep
```

In preferences you can:

- change policy for connected devices (`Allow once`, `Allow always`, `Block once`, `Block permanent`)
- reset matching permanent rules for a device (`Reset rules`)
- edit permanent rules (`Allow`, `Block`, `Reject`)
- delete permanent rules

## NixOS Notes

1. Enable USBGuard (`services.usbguard.enable = true;`).
2. Ensure your desktop user is authorized to call USBGuard D-Bus policy
   methods, otherwise actions may fail with permission errors.
3. Set your USBGuard default policy to block/reject unknown devices if you want
   explicit prompts for every new insertion.

## Debugging

Follow shell logs:

```bash
journalctl --user -f | rg usbguard-prompt
```

Manual D-Bus sanity check:

```bash
busctl --system call org.usbguard /org/usbguard org.usbguard.Devices listDevices s "match"
```

## License

This project is licensed under GNU GPL v3.0 (`GPL-3.0-only`).

