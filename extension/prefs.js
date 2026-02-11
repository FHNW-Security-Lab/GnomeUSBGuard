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
        this._ruleRows = [];
        this._busy = false;

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

        const baselineRow = new Adw.ActionRow({
            title: 'Accept current devices as baseline',
            subtitle: 'Permanently allow all currently connected devices. Unplug removable devices first if needed.',
        });
        this._baselineButton = this._registerActionButton(new Gtk.Button({
            label: 'Accept baseline',
            valign: Gtk.Align.CENTER,
        }));
        this._baselineButton.add_css_class('suggested-action');
        this._baselineButton.connect('clicked', () => {
            void this._runBusyTask(async () => {
                await this._acceptCurrentStateAsBaseline();
                await this._refreshAll();
            });
        });
        baselineRow.add_suffix(this._baselineButton);
        controlsGroup.add(baselineRow);

        this._statusRow = new Adw.ActionRow({
            title: 'Status',
            subtitle: 'Loading USBGuard data...',
        });
        this._statusRow.activatable = false;
        controlsGroup.add(this._statusRow);

        this._devicesGroup = new Adw.PreferencesGroup({
            title: 'Connected Devices',
            description: 'Change policy for active devices (allow/block once or permanently) or reset matching permanent rules.',
        });

        this._rulesGroup = new Adw.PreferencesGroup({
            title: 'Permanent Rules',
            description: 'Edit or remove USBGuard rules persisted in policy.',
        });

        page.add(controlsGroup);
        page.add(this._devicesGroup);
        page.add(this._rulesGroup);
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

    _createActionSelector(actionLabels) {
        const stringList = Gtk.StringList.new(actionLabels);
        const dropdown = this._registerActionWidget(new Gtk.DropDown({
            model: stringList,
            selected: 0,
            valign: Gtk.Align.CENTER,
        }));

        const applyButton = this._registerActionButton(new Gtk.Button({
            label: 'Apply',
            valign: Gtk.Align.CENTER,
        }));

        const actionBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        actionBox.append(dropdown);
        actionBox.append(applyButton);

        return {
            actionBox,
            dropdown,
            applyButton,
        };
    }

    _setStatus(message) {
        if (this._statusRow)
            this._statusRow.set_subtitle(message);
    }

    async _refreshAll() {
        const [devices, rules] = await Promise.all([
            this._client.listDevices(),
            this._client.listRules(),
        ]);

        this._renderDevices(devices);
        this._renderRules(rules);
        this._setStatus(`Loaded ${devices.length} connected devices and ${rules.length} permanent rules.`);
    }

    async _acceptCurrentStateAsBaseline() {
        const devices = await this._client.listDevices();
        if (devices.length === 0) {
            this._setStatus('No connected devices found. Nothing to baseline.');
            return;
        }

        const failedDevices = [];
        let appliedCount = 0;

        for (const [deviceId, deviceRule] of devices) {
            try {
                await this._client.applyDevicePolicy(deviceId, 'allow', true);
                appliedCount += 1;
            } catch (error) {
                const parsed = parseRuleText(deviceRule);
                failedDevices.push(parsed.name || parsed.usbId || `id=${deviceId}`);
                logError(error, `[usbguard-prompt] Failed to baseline device ${deviceId}`);
            }
        }

        if (failedDevices.length === 0) {
            this._setStatus(`Baseline saved: ${appliedCount} connected device(s) permanently allowed.`);
            return;
        }

        const preview = failedDevices.slice(0, 3).join(', ');
        const moreCount = failedDevices.length > 3 ? ` (+${failedDevices.length - 3} more)` : '';
        this._setStatus(
            `Baseline partially applied (${appliedCount}/${devices.length}). Failed: ${preview}${moreCount}`
        );
    }

    _renderDevices(devices) {
        this._clearGroupRows(this._devicesGroup, this._deviceRows);

        if (devices.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No connected devices',
                subtitle: 'No USBGuard device entries returned for query "match".',
            });
            emptyRow.activatable = false;
            this._devicesGroup.add(emptyRow);
            this._deviceRows.push(emptyRow);
            return;
        }

        for (const [deviceId, deviceRule] of devices) {
            const parsed = parseRuleText(deviceRule);
            const title = parsed.name || parsed.hash || parsed.usbId || `Device ${deviceId}`;
            const subtitleParts = [
                `id=${deviceId}`,
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
                        this._setStatus(`Applied "allow once" to ${title}.`);
                    },
                },
                {
                    label: 'Allow always',
                    run: async () => {
                        await this._client.applyDevicePolicy(deviceId, 'allow', true);
                        this._setStatus(`Applied permanent allow to ${title}.`);
                    },
                },
                {
                    label: 'Block once',
                    run: async () => {
                        await this._client.applyDevicePolicy(deviceId, 'block', false);
                        this._setStatus(`Applied "block once" to ${title}.`);
                    },
                },
                {
                    label: 'Block permanent',
                    run: async () => {
                        await this._client.applyDevicePolicy(deviceId, 'block', true);
                        this._setStatus(`Applied permanent block to ${title}.`);
                    },
                },
                {
                    label: 'Reset rules',
                    run: async () => {
                        await this._resetRulesForDevice(title, parsed);
                    },
                },
            ];

            const {
                actionBox,
                dropdown,
                applyButton,
            } = this._createActionSelector(actions.map(action => action.label));

            applyButton.connect('clicked', () => {
                const selected = Math.max(0, dropdown.get_selected());
                const action = actions[selected] ?? actions[0];
                void this._runBusyTask(async () => {
                    await action.run();
                    await this._refreshAll();
                });
            });

            row.add_suffix(actionBox);

            this._devicesGroup.add(row);
            this._deviceRows.push(row);
        }
    }

    async _resetRulesForDevice(deviceTitle, parsedDeviceRule) {
        const rules = await this._client.listRules();
        const matchedRules = this._findRulesMatchingDevice(rules, parsedDeviceRule);

        if (matchedRules.length === 0) {
            this._setStatus(`No matching permanent rules found for ${deviceTitle}.`);
            return;
        }

        for (const [ruleId] of matchedRules)
            await this._client.removeRule(ruleId);

        this._setStatus(`Removed ${matchedRules.length} permanent rule(s) for ${deviceTitle}.`);
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

    _renderRules(rules) {
        this._clearGroupRows(this._rulesGroup, this._ruleRows);

        if (rules.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No permanent rules',
                subtitle: 'Create rules via prompts or device actions.',
            });
            emptyRow.activatable = false;
            this._rulesGroup.add(emptyRow);
            this._ruleRows.push(emptyRow);
            return;
        }

        for (const [ruleId, ruleText] of rules) {
            const parsed = parseRuleText(ruleText);
            const title = parsed.name || parsed.hash || parsed.usbId || `Rule ${ruleId}`;
            const subtitleParts = [
                `#${ruleId}`,
                `target=${parsed.target}`,
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

            const actions = [
                {
                    label: 'Set Allow',
                    run: async () => {
                        await this._changeRuleTarget(ruleId, ruleText, 'allow');
                    },
                },
                {
                    label: 'Set Block',
                    run: async () => {
                        await this._changeRuleTarget(ruleId, ruleText, 'block');
                    },
                },
                {
                    label: 'Set Reject',
                    run: async () => {
                        await this._changeRuleTarget(ruleId, ruleText, 'reject');
                    },
                },
                {
                    label: 'Delete rule',
                    run: async () => {
                        await this._client.removeRule(ruleId);
                        this._setStatus(`Deleted rule #${ruleId}.`);
                    },
                },
            ];

            const {
                actionBox,
                dropdown,
                applyButton,
            } = this._createActionSelector(actions.map(action => action.label));

            applyButton.connect('clicked', () => {
                const selected = Math.max(0, dropdown.get_selected());
                const action = actions[selected] ?? actions[0];
                void this._runBusyTask(async () => {
                    await action.run();
                    await this._refreshAll();
                });
            });

            row.add_suffix(actionBox);

            this._rulesGroup.add(row);
            this._ruleRows.push(row);
        }
    }

    async _changeRuleTarget(ruleId, originalRuleText, newTarget) {
        const currentTarget = parseRuleText(originalRuleText).target;
        if (currentTarget === newTarget) {
            this._setStatus(`Rule #${ruleId} is already "${newTarget}".`);
            return;
        }

        const updatedRuleText = rewriteRuleTarget(originalRuleText, newTarget);
        await this._client.appendRule(updatedRuleText, 0);
        await this._client.removeRule(ruleId);
        this._setStatus(`Changed rule #${ruleId} target to ${newTarget}.`);
    }
}

