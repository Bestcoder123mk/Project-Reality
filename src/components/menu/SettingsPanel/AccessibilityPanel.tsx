"use client";

/**
 * SettingsPanel/AccessibilityPanel.tsx — Accessibility tab.
 * Extracted verbatim from the original SettingsPanel.tsx (backlog §20 #468).
 */

import { useState } from "react";
import { useGameStore } from "@/lib/game/store";
import {
  COLORBLIND_MODES,
  getColorblindPalette,
  listColorblindPalettes,
  loadColorblindMode,
  saveColorblindMode,
  type ColorblindMode,
} from "@/lib/game/Accessibility";
import {
  getAimAssistConfig,
  setAimAssistStrength,
} from "@/lib/game/uiux/gamepad";
import {
  type PanelProps,
  SectionHeader,
  Row,
  ValuePill,
  Segmented,
  ThemedSlider,
  ThemedSwitch,
} from "./_shared";
import { saveVisualSettingsBlob } from "@/lib/game/uiux/boot-attributes";

export function AccessibilityPanel({ visual, setVisual }: PanelProps) {
  const settings = useGameStore((s) => s.settings);
  const setExtended = useGameStore((s) => s.setExtended);
  // Prompt J-4050 — colorblind mode now persists across all 6 modes.
  // Previously only the 4 store-supported modes (none/protanopia/
  // deuteranopia/tritanopia) were persisted via `setExtended`; the other
  // 2 (high_contrast, monochrome) drove the palette preview live but
  // reset on reload. Now we ALSO persist via the Accessibility module's
  // localStorage key (`pr_colorblind_mode`) which supports all 6 modes,
  // + `applyBootDataAttributes()` reads that key at boot. The 4
  // store-supported modes still go through `setExtended` so the engine's
  // renderer filter applies; the 2 extra modes are CSS-only.
  const [cbMode, setCbMode] = useState<ColorblindMode>(
    () => loadColorblindMode() ?? settings.extended.colorblind ?? "none",
  );
  const palette = getColorblindPalette(cbMode);
  const allPalettes = listColorblindPalettes();

  const onCbModeChange = (v: ColorblindMode) => {
    setCbMode(v);
    // Persist via the Accessibility module (all 6 modes).
    saveColorblindMode(v);
    // Also push to the store for the 4 engine-supported modes so the
    // renderer's colorblind filter applies.
    if (v === "none" || v === "protanopia" || v === "deuteranopia" || v === "tritanopia") {
      setExtended({ colorblind: v });
    }
  };

  // SEC10-UIUX (prompt 79): aim-assist strength slider for gamepad users.
  const aimAssist = getAimAssistConfig();
  const [aimAssistLevel, setAimAssistLevel] = useState(aimAssist.strength);
  const onAimAssistChange = (v: number) => {
    setAimAssistLevel(v);
    setAimAssistStrength(v);
  };

  return (
    <div>
      <SectionHeader
        title="Accessibility"
        description="Color vision, motion comfort, captions, and gamepad aim-assist."
      />
      <div>
        <Row label="Colorblind Mode">
          <Segmented<ColorblindMode>
            value={cbMode}
            onChange={(v) => onCbModeChange(v)}
            options={[
              { value: "none", label: "None" },
              { value: "protanopia", label: "Protan" },
              { value: "deuteranopia", label: "Deutan" },
              { value: "tritanopia", label: "Tritan" },
              { value: "high_contrast", label: "High Contrast" },
              { value: "monochrome", label: "Mono" },
            ]}
          />
        </Row>

        {/* SEC10-UIUX (prompt 77): palette preview — show the semantic
            colors the HUD/subtitles will use under the selected mode. */}
        <div className="mb-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/30">
            Palette Preview ({COLORBLIND_MODES[cbMode].label})
          </div>
          <div className="flex flex-wrap gap-2">
            {([
              { label: "Friendly", color: palette.friendly },
              { label: "Enemy", color: palette.enemy },
              { label: "Objective", color: palette.objective },
              { label: "Danger", color: palette.danger },
              { label: "Item", color: palette.item },
              { label: "System", color: palette.system },
              { label: "Text", color: palette.text },
            ] as { label: string; color: string }[]).map((sw) => (
              <div key={sw.label} className="flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1">
                <span
                  className="h-3 w-3 rounded-full border border-white/20"
                  style={{ backgroundColor: sw.color }}
                />
                <span className="text-[10px] text-white/60">{sw.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-white/30">
            {allPalettes.length} re-tested palettes available — every semantic color stays distinguishable under the selected vision mode.
          </div>
        </div>

        {/* SEC10-UIUX (prompt 79): gamepad aim-assist strength */}
        <Row
          label="Gamepad Aim-Assist"
          hint="Console-style stickiness for gamepad users. Mouse/keyboard users are unaffected."
        >
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[aimAssistLevel]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(v) => onAimAssistChange(v[0])}
              aria-label="Aim-assist strength"
            />
            <ValuePill>{Math.round(aimAssistLevel * 100)}%</ValuePill>
          </div>
        </Row>

        <Row
          label="Motion Sickness Mode"
          hint="Disables head bob, motion blur, and FOV kick on sprint."
        >
          <ThemedSwitch
            checked={settings.extended.motionSickness}
            onCheckedChange={(c) => setExtended({ motionSickness: c })}
            aria-label="Motion sickness mode"
          />
        </Row>
        <Row
          label="Subtitles"
          hint="SEC10-UIUX: closed captions for ALL audio cues — gunfire, footsteps, explosions, dialogue."
        >
          <ThemedSwitch
            // Prompt J-4051 — subtitles now persist via ExtendedSettings
            // (was visual.subtitles which reset on tab switch per I-964).
            checked={settings.extended.subtitlesEnabled}
            onCheckedChange={(c) => setExtended({ subtitlesEnabled: c })}
            aria-label="Subtitles"
          />
        </Row>
        {/* Prompt J-4055 — non-VO ambient captions. When on, ambient
            audio cues (footsteps, reloads, explosions, glass breaking)
            are captioned in addition to VO. The Subtitles system reads
            this flag. */}
        <Row label="Ambient Captions" hint="Caption non-VO audio cues (footsteps, reloads, explosions) in addition to dialogue.">
          <ThemedSwitch
            checked={settings.extended.ambientCaptions}
            onCheckedChange={(c) => setExtended({ ambientCaptions: c })}
            aria-label="Ambient captions"
          />
        </Row>
        {/* Prompt J-4053 — audio ducking. When >0 dB, non-VO audio
            buses (music, sfx) are attenuated while VO is playing so
            the player can hear dialogue clearly. */}
        <Row label="Audio Ducking" hint="Lower music/SFX volume while voice-over plays so dialogue is audible (dB).">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[settings.extended.audioDuckDb]}
              min={0}
              max={12}
              step={1}
              onValueChange={(v) => setExtended({ audioDuckDb: v[0] })}
              aria-label="Audio ducking (dB)"
            />
            <ValuePill>{settings.extended.audioDuckDb} dB</ValuePill>
          </div>
        </Row>
        {/* Prompt J-4054 — motor assist / one-handed mode. When on,
            the engine auto-holds sprint while moving forward, auto-
            crouches on backward movement, + remaps combined actions
            to a single key. Designed for one-handed play. */}
        <Row label="Motor Assist" hint="One-handed mode: auto-sprint on forward, auto-crouch on back, combined actions on one key.">
          <ThemedSwitch
            checked={settings.extended.motorAssist}
            onCheckedChange={(c) => setExtended({ motorAssist: c })}
            aria-label="Motor assist"
          />
        </Row>
        {/* Prompt J-4052 — subtitle background + color customization. */}
        <Row label="Subtitle Background" hint="Opacity of the panel behind subtitle text (0 = transparent, 1 = solid).">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[settings.extended.subtitleBackground]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(v) => setExtended({ subtitleBackground: v[0] })}
              aria-label="Subtitle background opacity"
            />
            <ValuePill>{Math.round(settings.extended.subtitleBackground * 100)}%</ValuePill>
          </div>
        </Row>
        {/* Prompt J-4057 — dyslexia-friendly font. */}
        <Row label="Dyslexia Font" hint="Swap body text + HUD labels to a dyslexia-friendly font stack.">
          <ThemedSwitch
            checked={settings.extended.dyslexiaFont}
            onCheckedChange={(c) => setExtended({ dyslexiaFont: c })}
            aria-label="Dyslexia font"
          />
        </Row>
        {/* Prompt J-4059 — RTL layout override. */}
        <Row label="RTL Layout" hint="Mirror the UI right-to-left (for Arabic / Hebrew).">
          <ThemedSwitch
            checked={settings.extended.rtlLayout}
            onCheckedChange={(c) => setExtended({ rtlLayout: c })}
            aria-label="RTL layout"
          />
        </Row>
        {/* Prompt J-4037 — low-health vignette color customization.
            The HUD's HP-tier vignette defaults to red (#dc2626) which
            is indistinguishable from the damage-flash red for
            protanopia/deuteranopia players. This picker lets the
            player swap to amber/yellow/etc. so the "I'm hurt" cue
            reads distinctly. The HUD reads
            settings.extended.lowHealthVignetteColor + parses the hex. */}
        <Row label="Low-HP Vignette Color" hint="Recolor the low-health screen-edge cue (useful for colorblind players who can't distinguish red-on-red).">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={settings.extended.lowHealthVignetteColor}
              onChange={(e) => setExtended({ lowHealthVignetteColor: e.target.value })}
              aria-label="Low-HP vignette color"
              className="h-8 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
            />
            <ValuePill>{settings.extended.lowHealthVignetteColor.toUpperCase()}</ValuePill>
          </div>
        </Row>
        <Row label="Reduced Motion" hint="Prompt I-977 — disable springs, auto-rotate, and shimmer site-wide (mirrors prefers-reduced-motion).">
          <ThemedSwitch
            checked={visual.reducedMotion}
            onCheckedChange={(c) => {
              setVisual((p) => ({ ...p, reducedMotion: c }));
              // Prompt I-977 — apply immediately to <html> + persist
              // so the boot-attributes module picks it up on reload.
              if (typeof document !== "undefined") {
                document.documentElement.setAttribute(
                  "data-reduced-motion",
                  String(c),
                );
              }
              saveVisualSettingsBlob({ reducedMotion: c });
            }}
            aria-label="Reduced motion"
          />
        </Row>
        <Row label="HUD Opacity" last>
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[visual.hudOpacity]}
              min={0.5}
              max={1}
              step={0.05}
              onValueChange={(v) =>
                setVisual((p) => ({ ...p, hudOpacity: v[0] }))
              }
              aria-label="HUD opacity"
            />
            <ValuePill>{Math.round(visual.hudOpacity * 100)}%</ValuePill>
          </div>
        </Row>
      </div>
    </div>
  );
}
