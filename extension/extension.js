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
const HUB_PROMPT_DEBOUNCE_MS = 4200;
const DEVICE_PROMPT_DEBOUNCE_MS = 1200;
const BURST_MAX_WINDOW_MS = 12000;
const PENDING_DECISION_MERGE_WINDOW_MS = 4500;
const DUPLICATE_INSERT_SUPPRESS_USEC = 900 * 1000;
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
        this._pendingDecisionGroups = new Map();
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
        this._pendingDecisionGroups.clear();
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

        const groupKey = this._groupKeyForDevice(device);
        const pendingDecision = this._findPendingDecisionContext(device, groupKey);
        if (pendingDecision) {
            pendingDecision.devicesByHash.set(device.hash, device);
            return;
        }

        this._queuePrompt(device, groupKey);
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
        const usbId = attrs.id?.trim() || '';
        const serial = attrs.serial?.trim() || '';

        return {
            id,
            hash,
            parentHash,
            viaPort,
            usbId,
            serial,
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
        const insertKey = `${device.hash}|${device.viaPort || ''}|${device.id}`;
        const lastSeen = this._recentInsertions.get(insertKey);
        this._recentInsertions.set(insertKey, now);

        const staleCutoff = now - DUPLICATE_INSERT_SUPPRESS_USEC * 6;
        for (const [key, seenAt] of this._recentInsertions.entries()) {
            if (seenAt < staleCutoff)
                this._recentInsertions.delete(key);
        }

        return lastSeen !== undefined && now - lastSeen < DUPLICATE_INSERT_SUPPRESS_USEC;
    }

    _extractPortPath(viaPort) {
        if (!viaPort)
            return '';

        // "3-1.4.2" -> "1.4.2"
        const match = viaPort.match(/^\d+-(.+)$/);
        return match ? match[1] : viaPort;
    }

    _isPathAncestorOrSame(pathA, pathB) {
        if (!pathA || !pathB)
            return false;
        if (pathA === pathB)
            return true;

        return pathA.startsWith(`${pathB}.`) || pathB.startsWith(`${pathA}.`);
    }

    _areDevicesTopologyRelated(deviceA, deviceB) {
        const pathA = this._extractPortPath(deviceA.viaPort);
        const pathB = this._extractPortPath(deviceB.viaPort);
        if (this._isPathAncestorOrSame(pathA, pathB))
            return true;

        if (deviceA.parentHash && (deviceA.parentHash === deviceB.hash || deviceA.parentHash === deviceB.parentHash))
            return true;

        if (deviceB.parentHash && (deviceB.parentHash === deviceA.hash || deviceB.parentHash === deviceA.parentHash))
            return true;

        // Some USB2/USB3 companion entries do not expose parent relationships.
        if (deviceA.usbId && deviceA.usbId === deviceB.usbId && (deviceA.isHub || deviceB.isHub)) {
            if (deviceA.serial && deviceB.serial)
                return deviceA.serial === deviceB.serial;

            return deviceA.name === deviceB.name;
        }

        return false;
    }

    _shouldMergeWithDevices(device, devicesByHash) {
        for (const existing of devicesByHash.values()) {
            if (this._areDevicesTopologyRelated(device, existing))
                return true;
        }

        return false;
    }

    _groupKeyForDevice(device) {
        // Use full bus-independent topology path as primary key.
        // Example: "3-1.4.2" and "4-1.4.2" both map to "port:1.4.2".
        const portPath = this._extractPortPath(device.viaPort);
        if (portPath)
            return `port:${portPath}`;

        if (device.parentHash)
            return `parent:${device.parentHash}`;

        if (device.usbId)
            return `usbid:${device.usbId}`;

        return `device:${device.hash}`;
    }

    _isPendingDecisionContextActive(context, nowUsec) {
        if (!context || context.resolved)
            return false;

        return nowUsec - context.createdAtUsec <= PENDING_DECISION_MERGE_WINDOW_MS * 1000;
    }

    _shouldMergeIntoPendingContext(device, context) {
        return this._shouldMergeWithDevices(device, context.devicesByHash);
    }

    _findPendingDecisionContext(device, groupKey) {
        const now = GLib.get_monotonic_time();
        const direct = this._pendingDecisionGroups.get(groupKey);
        if (this._isPendingDecisionContextActive(direct, now))
            return direct;
        if (direct)
            this._pendingDecisionGroups.delete(groupKey);

        for (const [key, context] of this._pendingDecisionGroups.entries()) {
            if (!this._isPendingDecisionContextActive(context, now)) {
                this._pendingDecisionGroups.delete(key);
                continue;
            }

            if (this._shouldMergeIntoPendingContext(device, context))
                return context;
        }

        return null;
    }

    _findPendingPromptGroup(device, preferredKey, nowUsec) {
        const direct = this._pendingPromptGroups.get(preferredKey);
        if (direct) {
            if (nowUsec - direct.createdAtUsec <= BURST_MAX_WINDOW_MS * 1000)
                return [preferredKey, direct];

            this._flushGroup(preferredKey, direct);
        }

        for (const [key, group] of this._pendingPromptGroups.entries()) {
            if (nowUsec - group.createdAtUsec > BURST_MAX_WINDOW_MS * 1000) {
                this._flushGroup(key, group);
                continue;
            }

            if (this._shouldMergeWithDevices(device, group.devicesByHash))
                return [key, group];
        }

        return [preferredKey, null];
    }

    _scheduleGroupTimer(groupKey, group) {
        if (group.timerId > 0)
            GLib.source_remove(group.timerId);

        const now = GLib.get_monotonic_time();
        const elapsedMs = Math.floor((now - group.createdAtUsec) / 1000);
        const remainingMs = BURST_MAX_WINDOW_MS - elapsedMs;
        if (remainingMs <= 0) {
            this._flushGroup(groupKey, group);
            return;
        }

        const debounceMs = group.hasHub ? HUB_PROMPT_DEBOUNCE_MS : DEVICE_PROMPT_DEBOUNCE_MS;
        const delayMs = Math.max(50, Math.min(debounceMs, remainingMs));
        group.timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delayMs,
            () => {
                group.timerId = 0;
                this._flushGroup(groupKey, group, false);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _flushGroup(groupKey, group, removeTimer = true) {
        const current = this._pendingPromptGroups.get(groupKey);
        if (current !== group)
            return;

        this._pendingPromptGroups.delete(groupKey);
        if (removeTimer && group.timerId > 0) {
            GLib.source_remove(group.timerId);
            group.timerId = 0;
        }

        this._showPromptForGroup(group);
    }

    _queuePrompt(device, groupKey = null) {
        const preferredKey = groupKey ?? this._groupKeyForDevice(device);
        const now = GLib.get_monotonic_time();
        let [key, group] = this._findPendingPromptGroup(device, preferredKey, now);

        if (!group) {
            group = {
                timerId: 0,
                groupKey: key,
                createdAtUsec: now,
                devicesByHash: new Map(),
                hasHub: false,
            };
            this._pendingPromptGroups.set(key, group);
        }

        group.devicesByHash.set(device.hash, device);
        group.hasHub = group.hasHub || device.isHub;
        this._scheduleGroupTimer(key, group);
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
        const decisionContext = {
            groupKey: group.groupKey,
            devicesByHash: new Map(group.devicesByHash),
            createdAtUsec: GLib.get_monotonic_time(),
            resolved: false,
        };
        this._pendingDecisionGroups.set(group.groupKey, decisionContext);

        if (typeof notification.setUrgency === 'function')
            notification.setUrgency(MessageTray.Urgency.HIGH);

        if (typeof notification.connect === 'function') {
            notification.connect('destroy', () => {
                const active = this._pendingDecisionGroups.get(group.groupKey);
                if (active === decisionContext && !decisionContext.resolved)
                    this._pendingDecisionGroups.delete(group.groupKey);
            });
        }

        const addAction = (label, handler) => {
            if (typeof notification.addAction === 'function') {
                notification.addAction(label, handler);
            } else {
                logInfo(`Notification backend has no action support, ignoring "${label}"`);
            }
        };

        addAction('Block once', () => {
            void this._applyDecisionFromContext(decisionContext, PolicyTarget.BLOCK, false);
        });
        addAction('Allow once', () => {
            void this._applyDecisionFromContext(decisionContext, PolicyTarget.ALLOW, false);
        });
        addAction('Allow always', () => {
            void this._applyDecisionFromContext(decisionContext, PolicyTarget.ALLOW, true);
        });

        this._source.addNotification(notification);
    }

    async _applyDecisionFromContext(context, target, permanent) {
        context.resolved = true;
        this._pendingDecisionGroups.delete(context.groupKey);
        const devices = [...context.devicesByHash.values()];
        await this._applyDecision(devices, target, permanent);
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

        if (failures.length === 0) {
            return;
        }

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
