/**
 * Section K — Accessibility Audit (axe-core-style WCAG pass).
 * Runs over a live DOM root; never in production hot paths.
 * Public API: `runAccessibilityAudit()`, `serializeReport()`.
 */

export type AuditSeverity = "critical" | "serious" | "moderate" | "minor";

export type AuditRuleId =
  | "image-alt" | "button-name" | "label" | "color-contrast"
  | "heading-order" | "tabindex" | "target-size" | "document-title";

export interface AuditIssue {
  rule: AuditRuleId;
  severity: AuditSeverity;
  selector: string;
  message: string;
  fix: string;
}

export interface AuditReport {
  timestamp: string;
  url: string;
  issues: AuditIssue[];
  counts: Record<AuditSeverity, number>;
  passed: boolean;
}

export interface AuditOptions {
  minTargetSize?: number;
  minContrast?: number;
}

const DEFAULTS: Required<AuditOptions> = { minTargetSize: 24, minContrast: 4.5 };

function relPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) part += `#${cur.id}`;
    else if (cur.classList.length) part += `.${[...cur.classList].join(".")}`;
    parts.unshift(part);
    cur = cur.parentElement;
    if (parts.length > 5) break;
  }
  return parts.join(" > ");
}

function luminance(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(c1: [number, number, number], c2: [number, number, number]): number {
  const l1 = luminance(c1[0], c1[1], c1[2]);
  const l2 = luminance(c2[0], c2[1], c2[2]);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function parseColor(color: string): [number, number, number] | null {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const hex = color.match(/#([0-9a-f]{3,6})/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/(.)/g, "$1$1") : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return null;
}

export function runAccessibilityAudit(
  root: Element | Document = document,
  opts: AuditOptions = {},
): AuditReport {
  const o = { ...DEFAULTS, ...opts };
  const scope = root instanceof Document ? root.body ?? root.documentElement : root;
  const issues: AuditIssue[] = [];
  const add = (
    rule: AuditRuleId, severity: AuditSeverity, el: Element, message: string, fix: string,
  ) => issues.push({ rule, severity, selector: relPath(el), message, fix });

  scope.querySelectorAll("img").forEach((img) => {
    if (!img.getAttribute("alt")) add("image-alt", "critical", img, "Image missing alt attribute", 'Add alt="" or descriptive alt');
  });
  scope.querySelectorAll("button, [role='button']").forEach((btn) => {
    const txt = (btn.textContent ?? "").trim();
    if (!txt && !btn.getAttribute("aria-label")) add("button-name", "critical", btn, "Button has no accessible name", "Add text or aria-label");
  });
  scope.querySelectorAll("input, select, textarea").forEach((ctrl) => {
    if (ctrl.getAttribute("type") === "hidden") return;
    if (!ctrl.getAttribute("id") && !ctrl.getAttribute("aria-label") && !ctrl.getAttribute("aria-labelledby")) {
      add("label", "serious", ctrl, "Form control without label", "Wrap with <label> or add aria-label");
    }
  });
  let lastLevel = 0;
  scope.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    const level = Number(h.tagName[1]);
    if (lastLevel && level > lastLevel + 1) add("heading-order", "moderate", h, `Heading jumps h${lastLevel} to h${level}`, "Use sequential heading levels");
    lastLevel = level;
  });
  scope.querySelectorAll("[tabindex]").forEach((el) => {
    const idx = Number(el.getAttribute("tabindex"));
    if (idx > 0) add("tabindex", "moderate", el, `tabindex=${idx} disrupts order`, "Use tabindex=0 or -1");
  });
  scope.querySelectorAll("button, a, [role='button'], input[type='checkbox'], input[type='radio']").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (r.width < o.minTargetSize || r.height < o.minTargetSize)) {
      add("target-size", "moderate", el, `Hit area ${r.width}x${r.height} < ${o.minTargetSize}px`, "Increase size to 24px+");
    }
  });
  scope.querySelectorAll("*").forEach((el) => {
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const fg = parseColor(cs.color);
    const bg = parseColor(cs.backgroundColor === "rgba(0, 0, 0, 0)" ? "#ffffff" : cs.backgroundColor);
    if (fg && bg) {
      const ratio = contrast(fg, bg);
      if ((el.textContent ?? "").trim().length > 0 && ratio < o.minContrast) {
        add("color-contrast", "serious", el, `Contrast ${ratio.toFixed(2)} < ${o.minContrast}`, "Darken text or lighten background");
      }
    }
  });
  if (typeof document !== "undefined" && !document.title) {
    issues.push({ rule: "document-title", severity: "serious", selector: "html > head > title", message: "Document missing <title>", fix: "Provide a descriptive title" });
  }
  const counts: Record<AuditSeverity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  issues.forEach((i) => { counts[i.severity] += 1; });
  return {
    timestamp: new Date().toISOString(),
    url: typeof location !== "undefined" ? location.href : "n/a",
    issues, counts, passed: counts.critical === 0 && counts.serious === 0,
  };
}

export function serializeReport(r: AuditReport): string {
  return JSON.stringify({ passed: r.passed, counts: r.counts, issues: r.issues.length, url: r.url }, null, 2);
}
