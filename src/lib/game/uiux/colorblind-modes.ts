/**
 * Section K — Colorblind Accessibility Modes (WCAG 1.4.11 + simulation).
 * Simulation matrices for preview; Daltonization correction applied via
 * an SVG feColorMatrix filter on the document root.
 * Public API: `COLORBLIND_FILTERS`, `applyColorblindFilter()`,
 * `removeColorblindFilter()`, `getActiveColorblindMode()`, `simulateColor()`.
 */

export type ColorblindMode =
  | "none" | "protanopia" | "deuteranopia" | "tritanopia"
  | "protanomaly" | "deuteranomaly" | "tritanomaly" | "achromatopsia";

export interface ColorblindFilter {
  id: ColorblindMode;
  label: string;
  simulationMatrix: number[];
  correctionMatrix: number[];
}

// Matrices adapted from Machado et al. 2009 + standard Daltonization.
export const COLORBLIND_FILTERS: Record<ColorblindMode, ColorblindFilter> = {
  none: { id: "none", label: "Off",
    simulationMatrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
    correctionMatrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] },
  protanopia: { id: "protanopia", label: "Protanopia (no red)",
    simulationMatrix: [0.567, 0.433, 0, 0, 0, 0.558, 0.442, 0, 0, 0, 0, 0.242, 0.758, 0, 0, 0, 0, 0, 1, 0],
    correctionMatrix: [0, 2.02344, -2.52581, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] },
  deuteranopia: { id: "deuteranopia", label: "Deuteranopia (no green)",
    simulationMatrix: [0.625, 0.375, 0, 0, 0, 0.7, 0.3, 0, 0, 0, 0, 0.3, 0.7, 0, 0, 0, 0, 0, 1, 0],
    correctionMatrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] },
  tritanopia: { id: "tritanopia", label: "Tritanopia (no blue)",
    simulationMatrix: [0.95, 0.05, 0, 0, 0, 0, 0.433, 0.567, 0, 0, 0, 0.475, 0.525, 0, 0, 0, 0, 0, 1, 0],
    correctionMatrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] },
  protanomaly: { id: "protanomaly", label: "Protanomaly (weak red)",
    simulationMatrix: [0.817, 0.183, 0, 0, 0, 0.333, 0.667, 0, 0, 0, 0, 0.125, 0.875, 0, 0, 0, 0, 0, 1, 0],
    correctionMatrix: [0.5, 1.5, -1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] },
  deuteranomaly: { id: "deuteranomaly", label: "Deuteranomaly (weak green)",
    simulationMatrix: [0.8, 0.2, 0, 0, 0, 0.258, 0.742, 0, 0, 0, 0, 0.142, 0.858, 0, 0, 0, 0, 0, 1, 0],
    correctionMatrix: [0.5, 1.5, -1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] },
  tritanomaly: { id: "tritanomaly", label: "Tritanomaly (weak blue)",
    simulationMatrix: [0.967, 0.033, 0, 0, 0, 0, 0.733, 0.267, 0, 0, 0, 0.182, 0.818, 0, 0, 0, 0, 0, 1, 0],
    correctionMatrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] },
  achromatopsia: { id: "achromatopsia", label: "Achromatopsia (no color)",
    simulationMatrix: [0.299, 0.587, 0.114, 0, 0, 0.299, 0.587, 0.114, 0, 0, 0.299, 0.587, 0.114, 0, 0, 0, 0, 0, 1, 0],
    correctionMatrix: [0.299, 0.587, 0.114, 0, 0, 0.299, 0.587, 0.114, 0, 0, 0.299, 0.587, 0.114, 0, 0, 0, 0, 0, 1, 0] },
};

const FILTER_ID = "pr-colorblind-filter";
const STORAGE_KEY = "pr_colorblind_mode";
let activeMode: ColorblindMode = "none";

function ensureSvgDefs(): SVGFilterElement {
  let svg = document.getElementById("pr-colorblind-svg") as unknown as SVGSVGElement | null;
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "pr-colorblind-svg";
    svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    document.body.appendChild(svg);
  }
  let filter = svg.querySelector<SVGFilterElement>(`#${FILTER_ID}`);
  if (!filter) {
    filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.id = FILTER_ID; filter.setAttribute("color-interpolation-filters", "sRGB");
    svg.appendChild(filter);
  }
  filter.innerHTML = "";
  const matrix = document.createElementNS("http://www.w3.org/2000/svg", "feColorMatrix");
  matrix.setAttribute("type", "matrix");
  filter.appendChild(matrix);
  return filter;
}

export function applyColorblindFilter(mode: ColorblindMode): void {
  activeMode = mode;
  const root = document.documentElement;
  if (mode === "none") {
    root.style.removeProperty("filter");
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    return;
  }
  const filterEl = ensureSvgDefs();
  filterEl.querySelector("feColorMatrix")!.setAttribute("values", COLORBLIND_FILTERS[mode].correctionMatrix.join(" "));
  root.style.filter = `url(#${FILTER_ID})`;
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
}

export function removeColorblindFilter(): void { applyColorblindFilter("none"); }

export function getActiveColorblindMode(): ColorblindMode {
  if (activeMode !== "none") return activeMode;
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as ColorblindMode | null;
    if (stored && stored in COLORBLIND_FILTERS) { activeMode = stored; return stored; }
  } catch { /* ignore */ }
  return "none";
}

/** Pure simulation: apply deficiency matrix to an RGB triple. */
export function simulateColor(rgb: [number, number, number], mode: ColorblindMode): [number, number, number] {
  const m = COLORBLIND_FILTERS[mode].simulationMatrix;
  const [r, g, b] = rgb;
  return [
    Math.min(255, Math.max(0, m[0] * r + m[1] * g + m[2] * b + m[4] * 255)),
    Math.min(255, Math.max(0, m[5] * r + m[6] * g + m[7] * b + m[9] * 255)),
    Math.min(255, Math.max(0, m[10] * r + m[11] * g + m[12] * b + m[14] * 255)),
  ];
}
