import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { OptionType } from "@utils/types";
import { showToast, useState } from "@webpack/common";

import { DEFAULT_PRESET, PRESET_LIST } from "./crypto";
import { runDiagnostics } from "./diagnostics";
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

function DiagnosticsSetting() {
    const [running, setRunning] = useState(false);
    const [report, setReport] = useState<string | null>(null);

    async function handleRun() {
        if (running) return;
        setRunning(true);
        try {
            setReport(await runDiagnostics());
        } catch (err) {
            setReport(`Diagnostics failed: ${String(err)}`);
        } finally {
            setRunning(false);
        }
    }

    async function handleCopy() {
        if (!report) return;
        try {
            await navigator.clipboard.writeText(report);
            showToast({ text: "Diagnostics report copied" });
        } catch {
            showToast({ text: "Could not access clipboard", variant: "critical" });
        }
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Paragraph>Verify JIT, WASM Worker mode, and WebCrypto hardware acceleration on this browser/WebView.</Paragraph>
            <div className="vc-aegires-modal-row">
                <Button variant="primary" size="small" disabled={running} onClick={() => void handleRun()}>
                    {running ? "Running Benchmark..." : "Run Diagnostics & Benchmark"}
                </Button>
                {report && (
                    <Button variant="secondary" size="small" onClick={() => void handleCopy()}>
                        Copy Report
                    </Button>
                )}
            </div>
            {report && <pre className="vc-aegires-diag">{report}</pre>}
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
    },
    diagnostics: {
        type: OptionType.COMPONENT,
        component: DiagnosticsSetting
    }
});
