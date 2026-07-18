"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useGameStore, type OperatorSettings, BODY_TYPES } from "@/lib/game/store";
import { buildHumanoid } from "@/lib/game/systems/utils";
import { applyTacticalEnvironment } from "@/lib/game/rendering/TacticalEnvironment";

/**
 * OperatorPreview3D — live Three.js render of the operator figure.
 * Shared by MainMenu (hero) and OperatorCreator (customization lab).
 *
 * Prompt J-4023 / J-4137 — 3D background on the MainMenu. The
 * operator preview IS the 3D element on the menu — a live Three.js
 * scene with a humanoid figure, tactical environment lighting, +
 * auto-rotate. Mounted as the hero panel of the MainMenu.
 *
 * Prompt J-4112 / J-4138 — loading operator / operator inspect.
 * The same component serves as the operator-inspect 3D viewport
 * on the OperatorScreen (the player can rotate + zoom the figure).
 *
 * V6 — Fix: preview not loading. The container div can report 0×0 on the
 * first effect run (React 19 concurrent rendering + framer-motion initial
 * animation delay). Creating a WebGLRenderer at 0×0 produces an invisible
 * canvas. We now defer init until the ResizeObserver fires with a non-zero
 * size. If the size is already non-zero, we init immediately.
 *
 * V5 — Performance + polish pass (retained):
 *   - Dirty-flag rendering, visibility-aware RAF, reduced shadow map,
 *     powerPreference, idle breathing, contact shadow, drag-staleness fix.
 */
export function OperatorPreview3D({
  operator,
  operatorSlug,
  className,
  cameraDistance = 3.0,
  cameraHeight = 1.35,
  lookAtY = 1.1,
  autoRotate = true,
}: {
  operator: OperatorSettings;
  operatorSlug?: string;
  className?: string;
  cameraDistance?: number;
  cameraHeight?: number;
  lookAtY?: number;
  autoRotate?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const figureRef = useRef<THREE.Group | null>(null);
  const chestRef = useRef<THREE.Object3D | null>(null);
  const rafRef = useRef<number>(0);
  const autoRotateRef = useRef(autoRotate);
  const lastInteractionRef = useRef(0);
  const dragRef = useRef({ active: false, x: 0, rotY: 0 });
  const cameraDistanceRef = useRef(cameraDistance);
  const dirtyRef = useRef(true);
  const visibleRef = useRef(true);

  // Build the scene once. V6 — deferred init via ResizeObserver.
  useEffect(() => {
    if (!mountRef.current) return;
    const mount = mountRef.current;
    let disposed = false;
    let sceneCleanup: (() => void) | null = null;

    const initScene = () => {
      if (disposed || sceneCleanup) return;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w < 2 || h < 2) return; // wait for ResizeObserver

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(28, w / h, 0.1, 100);
      camera.position.set(0, cameraHeight, cameraDistance);
      camera.lookAt(0, lookAtY, 0);

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      mount.appendChild(renderer.domElement);

      applyTacticalEnvironment(scene, renderer);

      // Studio 3-point lighting.
      const key = new THREE.DirectionalLight(0xfff0e0, 2.0);
      key.position.set(2.5, 4, 3.5); key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.near = 0.5; key.shadow.camera.far = 15;
      key.shadow.camera.left = -2; key.shadow.camera.right = 2;
      key.shadow.camera.top = 2.5; key.shadow.camera.bottom = -0.5;
      key.shadow.bias = -0.0003;
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x88aaff, 0.6);
      fill.position.set(-3, 2, 2);
      scene.add(fill);
      const rim = new THREE.DirectionalLight(0xff8c1a, 0.9);
      rim.position.set(-1, 2.5, -3);
      scene.add(rim);
      const kicker = new THREE.DirectionalLight(0xa0c0ff, 0.4);
      kicker.position.set(2, 1.5, -2);
      scene.add(kicker);
      scene.add(new THREE.AmbientLight(0x404050, 0.4));

      // Soft radial contact shadow under the feet.
      const contactShadowTex = makeRadialShadowTexture();
      const contactShadow = new THREE.Mesh(
        new THREE.CircleGeometry(0.9, 32),
        new THREE.MeshBasicMaterial({
          map: contactShadowTex,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        }),
      );
      contactShadow.rotation.x = -Math.PI / 2;
      contactShadow.position.y = 0.01;
      scene.add(contactShadow);

      // Ground plane for the directional shadow.
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(3, 32),
        new THREE.ShadowMaterial({ opacity: 0.35 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);

      sceneRef.current = scene;
      cameraRef.current = camera;
      rendererRef.current = renderer;
      dirtyRef.current = true;

      const onResize = () => {
        if (!mountRef.current || !rendererRef.current || !cameraRef.current) return;
        const nw = mountRef.current.clientWidth;
        const nh = mountRef.current.clientHeight;
        if (nw < 2 || nh < 2) return;
        rendererRef.current.setSize(nw, nh);
        cameraRef.current.aspect = nw / nh;
        cameraRef.current.updateProjectionMatrix();
        dirtyRef.current = true;
      };
      window.addEventListener("resize", onResize);

      const onVisibility = () => {
        const wasVisible = visibleRef.current;
        visibleRef.current = !document.hidden;
        if (visibleRef.current && !wasVisible) {
          dirtyRef.current = true;
          lastInteractionRef.current = performance.now();
          rafRef.current = requestAnimationFrame(animate);
        } else if (!visibleRef.current && wasVisible) {
          cancelAnimationFrame(rafRef.current);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);

      const animate = () => {
        if (!visibleRef.current) return;
        rafRef.current = requestAnimationFrame(animate);

        let moved = false;
        if (figureRef.current) {
          const now = performance.now();
          if (autoRotateRef.current && now - lastInteractionRef.current > 4000) {
            figureRef.current.rotation.y += 0.005;
            dragRef.current.rotY = figureRef.current.rotation.y;
            moved = true;
          }
          // Idle breathing.
          const breathPhase = now * 0.00045;
          const bob = Math.sin(breathPhase * 2) * 0.015;
          const chestPulse = 1.0 + Math.sin(breathPhase * 2 + 0.3) * 0.012;
          figureRef.current.position.y = bob;
          if (chestRef.current) {
            chestRef.current.scale.set(chestPulse, 1.0, 1.0);
          }
          moved = true;
        }

        if (moved || dirtyRef.current) {
          renderer.render(scene, camera);
          dirtyRef.current = false;
        }
      };
      animate();

      // V6 — store cleanup closure. Called on unmount or re-init.
      sceneCleanup = () => {
        window.removeEventListener("resize", onResize);
        document.removeEventListener("visibilitychange", onVisibility);
        cancelAnimationFrame(rafRef.current);
        contactShadowTex.dispose();
        (contactShadow.material as THREE.Material).dispose();
        contactShadow.geometry.dispose();
        ground.geometry.dispose();
        (ground.material as THREE.Material).dispose();
        renderer.dispose();
        if (renderer.domElement.parentElement === mount) {
          mount.removeChild(renderer.domElement);
        }
        sceneRef.current = null;
        cameraRef.current = null;
        rendererRef.current = null;
      };
    };

    // Try to init immediately. If the container is 0×0, the ResizeObserver
    // will fire once layout resolves and init then.
    initScene();

    // V6 — If init didn't happen (container was 0×0), set up a ResizeObserver
    // + fallback timer to init when the container gets a real size. We use
    // a wrapper cleanup array so TypeScript doesn't narrow sceneCleanup to
    // null inside the if-block (which would make the reassignment `never`).
    let extraCleanups: (() => void)[] = [];
    if (!sceneCleanup) {
      let ro: ResizeObserver | null = new ResizeObserver(() => {
        initScene();
        if (sceneCleanup && ro) { ro.disconnect(); ro = null; }
      });
      ro.observe(mount);
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
  }, [cameraDistance, cameraHeight, lookAtY]);

  // Rebuild the figure when operator settings change.
  const equippedCustomization = useGameStore((s) => s.equippedCustomization);
  useEffect(() => {
    if (!sceneRef.current) return;
    if (figureRef.current) {
      sceneRef.current.remove(figureRef.current);
      figureRef.current.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    chestRef.current = null;

    const suitHex = parseInt(operator.suitColor.replace("#", "0x"));
    const skinStops = [0xfce7d4, 0xf0c8a8, 0xd9a878, 0xc08858, 0xa06840, 0x804828, 0x603818, 0x3a2418];
    const toneIdx = Math.min(7, Math.max(0, Math.floor(operator.skinTone * 7)));
    const skinHex = skinStops[toneIdx];
    const bodyScale = BODY_TYPES.find((b) => b.slug === operator.bodyType)?.scale ?? 1.0;
    const heightScale = operator.heightCm / 180;

    const customOverride = equippedCustomization && equippedCustomization.baseSlug === operatorSlug
      ? equippedCustomization.overrides
      : undefined;
    const built = buildHumanoid(suitHex, skinHex, operatorSlug, customOverride);
    const group = built.group;
    group.scale.setScalar(operatorSlug ? 1.0 : heightScale * bodyScale);
    group.rotation.y = dragRef.current.rotY;
    sceneRef.current.add(group);
    figureRef.current = group;

    chestRef.current = built.parts["body"] ?? null;
    dirtyRef.current = true;
  }, [operator, operatorSlug, equippedCustomization]);

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current.active = true;
    dragRef.current.x = e.clientX;
    autoRotateRef.current = false;
    lastInteractionRef.current = performance.now();
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current.active || !figureRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    dragRef.current.x = e.clientX;
    dragRef.current.rotY += dx * 0.01;
    figureRef.current.rotation.y = dragRef.current.rotY;
    lastInteractionRef.current = performance.now();
    dirtyRef.current = true;
  };
  const onMouseUp = () => {
    dragRef.current.active = false;
    setTimeout(() => {
      if (performance.now() - lastInteractionRef.current >= 3900) autoRotateRef.current = autoRotate;
    }, 4000);
  };
  const onWheel = (e: React.WheelEvent) => {
    cameraDistanceRef.current = Math.max(2.5, Math.min(7, cameraDistanceRef.current + e.deltaY * 0.003));
    if (cameraRef.current) {
      cameraRef.current.position.z = cameraDistanceRef.current;
    }
    dirtyRef.current = true;
  };

  return (
    <div
      ref={mountRef}
      className={className ?? "relative h-full w-full cursor-grab active:cursor-grabbing"}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onWheel={onWheel}
    />
  );
}

// ─── V5 helper: procedural radial-gradient contact shadow texture ────────
let _radialShadowTex: THREE.Texture | null = null;
function makeRadialShadowTexture(): THREE.Texture {
  if (_radialShadowTex) return _radialShadowTex;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2,
  );
  grad.addColorStop(0.0, "rgba(0,0,0,0.85)");
  grad.addColorStop(0.5, "rgba(0,0,0,0.45)");
  grad.addColorStop(1.0, "rgba(0,0,0,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _radialShadowTex = tex;
  return tex;
}
