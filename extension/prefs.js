import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const USBGUARD_BACKENDS = [
    {
        busName: 'org.usbguard1',
        devicesInterface: 'org.usbguard.Devices1',
        policyInterface: 'org.usbguard.Policy1',
        devicePaths: ['/org/usbguard1/Devices'],
        policyPaths: ['/org/usbguard1/Policy'],
        appendRuleHasTemporary: true,
    },
    {
        busName: 'org.usbguard',
        devicesInterface: 'org.usbguard.Devices',
        policyInterface: 'org.usbguard.Policy',
        devicePaths: ['/org/usbguard', '/org/usbguard/Devices'],
        policyPaths: ['/org/usbguard/Devices', '/org/usbguard'],
        appendRuleHasTemporary: false,
    },
];

const TARGET_NAME_TO_NUMERIC = {
    allow: 0,
    block: 1,
    reject: 2,
};
const SETTINGS_FILENAME = 'settings.json';
const SYSTEM_DEVICES_FILENAME = 'system-devices.json';

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractQuotedField(ruleText, fieldName) {
    const escapedField = escapeRegex(fieldName);
    const pattern = new RegExp(`\\b${escapedField}\\s+"([^"]+)"`, 'i');
    const match = String(ruleText ?? '').match(pattern);
    return match ? match[1] : '';
}

function parseRuleText(ruleText) {
    const rawText = String(ruleText ?? '');
    const targetMatch = rawText.trim().match(/^(allow|block|reject)\b/i);

    const target = targetMatch ? targetMatch[1].toLowerCase() : 'unknown';
    const name = extractQuotedField(rawText, 'name');
    const hash = extractQuotedField(rawText, 'hash');
    const parentHash = extractQuotedField(rawText, 'parent-hash');
    const serial = extractQuotedField(rawText, 'serial');
    const interfaceDescriptor = extractQuotedField(rawText, 'with-interface');
    const viaPort = extractQuotedField(rawText, 'via-port');

    const idMatch = rawText.match(/\bid\s+([0-9a-f]{4}:[0-9a-f]{4})\b/i);
    const usbId = idMatch ? idMatch[1] : '';

    return {
        rawText,
        target,
        name,
        hash,
        parentHash,
        serial,
        interfaceDescriptor,
        viaPort,
        usbId,
    };
}

function rewriteRuleTarget(ruleText, newTarget) {
    if (/^\s*(allow|block|reject)\b/i.test(ruleText))
        return ruleText.replace(/^\s*(allow|block|reject)\b/i, newTarget);
    return `${newTarget} ${ruleText}`.trim();
}

function compactValue(text, keepHead = 10, keepTail = 8) {
    const value = String(text ?? '');
    if (!value)
        return '';

    const minLength = keepHead + keepTail + 3;
    if (value.length <= minLength)
        return value;

    return `${value.slice(0, keepHead)}...${value.slice(-keepTail)}`;
}

function formatDbusError(error) {
    if (error?.message)
        return error.message;
    return String(error);
}

class USBGuardClient {
    constructor() {
        this._bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        this._backend = this._detectBackend();
        if (!this._backend) {
            throw new Error('USBGuard D-Bus service not found (expected org.usbguard1 or org.usbguard)');
        }
    }

    async listDevices() {
        const response = await this._callMethod(
            this._backend.devicePaths,
            this._backend.devicesInterface,
            'listDevices',
            new GLib.Variant('(s)', ['match']),
            new GLib.VariantType('(a(us))')
        );
        const [devices] = response.deepUnpack();
        return devices ?? [];
    }

    async applyDevicePolicy(deviceId, targetName, permanent) {
        const target = TARGET_NAME_TO_NUMERIC[targetName];
        if (target === undefined)
            throw new Error(`Unsupported target "${targetName}"`);

        await this._callMethod(
            this._backend.devicePaths,
            this._backend.devicesInterface,
            'applyDevicePolicy',
            new GLib.Variant('(uub)', [deviceId, target, permanent]),
            new GLib.VariantType('(u)')
        );
    }

    async listRules() {
        const response = await this._callMethod(
            this._backend.policyPaths,
            this._backend.policyInterface,
            'listRules',
            new GLib.Variant('(s)', ['']),
            new GLib.VariantType('(a(us))')
        );
        const [rules] = response.deepUnpack();
        return rules ?? [];
    }

    async appendRule(ruleText, parentId = 0) {
        const parameters = this._backend.appendRuleHasTemporary
            ? new GLib.Variant('(sub)', [ruleText, parentId, false])
            : new GLib.Variant('(su)', [ruleText, parentId]);

        const response = await this._callMethod(
            this._backend.policyPaths,
            this._backend.policyInterface,
            'appendRule',
            parameters,
            new GLib.VariantType('(u)')
        );
        const [ruleId] = response.deepUnpack();
        return ruleId;
    }

    async removeRule(ruleId) {
        await this._callMethod(
            this._backend.policyPaths,
            this._backend.policyInterface,
            'removeRule',
            new GLib.Variant('(u)', [ruleId]),
            null
        );
    }

    _detectBackend() {
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
                3000,
                null
            );
            const [hasOwner] = response.deepUnpack();
            return Boolean(hasOwner);
        } catch (error) {
            logError(error, `[usbguard-prompt] Failed to query owner for ${busName}`);
            return false;
        }
    }

    async _callMethod(objectPaths, interfaceName, methodName, parameters, replyType) {
        let lastError = null;
        for (const objectPath of objectPaths) {
            try {
                return await this._callMethodOnce(objectPath, interfaceName, methodName, parameters, replyType);
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError ?? new Error(`Failed to call ${interfaceName}.${methodName}`);
    }

    _callMethodOnce(objectPath, interfaceName, methodName, parameters, replyType) {
        return new Promise((resolve, reject) => {
            this._bus.call(
                this._backend.busName,
                objectPath,
                interfaceName,
                methodName,
                parameters,
                replyType,
                Gio.DBusCallFlags.NONE,
                3000,
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

export default class UsbGuardPromptPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._actionWidgets = [];
        this._deviceRows = [];
        this._systemRuleRows = [];
        this._ruleRows = [];
        this._busy = false;
        this._systemDeviceKeys = new Set();
        this._runtimeSettings = this._loadRuntimeSettings();

        window.set_default_size(1100, 760);
        window.set_search_enabled(true);

        try {
            this._client = new USBGuardClient();
        } catch (error) {
            const page = new Adw.PreferencesPage({
                title: 'USBGuard',
                iconName: 'drive-removable-media-usb-symbolic',
            });
            const group = new Adw.PreferencesGroup({
                title: 'Initialization failed',
            });
            const row = new Adw.ActionRow({
                title: 'Cannot access system D-Bus',
                subtitle: formatDbusError(error),
            });
            group.add(row);
            page.add(group);
            window.add(page);
            return;
        }

        const page = new Adw.PreferencesPage({
            title: 'USBGuard',
            iconName: 'drive-removable-media-usb-symbolic',
        });

        const controlsGroup = new Adw.PreferencesGroup({
            title: 'Controls',
            description: 'Manage USBGuard device decisions and permanent policy rules.',
        });

        const refreshRow = new Adw.ActionRow({
            title: 'Reload USBGuard state',
            subtitle: 'Refresh connected devices and all permanent rules.',
        });
        this._refreshButton = new Gtk.Button({
            label: 'Refresh',
            valign: Gtk.Align.CENTER,
        });
        this._refreshButton.connect('clicked', () => {
            void this._runBusyTask(async () => {
                await this._refreshAll();
            });
        });
        refreshRow.add_suffix(this._refreshButton);
        controlsGroup.add(refreshRow);

        this._statusRow = new Adw.ActionRow({
            title: 'Status',
            subtitle: 'Loading USBGuard data...',
        });
        this._statusRow.activatable = false;
        controlsGroup.add(this._statusRow);

        this._trayIconRow = this._registerActionWidget(new Adw.SwitchRow({
            title: 'Enable tray icon',
            subtitle: 'Show non-System device groups in the top bar with quick allow/block actions.',
            active: Boolean(this._runtimeSettings.trayIconEnabled),
        }));
        this._trayIconRow.connect('notify::active', () => {
            if (!this._trayIconRow)
                return;

            void this._runBusyTask(async () => {
                this._runtimeSettings.trayIconEnabled = this._trayIconRow.get_active();
                this._saveRuntimeSettings();
                this._setStatus(`Tray icon ${this._runtimeSettings.trayIconEnabled ? 'enabled' : 'disabled'}.`);
            });
        });
        controlsGroup.add(this._trayIconRow);

        this._trayNotificationRow = this._registerActionWidget(new Adw.SwitchRow({
            title: 'Disable notifications when tray icon is enabled',
            subtitle: 'Use tray menu only (no USB approval notifications) while tray icon is active.',
            active: Boolean(this._runtimeSettings.disableNotificationsWhenTrayEnabled),
        }));
        this._trayNotificationRow.connect('notify::active', () => {
            if (!this._trayNotificationRow)
                return;

            void this._runBusyTask(async () => {
                this._runtimeSettings.disableNotificationsWhenTrayEnabled = this._trayNotificationRow.get_active();
                this._saveRuntimeSettings();
                this._setStatus(
                    this._runtimeSettings.disableNotificationsWhenTrayEnabled
                        ? 'Notifications are disabled while tray icon is enabled.'
                        : 'Notifications are enabled.'
                );
            });
        });
        controlsGroup.add(this._trayNotificationRow);

        this._devicesGroup = new Adw.PreferencesGroup({
            title: 'Connected Devices',
            description: 'Active devices without permanent rules. Shows current status and lets you change state.',
        });

        this._systemRulesGroup = new Adw.PreferencesGroup({
            title: 'System-Devices',
            description: 'Baseline trusted devices (permanent rules) with allow/block toggle and remove.',
        });

        this._rulesGroup = new Adw.PreferencesGroup({
            title: 'Permanent Rules',
            description: 'Devices/rules persisted in USBGuard policy with current status, change, and remove actions.',
        });

        this._baselineGroup = new Adw.PreferencesGroup({
            title: 'Baseline',
            description: 'Set all currently connected devices as allowed System-Devices.',
        });
        const baselineRow = new Adw.ActionRow({
            title: 'Set baseline from connected devices',
            subtitle: 'Creates/updates permanent allow policy and marks devices as System-Devices.',
        });
        this._setBaselineButton = this._registerActionButton(new Gtk.Button({
            label: 'Set Baseline',
            valign: Gtk.Align.CENTER,
        }));
        this._setBaselineButton.connect('clicked', () => {
            void this._runBusyTask(async () => {
                await this._setBaselineFromConnectedDevices();
                await this._refreshAll();
            });
        });
        baselineRow.add_suffix(this._setBaselineButton);
        this._baselineGroup.add(baselineRow);

        page.add(controlsGroup);
        page.add(this._devicesGroup);
        page.add(this._systemRulesGroup);
        page.add(this._rulesGroup);
        page.add(this._baselineGroup);
        window.add(page);

        void this._runBusyTask(async () => {
            await this._refreshAll();
        });
    }

    async _runBusyTask(task) {
        if (this._busy)
            return;

        this._setBusy(true);
        try {
            await task();
        } catch (error) {
            logError(error, '[usbguard-prompt] Preferences action failed');
            this._setStatus(`Error: ${formatDbusError(error)}`);
        } finally {
            this._setBusy(false);
        }
    }

    _setBusy(busy) {
        this._busy = busy;

        if (this._refreshButton)
            this._refreshButton.set_sensitive(!busy);

        for (const widget of this._actionWidgets)
            widget.set_sensitive(!busy);
    }

    _registerActionWidget(widget) {
        this._actionWidgets.push(widget);
        widget.set_sensitive(!this._busy);
        return widget;
    }

    _registerActionButton(button) {
        return this._registerActionWidget(button);
    }

    _clearGroupRows(group, rowsList) {
        for (const row of rowsList)
            group.remove(row);
        rowsList.length = 0;
    }

    _createChangeMenuButton(actions) {
        const menuButton = this._registerActionWidget(new Gtk.MenuButton({
            label: 'Change',
            valign: Gtk.Align.CENTER,
        }));

        const popover = new Gtk.Popover({
            hasArrow: true,
            autohide: true,
        });
        const list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8,
        });

        for (const action of actions) {
            const button = this._registerActionButton(new Gtk.Button({
                label: action.label,
                halign: Gtk.Align.FILL,
                hexpand: true,
            }));
            button.connect('clicked', () => {
                popover.popdown();
                void this._runBusyTask(async () => {
                    await action.run();
                    await this._refreshAll();
                });
            });
            list.append(button);
        }

        popover.set_child(list);
        menuButton.set_popover(popover);
        return menuButton;
    }

    _setStatus(message) {
        if (this._statusRow)
            this._statusRow.set_subtitle(message);
    }

    _settingsPath() {
        return GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'usbguard-prompt',
            SETTINGS_FILENAME,
        ]);
    }

    _loadRuntimeSettings() {
        const path = this._settingsPath();
        try {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                return {
                    trayIconEnabled: false,
                    disableNotificationsWhenTrayEnabled: false,
                };

            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok)
                return {
                    trayIconEnabled: false,
                    disableNotificationsWhenTrayEnabled: false,
                };

            const text = new TextDecoder().decode(contents);
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object')
                return {
                    trayIconEnabled: false,
                    disableNotificationsWhenTrayEnabled: false,
                };

            return {
                trayIconEnabled: Boolean(parsed.trayIconEnabled),
                disableNotificationsWhenTrayEnabled: Boolean(parsed.disableNotificationsWhenTrayEnabled),
            };
        } catch (error) {
            logError(error, '[usbguard-prompt] Failed to load runtime settings');
            return {
                trayIconEnabled: false,
                disableNotificationsWhenTrayEnabled: false,
            };
        }
    }

    _saveRuntimeSettings() {
        const path = this._settingsPath();
        const dir = GLib.path_get_dirname(path);
        try {
            let existing = {};
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                const [ok, contents] = GLib.file_get_contents(path);
                if (ok) {
                    const parsed = JSON.parse(new TextDecoder().decode(contents));
                    if (parsed && typeof parsed === 'object')
                        existing = parsed;
                }
            }

            GLib.mkdir_with_parents(dir, 0o700);
            const payload = JSON.stringify({
                ...existing,
                trayIconEnabled: Boolean(this._runtimeSettings?.trayIconEnabled),
                disableNotificationsWhenTrayEnabled: Boolean(
                    this._runtimeSettings?.disableNotificationsWhenTrayEnabled
                ),
            }, null, 2);
            GLib.file_set_contents(path, payload);
        } catch (error) {
            logError(error, '[usbguard-prompt] Failed to persist runtime settings');
            throw error;
        }
    }

    _systemDevicesPath() {
        return GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'usbguard-prompt',
            SYSTEM_DEVICES_FILENAME,
        ]);
    }

    _loadSystemDeviceKeys() {
        const path = this._systemDevicesPath();
        try {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                return new Set();

            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok)
                return new Set();

            const text = new TextDecoder().decode(contents);
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed))
                return new Set();

            return new Set(parsed.filter(key => typeof key === 'string' && key.length > 0));
        } catch (error) {
            logError(error, '[usbguard-prompt] Failed to load System-Devices metadata');
            return new Set();
        }
    }

    _saveSystemDeviceKeys() {
        const path = this._systemDevicesPath();
        const dir = GLib.path_get_dirname(path);
        try {
            GLib.mkdir_with_parents(dir, 0o700);
            const payload = JSON.stringify([...this._systemDeviceKeys].sort(), null, 2);
            GLib.file_set_contents(path, payload);
        } catch (error) {
            logError(error, '[usbguard-prompt] Failed to persist System-Devices metadata');
            throw error;
        }
    }

    _buildDeviceIdentityKey(parsedRule) {
        if (parsedRule.hash)
            return `hash:${parsedRule.hash}`;
        if (parsedRule.serial && parsedRule.usbId)
            return `id-serial:${parsedRule.usbId}|${parsedRule.serial}`;
        if (parsedRule.serial)
            return `serial:${parsedRule.serial}`;
        if (parsedRule.usbId && parsedRule.viaPort)
            return `id-port:${parsedRule.usbId}|${parsedRule.viaPort}`;
        if (parsedRule.usbId)
            return `usbid:${parsedRule.usbId}`;

        const normalizedRule = String(parsedRule.rawText ?? '')
            .replace(/^\s*(allow|block|reject)\b/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (normalizedRule)
            return `rule:${normalizedRule}`;

        return null;
    }

    async _setBaselineFromConnectedDevices() {
        const devices = await this._client.listDevices();
        if (devices.length === 0) {
            this._setStatus('No connected devices available for baseline.');
            return;
        }

        this._systemDeviceKeys = this._loadSystemDeviceKeys();
        let changedKeys = 0;
        let withoutKey = 0;

        for (const [deviceId, deviceRule] of devices) {
            const parsed = parseRuleText(deviceRule);
            await this._client.applyDevicePolicy(deviceId, 'allow', true);

            const identity = this._buildDeviceIdentityKey(parsed);
            if (!identity) {
                withoutKey++;
                continue;
            }

            if (!this._systemDeviceKeys.has(identity)) {
                this._systemDeviceKeys.add(identity);
                changedKeys++;
            }
        }

        this._saveSystemDeviceKeys();
        const total = devices.length;
        const suffix = withoutKey > 0 ? ` (${withoutKey} without stable identity key)` : '';
        this._setStatus(`Baseline applied for ${total} connected device(s); added ${changedKeys} System-Device key(s).${suffix}`);
    }

    async _refreshAll() {
        const [devices, rules] = await Promise.all([
            this._client.listDevices(),
            this._client.listRules(),
        ]);

        this._systemDeviceKeys = this._loadSystemDeviceKeys();

        const parsedDevices = devices.map(([deviceId, deviceRule]) => ({
            deviceId,
            deviceRule,
            parsed: parseRuleText(deviceRule),
        }));

        const permanentRuleMatchesByDeviceId = new Map();
        const connectedDevicesByRuleId = new Map();
        for (const device of parsedDevices) {
            const matches = this._findRulesMatchingDevice(rules, device.parsed);
            permanentRuleMatchesByDeviceId.set(device.deviceId, matches);
            for (const [ruleId] of matches) {
                if (!connectedDevicesByRuleId.has(ruleId))
                    connectedDevicesByRuleId.set(ruleId, []);
                connectedDevicesByRuleId.get(ruleId).push(device);
            }
        }

        const systemRules = [];
        const permanentRules = [];
        for (const [ruleId, ruleText] of rules) {
            const parsedRule = parseRuleText(ruleText);
            const identity = this._buildDeviceIdentityKey(parsedRule);
            if (identity && this._systemDeviceKeys.has(identity)) {
                systemRules.push([ruleId, ruleText]);
            } else {
                permanentRules.push([ruleId, ruleText]);
            }
        }

        this._renderDevices(parsedDevices, permanentRuleMatchesByDeviceId);
        this._renderSystemRules(systemRules, connectedDevicesByRuleId);
        this._renderRules(permanentRules, connectedDevicesByRuleId);

        const transientCount = parsedDevices.filter(device => {
            const matches = permanentRuleMatchesByDeviceId.get(device.deviceId) ?? [];
            return matches.length === 0;
        }).length;
        this._setStatus(
            `Loaded ${parsedDevices.length} connected devices (${transientCount} without permanent rule), ${systemRules.length} System-Devices, ${permanentRules.length} permanent rules.`
        );
    }

    _renderDevices(parsedDevices, permanentRuleMatchesByDeviceId) {
        this._clearGroupRows(this._devicesGroup, this._deviceRows);

        const visibleDevices = parsedDevices.filter(device => {
            const matches = permanentRuleMatchesByDeviceId.get(device.deviceId) ?? [];
            return matches.length === 0;
        });

        if (visibleDevices.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No non-permanent connected devices',
                subtitle: 'Devices with permanent rules are listed under "System-Devices" or "Permanent Rules".',
            });
            emptyRow.activatable = false;
            this._devicesGroup.add(emptyRow);
            this._deviceRows.push(emptyRow);
            return;
        }

        for (const device of visibleDevices) {
            const {deviceId, parsed} = device;
            const title = parsed.name || parsed.hash || parsed.usbId || `Device ${deviceId}`;
            const subtitleParts = [
                `id=${deviceId}`,
                `status=${parsed.target}`,
                parsed.usbId ? `usb-id=${parsed.usbId}` : null,
                parsed.serial ? `serial=${compactValue(parsed.serial, 8, 4)}` : null,
                parsed.hash ? `hash=${compactValue(parsed.hash, 8, 6)}` : null,
            ].filter(Boolean);

            const row = new Adw.ActionRow({
                title,
                subtitle: subtitleParts.join(' | '),
            });
            if (typeof row.set_subtitle_lines === 'function')
                row.set_subtitle_lines(1);
            if (typeof row.set_title_lines === 'function')
                row.set_title_lines(1);
            row.set_tooltip_text(parsed.rawText);

            const actions = [
                {
                    label: 'Allow once',
                    run: async () => {
                        await this._client.applyDevicePolicy(deviceId, 'allow', false);
                        this._setStatus(`Changed ${title} to allow once.`);
                    },
                },
                {
                    label: 'Allow always',
                    run: async () => {
                        await this._client.applyDevicePolicy(deviceId, 'allow', true);
                        this._setStatus(`Changed ${title} to allow permanent.`);
                    },
                },
                {
                    label: 'Block once',
                    run: async () => {
                        await this._client.applyDevicePolicy(deviceId, 'block', false);
                        this._setStatus(`Changed ${title} to block once.`);
                    },
                },
                {
                    label: 'Block permanent',
                    run: async () => {
                        await this._client.applyDevicePolicy(deviceId, 'block', true);
                        this._setStatus(`Changed ${title} to block permanent.`);
                    },
                },
            ];

            row.add_suffix(this._createChangeMenuButton(actions));

            this._devicesGroup.add(row);
            this._deviceRows.push(row);
        }
    }

    _findRulesMatchingDevice(rules, parsedDeviceRule) {
        if (parsedDeviceRule.hash) {
            const token = `hash "${parsedDeviceRule.hash}"`;
            return rules.filter(([, ruleText]) => String(ruleText).includes(token));
        }

        if (parsedDeviceRule.serial) {
            const token = `serial "${parsedDeviceRule.serial}"`;
            return rules.filter(([, ruleText]) => String(ruleText).includes(token));
        }

        if (parsedDeviceRule.usbId) {
            const idRegex = new RegExp(`\\bid\\s+${escapeRegex(parsedDeviceRule.usbId)}\\b`, 'i');
            return rules.filter(([, ruleText]) => idRegex.test(String(ruleText)));
        }

        return [];
    }

    _renderSystemRules(rules, connectedDevicesByRuleId) {
        this._renderRuleRows(
            this._systemRulesGroup,
            this._systemRuleRows,
            rules,
            connectedDevicesByRuleId,
            'No System-Devices',
            'Use "Set Baseline" at the bottom to populate this category.'
        );
    }

    _renderRules(rules, connectedDevicesByRuleId) {
        this._renderRuleRows(
            this._rulesGroup,
            this._ruleRows,
            rules,
            connectedDevicesByRuleId,
            'No permanent rules',
            'Create rules via prompts or device actions.'
        );
    }

    _renderRuleRows(group, rowsList, rules, connectedDevicesByRuleId, emptyTitle, emptySubtitle) {
        this._clearGroupRows(group, rowsList);

        if (rules.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: emptyTitle,
                subtitle: emptySubtitle,
            });
            emptyRow.activatable = false;
            group.add(emptyRow);
            rowsList.push(emptyRow);
            return;
        }

        for (const [ruleId, ruleText] of rules) {
            const parsed = parseRuleText(ruleText);
            const identity = this._buildDeviceIdentityKey(parsed);
            const title = parsed.name || parsed.hash || parsed.usbId || `Rule ${ruleId}`;
            const connectedDevices = connectedDevicesByRuleId.get(ruleId) ?? [];
            const connectedStatuses = [...new Set(connectedDevices.map(device => device.parsed.target))];
            const subtitleParts = [
                `#${ruleId}`,
                `status=${parsed.target}`,
                connectedDevices.length > 0 ? `connected=${connectedDevices.length}` : 'connected=0',
                connectedStatuses.length > 0 ? `device-status=${connectedStatuses.join(',')}` : 'device-status=n/a',
                parsed.usbId ? `usb-id=${parsed.usbId}` : null,
                parsed.serial ? `serial=${compactValue(parsed.serial, 8, 4)}` : null,
                parsed.hash ? `hash=${compactValue(parsed.hash, 8, 6)}` : null,
            ].filter(Boolean);
            const subtitle = subtitleParts.join(' | ');

            const row = new Adw.ActionRow({
                title,
                subtitle,
            });
            if (typeof row.set_subtitle_lines === 'function')
                row.set_subtitle_lines(1);
            if (typeof row.set_title_lines === 'function')
                row.set_title_lines(1);
            row.set_tooltip_text(parsed.rawText);

            const nextTarget = parsed.target === 'allow' ? 'block' : 'allow';
            const toggleLabel = nextTarget === 'block' ? 'Set Block' : 'Set Allow';
            const controls = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
                valign: Gtk.Align.CENTER,
            });
            const toggleButton = this._registerActionButton(new Gtk.Button({
                label: toggleLabel,
                valign: Gtk.Align.CENTER,
            }));
            toggleButton.connect('clicked', () => {
                void this._runBusyTask(async () => {
                    await this._changeRuleTarget(ruleId, ruleText, nextTarget);
                    await this._refreshAll();
                });
            });
            controls.append(toggleButton);
            const removeButton = this._registerActionButton(new Gtk.Button({
                label: 'Remove',
                valign: Gtk.Align.CENTER,
            }));
            removeButton.connect('clicked', () => {
                void this._runBusyTask(async () => {
                    await this._client.removeRule(ruleId);
                    if (identity && this._systemDeviceKeys.has(identity)) {
                        this._systemDeviceKeys.delete(identity);
                        this._saveSystemDeviceKeys();
                    }
                    this._setStatus(`Removed permanent rule #${ruleId}.`);
                    await this._refreshAll();
                });
            });
            controls.append(removeButton);

            row.add_suffix(controls);

            group.add(row);
            rowsList.push(row);
        }
    }

    async _changeRuleTarget(ruleId, originalRuleText, newTarget) {
        const currentTarget = parseRuleText(originalRuleText).target;
        if (currentTarget === newTarget) {
            this._setStatus(`Rule #${ruleId} is already "${newTarget}".`);
            return;
        }

        const updatedRuleText = rewriteRuleTarget(originalRuleText, newTarget);

        // Prefer append-before-remove to avoid a temporary policy gap.
        // Some USBGuard setups can reject this path due ordering/duplicate rules,
        // so fall back to remove-then-append with rollback.
        try {
            const newRuleId = await this._client.appendRule(updatedRuleText, ruleId);
            try {
                await this._client.removeRule(ruleId);
            } catch (error) {
                // Best-effort rollback if old rule removal failed.
                try {
                    await this._client.removeRule(newRuleId);
                } catch (_rollbackError) {
                    // Ignore rollback failures and rethrow original error.
                }
                throw error;
            }
        } catch (appendFirstError) {
            await this._client.removeRule(ruleId);
            try {
                await this._client.appendRule(updatedRuleText, 0);
            } catch (appendAfterRemoveError) {
                // Best-effort rollback to keep the original policy in place.
                try {
                    await this._client.appendRule(originalRuleText, 0);
                } catch (_rollbackError) {
                    // Ignore rollback failures and rethrow original error.
                }
                throw appendAfterRemoveError;
            }
        }

        this._setStatus(`Changed rule #${ruleId} target to ${newTarget}.`);
    }
}
