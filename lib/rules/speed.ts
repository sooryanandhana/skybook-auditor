/**
 * Speed grading rules, from Google PageSpeed Insights.
 *
 * These read `performance` and nothing else. That is enforced by the type:
 * they are declared against `PerformanceFacts`, not the whole audit, so a
 * speed rule cannot reach a certificate or a heading count even by accident.
 *
 * ---------------------------------------------------------------------------
 * SEVERITY POLICY — APPROVED AND FIXED
 *
 *   high    speed.field.lcp.slow   speed.field.inp.slow   speed.field.cls.slow
 *   medium  speed.field.lcp.needs-improvement
 *           speed.field.inp.needs-improvement
 *           speed.field.cls.needs-improvement
 *           speed.lab.score
 *
 * No critical. A slow site is not removed from search the way a blocking
 * robots.txt is, and nothing here shows a visitor a browser warning.
 *
 * ---------------------------------------------------------------------------
 * GOOGLE'S CATEGORIES ARE THE AUTHORITY
 *
 * Not one number in this file is compared against a threshold of ours. Each
 * rule reads the `category` Google itself assigned — FAST, AVERAGE or SLOW —
 * and maps it:
 *
 *   SLOW    -> high
 *   AVERAGE -> medium
 *   FAST    -> nothing
 *
 * Google moves those boundaries (INP replaced FID outright in 2024), and a
 * hardcoded copy would quietly start disagreeing with the client's own Search
 * Console. The measured value appears in the evidence so a person can check
 * it, but it is never what decides the grade.
 *
 * Two rules per metric because a rule declares one severity, fixed. They read
 * mutually exclusive categories, so a metric produces exactly one finding.
 *
 * ---------------------------------------------------------------------------
 * ONLY THE THREE CORE WEB VITALS
 *
 * LCP, INP and CLS are what Google ranks on. FCP and TTFB stay measured and
 * reported as supporting diagnostics, and are deliberately not graded.
 */
import type { FieldShiftMetric, FieldTimeMetric, LabPerformance } from "../types";
import { defineRule } from "./runner.ts";
import {
  fromFieldShiftMetric,
  fromFieldTimeMetric,
  fromLabScoreFallback,
} from "./selectors.ts";
import { fires, passes, type PerformanceFacts } from "./types.ts";

/** Google's own score bands. 0-49 is the band it colours red. */
const LAB_SCORE_POOR = 50;

// ---------------------------------------------------------------------------
// Largest Contentful Paint — when the biggest thing on screen appears
// ---------------------------------------------------------------------------

export const lcpSlowRule = defineRule<FieldTimeMetric, PerformanceFacts>({
  id: "speed.field.lcp.slow",
  scope: "page",
  title: "Largest Contentful Paint is slow for real visitors",
  category: "speed",
  severity: "high",
  remediation:
    "Find the largest element above the fold — usually a hero image or heading — and make it load sooner: serve it at the right size, preload it, and remove render-blocking CSS and fonts ahead of it.",
  select: (data) => fromFieldTimeMetric(data.performance, "lcp"),
  evaluate: (lcp) =>
    lcp.category === "SLOW"
      ? fires(`Google rates LCP as SLOW: ${lcp.percentileMs} ms at the 75th percentile.`)
      : passes,
});

export const lcpNeedsImprovementRule = defineRule<FieldTimeMetric, PerformanceFacts>({
  id: "speed.field.lcp.needs-improvement",
  scope: "page",
  title: "Largest Contentful Paint needs improvement",
  category: "speed",
  severity: "medium",
  remediation:
    "Reduce the time to the main above-the-fold element: compress and correctly size the hero image, preload it, and cut render-blocking resources before it.",
  select: (data) => fromFieldTimeMetric(data.performance, "lcp"),
  evaluate: (lcp) =>
    lcp.category === "AVERAGE"
      ? fires(`Google rates LCP as AVERAGE: ${lcp.percentileMs} ms at the 75th percentile.`)
      : passes,
});

// ---------------------------------------------------------------------------
// Interaction to Next Paint — how quickly the page answers a tap or click
// ---------------------------------------------------------------------------

export const inpSlowRule = defineRule<FieldTimeMetric, PerformanceFacts>({
  id: "speed.field.inp.slow",
  scope: "page",
  title: "Interaction responsiveness is slow for real visitors",
  category: "speed",
  severity: "high",
  remediation:
    "Cut main-thread work around interactions: break up long JavaScript tasks, defer work that does not need to run during a tap, and reduce third-party scripts competing for the thread.",
  select: (data) => fromFieldTimeMetric(data.performance, "inp"),
  evaluate: (inp) =>
    inp.category === "SLOW"
      ? fires(`Google rates INP as SLOW: ${inp.percentileMs} ms at the 75th percentile.`)
      : passes,
});

export const inpNeedsImprovementRule = defineRule<FieldTimeMetric, PerformanceFacts>({
  id: "speed.field.inp.needs-improvement",
  scope: "page",
  title: "Interaction responsiveness needs improvement",
  category: "speed",
  severity: "medium",
  remediation:
    "Reduce long-running JavaScript on the main thread, split long tasks, and postpone non-urgent work so the page can repaint promptly after a tap or click.",
  select: (data) => fromFieldTimeMetric(data.performance, "inp"),
  evaluate: (inp) =>
    inp.category === "AVERAGE"
      ? fires(`Google rates INP as AVERAGE: ${inp.percentileMs} ms at the 75th percentile.`)
      : passes,
});

// ---------------------------------------------------------------------------
// Cumulative Layout Shift — how much the page moves about while loading
// ---------------------------------------------------------------------------

export const clsSlowRule = defineRule<FieldShiftMetric, PerformanceFacts>({
  id: "speed.field.cls.slow",
  scope: "page",
  title: "Page layout shifts badly for real visitors",
  category: "speed",
  severity: "high",
  remediation:
    "Reserve space for anything that arrives late: set width and height on images and embeds, give ad and banner slots a fixed size, and avoid inserting content above what is already on screen.",
  select: (data) => fromFieldShiftMetric(data.performance),
  evaluate: (cls) =>
    cls.category === "SLOW"
      ? fires(
          `Google rates CLS as SLOW: ${cls.percentile.toFixed(2)} at the 75th percentile.`,
        )
      : passes,
});

export const clsNeedsImprovementRule = defineRule<FieldShiftMetric, PerformanceFacts>({
  id: "speed.field.cls.needs-improvement",
  scope: "page",
  title: "Page layout shift needs improvement",
  category: "speed",
  severity: "medium",
  remediation:
    "Set explicit dimensions on images, iframes and ad slots, and load fonts so that swapping them does not reflow the text around them.",
  select: (data) => fromFieldShiftMetric(data.performance),
  evaluate: (cls) =>
    cls.category === "AVERAGE"
      ? fires(
          `Google rates CLS as AVERAGE: ${cls.percentile.toFixed(2)} at the 75th percentile.`,
        )
      : passes,
});

// ---------------------------------------------------------------------------
// The simulated score — a fallback, never a verdict over real visitors
// ---------------------------------------------------------------------------

/**
 * Graded ONLY when Google has no usable real-visitor Core Web Vitals.
 *
 * `fromLabScoreFallback` is what enforces that, and it is the most important
 * selector in this file. Where real-visitor data exists it withholds the lab
 * score entirely, so a site whose visitors Google rates FAST can never be told
 * it is slow because a throttled simulation scored badly.
 */
export const labScoreRule = defineRule<LabPerformance, PerformanceFacts>({
  id: "speed.lab.score",
  scope: "page",
  title: "Simulated performance score is poor",
  category: "speed",
  severity: "medium",
  remediation:
    "Google has too little real-visitor data for this address, so this is a laboratory simulation rather than a measurement of your visitors. Treat it as a starting point: open the PageSpeed Insights report for this page and work through the opportunities it lists, then re-check once the site has more traffic.",
  select: (data) => fromLabScoreFallback(data.performance),
  evaluate: (lab) =>
    lab.score !== null && lab.score < LAB_SCORE_POOR
      ? fires(
          `A simulated mobile load scored ${lab.score} out of 100. Google has no real-visitor data for this address to compare it against.`,
        )
      : passes,
});

/** The seven speed rules. */
export const SPEED_RULES = [
  lcpSlowRule,
  lcpNeedsImprovementRule,
  inpSlowRule,
  inpNeedsImprovementRule,
  clsSlowRule,
  clsNeedsImprovementRule,
  labScoreRule,
] as const;
