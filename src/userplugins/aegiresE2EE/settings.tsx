import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { OptionType } from "@utils/types";

import { DEFAULT_PRESET, PRESET_LIST } from "./crypto";
import { useE2EEState } from "./state";
import { openE2EEModal } from "./ui";

function SessionControlsSetting() {
    const { hasKey, enabled, deriving } = useE2EEState();
    const status = deriving
        ? "Deriving session key..."
        : hasKey
            ? (enabled ? "Session key active — encryption ON" : "Session key loaded — encryption PAUSED")
            : "No session key set (key stays in RAM only and clears on reload)";

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Paragraph>{status}</Paragraph>
            <div>
                <Button variant="primary" size="small" onClick={() => openE2EEModal()}>
                    Manage Session Key
                </Button>
            </div>
        </div>
    );
}

export const settings = definePluginSettings({
    preset: {
        type: OptionType.SELECT,
        description: "Cipher preset used for outgoing encrypted messages (incoming messages auto-detect from header)",
        options: PRESET_LIST.map(p => ({
            label: p.label,
            value: p.index,
            default: p.index === DEFAULT_PRESET.index
        }))
    },
    sessionControls: {
        type: OptionType.COMPONENT,
        component: SessionControlsSetting
    }
});
