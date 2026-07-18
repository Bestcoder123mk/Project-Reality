"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { buildWeaponModel } from "@/lib/game/weaponModel";
import { applyTacticalEnvironment } from "@/lib/game/rendering/TacticalEnvironment";
import type { LoadoutConfig, WeaponType } from "@/lib/game/store";
import { WEAPONS } from "@/lib/game/store";
import { applyWrapToWeapon } from "@/lib/game/Wraps";
import { attachCharm, type CharmSlug } from "@/lib/game/Charms";
import type { WrapSlug } from "@/lib/game/Wraps";
import { REAL_WORLD_SPECS, formatMuzzleVelocity, formatWeight, formatMuzzleEnergy, formatCyclicRate } from "@/lib/game/combat/weapon-catalog-extended";
import { selectorLayoutFor, selectorLabel, selectorColor, selectorSymbol } from "@/lib/game/combat/fire-modes";
import { railSummaryFor, railLabel } from "@/lib/game/combat/attachment-sockets";

/**
 * Gunsmith3D — weapon preview pod with drag-to-rotate + auto-spin.
 *
 * Prompt J-4139 / J-4140 — weapon inspect / firing range. The
 * Gunsmith3D pod is the weapon-inspect 3D viewport: the player
 * drags to rotate the weapon, sees the wrap/charm/attachments
 * live, + the auto-spin gives a 360° tour. The "firing range
 * preview from shop" (J-4025 / J-4140) uses the same shared
 * <WeaponPreview3D> export (compact mode) so the shop can embed
 * a live weapon preview in each card cell. The test-fire mode
 * (animated muzzle flash + recoil) is the next-layer feature,
 * flagged for a future art pass.
 *
 * Section D enhancement — `showStats` overlay: when enabled, overlays
 * real-world weapon specs (muzzle velocity, weight, fire selector
 * diagram, rail system) on top of the 3D view. Players get instant
 * provenance for the in-game stat.
 *
 * V7 — Task 2-d: shared via the new <WeaponPreview3D> export. The original
 * <Gunsmith3D> export is preserved as a thin wrapper for backward compat.
 * The shared component accepts the loadout + an optional wrap/charm (so the
 * shop + gunsmith can both preview wraps + charms) + a `compact` mode for
 * small card cells (lower pixel ratio, no shadows, slower spin).
 *
 * V6 — Fix: same ResizeObserver deferred-init pattern as OperatorPreview3D.
 * V5 — Performance + polish (retained): dirty-flag rendering, visibility-
 *      aware RAF, reduced shadow map, turntable deceleration.
 */
export interface WeaponPreview3DProps {
  loadout: LoadoutConfig;
  /** Optional wrap slug to preview on the weapon (default: loadout.skin-derived). */
  wrapSlug?: WrapSlug;
  /** Optional charm slug to preview on the weapon's socket_charm. */
  charmSlug?: CharmSlug;
  /** Compact mode — slimmer lighting, no shadows, lower pixel ratio, slower
   *  spin. For shop cards where many viewers may coexist. */
  compact?: boolean;
  /** Disable auto-spin (drag still works). */
  autoSpin?: boolean;
  /** Show real-world spec overlay (top-right corner). */
  showStats?: boolean;
  /** Class name passthrough. */
  className?: string;
}

export function WeaponPreview3D({
  loadout,
  wrapSlug,
  charmSlug,
  compact = false,
  autoSpin = true,
  showStats = false,
  className,
}: WeaponPreview3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [statsExpanded, setStatsExpanded] = useState(true);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    modelGroup: THREE.Group;
    rotY: number;
    rotX: number;
    targetRotY: number;
    targetRotX: number;
    autoSpin: boolean;
    idleTime: number;
  } | null>(null);
  const dirtyRef = useRef(true);
  const visibleRef = useRef(true);

  // Init once — V6 deferred via ResizeObserver.
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let disposed = false;
    let sceneCleanup: (() => void) | null = null;

    const initScene = () => {
      if (disposed || sceneCleanup) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w < 2 || h < 2) return; // wait for ResizeObserver

      const renderer = new THREE.WebGLRenderer({
        antialias: !compact,
        alpha: true,
        powerPreference: compact ? "default" : "high-performance",
      });
      renderer.setSize(w, h);
      renderer.setPixelRatio(compact ? 1 : Math.min(window.devicePixelRatio, 1.75));
      renderer.shadowMap.enabled = !compact;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = compact ? 1.05 : 1.1;
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      applyTacticalEnvironment(scene, renderer);
      const bgGeo = new THREE.SphereGeometry(50, 32, 16);
      const bgMat = new THREE.ShaderMaterial({
        uniforms: { c1: { value: new THREE.Color(0x1a1a22) }, c2: { value: new THREE.Color(0x0a0a0c) } },
        vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
        fragmentShader: `uniform vec3 c1; uniform vec3 c2; varying vec3 vP; void main(){ float h=normalize(vP).y*0.5+0.5; gl_FragColor=vec4(mix(c2,c1,h),1.0);}`,
        side: THREE.BackSide,
      });
      scene.add(new THREE.Mesh(bgGeo, bgMat));

      const camera = new THREE.PerspectiveCamera(compact ? 36 : 40, w / h, 0.1, 100);
      camera.position.set(0, compact ? 0.4 : 0.6, compact ? 4.5 : 5.5);
      camera.lookAt(0, 0, 0);

      scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, compact ? 0.6 : 0.5));
      const key = new THREE.DirectionalLight(0xffffff, compact ? 1.6 : 2.2);
      key.position.set(4, 6, 5);
      if (!compact) {
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.near = 1; key.shadow.camera.far = 30;
        key.shadow.camera.left = -2.5; key.shadow.camera.right = 2.5;
        key.shadow.camera.top = 2.5; key.shadow.camera.bottom = -2.5;
        key.shadow.bias = -0.0003;
      }
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x88aaff, compact ? 0.5 : 0.6); fill.position.set(-5, 2, 3); scene.add(fill);
      const rim = new THREE.DirectionalLight(0xffaa66, compact ? 0.6 : 0.8); rim.position.set(0, 3, -5); scene.add(rim);

      // Podium — smaller in compact mode.
      const podiumRadius = compact ? 1.3 : 1.6;
      const podium = new THREE.Mesh(
        new THREE.CylinderGeometry(podiumRadius, podiumRadius + 0.2, 0.15, 48),
        new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.4, metalness: 0.7 })
      );
      podium.position.y = -1.0;
      if (!compact) podium.receiveShadow = true;
      scene.add(podium);
      const podiumRing = new THREE.Mesh(
        new THREE.TorusGeometry(podiumRadius + 0.05, 0.02, 12, 64),
        new THREE.MeshStandardMaterial({ color: 0x6a6a78, roughness: 0.3, metalness: 0.9, emissive: 0x222230 })
      );
      podiumRing.rotation.x = Math.PI / 2; podiumRing.position.y = -0.92;
      scene.add(podiumRing);

      const modelGroup = new THREE.Group();
      scene.add(modelGroup);

      const state = { renderer, scene, camera, modelGroup, rotY: -0.4, rotX: 0.05, targetRotY: -0.4, targetRotX: 0.05, autoSpin, idleTime: 0 };
      sceneRef.current = state;
      dirtyRef.current = true;

      let dragging = false;
      let lastX = 0, lastY = 0;
      const onDown = (e: PointerEvent) => { dragging = true; state.autoSpin = false; state.idleTime = 0; lastX = e.clientX; lastY = e.clientY; (e.target as HTMLElement).setPointerCapture(e.pointerId); };
      const onMove = (e: PointerEvent) => {
        if (!dragging) return;
        const dx = e.clientX - lastX; const dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
        state.targetRotY += dx * 0.01;
        state.targetRotX = Math.max(-0.6, Math.min(0.6, state.targetRotX + dy * 0.01));
        state.idleTime = 0;
        dirtyRef.current = true;
      };
      const onUp = () => { dragging = false; };
      renderer.domElement.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);

      const onVisibility = () => {
        const wasVisible = visibleRef.current;
        visibleRef.current = !document.hidden;
        if (visibleRef.current && !wasVisible) {
          dirtyRef.current = true;
          raf = requestAnimationFrame(loop);
        } else if (!visibleRef.current && wasVisible) {
          cancelAnimationFrame(raf);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);

      let raf = 0;
      const clock = new THREE.Clock();
      const loop = () => {
        if (!visibleRef.current) return;
        raf = requestAnimationFrame(loop);
        const dt = clock.getDelta();

        let moved = false;
        if (state.autoSpin) {
          state.idleTime += dt;
          // Compact: slower spin + never speeds up after idle (calmer in shop grid).
          const spinRate = compact ? 0.18 : (state.idleTime > 8 ? 0.03 : 0.3);
          state.targetRotY += dt * spinRate;
          moved = true;
        } else {
          state.idleTime = 0;
        }
        const rotYDelta = (state.targetRotY - state.rotY) * 0.1;
        const rotXDelta = (state.targetRotX - state.rotX) * 0.1;
        if (Math.abs(rotYDelta) > 0.0001 || Math.abs(rotXDelta) > 0.0001) {
          state.rotY += rotYDelta;
          state.rotX += rotXDelta;
          modelGroup.rotation.y = state.rotY;
          modelGroup.rotation.x = state.rotX;
          moved = true;
        } else if (state.targetRotY !== state.rotY || state.targetRotX !== state.rotX) {
          state.rotY = state.targetRotY;
          state.rotX = state.targetRotX;
          modelGroup.rotation.y = state.rotY;
          modelGroup.rotation.x = state.rotX;
          moved = true;
        }

        if (moved || dirtyRef.current) {
          renderer.render(scene, camera);
          dirtyRef.current = false;
        }
      };
      loop();

      const onResize = () => {
        const nw = container.clientWidth; const nh = container.clientHeight;
        if (nw < 2 || nh < 2) return;
        camera.aspect = nw / nh; camera.updateProjectionMatrix();
        renderer.setSize(nw, nh);
        dirtyRef.current = true;
      };
      window.addEventListener("resize", onResize);

      sceneCleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("resize", onResize);
        document.removeEventListener("visibilitychange", onVisibility);
        renderer.domElement.removeEventListener("pointerdown", onDown);
        bgGeo.dispose();
        bgMat.dispose();
        podium.geometry.dispose();
        (podium.material as THREE.Material).dispose();
        podiumRing.geometry.dispose();
        (podiumRing.material as THREE.Material).dispose();
        renderer.dispose();
        if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement);
        sceneRef.current = null;
      };
    };

    // V6 — try immediate init; fall back to ResizeObserver.
    initScene();

    let extraCleanups: (() => void)[] = [];
    if (!sceneCleanup) {
      let ro: ResizeObserver | null = new ResizeObserver(() => {
        initScene();
        if (sceneCleanup && ro) { ro.disconnect(); ro = null; }
      });
      ro.observe(container);
      const fallbackTimer = setTimeout(() => {
        initScene();
        if (sceneCleanup && ro) { ro.disconnect(); ro = null; }
      }, 100);
      extraCleanups = [
        () => { clearTimeout(fallbackTimer); if (ro) { ro.disconnect(); ro = null; } },
      ];
    }

    return () => {
      disposed = true;
      for (const c of extraCleanups) c();
      sceneCleanup?.();
    };
  }, [compact, autoSpin]);

  // Rebuild model when loadout/wrap/charm changes.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    while (s.modelGroup.children.length > 0) {
      const ch = s.modelGroup.children[0];
      s.modelGroup.remove(ch);
      ch.traverse((o) => {
        if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
      });
    }
    const model = buildWeaponModel(loadout);
    model.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = !compact; o.receiveShadow = !compact; } });
    // Apply wrap (if specified) — re-tints the body-class meshes.
    if (wrapSlug && wrapSlug !== "default") {
      applyWrapToWeapon(model, wrapSlug);
    }
    // Attach charm (if specified) — adds a small mesh to the socket_charm.
    if (charmSlug && charmSlug !== "none") {
      attachCharm(model, charmSlug);
    }
    s.modelGroup.add(model);
    dirtyRef.current = true;
  }, [loadout, wrapSlug, charmSlug, compact]);

  return (
    <div
      ref={containerRef}
      className={className ?? "h-full w-full cursor-grab active:cursor-grabbing touch-none"}
    >
      {showStats && (
        <StatOverlay
          weapon={loadout.weapon}
          expanded={statsExpanded}
          onToggle={() => setStatsExpanded((e) => !e)}
        />
      )}
    </div>
  );
}

// ─── Section D — Real-world spec overlay ────────────────────────────────
// Renders a translucent card with verified real-world weapon specs (muzzle
// velocity, weight, fire selector diagram, rail system). The card can be
// collapsed to a single chip when not in use.

function StatOverlay({
  weapon,
  expanded,
  onToggle,
}: {
  weapon: WeaponType;
  expanded: boolean;
  onToggle: () => void;
}) {
  const spec = REAL_WORLD_SPECS[weapon];
  const layout = selectorLayoutFor(weapon);
  const rail = railSummaryFor(weapon);
  const cfg = WEAPONS[weapon];

  if (!spec) return null;

  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-10 max-w-[260px]">
      <div className="overflow-hidden rounded-xl border border-white/10 bg-black/50 backdrop-blur-xl">
        {/* Header — always visible (collapse toggle). */}
        <button
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-2 border-b border-white/[0.05] px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
        >
          <div className="min-w-0">
            <div className="truncate text-[10px] font-medium uppercase tracking-wider text-amber-400/80">
              {cfg?.category ?? "—"} · {spec.origin}
            </div>
            <div className="truncate text-xs font-bold text-white">{spec.realName}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-amber-300">
              {spec.inService}
            </span>
            <span className="text-[10px] text-white/40">{expanded ? "▾" : "▸"}</span>
          </div>
        </button>

        {/* Body — collapsed/expanded. */}
        {expanded && (
          <div className="space-y-2.5 px-3 py-2.5">
            {/* Cartridge + action. */}
            <div className="flex flex-wrap gap-1">
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-medium text-white/70">
                {spec.cartridge}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-medium text-white/70">
                {spec.action.replace(/_/g, " ")}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-medium text-white/70">
                {spec.feed.replace(/_/g, " ")}
              </span>
            </div>

            {/* Spec grid. */}
            <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px]">
              <SpecRow label="MV" value={formatMuzzleVelocity(spec.muzzleVelocityMs).split(" · ")[0]} />
              <SpecRow label="Energy" value={`${spec.muzzleEnergyJ} J`} />
              <SpecRow label="Weight" value={formatWeight(spec.weightKg).split(" · ")[0]} />
              <SpecRow label="ROF" value={formatCyclicRate(spec.cyclicRpm)} />
              <SpecRow label="Barrel" value={`${spec.barrelMm} mm`} />
              <SpecRow label="Range" value={`${spec.effectiveRangeM} m`} />
            </div>

            {/* Fire selector diagram. */}
            <div>
              <div className="mb-1 text-[8px] font-semibold uppercase tracking-wider text-white/40">
                Selector
              </div>
              <div className="flex items-center gap-0.5">
                {layout.positions.map((p, i) => (
                  <div key={p} className="flex items-center gap-0.5">
                    <div
                      className="flex h-5 w-7 items-center justify-center rounded border text-[9px] font-bold"
                      style={{
                        borderColor: `${selectorColor(p)}60`,
                        background: `${selectorColor(p)}15`,
                        color: selectorColor(p),
                      }}
                    >
                      {selectorSymbol(p)}
                    </div>
                    {i < layout.positions.length - 1 && (
                      <span className="text-[8px] text-white/20">→</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Rail system. */}
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-white/40">Rail</span>
              <span className="font-medium text-white/70">
                {railLabel(rail.topRail.system)} · {rail.totalSlots} slots
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-1">
      <span className="text-[8px] font-medium uppercase tracking-wider text-white/40">{label}</span>
      <span className="truncate text-right font-semibold tabular-nums text-white/80">{value}</span>
    </div>
  );
}

/**
 * Gunsmith3D — original export. Preserved for backward compat.
 * Equivalent to <WeaponPreview3D loadout={loadout} />.
 */
export function Gunsmith3D({ loadout }: { loadout: LoadoutConfig }) {
  return <WeaponPreview3D loadout={loadout} showStats />;
}
