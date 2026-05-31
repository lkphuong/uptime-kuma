<template>
    <div class="mb-3">
        <label for="zalo-cookie" class="form-label">Zalo Cookie JSON</label>
        <textarea
            id="zalo-cookie"
            v-model="$parent.notification.zaloCookie"
            class="form-control"
            rows="8"
            required
            autocomplete="new-password"
            spellcheck="false"
        ></textarea>
        <i18n-t tag="div" keypath="More info on:" class="form-text">
            <a href="https://zca-js.tdung.com/vi/auth/login-with-cookie" target="_blank">
                https://zca-js.tdung.com/vi/auth/login-with-cookie
            </a>
        </i18n-t>
    </div>

    <div class="mb-3">
        <label for="zalo-imei" class="form-label">IMEI</label>
        <HiddenInput
            id="zalo-imei"
            v-model="$parent.notification.zaloImei"
            :required="true"
            autocomplete="new-password"
        ></HiddenInput>
    </div>

    <div class="mb-3">
        <label for="zalo-user-agent" class="form-label">User-Agent</label>
        <HiddenInput
            id="zalo-user-agent"
            v-model="$parent.notification.zaloUserAgent"
            :required="true"
            autocomplete="new-password"
        ></HiddenInput>
    </div>

    <div class="mb-3">
        <label for="zalo-group-id" class="form-label">{{ $t("Group ID") }}</label>
        <div class="input-group">
            <select
                id="zalo-group-id"
                v-model="$parent.notification.zaloGroupId"
                class="form-select"
                required
            >
                <option value="" disabled>Select a Zalo group</option>
                <option v-for="group in groupOptions" :key="group.groupId" :value="group.groupId">
                    {{ group.name }} ({{ group.groupId }})
                </option>
            </select>
            <button
                class="btn btn-outline-secondary"
                type="button"
                :disabled="isLoadingGroups || !canLoadGroups"
                @click="loadZaloGroups"
            >
                {{ isLoadingGroups ? "Loading..." : "Load groups" }}
            </button>
        </div>
        <div class="form-text">Load groups after entering Cookie JSON, IMEI, and User-Agent.</div>
    </div>

    <div class="mb-3">
        <div class="form-check">
            <input
                id="zalo-escalation-toggle"
                v-model="$parent.notification.zaloEscalationEnabled"
                class="form-check-input"
                type="checkbox"
            />
            <label class="form-check-label" for="zalo-escalation-toggle">
                Enable time-based escalation
            </label>
        </div>
        <div class="form-text">
            Configure escalation intervals and message templates via
            UPTIME_KUMA_ZALO_ESCALATION environment variable.
        </div>
    </div>
</template>

<script>
import HiddenInput from "../HiddenInput.vue";

export default {
    components: {
        HiddenInput,
    },
    data() {
        return {
            loadedGroups: [],
            isLoadingGroups: false,
        };
    },
    computed: {
        canLoadGroups() {
            const notification = this.$parent.notification;

            return Boolean(notification.zaloCookie && notification.zaloImei && notification.zaloUserAgent);
        },
        groupOptions() {
            const selectedGroupId = this.$parent.notification.zaloGroupId;
            const groups = [...this.loadedGroups];

            if (selectedGroupId && !groups.some((group) => group.groupId === selectedGroupId)) {
                groups.unshift({
                    groupId: selectedGroupId,
                    name: selectedGroupId,
                });
            }

            return groups;
        },
    },
    methods: {
        /**
         * Load Zalo group options from the server using the current credentials.
         * @returns {void}
         */
        loadZaloGroups() {
            this.isLoadingGroups = true;
            this.$root.getSocket().emit("getZaloGroups", this.$parent.notification, (res) => {
                this.isLoadingGroups = false;

                if (!res.ok) {
                    this.$root.toastError(res.msg);
                    return;
                }

                this.loadedGroups = res.groups || [];

                if (!this.$parent.notification.zaloGroupId && this.loadedGroups.length > 0) {
                    this.$parent.notification.zaloGroupId = this.loadedGroups[0].groupId;
                }
            });
        },
    },
};
</script>
