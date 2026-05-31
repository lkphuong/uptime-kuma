const { describe, test } = require("node:test");
const assert = require("node:assert");

const Zalo = require("../../../server/notification-providers/zalo");

/**
 * Create a Zalo provider with zca-js replaced by an in-memory fake.
 * @param {object} groups Group map returned by getAllGroups
 * @param {Set<string>} failedGroupInfoIds Group IDs whose info call fails
 * @returns {object} Provider and captured calls
 */
function createProvider(groups = { "group-1": "1" }, failedGroupInfoIds = new Set()) {
    const calls = {
        constructorOptions: null,
        credentials: null,
        sentMessage: null,
        groupInfoIds: [],
    };

    class TestZalo extends Zalo {
        /**
         * Return a fake zca-js module for deterministic tests.
         * @returns {Promise<object>} Fake zca-js module
         */
        async loadZcaJs() {
            return {
                Zalo: class {
                    /**
                     * Capture constructor options.
                     * @param {object} options Zalo client options
                     */
                    constructor(options) {
                        calls.constructorOptions = options;
                    }

                    /**
                     * Capture login credentials and return a fake API client.
                     * @param {object} credentials Zalo login credentials
                     * @returns {Promise<object>} Fake API client
                     */
                    async login(credentials) {
                        calls.credentials = credentials;

                        return {
                            getAllGroups: async () => ({
                                version: "1",
                                gridVerMap: groups,
                            }),
                            getGroupInfo: async (groupId) => {
                                calls.groupInfoIds.push(groupId);

                                if (failedGroupInfoIds.has(groupId)) {
                                    throw new Error("Group info failed");
                                }

                                return {
                                    gridInfoMap: {
                                        [groupId]: {
                                            name: groups[groupId],
                                        },
                                    },
                                };
                            },
                            sendMessage: async (message, threadId, type) => {
                                calls.sentMessage = { message, threadId, type };
                            },
                        };
                    }
                },
                ThreadType: {
                    Group: "group",
                },
            };
        }
    }

    return {
        provider: new TestZalo(),
        calls,
    };
}

/**
 * Create a valid notification config for provider tests.
 * @param {object} overrides Notification property overrides
 * @returns {object} Notification config
 */
function createNotification(overrides = {}) {
    return {
        zaloCookie: JSON.stringify([{ name: "zpw_sek", value: "cookie-value" }]),
        zaloImei: "test-imei",
        zaloUserAgent: "test-user-agent",
        zaloGroupId: "group-1",
        ...overrides,
    };
}

describe("Zalo notification provider", () => {
    test("rejects invalid cookie JSON", async () => {
        const { provider } = createProvider();

        await assert.rejects(
            () => provider.send(createNotification({ zaloCookie: "not-json" }), "Test message"),
            /Zalo cookie must be valid JSON/
        );
    });

    test("rejects a group id that is not available to the account", async () => {
        const { provider } = createProvider({ "group-2": "1" });

        await assert.rejects(
            () => provider.send(createNotification(), "Test message"),
            /Zalo groupId was not found/
        );
    });

    test("sends detailed heartbeat messages to a Zalo group", async () => {
        const { provider, calls } = createProvider();

        const result = await provider.send(
            createNotification(),
            "Fallback message",
            { name: "Main API" },
            {
                status: 0,
                msg: "Connection refused",
                timezone: "UTC",
                localDateTime: "2026-05-31 12:00:00",
            }
        );

        assert.strictEqual(result, "Sent Successfully.");
        assert.deepStrictEqual(calls.constructorOptions, {
            selfListen: false,
            checkUpdate: false,
            logging: false,
        });
        assert.deepStrictEqual(calls.credentials, {
            cookie: [{ name: "zpw_sek", value: "cookie-value" }],
            imei: "test-imei",
            userAgent: "test-user-agent",
        });
        assert.deepStrictEqual(calls.sentMessage, {
            message:
                "Uptime Kuma Alert: [Down]\n" +
                "Name: Main API\n" +
                "Message: Connection refused\n" +
                "Time (UTC): 2026-05-31 12:00:00",
            threadId: "group-1",
            type: "group",
        });
    });

    test("sends generic messages when heartbeat context is unavailable", async () => {
        const { provider, calls } = createProvider();

        await provider.send(createNotification(), "Manual test message");

        assert.deepStrictEqual(calls.sentMessage, {
            message: "Uptime Kuma Zalo Test\n\nManual test message",
            threadId: "group-1",
            type: "group",
        });
    });

    test("loads group options with names from Zalo group info", async () => {
        const { provider, calls } = createProvider({
            "group-2": "Operations",
            "group-1": "Backend Team",
        });

        const groups = await provider.getGroupOptions(createNotification());

        assert.deepStrictEqual(groups, [
            {
                groupId: "group-1",
                name: "Backend Team",
            },
            {
                groupId: "group-2",
                name: "Operations",
            },
        ]);
        assert.deepStrictEqual(calls.groupInfoIds, ["group-2", "group-1"]);
    });

    test("uses group id when Zalo group info has no name", async () => {
        const { provider } = createProvider({
            "group-1": "",
        });

        const groups = await provider.getGroupOptions(createNotification());

        assert.deepStrictEqual(groups, [
            {
                groupId: "group-1",
                name: "group-1",
            },
        ]);
    });

    test("skips groups when only that group info lookup fails", async () => {
        const { provider } = createProvider(
            {
                "group-1": "Backend Team",
                "group-2": "Operations",
            },
            new Set(["group-2"])
        );

        const groups = await provider.getGroupOptions(createNotification());

        assert.deepStrictEqual(groups, [
            {
                groupId: "group-1",
                name: "Backend Team",
            },
        ]);
    });
});
