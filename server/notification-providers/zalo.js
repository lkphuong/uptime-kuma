const NotificationProvider = require("./notification-provider");
const { DOWN, UP, log } = require("../../src/util");
const { Liquid } = require("liquidjs");

class Zalo extends NotificationProvider {
    name = "zalo";

    // Track escalation progress per monitor across send() calls
    static escalationState = new Map();

    // Cached parsed escalation config from env var
    static _escalationConfigCache = null;
    static _escalationConfigParsed = false;

    /**
     * Parse and cache the UPTIME_KUMA_ZALO_ESCALATION env var.
     * Returns null if not configured or invalid, so the provider falls back to legacy.
     */
    static get escalationConfig() {
        if (Zalo._escalationConfigParsed) {
            return Zalo._escalationConfigCache;
        }
        Zalo._escalationConfigParsed = true;
        const raw = process.env.UPTIME_KUMA_ZALO_ESCALATION;
        if (!raw) {
            return null;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                throw new Error("must be an array");
            }
            for (const step of parsed) {
                if (typeof step.interval_minutes !== "number" || typeof step.template !== "string") {
                    throw new Error("each step needs interval_minutes (number) and template (string)");
                }
                if (step.interval_minutes <= 0) {
                    throw new Error("interval_minutes must be positive");
                }
            }
            parsed.sort((a, b) => a.interval_minutes - b.interval_minutes);
            Zalo._escalationConfigCache = parsed;
            return parsed;
        } catch (e) {
            log.warn("zalo", `Invalid UPTIME_KUMA_ZALO_ESCALATION: ${e.message}. Escalation disabled.`);
            return null;
        }
    }

    // Cached parsed retries threshold from env var
    static _retriesThresholdCache = null;
    static _retriesThresholdParsed = false;

    /**
     * Parse and cache the UPTIME_KUMA_ZALO_RETRIES_THRESHOLD env var.
     * Returns null if not configured or invalid, so the provider falls back to legacy.
     * @returns {number|null}
     */
    static get retriesThreshold() {
        if (Zalo._retriesThresholdParsed) {
            return Zalo._retriesThresholdCache;
        }
        Zalo._retriesThresholdParsed = true;
        const raw = process.env.UPTIME_KUMA_ZALO_RETRIES_THRESHOLD;
        if (!raw) {
            return null;
        }
        const parsed = parseInt(raw, 10);
        if (isNaN(parsed) || parsed < 0) {
            log.warn("zalo", `Invalid UPTIME_KUMA_ZALO_RETRIES_THRESHOLD: must be a non-negative integer. Got "${raw}". Threshold disabled.`);
            return null;
        }
        Zalo._retriesThresholdCache = parsed;
        return parsed;
    }

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        // Test notification (no heartbeat context)
        if (!monitorJSON || !heartbeatJSON) {
            return await this._sendTestMessage(notification, msg);
        }

        // Retries threshold gate: suppress DOWN notifications until retries >= threshold
        if (heartbeatJSON.status === DOWN) {
            const threshold = Zalo.retriesThreshold;
            if (threshold !== null && heartbeatJSON.retries < threshold) {
                return `Retries threshold not met (${heartbeatJSON.retries}/${threshold}).`;
            }
        }

        const escalation = Zalo.escalationConfig;
        const escalationEnabled = notification.zaloEscalationEnabled !== false;

        if (escalation && escalationEnabled) {
            if (heartbeatJSON.status === DOWN) {
                return await this._handleDownEscalation(notification, monitorJSON, heartbeatJSON, escalation);
            } else if (heartbeatJSON.status === UP) {
                return await this._handleRecovery(notification, monitorJSON, heartbeatJSON);
            }
        }

        // Legacy path: unchanged behavior
        return await this._sendAlertLegacy(notification, msg, monitorJSON, heartbeatJSON);
    }

    // -------------------------------------------------------------------------
    // Escalation methods
    // -------------------------------------------------------------------------

    /**
     * Send a test message (no monitor/heartbeat context).
     * @param notification
     * @param msg
     */
    async _sendTestMessage(notification, msg) {
        const okMsg = "Sent Successfully.";
        const groupId = this.requireString(notification.zaloGroupId, "Zalo groupId is required.");

        try {
            const { api, ThreadType } = await this.login(notification);
            await this.ensureGroupExists(api, groupId);
            await api.sendMessage(`Uptime Kuma Zalo Test\n\n${msg}`, groupId, ThreadType.Group);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }

    /**
     * Send an alert using the original message format (legacy behavior).
     * @param notification
     * @param msg
     * @param monitorJSON
     * @param heartbeatJSON
     */
    async _sendAlertLegacy(notification, msg, monitorJSON, heartbeatJSON) {
        const okMsg = "Sent Successfully.";
        const groupId = this.requireString(notification.zaloGroupId, "Zalo groupId is required.");

        try {
            const { api, ThreadType } = await this.login(notification);
            await this.ensureGroupExists(api, groupId);
            await api.sendMessage(this.buildMessage(msg, monitorJSON, heartbeatJSON), groupId, ThreadType.Group);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }

    /**
     * @param notification
     * @param monitorJSON
     * @param heartbeatJSON
     * @param escalation
     */
    async _handleDownEscalation(notification, monitorJSON, heartbeatJSON, escalation) {
        const okMsg = "Sent Successfully.";
        const monitorId = monitorJSON.id;
        const state = await this._getEscalationState(monitorId, heartbeatJSON);
        // Record first down time if this is the first DOWN we have seen
        if (!state.firstDownTime) {
            state.firstDownTime = heartbeatJSON.time || new Date().toISOString();
        }
        console.log("heartbeatJSON: ", heartbeatJSON)
        
        const elapsedMs = Date.now() - new Date(state.firstDownTime).getTime();
        const elapsedMinutes = Math.floor(elapsedMs / 60000);

        // Walk in reverse to find the highest unmatched interval that has been reached
        let sentIndex = -1;
        for (let i = escalation.length - 1; i >= 0; i--) {
            if (escalation[i].interval_minutes == heartbeatJSON.retries)  {
                sentIndex = i;
                break;
            }
        }

        if (sentIndex === -1) {
            // No escalation threshold reached yet, send default DOWN message
            // return await this._sendAlertLegacy(notification, "", monitorJSON, heartbeatJSON);
            console.log("No escalation threshold reached yet, skipping notification. Elapsed minutes:", elapsedMinutes);
            return;
        }

        const step = escalation[sentIndex];
        const durationDisplay = this._formatDuration(elapsedMinutes);

        try {
            const groupId = this.requireString(notification.zaloGroupId, "Zalo groupId is required.");
            const { api, ThreadType } = await this.login(notification);
            await this.ensureGroupExists(api, groupId);

            const message = await this._renderEscalationTemplate(
                step.template, monitorJSON, heartbeatJSON,
                {
                    duration: elapsedMinutes,
                    duration_display: durationDisplay,
                    escalation_level: sentIndex,
                    interval_minutes: step.interval_minutes,
                }
            );

            await api.sendMessage(message, groupId, ThreadType.Group);
            state.sentIntervals.add(sentIndex);

            log.info("zalo", `[${monitorJSON.name}] Sent escalation level ${sentIndex} (${step.interval_minutes} min threshold, actual downtime: ${durationDisplay})`);
            return okMsg;
        } catch (error) {
            // Do NOT mark the interval as sent on failure, so it retries next time
            this.throwGeneralAxiosError(error);
        }
    }

    /**
     * Handle an UP (recovery) notification.
     * Sends the recovery template and clears escalation state for this monitor.
     * @param notification
     * @param monitorJSON
     * @param heartbeatJSON
     */
    async _handleRecovery(notification, monitorJSON, heartbeatJSON) {
        const okMsg = "Sent Successfully.";
        const monitorId = monitorJSON.id;
        const state = Zalo.escalationState.get(monitorId);

        // Calculate total downtime
        let durationMinutes = 0;
        let durationDisplay = "?";
        if (heartbeatJSON.lastDownTime) {
            const downTime = new Date(heartbeatJSON.lastDownTime).getTime();
            const upTime = heartbeatJSON.time ? new Date(heartbeatJSON.time).getTime() : Date.now();
            const elapsedMs = upTime - downTime;
            if (elapsedMs > 0) {
                durationMinutes = Math.floor(elapsedMs / 60000);
                durationDisplay = this._formatDuration(durationMinutes);
            }
        } else if (state && state.firstDownTime) {
            // Fallback: use our tracked first down time
            const elapsedMs = Date.now() - new Date(state.firstDownTime).getTime();
            if (elapsedMs > 0) {
                durationMinutes = Math.floor(elapsedMs / 60000);
                durationDisplay = this._formatDuration(durationMinutes);
            }
        }

        // Clear escalation state for this monitor
        Zalo.escalationState.delete(monitorId);

        const recoveryTemplate = process.env.UPTIME_KUMA_ZALO_RECOVERY_TEMPLATE
            || "✅ {{ name }} đã hoạt động trở lại sau {{ duration_display }}. Cảm ơn anh chị đã xử lý ạ.";

        try {
            const groupId = this.requireString(notification.zaloGroupId, "Zalo groupId is required.");
            const { api, ThreadType } = await this.login(notification);
            await this.ensureGroupExists(api, groupId);

            const message = await this._renderEscalationTemplate(
                recoveryTemplate, monitorJSON, heartbeatJSON,
                {
                    duration: durationMinutes,
                    duration_display: durationDisplay,
                }
            );

            await api.sendMessage(message, groupId, ThreadType.Group);
            log.info("zalo", `[${monitorJSON.name}] Sent recovery message (was down for ${durationDisplay})`);
            return okMsg;
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }

    /**
     * Get or create escalation state for a monitor.
     * On first call, tries to bootstrap firstDownTime from the heartbeat DB table.
     * @param monitorId
     * @param heartbeatJSON
     */
    async _getEscalationState(monitorId, heartbeatJSON) {
        let state = Zalo.escalationState.get(monitorId);
        if (state) {
            return state;
        }

        // Bootstrap: try to find the first important DOWN heartbeat from DB
        let firstDownTime = null;
        try {
            const { R } = require("redbean-node");
            const row = await R.getRow(
                "SELECT time FROM heartbeat WHERE monitor_id = ? AND status = ? AND important = 1 ORDER BY time ASC LIMIT 1",
                [monitorId, DOWN]
            );
            if (row && row.time) {
                firstDownTime = row.time;
            }
        } catch (e) {
            // If DB query fails (e.g. during startup), use current heartbeat time
            log.debug("zalo", `Could not query first down time for monitor ${monitorId}: ${e.message}`);
        }

        state = {
            firstDownTime,
            sentIntervals: new Set(),
        };
        Zalo.escalationState.set(monitorId, state);
        return state;
    }

    /**
     * Format total minutes into Vietnamese human-readable duration.
     * @param totalMinutes
     */
    _formatDuration(totalMinutes) {
        if (totalMinutes < 1) {
            return "dưới 1 phút";
        }
        if (totalMinutes < 60) {
            return `${totalMinutes} phút`;
        }
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        if (hours < 24) {
            if (minutes > 0) {
                return `${hours} giờ ${minutes} phút`;
            }
            return `${hours} giờ`;
        }
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        if (remainingHours > 0) {
            return `${days} ngày ${remainingHours} giờ`;
        }
        return `${days} ngày`;
    }

    /**
     * Render a LiquidJS template with extra context variables for escalation.
     * @param template
     * @param monitorJSON
     * @param heartbeatJSON
     * @param extras
     */
    async _renderEscalationTemplate(template, monitorJSON, heartbeatJSON, extras = {}) {
        const engine = new Liquid({
            root: "./no-such-directory-uptime-kuma",
            relativeReference: false,
            dynamicPartials: false,
        });
        const parsedTpl = engine.parse(template);

        let monitorName = monitorJSON?.name || "Monitor Name not available";
        let monitorHostnameOrURL = this.extractAddress(monitorJSON || {});

        let serviceStatus = "⚠️ Test";
        if (heartbeatJSON !== null) {
            serviceStatus = heartbeatJSON.status === DOWN ? "🔴 Down" : "✅ Up";
        }

        // Build the same context the base renderTemplate uses, plus extras
        const context = {
            STATUS: serviceStatus,
            NAME: monitorName,
            HOSTNAME_OR_URL: monitorHostnameOrURL,
            status: serviceStatus,
            name: monitorName,
            hostnameOrURL: monitorHostnameOrURL,
            monitorJSON,
            heartbeatJSON,
            msg: heartbeatJSON?.msg || "",
            ...extras,
        };

        return engine.render(parsedTpl, context);
    }

    /**
     * Load Zalo group options for the notification form.
     * @param {object} notification Notification configuration
     * @returns {Promise<object[]>} Group options
     */
    async getGroupOptions(notification) {
        const { api } = await this.login(notification);
        const groups = await api.getAllGroups();
        const groupIds = groups && groups.gridVerMap ? Object.keys(groups.gridVerMap) : [];
        const options = [];

        for (const groupId of groupIds) {
            let info;

            try {
                info = await api.getGroupInfo(groupId);
            } catch {
                continue;
            }

            const name = info?.gridInfoMap?.[groupId]?.name || groupId;

            options.push({
                groupId,
                name,
            });
        }

        return options.sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Login to Zalo and return an authenticated API client.
     * @param {object} notification Notification configuration
     * @returns {Promise<object>} API client and zca-js constants
     */
    async login(notification) {
        const { Zalo: ZaloClient, ThreadType } = await this.loadZcaJs();
        const cookie = this.parseCookie(notification.zaloCookie);
        const imei = this.requireString(notification.zaloImei, "Zalo IMEI is required.");
        const userAgent = this.requireString(notification.zaloUserAgent, "Zalo userAgent is required.");
        const zalo = new ZaloClient({
            selfListen: false,
            checkUpdate: false,
            logging: false,
        });
        const api = await zalo.login({
            cookie,
            imei,
            userAgent,
        });

        return {
            api,
            ThreadType,
        };
    }

    /**
     * Load zca-js lazily because the package is ESM.
     * @returns {Promise<object>} zca-js module
     */
    async loadZcaJs() {
        return import("zca-js");
    }

    /**
     * Parse the cookie JSON copied from Zalo Web.
     * @param {string} rawCookie Raw cookie JSON
     * @returns {object} Parsed cookie object
     * @throws {Error} Invalid cookie JSON
     */
    parseCookie(rawCookie) {
        if (typeof rawCookie !== "string" || rawCookie.trim() === "") {
            throw new Error("Zalo cookie must be valid JSON.");
        }

        try {
            const cookie = JSON.parse(rawCookie);
            if (cookie === null || typeof cookie !== "object") {
                throw new Error("Invalid cookie shape");
            }
            return cookie;
        } catch (error) {
            throw new Error("Zalo cookie must be valid JSON.");
        }
    }

    /**
     * Require a non-empty string configuration value.
     * @param {string} value Configuration value
     * @param {string} message Error message
     * @returns {string} Trimmed value
     * @throws {Error} Missing value
     */
    requireString(value, message) {
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error(message);
        }

        return value.trim();
    }

    /**
     * Verify the configured group is available to the logged-in account.
     * @param {object} api Zalo API client
     * @param {string} groupId Target group ID
     * @returns {Promise<void>}
     * @throws {Error} Group is unavailable
     */
    async ensureGroupExists(api, groupId) {
        const groups = await api.getAllGroups();
        if (!groups || !groups.gridVerMap || !Object.prototype.hasOwnProperty.call(groups.gridVerMap, groupId)) {
            throw new Error("Zalo groupId was not found in the account group list.");
        }
    }

    /**
     * Build the Zalo message text from Uptime Kuma notification context.
     * @param {string} msg Notification message
     * @param {?object} monitorJSON Monitor details
     * @param {?object} heartbeatJSON Heartbeat details
     * @returns {string} Message text
     */
    buildMessage(msg, monitorJSON = null, heartbeatJSON = null) {
        if (!monitorJSON || !heartbeatJSON) {
            return `Uptime Kuma Zalo Test\n\n${msg}`;
        }

        const status = this.formatStatus(heartbeatJSON.status);
        const message = heartbeatJSON.msg || msg;
        const lines = [
            `Uptime Kuma Alert: [${status}]`,
            `Name: ${monitorJSON.name || "Monitor Name not available"}`,
            `Message: ${message}`,
        ];

        if (heartbeatJSON.timezone && heartbeatJSON.localDateTime) {
            lines.push(`Time (${heartbeatJSON.timezone}): ${heartbeatJSON.localDateTime}`);
        }

        return lines.join("\n");
    }

    /**
     * Format Uptime Kuma status code for a plain text Zalo message.
     * @param {number} status Heartbeat status code
     * @returns {string} Status label
     */
    formatStatus(status) {
        if (status === DOWN) {
            return "Down";
        }

        if (status === UP) {
            return "Up";
        }

        return "Unknown";
    }
}

module.exports = Zalo;
