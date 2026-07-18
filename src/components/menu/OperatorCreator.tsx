"use client";

/**
 * OperatorCreator — DEPRECATED. Prompt J-4027 / J-4086.
 *
 * This was the original operator-customization MVP (face/hair/eyes/body
 * sliders + a 3D preview). It was superseded by `OperatorScreen.tsx`,
 * which is the production operator studio: it adds helmet/armor/gear
 * slots, wraps the same `OperatorPreview3D` viewer, persists via
 * `saveOperatorCustomization` (server route), and reads from the same
 * `OperatorCustomization` schema the engine consumes.
 *
 * The two screens coexisted as separate systems — `OperatorCreator`
 * was never imported (orphan file) but still showed up in code-search
 * + IDE jump-to-definition, which read as "two customization systems."
 *
 * This file is now a thin re-export of `OperatorScreen` so:
 *   - any future code that imports `OperatorCreator` gets the unified,
 *     server-persisted studio instead of the orphan MVP;
 *   - the file no longer carries dead code that drifts from the real
 *     data model;
 *   - IDE jump-to-definition lands on the real implementation.
 *
 * The original MVP body (540 lines of slider/snapshot code) is removed.
 */
export { OperatorScreen as OperatorCreator } from "./OperatorScreen";
