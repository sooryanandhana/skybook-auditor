/**
 * Plain-language explanations of every audit rule, for the PDF report.
 *
 * WRITTEN BY PEOPLE, NOT GENERATED. Each entry is a constant in our source, the
 * same way each rule's remediation is: reviewed once, identical in every report,
 * and present whether or not the AI explanation layer answered. A client who
 * receives a report on a day the AI service is down still gets every finding
 * explained.
 *
 * WHAT AN ENTRY MAY SAY. What the check means, why it matters, what MAY follow
 * from it, the practical steps, and who normally does the work. It never states
 * a consequence as a fact about this particular website: a missing header is a
 * missing safeguard, not a breach; a missing description is not a ranking
 * penalty; a slow score is not every visitor's experience. "May" and "can" are
 * deliberate, and a test refuses the certainty phrases that would undo them.
 *
 * WHAT AN ENTRY MAY NOT SAY. Anything about the specific site, a number the
 * audit did not measure, or a promise of results. The finding's own evidence
 * and affected pages carry the specifics; this text carries the meaning.
 *
 * KEYED BY RULE ID, and a test pins the keys to the rule set: a rule added
 * without an explanation, or an explanation left behind by a removed rule,
 * fails the build rather than printing a bare finding.
 */

/** Who normally does the work. A fixed list, so the report uses consistent wording. */
export type FixRole = "developer" | "seo" | "hosting" | "dns";

/** How each role is named in the report. */
export const FIX_ROLE_LABELS: Record<FixRole, string> = {
  developer: "Website developer",
  seo: "SEO or content specialist",
  hosting: "Hosting or server administrator",
  dns: "Domain or DNS administrator",
};

export interface FindingExplainer {
  /** The check in everyday words: what the finding actually describes. */
  readonly whatItMeans: string;
  /** Why the owner should care, without alarm. */
  readonly whyItMatters: string;
  /** What MAY follow. Hedged, and explicit about what the audit does not establish. */
  readonly possibleImpact: string;
  /** Practical steps, in the order someone would take them. */
  readonly steps: readonly string[];
  /** Who normally does the work, most likely first. */
  readonly whoFixes: readonly FixRole[];
}

const LCP_MEANS =
  "This measures how long real visitors wait before the main part of the page, usually a large picture or headline, appears on screen (Google calls this Largest Contentful Paint). The result comes from Google's records of real visits to this page.";
const LCP_STEPS = [
  "Open the PageSpeed Insights report for this page and note which item it names as the largest one on screen.",
  "Make that picture smaller in file size, show it at the size it is actually displayed, and save it in a modern format such as WebP or AVIF.",
  "Ask the browser to load it early (this is called preloading), and reduce the styles, fonts and scripts that have to load before it.",
  "Ask the hosting provider to review how quickly the server responds and whether pages are cached (kept ready to send), and consider a content delivery network, which serves the site from locations closer to visitors.",
  "Check again after the changes. Google's real-visitor data updates gradually, so improvements take several weeks to show fully.",
];

const INP_MEANS =
  "This measures how quickly the page visibly reacts after a visitor taps, clicks or types (Google calls this Interaction to Next Paint). The result comes from Google's records of real visits to this page.";
const INP_STEPS = [
  "Use the PageSpeed Insights report, or the browser's built-in performance tools, to find the scripts that keep the page busy.",
  "Break long-running scripts into smaller pieces, and delay work that does not need to happen at the moment of a tap or click.",
  "Remove plugins, widgets and outside scripts the site no longer needs, and load the rest after the page is ready to use.",
  "Check again after the changes. Google's real-visitor data updates gradually, so improvements take several weeks to show fully.",
];

const CLS_MEANS =
  "This measures how much the content of the page moves around while it loads (Google calls this Cumulative Layout Shift). The result comes from Google's records of real visits to this page.";
const CLS_STEPS = [
  "Give every picture, video and embedded item a fixed width and height, so the browser can keep space for it before it loads.",
  "Keep space ready for banners, cookie notices and advertisements, instead of letting them push the page content down when they appear.",
  "Avoid adding new content above what the visitor is already reading.",
  "Set up web fonts so that the text does not jump when the final font replaces the temporary one.",
  "Check again after the changes. Google's real-visitor data updates gradually, so improvements take several weeks to show fully.",
];

export const FINDING_EXPLAINERS: Readonly<Record<string, FindingExplainer>> = {
  // -------------------------------------------------------------------------
  // Security
  // -------------------------------------------------------------------------
  "security.https": {
    whatItMeans:
      "The page was sent without encryption: its address begins http:// instead of https://. Browsers do not show the padlock symbol for pages sent this way.",
    whyItMatters:
      "Encryption keeps what visitors see and type private as it travels between their device and the website. Modern browsers label unencrypted pages as \"Not secure\".",
    possibleImpact:
      "Visitors may trust the site less when they see the \"Not secure\" label, and anything typed into the page could be read or changed by others on shared networks such as public Wi-Fi. Search engines generally prefer secure pages.",
    steps: [
      "Get a security certificate for the website (the file that makes https:// work). Many hosting providers include one free, for example through Let's Encrypt.",
      "Turn on HTTPS on the web server or in the hosting control panel.",
      "Send every http:// address automatically to the matching https:// address (this is called a redirect).",
      "Update links, pictures and scripts inside the site to use https:// addresses, then check the page again.",
    ],
    whoFixes: ["hosting", "developer"],
  },
  "security.ssl.expired": {
    whatItMeans:
      "The website's security certificate has passed its expiry date. This certificate is what lets browsers confirm they are connected to the genuine website.",
    whyItMatters:
      "Browsers show a full-page warning before letting visitors reach a site whose certificate has expired.",
    possibleImpact:
      "Many visitors may not continue past the warning, and some services or devices that connect to the site may refuse the connection.",
    steps: [
      "Renew the certificate with the certificate provider or hosting company.",
      "Install the new certificate on the server and confirm the site opens without a warning.",
      "Turn on automatic renewal so the certificate does not lapse again, and set a reminder before the next expiry date.",
    ],
    whoFixes: ["hosting"],
  },
  "security.ssl.hostname": {
    whatItMeans:
      "The website's security certificate was issued for different web addresses from the one the site was opened on, so it does not confirm this address.",
    whyItMatters:
      "Browsers treat a certificate for the wrong address as a possible sign of impersonation, and warn visitors before letting them reach the site.",
    possibleImpact:
      "Visitors may see a security warning and leave instead of continuing to the site.",
    steps: [
      "List every address the site can be opened on, including the versions with and without \"www\".",
      "Have the certificate reissued so it covers each of those addresses, or send visitors to an address the current certificate already covers.",
      "Install the updated certificate and confirm each address opens without a warning.",
    ],
    whoFixes: ["hosting", "dns"],
  },
  "security.ssl.untrusted": {
    whatItMeans:
      "The website's security certificate could not be linked back to a certificate provider that browsers and devices recognise. This often happens when the website created its own certificate, or when part of the certificate set is missing from the server.",
    whyItMatters:
      "Browsers and devices rely on that link to a recognised provider to confirm they are connected to the genuine website.",
    possibleImpact:
      "Some visitors' browsers or devices may show warnings or refuse to connect.",
    steps: [
      "Use a certificate issued by a widely recognised certificate provider.",
      "Install the full set of certificate files on the server, including any \"intermediate\" certificates the provider supplies.",
      "Check the site again with an online SSL checking tool to confirm the set is complete.",
    ],
    whoFixes: ["hosting"],
  },
  "security.mixed-content": {
    whatItMeans:
      "The page itself is sent securely, but some of the pictures, scripts or other files it uses are loaded from unencrypted http:// addresses.",
    whyItMatters:
      "Browsers may block those files or show a weaker padlock, and files sent without encryption could be changed on the way to the visitor.",
    possibleImpact:
      "Parts of the page may not display or work as intended, and visitors may see a security notice.",
    steps: [
      "Use the affected addresses listed in this report to find each insecure file.",
      "Change each http:// address to https:// where the file's source supports it.",
      "Where the source does not support https://, store the file on the website itself or replace it.",
      "Check the page again after the changes.",
    ],
    whoFixes: ["developer"],
  },
  "security.form.insecure": {
    whatItMeans:
      "A form on the page sends what visitors type to an unencrypted http:// address.",
    whyItMatters:
      "Details entered into the form, such as names, email addresses or messages, travel without encryption.",
    possibleImpact:
      "Information sent through the form could be read or changed by others on the network, and browsers may warn visitors before they submit it.",
    steps: [
      "Change the address the form sends to so that it begins with https://.",
      "Confirm that the page receiving the form works over https://.",
      "Send a test message through the form and check that it arrives correctly.",
    ],
    whoFixes: ["developer"],
  },
  "security.headers.hsts": {
    whatItMeans:
      "Your website does not give browsers a working instruction to always open it securely. This instruction is called HSTS (HTTP Strict-Transport-Security).",
    whyItMatters:
      "Without it, a visitor's first visit can begin on the unencrypted version of the site before being moved to the secure one. That brief moment could be interfered with on an untrusted network, such as public Wi-Fi.",
    possibleImpact:
      "The site has one fewer layer of protection against certain network attacks. This is a missing safeguard, not a sign of any attack on the site.",
    steps: [
      "Confirm that every page of the site works over https://.",
      "Add the HSTS instruction with a short duration first, to make sure nothing stops working.",
      "Once the site is confirmed to work, increase the duration to at least six months.",
      "Only add the \"includeSubDomains\" option if every subdomain (such as shop. or mail. versions of the address) also works over https://.",
    ],
    whoFixes: ["hosting", "developer"],
  },
  "security.headers.csp": {
    whatItMeans:
      "Your website does not give browsers a list of the places it is allowed to load content from, such as scripts, styles and fonts. This list is called a Content-Security-Policy.",
    whyItMatters:
      "It is an extra layer of protection: if harmful code were ever slipped into a page, the list would limit what that code could do.",
    possibleImpact:
      "The site relies on its other protections alone. A missing list is not a sign that the site has a weakness or has been affected by one.",
    steps: [
      "List the scripts, styles, fonts and outside services the site uses.",
      "Start the policy in \"report-only\" mode, so it reports problems without blocking anything.",
      "Review the reports, adjust the list, and then switch the policy on fully.",
      "Update the list whenever new outside tools are added to the site.",
    ],
    whoFixes: ["developer"],
  },
  "security.cookies.secure": {
    whatItMeans:
      "Some cookies set by the website are allowed to travel over unencrypted connections. Cookies are small pieces of information the site stores in the visitor's browser.",
    whyItMatters:
      "Cookies often identify a visitor or keep them signed in, so they should only travel over encrypted connections.",
    possibleImpact:
      "On insecure networks, the contents of those cookies could be seen by others.",
    steps: [
      "Identify every cookie the site and its plugins set.",
      "Add the \"Secure\" setting to each cookie, usually through an option in the website platform or the server configuration.",
      "Check the page again to confirm the setting is present.",
    ],
    whoFixes: ["developer"],
  },
  "security.cookies.httponly": {
    whatItMeans:
      "Some cookies set by the website can be read by scripts running on the page. Cookies are small pieces of information the site stores in the visitor's browser.",
    whyItMatters:
      "If a harmful script ever ran on the page, it could read those cookies, including ones that keep a visitor signed in.",
    possibleImpact:
      "This could make another weakness more damaging. On its own, it is not evidence of a problem.",
    steps: [
      "Identify which cookies the page's own scripts really need to read.",
      "Add the \"HttpOnly\" setting to all other cookies, starting with sign-in and session cookies.",
      "Test that the website's features still work, then check the page again.",
    ],
    whoFixes: ["developer"],
  },
  "security.dns.spf": {
    whatItMeans:
      "The domain does not publish an SPF record. SPF is a public list, kept in the domain's settings, of the mail services allowed to send email for the domain.",
    whyItMatters:
      "Receiving email systems use this list to help tell genuine email from the domain apart from forged email.",
    possibleImpact:
      "Email from the domain may be more likely to be treated as suspicious, and it may be easier for others to send email pretending to come from it. This audit does not establish that either is currently happening.",
    steps: [
      "List every service that sends email for the domain, such as the email provider, the website, and any newsletter or booking tools.",
      "Create one SPF record that includes each of those services, using the values each service publishes.",
      "Add it as a TXT record with the company that manages the domain's DNS settings.",
      "Confirm the record with an online SPF checking tool.",
    ],
    whoFixes: ["dns"],
  },
  "security.dns.dmarc": {
    whatItMeans:
      "The domain does not publish a DMARC policy. DMARC is a public setting that tells receiving email systems how the domain owner wants them to handle messages that fail the domain's email-authentication checks, and where to send reports about them.",
    whyItMatters:
      "DMARC helps receiving email systems identify and handle messages that fail the domain's email-authentication policy. Its reports also show which services are sending email using the domain's name.",
    possibleImpact:
      "Receiving email systems have no instruction from the domain owner about messages that fail these checks, and the owner receives no reports. This is one of several email protections, and it does not mean that the domain's email is failing to arrive.",
    steps: [
      "Make sure SPF is in place, and that DKIM email signing is turned on with the email provider.",
      "Publish a DMARC record at _dmarc on the domain with a monitoring-only policy (p=none) and an email address to receive reports.",
      "Review the reports for a few weeks to confirm that genuine email passes the checks.",
      "Then strengthen the policy step by step (p=quarantine, then p=reject).",
    ],
    whoFixes: ["dns"],
  },

  // -------------------------------------------------------------------------
  // Search visibility
  // -------------------------------------------------------------------------
  "seo.viewport.missing": {
    whatItMeans:
      "The page is missing the viewport tag, a short line of code that tells phones and tablets how to fit the page to their screens.",
    whyItMatters:
      "Without it, mobile devices may show the page as a shrunken version of the desktop page.",
    possibleImpact:
      "Mobile visitors may need to zoom and scroll sideways to read the page, and search engines take mobile-friendliness into account.",
    steps: [
      "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> to the page's head section.",
      "Check the page on several phone sizes.",
      "Adjust anything that does not fit the narrower screen.",
    ],
    whoFixes: ["developer"],
  },
  "seo.title.missing": {
    whatItMeans:
      "The page has no title. The title is the name shown in the browser tab, and usually the headline shown in search results.",
    whyItMatters:
      "Search engines and visitors use the title to understand what the page is about before opening it.",
    possibleImpact:
      "Search engines may write a headline for the page themselves, which may describe it less clearly.",
    steps: [
      "Write a short, unique title that describes the page and includes the business name.",
      "Add it in the page's head section, or in the SEO title field of the website platform.",
      "Check the page again after publishing.",
    ],
    whoFixes: ["seo", "developer"],
  },
  "seo.meta-description.missing": {
    whatItMeans:
      "The page has no meta description. This is a short summary of the page that search engines may show under its headline in search results.",
    whyItMatters:
      "A clear summary helps people decide whether the page is what they are looking for.",
    possibleImpact:
      "Search engines may pick text from the page instead, which may be less relevant. A missing description is not a ranking penalty.",
    steps: [
      "Write one or two sentences that summarise the page for a potential visitor.",
      "Add it through the SEO description field of the website platform, or in the page's head section.",
      "Use a different description for each important page.",
    ],
    whoFixes: ["seo"],
  },
  "seo.canonical.missing": {
    whatItMeans:
      "The page does not state its preferred web address. This is called the canonical URL.",
    whyItMatters:
      "The same page can often be opened at several addresses, for example with or without \"www\", or with tracking codes added. Stating the preferred address gives search engines a clear signal about which one is the main version.",
    possibleImpact:
      "Without it, search engines may not receive a clear signal about the preferred address, although they can use other signals to choose one. This audit does not establish that it has affected the site's search results.",
    steps: [
      "Decide on the preferred address for each page.",
      "Add a canonical tag pointing to that address. Most website platforms and SEO plugins can do this automatically.",
      "Make sure redirects and links within the site use the same preferred addresses.",
    ],
    whoFixes: ["developer", "seo"],
  },
  "seo.lang.missing": {
    whatItMeans:
      "The page does not state which language it is written in.",
    whyItMatters:
      "Screen readers (software that reads pages aloud) use the language to pronounce words correctly, browsers use it to offer translation, and search engines use it as a hint.",
    possibleImpact:
      "Visitors using a screen reader may hear the page read with the wrong pronunciation.",
    steps: [
      "Add the language setting to the page's html tag, for example lang=\"en\" for English.",
      "Use the correct language code on each language version of the site.",
    ],
    whoFixes: ["developer"],
  },
  "seo.h1.missing": {
    whatItMeans:
      "The page has no main heading. The main heading (coded as h1) is the top-level heading that states what the page is about.",
    whyItMatters:
      "The main heading helps visitors, search engines and screen-reader users understand the page and find their way around it.",
    possibleImpact:
      "The page's structure and purpose may be less clear to search engines and to people using screen readers.",
    steps: [
      "Add one clear main heading near the top of the page that describes its content.",
      "If a visible title is already styled to look like a heading, mark it as the h1 instead.",
    ],
    whoFixes: ["developer", "seo"],
  },
  "seo.h1.multiple": {
    whatItMeans:
      "The page has more than one main heading (coded as h1).",
    whyItMatters:
      "A single main heading makes it clear what the page is about.",
    possibleImpact:
      "The page's structure may be less clear to search engines and to people using screen readers. This is usually a minor issue.",
    steps: [
      "Choose the heading that best describes the whole page and keep it as the h1.",
      "Change the other main headings to lower levels (h2 or h3).",
      "Adjust their appearance with styling if they need to look the same as before.",
    ],
    whoFixes: ["developer"],
  },
  "seo.h1.empty": {
    whatItMeans:
      "The page has a main heading (h1), but it contains no readable text.",
    whyItMatters:
      "Search engines and screen readers get nothing useful from a heading without text.",
    possibleImpact:
      "The page loses the benefit of having a main heading.",
    steps: [
      "Put readable text inside the main heading.",
      "If the heading contains a picture such as a logo, give that picture alternative text describing it.",
    ],
    whoFixes: ["developer"],
  },
  "seo.headings.order": {
    whatItMeans:
      "The page's heading levels skip a step, for example going straight from the main heading (h1) to a fourth-level heading (h4).",
    whyItMatters:
      "Headings work like a table of contents. Skipped levels make that outline harder to follow, especially for screen-reader users.",
    possibleImpact:
      "This has a minor effect on accessibility and on how clearly the page is organised.",
    steps: [
      "Arrange headings in order: one h1, then h2, then h3 where needed, without skipping levels.",
      "Control the size of headings with styling rather than by choosing a different level.",
    ],
    whoFixes: ["developer"],
  },
  "seo.images.alt": {
    whatItMeans:
      "Some pictures on the page have no alternative text. Alternative text is a short description that screen readers read aloud, and that browsers show if the picture cannot load.",
    whyItMatters:
      "Visitors who use screen readers miss what those pictures show, and search engines use the description to understand pictures.",
    possibleImpact:
      "Some visitors face an accessibility barrier, and search engines may understand those pictures less well.",
    steps: [
      "Add a short, accurate description to each meaningful picture, usually through its alt text field in the website platform.",
      "Give purely decorative pictures an empty alternative text so screen readers skip them.",
      "Check the page again after the changes.",
    ],
    whoFixes: ["seo", "developer"],
  },

  // -------------------------------------------------------------------------
  // Technical
  // -------------------------------------------------------------------------
  "technical.robots.blocks-all": {
    whatItMeans:
      "The site's robots.txt file, a short file that gives instructions to search engines, tells every search engine not to visit any page of the site.",
    whyItMatters:
      "Search engines that follow this instruction do not read the site's pages. It is often left over from when the website was still being built.",
    possibleImpact:
      "Pages may be missing from search results, or shown without a description. This audit checked the instruction, not the site's current search listings.",
    steps: [
      "Open the robots.txt file at the root of the website.",
      "Remove the \"Disallow: /\" line that applies to all search engines, keeping only blocks that are intended.",
      "Ask search engines to read the site again, for example through Google Search Console.",
    ],
    whoFixes: ["developer", "seo"],
  },

  // -------------------------------------------------------------------------
  // Speed
  // -------------------------------------------------------------------------
  "speed.field.lcp.slow": {
    whatItMeans: `${LCP_MEANS} Google rates this result as slow.`,
    whyItMatters:
      "Visitors judge a site's speed by how soon the main content appears.",
    possibleImpact:
      "Some visitors may leave before the page has finished appearing. Google uses these measurements as one of many signals about page experience.",
    steps: LCP_STEPS,
    whoFixes: ["developer", "hosting"],
  },
  "speed.field.lcp.needs-improvement": {
    whatItMeans: `${LCP_MEANS} Google rates this result as needing improvement.`,
    whyItMatters:
      "Visitors judge a site's speed by how soon the main content appears.",
    possibleImpact:
      "Some visitors, particularly on slower connections, may wait noticeably before seeing the page's main content.",
    steps: LCP_STEPS,
    whoFixes: ["developer", "hosting"],
  },
  "speed.field.inp.slow": {
    whatItMeans: `${INP_MEANS} Google rates this result as slow.`,
    whyItMatters:
      "When a page is slow to react, visitors can feel that it is not working.",
    possibleImpact:
      "Visitors may tap or click repeatedly, become frustrated, or give up on what they were doing.",
    steps: INP_STEPS,
    whoFixes: ["developer"],
  },
  "speed.field.inp.needs-improvement": {
    whatItMeans: `${INP_MEANS} Google rates this result as needing improvement.`,
    whyItMatters:
      "Quick reactions to taps and clicks make a site feel smooth and dependable.",
    possibleImpact:
      "Some visitors may notice a delay after tapping, clicking or typing.",
    steps: INP_STEPS,
    whoFixes: ["developer"],
  },
  "speed.field.cls.slow": {
    whatItMeans: `${CLS_MEANS} Google rates the amount of movement as poor.`,
    whyItMatters:
      "Content that moves while someone is reading, or about to tap, is disruptive.",
    possibleImpact:
      "Visitors may tap the wrong item or lose their place while the page loads.",
    steps: CLS_STEPS,
    whoFixes: ["developer"],
  },
  "speed.field.cls.needs-improvement": {
    whatItMeans: `${CLS_MEANS} Google rates the amount of movement as needing improvement.`,
    whyItMatters:
      "A page that stays still while loading is easier and more pleasant to use.",
    possibleImpact:
      "Some visitors may notice content moving while the page loads.",
    steps: CLS_STEPS,
    whoFixes: ["developer"],
  },
  "speed.lab.score": {
    whatItMeans:
      "Google did not have enough real-visitor data for this page, so it ran a simulated test, loading the page on a virtual phone. The simulated test rated the page as poor.",
    whyItMatters:
      "A poor simulated score suggests the page may be heavy or slow to load, especially on phones and slower connections.",
    possibleImpact:
      "This is an estimate from a test, not a measurement of real visitors, but it suggests that some of them may experience slow loading.",
    steps: [
      "Open the PageSpeed Insights report for this page and review the improvements it lists.",
      "Start with the biggest items, usually oversized pictures, unused scripts and files that delay the first display.",
      "Run the test again after each round of changes.",
      "Check the real-visitor results again once the site has more traffic.",
    ],
    whoFixes: ["developer"],
  },
};

/** Where a finding's evidence panel was measured. Report wording, shared by the PDF. */
export const EVIDENCE_PANEL_HEADINGS = {
  site: "Measured for the whole site",
  mainPage: "Measured on the main page checked",
} as const;

/** The explanation for a rule, or null when the rule has none. */
export function explainerFor(ruleId: string): FindingExplainer | null {
  return Object.hasOwn(FINDING_EXPLAINERS, ruleId) ? FINDING_EXPLAINERS[ruleId] : null;
}

/** The "who should fix it" line, in report wording. */
export function whoFixesLabel(explainer: FindingExplainer): string {
  return explainer.whoFixes.map((role) => FIX_ROLE_LABELS[role]).join(", ");
}
