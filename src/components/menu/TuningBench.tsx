"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Gauge, Target, Zap, Wrench, Crosshair, TrendingUp, Settings2, Layers, Flame, Crown } from "lucide-react";
import type { LoadoutConfig, WeaponType } from "@/lib/game/store";
import { WEAPONS } from "@/lib/game/store";
import {
  buildTuningBenchReport,
  compareTwoWeapons,
  catalogStats,
  type TuningBenchReport,
} from "@/lib/game/combat/tuning-bench";
import {
  REAL_WORLD_SPECS,
  REAL_WORLD_EXTENDED,
  type ExtendedWeaponSlug,
} from "@/lib/game/combat/weapon-catalog-extended";
import {
  selectorLayoutFor,
  selectorLabel,
  selectorColor,
  selectorSymbol,
} from "@/lib/game/combat/fire-modes";
import { supportsBoltHoldOpen } from "@/lib/game/combat/bolt-catch";
import { railLabel } from "@/lib/game/combat/attachment-sockets";

interface TuningBenchProps {
  loadout: LoadoutConfig;
  className?: string;
}

type Tab = "overview" | "ballistics" | "heat" | "mechanism" | "recommendations";

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "overview",      label: "Overview",      icon: Gauge },
  { id: "ballistics",    label: "Ballistics",    icon: Target },
  { id: "heat",          label: "Heat Soak",     icon: Flame },
  { id: "mechanism",     label: "Mechanism",     icon: Wrench },
  { id: "recommendations", label: "Tuning",      icon: TrendingUp },
];

export function TuningBench({ loadout, className }: TuningBenchProps) {
  const weapon = loadout.weapon;
  const [tab, setTab] = useState<Tab>("overview");
  const [compareWeapon, setCompareWeapon] = useState<WeaponType | null>(null);

  const report = useMemo<TuningBenchReport>(
    () => buildTuningBenchReport(weapon, loadout),
    [weapon, loadout],
  );

  const comparison = useMemo(
    () => compareWeapon ? compareTwoWeapons(weapon, compareWeapon) : null,
    [weapon, compareWeapon],
  );

  const catalogStatList = useMemo(() => catalogStats(), []);

  return (
    <div className={`flex h-full flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-[#0c0d10] ${className ?? ""}`}>
      {/* Header */}
      <header className="flex items-center justify-between border-b border-white/[0.05] px-4 py-3">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-amber-400" />
          <h2 className="text-sm font-bold tracking-tight">Tuning Bench</h2>
          <span className="text-[10px] text-white/40">·</span>
          <span className="text-[11px] font-medium text-white/60">{WEAPONS[weapon]?.name ?? weapon}</span>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.02] px-2 py-1">
          <Crown className="h-3 w-3 text-amber-400" />
          <span className="text-[10px] font-medium text-white/40">
            {catalogStatList[0]?.value ?? "—"}
          </span>
        </div>
      </header>

      {/* Tab strip */}
      <div className="flex gap-1 border-b border-white/[0.05] px-2 py-1.5">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${active ? "text-white" : "text-white/40 hover:text-white/70"}`}
            >
              <Icon className="h-3 w-3" />
              {t.label}
              {active && (
                <motion.div
                  layoutId="tuning-bench-tab"
                  className="absolute inset-0 rounded-md bg-white/[0.08]"
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Body — scrollable */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "overview" && <OverviewTab report={report} />}
        {tab === "ballistics" && <BallisticsTab report={report} />}
        {tab === "heat" && <HeatTab report={report} />}
        {tab === "mechanism" && (
          <MechanismTab
            report={report}
            compareWeapon={compareWeapon}
            onPickCompare={setCompareWeapon}
            comparison={comparison}
          />
        )}
        {tab === "recommendations" && <RecommendationsTab report={report} />}
      </div>
    </div>
  );
}

// ─── Overview tab — real-world spec card. ──────────────────────────────

function OverviewTab({ report }: { report: TuningBenchReport }) {
  const spec = report.realWorldSpec;
  if (!spec) {
    return (
      <div className="text-xs text-white/40">
        No real-world spec available for this weapon.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {/* Hero card — name + cartridge + origin. */}
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/40">Real-World Designation</div>
            <div className="text-base font-bold">{spec.realName}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-white/40">In Service</div>
            <div className="text-sm font-semibold tabular-nums">{spec.inService}</div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Pill label={spec.cartridge} />
          <Pill label={spec.origin} />
          <Pill label={spec.action} />
          <Pill label={spec.feed} />
        </div>
      </div>

      {/* Stat grid. */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Muzzle Velocity" value={report.formattedStats.muzzleVelocity} />
        <StatCard label="Cyclic Rate"     value={report.formattedStats.cyclicRate} />
        <StatCard label="Weight"          value={report.formattedStats.weight} />
        <StatCard label="Barrel Length"   value={report.formattedStats.barrelLength} />
        <StatCard label="Muzzle Energy"   value={report.formattedStats.muzzleEnergy} />
        <StatCard label="Effective Range" value={`${spec.effectiveRangeM} m`} />
      </div>

      {/* History. */}
      <div>
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-white/40">Background</div>
        <p className="text-xs leading-relaxed text-white/70">{spec.history}</p>
      </div>

      {/* Fire modes. */}
      <div>
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-white/40">Fire Modes</div>
        <div className="flex flex-wrap gap-1.5">
          {report.fireSelectorPositions.map((p) => (
            <div
              key={p}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1"
              style={{ borderColor: `${selectorColor(p)}40` }}
            >
              <span className="text-xs font-bold" style={{ color: selectorColor(p) }}>
                {selectorSymbol(p)}
              </span>
              <span className="text-[10px] font-medium" style={{ color: selectorColor(p) }}>
                {selectorLabel(p)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Rail system. */}
      <div>
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-white/40">Rail System</div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-white/60">Top rail</span>
            <span className="font-medium">{railLabel(report.railSummary.topRail.system)} · {report.railSummary.topRail.slotCount} slots</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-white/60">Handguard</span>
            <span className="font-medium">{railLabel(report.railSummary.handguardRail.system)} · {report.railSummary.handguardRail.slotCount} slots</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-white/60">Total slots</span>
            <span className="font-medium tabular-nums">{report.railSummary.totalSlots}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-white/60">QD sling sockets</span>
            <span className="font-medium">{report.railSummary.hasQdSockets ? "Yes" : "No"}</span>
          </div>
        </div>
      </div>

      {/* Bolt-hold-open. */}
      <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
        <span className="text-xs text-white/60">Last-Round Bolt Hold-Open</span>
        <span className={`text-xs font-medium ${report.supportsBho ? "text-emerald-400" : "text-rose-400"}`}>
          {report.supportsBho ? "Supported" : "Not Supported"}
        </span>
      </div>
    </div>
  );
}

// ─── Ballistics tab — drop + wind drift charts. ──────────────────────

function BallisticsTab({ report }: { report: TuningBenchReport }) {
  return (
    <div className="space-y-4">
      {/* Drop chart. */}
      <div>
        <div className="mb-2 flex items-center gap-1.5">
          <Target className="h-3 w-3 text-amber-400" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">Bullet Drop</span>
        </div>
        <ChartTable
          headers={["Range", "Drop", "TOF", "Velocity", "Energy"]}
          rows={report.dropChart.map((r) => [
            `${r.rangeM} m`,
            `${r.dropCm.toFixed(1)} cm`,
            `${r.tofSec.toFixed(2)} s`,
            `${r.velocityMs} m/s`,
            `${r.energyJ} J`,
          ])}
        />
      </div>

      {/* Wind drift chart. */}
      <div>
        <div className="mb-2 flex items-center gap-1.5">
          <Zap className="h-3 w-3 text-amber-400" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">Wind Drift</span>
        </div>
        <ChartTable
          headers={["Range", "5 m/s", "10 m/s", "15 m/s"]}
          rows={report.windDriftChart.map((r) => [
            `${r.rangeM} m`,
            `${r.wind5MsCm.toFixed(1)} cm`,
            `${r.wind10MsCm.toFixed(1)} cm`,
            `${r.wind15MsCm.toFixed(1)} cm`,
          ])}
        />
      </div>

      {/* Optic parallax info. */}
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="mb-1.5 flex items-center gap-1.5">
          <Crosshair className="h-3 w-3 text-amber-400" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">Optic Parallax</span>
        </div>
        <div className="space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-white/60">Factory zero</span>
            <span className="font-medium tabular-nums">
              {report.opticParallaxFactoryZero === Infinity ? "∞" : `${report.opticParallaxFactoryZero} m`}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/60">Adjustable</span>
            <span className="font-medium">{report.opticParallaxAdjustable ? "Yes" : "No"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Heat soak tab — POI shift vs rounds fired. ─────────────────────

function HeatTab({ report }: { report: TuningBenchReport }) {
  const maxPoiV = Math.max(...report.heatSoakChart.map((r) => r.poiVerticalMoa), 1);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="mb-2 flex items-center gap-1.5">
          <Flame className="h-3 w-3 text-amber-400" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">Barrel Heat Profile</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <StatRow label="Barrel mass" value={`${report.heatProfile.barrelMassKg} kg`} />
          <StatRow label="Profile" value={report.heatProfile.profile} />
          <StatRow label="Heat per shot" value={`${report.heatProfile.heatPerShotJ} J`} />
          <StatRow label="Heat capacity" value={`${(report.heatProfile.heatCapacityJ / 1000).toFixed(1)} kJ`} />
          <StatRow label="Cooling rate" value={`${report.heatProfile.coolingRateJPerSec} J/s`} />
          <StatRow label="Cook-off at" value={`${report.heatProfile.cookOffThresholdC} °C`} />
        </div>
      </div>

      {/* POI shift chart — vertical bars. */}
      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/60">
          POI Shift vs Rounds Fired
        </div>
        <div className="space-y-1.5">
          {report.heatSoakChart.map((r) => (
            <div key={r.roundsFired} className="flex items-center gap-2">
              <div className="w-16 text-right text-[10px] tabular-nums text-white/50">{r.roundsFired} rds</div>
              <div className="relative h-4 flex-1 overflow-hidden rounded bg-white/[0.03]">
                <div
                  className="absolute inset-y-0 left-0 rounded"
                  style={{
                    width: `${Math.max(2, (r.poiVerticalMoa / maxPoiV) * 100)}%`,
                    background: `linear-gradient(90deg, ${barColor(r.heatFraction)}, ${barColor(r.heatFraction)})`,
                  }}
                />
              </div>
              <div className="w-20 text-[10px] tabular-nums text-white/70">
                +{r.poiVerticalMoa.toFixed(1)} MOA
              </div>
              <div className="w-12 text-[10px] tabular-nums text-white/40">
                {Math.round(r.heatFraction * 100)}%
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-white/40">
        Barrels deform as they heat up. A precision rifle dumping a 5-round string may see ~0.5 MOA shift;
        an LMG dumping a belt may see ~2 MOA shift. The point of impact walks up + to the right.
      </p>
    </div>
  );
}

function barColor(fraction: number): string {
  if (fraction < 0.5) return "#10b981";       // green
  if (fraction < 0.75) return "#f59e0b";      // amber
  return "#ef4444";                            // red
}

// ─── Mechanism tab — fire selector + reload timing + trigger. ────────

function MechanismTab({
  report,
  compareWeapon,
  onPickCompare,
  comparison,
}: {
  report: TuningBenchReport;
  compareWeapon: WeaponType | null;
  onPickCompare: (w: WeaponType | null) => void;
  comparison: ReturnType<typeof compareTwoWeapons> | null;
}) {
  return (
    <div className="space-y-4">
      {/* Selector diagram. */}
      <div>
        <div className="mb-2 flex items-center gap-1.5">
          <Layers className="h-3 w-3 text-amber-400" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">Fire Selector</span>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-2">
          {report.fireSelectorPositions.map((p, i) => (
            <div key={p} className="flex items-center gap-1">
              <div
                className="flex h-9 w-12 flex-col items-center justify-center rounded border-2"
                style={{ borderColor: selectorColor(p), background: `${selectorColor(p)}15` }}
              >
                <span className="text-sm font-bold" style={{ color: selectorColor(p) }}>
                  {selectorSymbol(p)}
                </span>
                <span className="text-[8px] font-medium uppercase" style={{ color: selectorColor(p) }}>
                  {selectorLabel(p)}
                </span>
              </div>
              {i < report.fireSelectorPositions.length - 1 && (
                <div className="text-white/20">→</div>
              )}
            </div>
          ))}
        </div>
        {report.burstRounds > 0 && (
          <div className="mt-1.5 text-[10px] text-white/40">
            Burst count: <span className="font-medium text-white/60">{report.burstRounds} rounds</span>
          </div>
        )}
      </div>

      {/* Trigger spec. */}
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/60">Trigger</div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <StatRow label="Type" value={report.triggerSpec.type.replace(/_/g, " ")} />
          <StatRow label="Pull weight" value={`${report.triggerSpec.pullWeightN} N`} />
          <StatRow label="Travel" value={`${report.triggerSpec.travelMm} mm`} />
          <StatRow label="Reset" value={`${report.triggerSpec.resetMm} mm`} />
          <StatRow label="Takeup" value={`${report.triggerSpec.takeupMm} mm`} />
          <StatRow label="Reset click" value={report.triggerSpec.resetClickAudible ? "Audible" : "Silent"} />
        </div>
      </div>

      {/* Reload timing. */}
      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/60">Reload Timing</div>
        <div className="space-y-2">
          {report.reloadTimings.map((rt) => {
            const stages = rt.stages;
            return (
              <div key={rt.type} className="rounded-lg border border-white/10 bg-white/[0.02] p-2">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[11px] font-medium capitalize">{rt.type} Reload</span>
                  <span className="text-[11px] font-bold tabular-nums text-amber-400">
                    {(rt.totalMs / 1000).toFixed(2)} s
                  </span>
                </div>
                <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.05]">
                  {stages.map((s, i) => (
                    <div
                      key={s.label}
                      className="h-full"
                      style={{
                        width: `${(s.durationMs / rt.totalMs) * 100}%`,
                        background: STAGE_COLORS[i % STAGE_COLORS.length],
                      }}
                      title={`${s.label}: ${s.durationMs} ms`}
                    />
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[9px] text-white/40">
                  {stages.map((s) => (
                    <span key={s.label}>{s.label}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Weapon comparison. */}
      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/60">
          Compare with…
        </div>
        <select
          value={compareWeapon ?? ""}
          onChange={(e) => onPickCompare(e.target.value as WeaponType || null)}
          className="w-full rounded-md border border-white/10 bg-white/[0.02] px-2 py-1.5 text-xs text-white"
        >
          <option value="">— None —</option>
          {(Object.keys(REAL_WORLD_SPECS) as WeaponType[]).map((w) => (
            <option key={w} value={w} className="bg-[#0c0d10]">
              {REAL_WORLD_SPECS[w].realName}
            </option>
          ))}
          {(Object.keys(REAL_WORLD_EXTENDED) as ExtendedWeaponSlug[]).map((w) => (
            <option key={w} value={REAL_WORLD_EXTENDED[w].closestGameSlug} className="bg-[#0c0d10]">
              {REAL_WORLD_EXTENDED[w].realName} (registry)
            </option>
          ))}
        </select>
        {comparison && (
          <div className="mt-2 overflow-hidden rounded-lg border border-white/10">
            <ChartTable
              headers={["Stat", "A", "B"]}
              rows={comparison.map((c) => [
                c.label,
                c.weaponA,
                c.weaponB,
              ])}
              highlightCol={comparison[0] ? undefined : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const STAGE_COLORS = ["#3b82f6", "#f59e0b", "#ef4444"];

// ─── Recommendations tab. ────────────────────────────────────────────

function RecommendationsTab({ report }: { report: TuningBenchReport }) {
  return (
    <div className="space-y-2">
      {report.recommendations.map((r, i) => (
        <motion.div
          key={`${r.category}-${i}`}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.04 }}
          className="rounded-lg border border-white/10 bg-white/[0.02] p-3"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <TrendingUp className="h-3 w-3 text-amber-400" />
              <span className="text-xs font-semibold">{r.title}</span>
            </div>
            <span
              className="rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider"
              style={{
                background: priorityColor(r.priority) + "20",
                color: priorityColor(r.priority),
              }}
            >
              {r.category}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-white/60">{r.description}</p>
          <div className="mt-1.5 flex items-center gap-1">
            <span className="text-[9px] uppercase tracking-wider text-white/30">Priority</span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${r.priority * 100}%`,
                  background: priorityColor(r.priority),
                }}
              />
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function priorityColor(p: number): string {
  if (p > 0.75) return "#ef4444"; // red — critical
  if (p > 0.55) return "#f59e0b"; // amber — important
  return "#10b981";               // green — nice-to-have
}

// ─── Shared small components. ────────────────────────────────────────

function Pill({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-white/70">
      {label}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
      <div className="text-[9px] font-medium uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/50">{label}</span>
      <span className="font-medium capitalize">{value}</span>
    </div>
  );
}

function ChartTable({ headers, rows }: { headers: string[]; rows: string[][]; highlightCol?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      <table className="w-full text-xs">
        <thead className="bg-white/[0.04]">
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className={`px-2 py-1.5 text-left text-[9px] font-semibold uppercase tracking-wider text-white/50 ${i === 0 ? "" : "text-right"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? "bg-white/[0.01]" : "bg-transparent"}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-2 py-1.5 tabular-nums ${j === 0 ? "text-white/70" : "text-right text-white/90"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
