import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const USBGUARD_BACKENDS = [
    {
        busName: 'org.usbguard1',
        devicesInterface: 'org.usbguard.Devices1',
        signalObjectPath: '/org/usbguard1/Devices',
        methodObjectPaths: ['/org/usbguard1/Devices'],
    },
    {
        busName: 'org.usbguard',
        devicesInterface: 'org.usbguard.Devices',
        signalObjectPath: '/org/usbguard/Devices',
        methodObjectPaths: ['/org/usbguard', '/org/usbguard/Devices'],
    },
];
const SCREENSAVER_BUS_NAME = 'org.gnome.ScreenSaver';
const SCREENSAVER_INTERFACE = 'org.gnome.ScreenSaver';
const SCREENSAVER_OBJECT_PATH = '/org/gnome/ScreenSaver';

const INSERT_EVENT = 1;
const HUB_PROMPT_DEBOUNCE_MS = 1200;
const REPEAT_INSERT_SUPPRESS_USEC = 3 * 1000 * 1000;
const DBUS_CALL_TIMEOUT_MS = 2500;

const PolicyTarget = {
    ALLOW: 0,
    BLOCK: 1,
};

function logInfo(message) {
    log(`[usbguard-prompt] ${message}`);
}

function logException(error, message) {
    logError(error, `[usbguard-prompt] ${message}`);
}

function createSource() {
    try {
        return new MessageTray.Source({
            title: 'USBGuard',
            iconName: 'drive-removable-media-usb-symbolic',
        });
    } catch (error) {
        return new MessageTray.Source('USBGuard', 'drive-removable-media-usb-symbolic');
    }
}

function createNotification(source, title, body) {
    try {
        return new MessageTray.Notification({
            source,
            title,
            body,
            isTransient: false,
        });
    } catch (error) {
        const notification = new MessageTray.Notification(source, title, body);
        if (typeof notification.setTransient === 'function')
            notification.setTransient(false);
        return notification;
    }
}

class UsbGuardPromptRuntime {
    enable() {
        this._source = createSource();
        Main.messageTray.add(this._source);

        this._bus = null;
        this._usbguardBackend = null;
        this._sessionBus = null;
        this._signalSubscriptionId = 0;
        this._screenSignalSubscriptionId = 0;
        this._screenLocked = false;
        this._pendingPromptGroups = new Map();
        this._recentInsertions = new Map();
        this._pendingLockedDevices = new Map();

        try {
            this._bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        } catch (error) {
            logException(error, 'Failed to connect to the system bus');
            Main.notifyError('USBGuard Prompt', 'Cannot connect to the system D-Bus.');
            return;
        }

        this._usbguardBackend = this._detectUsbguardBackend();
        if (!this._usbguardBackend) {
            Main.notifyError(
                'USBGuard Prompt',
                'USBGuard D-Bus service not found (expected org.usbguard1 or org.usbguard).'
            );
            return;
        }

        this._signalSubscriptionId = this._bus.signal_subscribe(
            this._usbguardBackend.busName,
            this._usbguardBackend.devicesInterface,
            'DevicePresenceChanged',
            this._usbguardBackend.signalObjectPath,
            null,
            Gio.DBusSignalFlags.NONE,
            this._onDevicePresenceChanged.bind(this)
        );

        this._setupScreenLockTracking();

        logInfo('Extension enabled');
    }

    disable() {
        if (this._signalSubscriptionId > 0 && this._bus) {
            this._bus.signal_unsubscribe(this._signalSubscriptionId);
            this._signalSubscriptionId = 0;
        }

        if (this._screenSignalSubscriptionId > 0 && this._sessionBus) {
            this._sessionBus.signal_unsubscribe(this._screenSignalSubscriptionId);
            this._screenSignalSubscriptionId = 0;
        }

        for (const group of this._pendingPromptGroups.values()) {
            if (group.timerId > 0)
                GLib.source_remove(group.timerId);
        }
        this._pendingPromptGroups.clear();
        this._recentInsertions.clear();
        this._pendingLockedDevices.clear();

        if (this._source) {
            this._source.destroy();
            this._source = null;
        }

        this._bus = null;
        this._usbguardBackend = null;
        this._sessionBus = null;
        logInfo('Extension disabled');
    }

    _onDevicePresenceChanged(_connection, _sender, _path, _interfaceName, _signalName, parameters) {
        const [id, event, _target, deviceRule, attributes] = parameters.deepUnpack();
        if (event !== INSERT_EVENT)
            return;

        const device = this._buildDeviceContext(id, deviceRule, attributes);
        if (this._shouldSuppressRepeatedInsert(device))
            return;

        if (this._screenLocked) {
            void this._handleInsertWhileLocked(device);
            return;
        }

        this._queuePrompt(device);
    }

    _detectUsbguardBackend() {
        for (const backend of USBGUARD_BACKENDS) {
            if (this._hasBusOwner(backend.busName))
                return backend;
        }
        return null;
    }

    _hasBusOwner(busName) {
        try {
            const response = this._bus.call_sync(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'NameHasOwner',
                new GLib.Variant('(s)', [busName]),
                new GLib.VariantType('(b)'),
                Gio.DBusCallFlags.NONE,
                DBUS_CALL_TIMEOUT_MS,
                null
            );
            const [hasOwner] = response.deepUnpack();
            return Boolean(hasOwner);
        } catch (error) {
            logException(error, `Failed to query D-Bus owner for ${busName}`);
            return false;
        }
    }

    _setupScreenLockTracking() {
        try {
            this._sessionBus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        } catch (error) {
            logException(error, 'Failed to connect to session bus for lock tracking');
            return;
        }

        this._screenLocked = this._readScreenLockedState();
        this._screenSignalSubscriptionId = this._sessionBus.signal_subscribe(
            SCREENSAVER_BUS_NAME,
            SCREENSAVER_INTERFACE,
            'ActiveChanged',
            SCREENSAVER_OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            this._onScreenActiveChanged.bind(this)
        );
    }

    _readScreenLockedState() {
        if (!this._sessionBus)
            return false;

        try {
            const result = this._sessionBus.call_sync(
                SCREENSAVER_BUS_NAME,
                SCREENSAVER_OBJECT_PATH,
                SCREENSAVER_INTERFACE,
                'GetActive',
                null,
                new GLib.VariantType('(b)'),
                Gio.DBusCallFlags.NONE,
                DBUS_CALL_TIMEOUT_MS,
                null
            );
            const [active] = result.deepUnpack();
            return Boolean(active);
        } catch (error) {
            logException(error, 'Failed to read current lock state');
            return false;
        }
    }

    _onScreenActiveChanged(_connection, _sender, _path, _interfaceName, _signalName, parameters) {
        const [isActive] = parameters.deepUnpack();
        this._setScreenLocked(Boolean(isActive));
    }

    _setScreenLocked(locked) {
        if (this._screenLocked === locked)
            return;

        this._screenLocked = locked;
        logInfo(`Screen lock state changed: ${locked ? 'locked' : 'unlocked'}`);

        if (locked)
            return;

        if (this._pendingLockedDevices.size === 0)
            return;

        const devices = [...this._pendingLockedDevices.values()];
        this._pendingLockedDevices.clear();
        for (const device of devices)
            this._queuePrompt(device);

        Main.notify(
            'USBGuard Prompt',
            `${devices.length} USB device(s) were blocked while locked and now need approval.`
        );
    }

    _buildDeviceContext(id, deviceRule, attributes) {
        const attrs = attributes ?? {};
        const deviceName = attrs.name?.trim() || this._extractNameFromRule(deviceRule) || 'Unknown USB device';
        const hash = attrs.hash?.trim() || `id-${id}`;
        const parentHash = attrs['parent-hash']?.trim() || '';
        const interfaceDescriptor = attrs['with-interface']?.trim() || '';
        const viaPort = attrs['via-port']?.trim() || '';

        return {
            id,
            hash,
            parentHash,
            viaPort,
            name: deviceName,
            rule: deviceRule,
            isHub: this._looksLikeUsbHub(deviceName, interfaceDescriptor, deviceRule),
        };
    }

    _extractNameFromRule(deviceRule) {
        if (typeof deviceRule !== 'string')
            return null;

        const match = deviceRule.match(/name\s+"([^"]+)"/);
        return match ? match[1] : null;
    }

    _looksLikeUsbHub(deviceName, interfaceDescriptor, deviceRule) {
        const haystack = `${deviceName} ${interfaceDescriptor} ${deviceRule}`.toLowerCase();
        if (haystack.includes('hub'))
            return true;

        // USB class 09 is hub. The "with-interface" value may include 09:*:*.
        return /(^|[^0-9a-f])09:[0-9a-f]{2}:[0-9a-f]{2}([^0-9a-f]|$)/.test(haystack);
    }

    _shouldSuppressRepeatedInsert(device) {
        const now = GLib.get_monotonic_time();
        const lastSeen = this._recentInsertions.get(device.hash);
        this._recentInsertions.set(device.hash, now);

        const staleCutoff = now - REPEAT_INSERT_SUPPRESS_USEC * 4;
        for (const [hash, seenAt] of this._recentInsertions.entries()) {
            if (seenAt < staleCutoff)
                this._recentInsertions.delete(hash);
        }

        return lastSeen !== undefined && now - lastSeen < REPEAT_INSERT_SUPPRESS_USEC;
    }

    _groupKeyForDevice(device) {
        if (device.isHub)
            return `hub:${device.hash}`;
        return `device:${device.hash}`;
    }

    _queuePrompt(device) {
        const groupKey = this._groupKeyForDevice(device);
        let group = this._pendingPromptGroups.get(groupKey);
        if (!group) {
            group = {
                timerId: 0,
                devicesByHash: new Map(),
            };

            group.timerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                HUB_PROMPT_DEBOUNCE_MS,
                () => {
                    this._pendingPromptGroups.delete(groupKey);
                    group.timerId = 0;
                    this._showPromptForGroup(group);
                    return GLib.SOURCE_REMOVE;
                }
            );

            this._pendingPromptGroups.set(groupKey, group);
        }

        group.devicesByHash.set(device.hash, device);
    }

    _showPromptForGroup(group) {
        const devices = [...group.devicesByHash.values()];
        if (devices.length === 0)
            return;

        if (this._screenLocked) {
            for (const device of devices)
                void this._handleInsertWhileLocked(device);
            return;
        }

        const title = this._buildPromptTitle(devices);
        const body = this._buildPromptBody(devices);
        const notification = createNotification(this._source, title, body);

        if (typeof notification.setUrgency === 'function')
            notification.setUrgency(MessageTray.Urgency.HIGH);

        const addAction = (label, handler) => {
            if (typeof notification.addAction === 'function') {
                notification.addAction(label, handler);
            } else {
                logInfo(`Notification backend has no action support, ignoring "${label}"`);
            }
        };

        addAction('Block once', () => {
            void this._applyDecision(devices, PolicyTarget.BLOCK, false);
        });
        addAction('Block permanently', () => {
            void this._applyDecision(devices, PolicyTarget.BLOCK, true);
        });
        addAction('Allow once', () => {
            void this._applyDecision(devices, PolicyTarget.ALLOW, false);
        });
        addAction('Allow always', () => {
            void this._applyDecision(devices, PolicyTarget.ALLOW, true);
        });

        this._source.addNotification(notification);
    }

    async _handleInsertWhileLocked(device) {
        this._pendingLockedDevices.set(device.hash, device);

        try {
            await this._applyDevicePolicy(device.id, PolicyTarget.BLOCK, false);
        } catch (error) {
            logException(error, `Failed to block inserted device while locked (${device.name})`);
            Main.notifyError(
                'USBGuard lock-screen policy failed',
                `Could not temporarily block ${device.name} while screen was locked.`
            );
        }
    }

    _buildPromptTitle(devices) {
        if (devices.length === 1) {
            return devices[0].isHub ? 'USB hub connected' : 'USB device connected';
        }

        const hasHub = devices.some(device => device.isHub);
        if (hasHub)
            return `USB hub event (${devices.length} devices)`;
        return `${devices.length} USB devices connected`;
    }

    _buildPromptBody(devices) {
        if (devices.length === 1) {
            const [device] = devices;
            return `${device.name}\nChoose how this device should be handled.`;
        }

        const names = devices.map(device => device.name);
        const preview = names.slice(0, 3).join(', ');
        const moreCount = Math.max(0, devices.length - 3);
        const suffix = moreCount > 0 ? ` (+${moreCount} more)` : '';
        return `${preview}${suffix}\nChoose how these devices should be handled.`;
    }

    async _applyDecision(devices, target, permanent) {
        const failures = [];
        for (const device of devices) {
            try {
                await this._applyDevicePolicy(device.id, target, permanent);
            } catch (error) {
                failures.push(device.name);
                logException(error, `Failed to apply policy for ${device.name}`);
            }
        }

        if (failures.length === 0)
            return;

        Main.notifyError(
            'USBGuard policy update failed',
            `Could not update: ${failures.join(', ')}`
        );
    }

    async _applyDevicePolicy(deviceId, target, permanent) {
        if (!this._usbguardBackend)
            throw new Error('USBGuard backend not initialized');

        const args = new GLib.Variant('(uub)', [deviceId, target, permanent]);
        const replyType = new GLib.VariantType('(u)');

        let lastError = null;
        for (const objectPath of this._usbguardBackend.methodObjectPaths) {
            try {
                await this._callUsbguardMethod(objectPath, 'applyDevicePolicy', args, replyType);
                return;
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError ?? new Error('USBGuard call failed');
    }

    _callUsbguardMethod(objectPath, methodName, parameters, replyType) {
        return new Promise((resolve, reject) => {
            this._bus.call(
                this._usbguardBackend.busName,
                objectPath,
                this._usbguardBackend.devicesInterface,
                methodName,
                parameters,
                replyType,
                Gio.DBusCallFlags.NONE,
                DBUS_CALL_TIMEOUT_MS,
                null,
                (connection, result) => {
                    try {
                        resolve(connection.call_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }
}

export default class UsbGuardPromptEntryPoint extends Extension {
    enable() {
        this._impl = new UsbGuardPromptRuntime();
        this._impl.enable();
    }

    disable() {
        if (!this._impl)
            return;

        this._impl.disable();
        this._impl = null;
    }
}

