"use client";

/**
 * SettingsPanel/GameplayPanel.tsx — Gameplay tab.
 * Extracted verbatim from the original SettingsPanel.tsx (backlog §20 #468).
 */

import { useGameStore } from "@/lib/game/store";
import {
  type PanelProps,
  SectionHeader,
  Row,
  Segmented,
  ThemedSwitch,
} from "./_shared";

export function GameplayPanel({ visual, setVisual }: PanelProps) {
  const settings = useGameStore((s) => s.settings);
  const setSettings = useGameStore((s) => s.setSettings);

  return (
    <div>
      <SectionHeader
        title="Gameplay"
        description="Convenience toggles and match configuration."
      />
      <div>
        {/* G4.2 — Difficulty selector: scales enemy health/accuracy/spawn/damage.
            J-5000-retry — type widened to include "insane" (store.ts already
            allows it; the Segmented type param now matches). The UI still
            offers only easy/normal/hard per the store.ts comment — insane
            is reachable via debug overlay / tests / future UI. */}
        <Row label="Difficulty">
          <Segmented<"easy" | "normal" | "hard" | "insane">
            value={settings.difficulty}
            onChange={(v) => setSettings({ difficulty: v })}
            options={[
              { value: "easy", label: "Easy" },
              { value: "normal", label: "Normal" },
              { value: "hard", label: "Hard" },
            ]}
          />
        </Row>
        <Row label="Auto-reload When Empty">
          <ThemedSwitch
            checked={visual.autoReload}
            onCheckedChange={(c) =>
              setVisual((p) => ({ ...p, autoReload: c }))
            }
            aria-label="Auto reload when empty"
          />
        </Row>
        <Row label="Auto-targeting Assist">
          <ThemedSwitch
            checked={visual.autoTarget}
            onCheckedChange={(c) =>
              setVisual((p) => ({ ...p, autoTarget: c }))
            }
            aria-label="Auto targeting assist"
          />
        </Row>
        <Row label="Confirmed Kills">
          <ThemedSwitch
            checked={visual.confirmedKills}
            onCheckedChange={(c) =>
              setVisual((p) => ({ ...p, confirmedKills: c }))
            }
            aria-label="Confirmed kills"
          />
        </Row>
        <Row label="Match Duration" last>
          <span className="font-mono text-sm font-medium text-white/60">
            6 waves
          </span>
        </Row>
      </div>
    </div>
  );
}
