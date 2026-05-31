const NotificationProvider = require("./notification-provider");
const { DOWN, UP } = require("../../src/util");

class Zalo extends NotificationProvider {
    name = "zalo";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
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
