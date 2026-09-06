/**
 * The only place allowed to look at "error", "null" and "timeout".
 *
 * Every one of these turns a collector's own state into a Measurement, so the
 * rule behind it receives a fact or does not run at all. Written once and
 * shared, because "remember to check status !== error" repeated across forty
 * rules is a bug waiting for the one rule that forgets.
 */
import type {
  DnsRecordSet,
  EmailPolicyRecord,
  FieldPerformance,
  FieldShiftMetric,
  FieldTimeMetric,
  LabPerformance,
  PerformanceData,
  SeoData,
  SslCertificate,
  SslData,
  TechnicalData,
} from "../types";
import { measured, unmeasured, type Measurement, type Presence } from "./types.ts";

/**
 * A value that may not have been measured at all.
 *
 * `technical` is null when the audit ran out of time. That is not "this site
 * has no robots.txt" — it is "we never looked".
 */
export function fromNullable<T>(
  value: T | null,
  reason: string,
): Measurement<T> {
  return value === null ? unmeasured(reason) : measured(value);
}

/**
 * A DNS lookup's three states, collapsed to two — correctly.
 *
 *   found  -> we have records
 *   absent -> we looked, and the domain genuinely publishes none
 *   error  -> we do not know, so the rule does not run
 *
 * The "absent" case stays a MEASUREMENT, because "this domain publishes no SPF
 * record" is a real finding. Only "error" is withheld. Collapsing the two is
 * exactly the bug this exists to prevent: it would report a client's email as
 * unprotected because our own lookup timed out.
 */
export function fromRecordSet<T>(set: DnsRecordSet<T>): Measurement<Presence<T[]>> {
  if (set.status === "error") {
    return unmeasured(set.error ?? "The DNS lookup did not complete.");
  }
  if (set.status === "absent") {
    return measured({ present: false });
  }
  return measured({ present: true, value: set.records });
}

/** The same three states for SPF and DMARC, which carry a single record. */
export function fromEmailPolicy(
  record: EmailPolicyRecord,
): Measurement<Presence<string>> {
  if (record.status === "error") {
    return unmeasured(record.error ?? "The DNS lookup did not complete.");
  }
  if (record.status === "absent" || record.record === null) {
    return measured({ present: false });
  }
  return measured({ present: true, value: record.record });
}

/**
 * The certificate, but only when one was actually read.
 *
 * "not-applicable" means the site is not on HTTPS — a real problem, but one
 * for an HTTPS rule to report, not a certificate rule. "blocked" and
 * "unreachable" mean we learned nothing about the certificate at all.
 */
export function fromSsl(ssl: SslData): Measurement<SslData> {
  if (ssl.status !== "checked") {
    return unmeasured(ssl.message);
  }
  return measured(ssl);
}

/** The technical files, when the audit had time to look for them. */
export function fromTechnical(technical: TechnicalData | null): Measurement<TechnicalData> {
  return fromNullable(
    technical,
    "The audit ran out of time before the technical checks could run.",
  );
}

/**
 * robots.txt, but only when we actually read it.
 *
 * `robotsBlocksEverything` is false in two completely different situations:
 * the file exists and blocks nobody, and the file could not be read at all.
 * A rule handed the raw boolean would PASS in both — telling a client their
 * site is not blocked from search on the strength of a request that timed out.
 *
 * "absent" is a measurement and passes honestly: a site with no robots.txt
 * blocks nothing. Only "unavailable" is withheld.
 */
export function fromRobotsRules(
  technical: TechnicalData | null,
): Measurement<TechnicalData> {
  const outer = fromTechnical(technical);
  if (!outer.measured) return outer;

  if (outer.value.robotsTxtStatus === "unavailable") {
    return unmeasured(
      "robots.txt could not be read, so whether it blocks search engines is unknown.",
    );
  }

  return outer;
}

/**
 * Speed figures, and ONLY when Google actually returned some.
 *
 * This is the guard behind the single most damaging thing this tool could say.
 * A timeout, a quota refusal, a missing key, or a check nobody asked for all
 * arrive here, and every one of them stops the rule dead. None of them is
 * evidence about how fast the website is.
 */
export function fromPerformance(
  performance: PerformanceData,
): Measurement<PerformanceData> {
  if (performance.status !== "checked") {
    return unmeasured(performance.message);
  }
  return measured(performance);
}

/**
 * What real visitors experienced — when Google has enough of them.
 *
 * "absent" is withheld here, unlike DNS, and the difference matters. No field
 * data means too few visitors for Google to report on anonymously. It is the
 * normal case for a small business site and says NOTHING about speed, so it
 * must not reach a rule that could read it as one.
 */
export function fromFieldPerformance(
  performance: PerformanceData,
): Measurement<FieldPerformance> {
  const outer = fromPerformance(performance);
  if (!outer.measured) return outer as Measurement<FieldPerformance>;

  const { field } = outer.value;
  if (field.status === "error") {
    return unmeasured(field.error ?? "The real-visitor figures could not be read.");
  }
  if (field.status === "absent") {
    return unmeasured(
      "Google has too few recent visits to this address to report on. This says nothing about how fast the site is.",
    );
  }
  return measured(field);
}

/** The simulated load, when the run produced something. */
export function fromLabPerformance(
  performance: PerformanceData,
): Measurement<LabPerformance> {
  const outer = fromPerformance(performance);
  if (!outer.measured) return outer as Measurement<LabPerformance>;

  const { lab } = outer.value;
  if (lab.status !== "found") {
    return unmeasured(lab.error ?? "The simulated load did not produce results.");
  }
  return measured(lab);
}

/**
 * The certificate itself, when one was actually read.
 *
 * Stricter than fromSsl: a connection can succeed and still hand back nothing
 * readable, and a rule about expiry dates needs the dates.
 */
export function fromCertificate(ssl: SslData): Measurement<SslCertificate> {
  const outer = fromSsl(ssl);
  if (!outer.measured) return outer as Measurement<SslCertificate>;

  return fromNullable(
    outer.value.certificate,
    "The connection succeeded but no readable certificate came back.",
  );
}

/**
 * A fact that only means something in certain conditions.
 *
 * HSTS on a plain HTTP page, or mixed content on one, are not findings — the
 * header is ignored and every resource is insecure anyway. Reporting them
 * would pile noise on top of the far bigger problem that there is no HTTPS.
 *
 * Skipped rather than passed, because "not applicable here" and "checked and
 * fine" are different things and only one of them is a clean bill of health.
 */
export function whenApplicable<T>(
  applicable: boolean,
  value: T,
  reason: string,
): Measurement<T> {
  return applicable ? measured(value) : unmeasured(reason);
}

/**
 * The least visible text a served page must contain before its BODY-dependent
 * facts are worth judging.
 *
 * CALIBRATED, NOT GUESSED. Measured with `measureBodyText`:
 *
 *   0        an empty body
 *   0        a client-rendered shell: <div id="root"></div> plus a script
 *   0        the same shell with a <noscript> message
 *   125      example.com — about as small as a real published page gets
 *   271      info.cern.ch
 *   11944    en.wikipedia.org
 *
 * 50 sits far above every shell and well below the smallest real page, so it
 * separates the two cases with room to spare. Deliberately low rather than
 * generous: the cost of setting it too high is silently declining to grade a
 * genuinely thin page, and a check that quietly stops running is worse than
 * one that runs and finds nothing.
 */
export const MIN_BODY_TEXT_FOR_SEO = 50;

/**
 * The SEO facts, but only when the served HTML actually carried a page body.
 *
 * FOR BODY-DEPENDENT RULES ONLY — headings, images, heading order. Those read
 * things that live in the body, and this scan does not run JavaScript, so a
 * site that builds its content in the browser serves almost nothing for them
 * to read. Its headings are absent from the HTML while being perfectly present
 * for a visitor, and grading that would fire half a dozen findings about a
 * page with nothing wrong with it.
 *
 * NOT FOR HEAD-BASED RULES. Title, meta description, canonical, lang and
 * viewport are served in the markup either way, so they are judged on their
 * own and must keep using the SEO facts directly.
 *
 * Note what this is NOT doing: it does not decide the page is client-rendered.
 * It compares one measured number against one documented threshold and, when
 * the number is too low to judge by, says so and declines. The reason travels
 * into `skippedChecks`, so the gap is stated rather than hidden.
 */
export function fromRenderedBody(seo: SeoData): Measurement<SeoData> {
  if (seo.bodyTextLength >= MIN_BODY_TEXT_FOR_SEO) {
    return measured(seo);
  }
  return unmeasured(
    `The served HTML contained only ${seo.bodyTextLength} characters of visible text, ` +
      "which is too little to judge headings or images by. This scan reads the markup as " +
      "sent and does not run JavaScript, so content the page builds in the browser is not " +
      "visible to it.",
  );
}

/**
 * A head tag, when its ABSENCE would actually mean something.
 *
 * THE ASYMMETRY THIS IS BUILT ON, AND THE WHOLE REASON IT EXISTS:
 *
 *   present -> certain. The tag is in the served HTML. Nothing a script does
 *              later can make it not have been there.
 *   absent  -> only as certain as the HTML was representative of the page.
 *
 * This scan does not run JavaScript. A page that builds itself in the browser
 * commonly sets its own canonical, description and title at runtime — that is
 * what react-helmet and its equivalents are for. The served markup for such a
 * page genuinely lacks those tags while the page a visitor and a rendering
 * search engine see carries them.
 *
 * So `seo.canonical.missing` firing on such a page states something untrue
 * about the client's website. That was observed directly: a shell measuring
 * ZERO characters of visible body text still produced "The page declares no
 * canonical URL" as a finding.
 *
 * The gate is `fromRenderedBody`'s, deliberately — the same measurement and the
 * same threshold that already decide whether the body-dependent rules may run.
 * A page whose served body was too thin to judge headings by is equally too
 * thin for an absent head tag to be called missing. Introducing a second,
 * separate notion of "measurable" would mean two thresholds to keep in step.
 *
 * What this does NOT do is stop the rules working on ordinary pages. A
 * server-rendered page carries a body, so the gate is open and a genuinely
 * missing tag is reported exactly as before.
 */
export function fromServedHead(
  seo: SeoData,
  isPresent: (seo: SeoData) => boolean,
): Measurement<SeoData> {
  // Present is present. No amount of unreadability makes a tag we can see
  // stop existing, so the rule runs and passes on its own evidence.
  if (isPresent(seo)) return measured(seo);

  if (seo.bodyTextLength >= MIN_BODY_TEXT_FOR_SEO) return measured(seo);

  /*
   * Its own sentence rather than `fromRenderedBody`'s, which talks about
   * headings and images. The threshold is shared; the explanation is not,
   * because what we are declining to say here is different.
   */
  return unmeasured(
    `The served HTML contained only ${seo.bodyTextLength} characters of visible text, so this ` +
      "page appears to build its content in the browser. This scan reads the markup as sent and " +
      "does not run JavaScript, and a page like this commonly sets its own head tags at runtime — " +
      "so their absence from the served HTML is not evidence they are missing from the page.",
  );
}

/**
 * One real-visitor timing metric, when Google actually reported it.
 *
 * Narrower than `fromFieldPerformance` on purpose. That one hands over the
 * whole field block, which would let a rule about LCP quietly read INP. This
 * gives a rule exactly the metric it grades, and withholds it when Google left
 * that metric out — a missing metric is not a slow one.
 *
 * Everything `fromFieldPerformance` withholds is withheld here too: a check
 * that was never requested, is still pending, had no API key, errored, timed
 * out, or found too few visitors to report on.
 */
export function fromFieldTimeMetric(
  performance: PerformanceData,
  key: "lcp" | "inp" | "fcp" | "ttfb",
): Measurement<FieldTimeMetric> {
  const field = fromFieldPerformance(performance);
  if (!field.measured) return field as Measurement<FieldTimeMetric>;

  const metric = field.value[key];
  return metric === null
    ? unmeasured(`Google did not report ${key.toUpperCase()} for this address.`)
    : measured(metric);
}

/** The same, for Cumulative Layout Shift — a score rather than a duration. */
export function fromFieldShiftMetric(
  performance: PerformanceData,
): Measurement<FieldShiftMetric> {
  const field = fromFieldPerformance(performance);
  if (!field.measured) return field as Measurement<FieldShiftMetric>;

  const metric = field.value.cls;
  return metric === null
    ? unmeasured("Google did not report CLS for this address.")
    : measured(metric);
}

/**
 * Whether Google gave us any Core Web Vital a real visitor experienced.
 *
 * "Usable" means the field block was actually found AND carries at least one
 * of the three metrics Google ranks on. A found block with none of them is no
 * more useful for judging speed than no block at all.
 */
export function hasUsableFieldVitals(field: FieldPerformance): boolean {
  if (field.status !== "found") return false;
  return field.lcp !== null || field.inp !== null || field.cls !== null;
}

/**
 * The lab score, but ONLY as a fallback when there is no real-visitor data.
 *
 * WHY THIS IS CONDITIONAL, AND WHY IT MATTERS MOST HERE:
 *
 * A real measurement from this project's own testing — bbc.co.uk scored 30/100
 * in Google's simulation while Google rated its real visitors' experience
 * FAST. Grading that simulation would have told the client their site is slow
 * on the same day Google said the opposite. The lab is one throttled run in a
 * datacentre; nobody experienced it.
 *
 * So it is graded only when there is nothing better:
 *
 *   field found with vitals   -> the lab is diagnostic. Not graded.
 *   field ABSENT              -> too few visitors to report on. The simulation
 *                                is the best evidence available, so it counts.
 *   field found, no vitals    -> same: nothing usable to prefer over it.
 *   field ERROR               -> we do not know what real visitors saw. An
 *                                unread measurement is not an absent one, so
 *                                this is NOT a fallback trigger. Skipped.
 */
export function fromLabScoreFallback(
  performance: PerformanceData,
): Measurement<LabPerformance> {
  const outer = fromPerformance(performance);
  if (!outer.measured) return outer as Measurement<LabPerformance>;

  const { field, lab } = outer.value;

  if (field.status === "error") {
    return unmeasured(
      "The real-visitor figures could not be read, so there is no basis for deciding whether the simulated score is the best evidence available.",
    );
  }

  if (hasUsableFieldVitals(field)) {
    return unmeasured(
      "Google reported what real visitors experienced, so the simulated score is diagnostic here rather than a verdict.",
    );
  }

  if (lab.status !== "found" || lab.score === null) {
    return unmeasured(lab.error ?? "The simulated load did not produce a score.");
  }

  return measured(lab);
}
