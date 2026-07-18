"use client";

/**
 * SettingsPanel/AudioPanel.tsx — Audio tab.
 * Extracted verbatim from the original SettingsPanel.tsx (backlog §20 #468).
 */

import { useGameStore } from "@/lib/game/store";
import {
  type PanelProps,
  SectionHeader,
  Row,
  ValuePill,
  ThemedSlider,
  ThemedSwitch,
} from "./_shared";

export function AudioPanel({ visual, setVisual }: PanelProps) {
  const settings = useGameStore((s) => s.settings);
  const setSettings = useGameStore((s) => s.setSettings);
  const setExtended = useGameStore((s) => s.setExtended);

  return (
    <div>
      <SectionHeader
        title="Audio"
        description="Volume levels and playback behavior."
      />
      <div>
        <Row label="Master Volume">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[settings.volume]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) => setSettings({ volume: v[0] })}
              aria-label="Master volume"
            />
            <ValuePill>{Math.round(settings.volume * 100)}%</ValuePill>
          </div>
        </Row>
        <Row label="SFX Volume">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[settings.extended.sfxVolume]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) => setExtended({ sfxVolume: v[0] })}
              aria-label="SFX volume"
            />
            <ValuePill>
              {Math.round(settings.extended.sfxVolume * 100)}%
            </ValuePill>
          </div>
        </Row>
        <Row label="Music Volume">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[settings.extended.musicVolume]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) => setExtended({ musicVolume: v[0] })}
              aria-label="Music volume"
            />
            <ValuePill>
              {Math.round(settings.extended.musicVolume * 100)}%
            </ValuePill>
          </div>
        </Row>
        <Row label="Voice Volume">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[settings.extended.voiceVolume]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) => setExtended({ voiceVolume: v[0] })}
              aria-label="Voice volume"
            />
            <ValuePill>
              {Math.round(settings.extended.voiceVolume * 100)}%
            </ValuePill>
          </div>
        </Row>
        <Row label="Mute on Focus Loss" last>
          <ThemedSwitch
            checked={visual.muteOnFocusLoss}
            onCheckedChange={(c) =>
              setVisual((p) => ({ ...p, muteOnFocusLoss: c }))
            }
            aria-label="Mute on focus loss"
          />
        </Row>
      </div>
    </div>
  );
}
