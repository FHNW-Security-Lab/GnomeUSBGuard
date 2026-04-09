# GnomeUSBGuard

GNOME Shell extension for USBGuard that gives interactive USB authorization with
good hub behavior and practical policy management.

Supported GNOME Shell versions: `49`, `50`  
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

- GNOME Shell `49` or `50`
- USBGuard service running with D-Bus enabled
- User authorized to call USBGuard policy methods

## Quick Install From Repo

```bash
./scripts/install-extension.sh
gnome-extensions enable usbguard-prompt@blacksheeep
```

## Install On Arch With `paru`

Install the required packages first:

```bash
sudo pacman -S --needed base-devel gnome-shell usbguard
```

Notes:

- The `paru -Bi ...` command below assumes you already have `paru` installed.
- `base-devel` is required so `paru` can build the local package.
- `gnome-shell` provides the GNOME extension runtime and CLI tooling.
- `usbguard` provides the daemon and D-Bus API this extension talks to.

Then build and install the package from this repository:

```bash
paru -Bi packaging/arch
```

Then log out and back in so GNOME Shell sees the new system extension, and
enable it:

```bash
gnome-extensions enable usbguard-prompt@blacksheeep
```

This installs the extension system-wide to:

```text
/usr/share/gnome-shell/extensions/usbguard-prompt@blacksheeep
```

## Arch Linux USBGuard Example

Edit `/etc/usbguard/usbguard-daemon.conf` like this:

```ini
RuleFile=/etc/usbguard/rules.conf

PresentDevicePolicy=allow
InsertedDevicePolicy=apply-policy

IPCAllowedUsers=root your-user
IPCAllowedGroups=wheel
```

Make sure the rule file exists, then enable the daemon:

```bash
sudo touch /etc/usbguard/rules.conf
sudo chmod 0600 /etc/usbguard/rules.conf
sudo systemctl enable --now usbguard.service usbguard-dbus.service
```

If the services are already running, restart them after changing the config:

```bash
sudo systemctl restart usbguard.service usbguard-dbus.service
```

Notes:

- Replace `your-user` with your actual login name.
- `PresentDevicePolicy=allow` keeps devices that are already connected when
  `usbguard.service` starts usable, so your keyboard and mouse are not blocked
  at boot or daemon start.
- `InsertedDevicePolicy=apply-policy` keeps newly inserted devices under
  USBGuard policy so this extension can prompt for them.
- `RuleFile=/etc/usbguard/rules.conf` gives USBGuard a writable persistent rule
  file for permanent allow/block decisions made through the extension.
- `usbguard-dbus.service` publishes `org.usbguard1` on the system bus. If it is
  not running, the extension will fail with `USBGuard D-Bus service not found`.
- On Arch, `org.usbguard1` protects write actions such as allow/block,
  `Set Baseline`, and permanent rule changes with polkit. The extension can use
  the normal polkit authentication dialog for these actions.

If you want NixOS-like passwordless local access for members of `wheel`, add a
polkit rule like this:

```javascript
polkit.addRule(function(action, subject) {
  if (!subject.active || !subject.local || !subject.isInGroup("wheel"))
    return null;

  if ([
    "org.usbguard.Devices1.applyDevicePolicy",
    "org.usbguard.Policy1.appendRule",
    "org.usbguard.Policy1.removeRule",
  ].includes(action.id)) {
    return polkit.Result.YES;
  }

  return null;
});
```

Save it as `/etc/polkit-1/rules.d/49-usbguard.rules`.

If the extension still shows `Initialization failed`, check:

```bash
sudo systemctl status usbguard.service usbguard-dbus.service
sudo journalctl -u usbguard.service -u usbguard-dbus.service -b --no-pager
busctl --system list | rg usbguard
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
