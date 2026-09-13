"use client";

import { useState } from "react";
import {
  CONFIRM_LABEL,
  NO_RECIPIENT,
  PREVIEW_LABEL,
  SEND_HEADING,
  SEND_INTRO,
  UNCONFIRMED,
  canConfirm,
  canSend,
  confirm,
  previewFor,
  withdraw,
  type SendContent,
  type SendGate,
} from "@/lib/report/sendGate";
import {
  SEND_READY,
  confirmBox,
  runSend,
  sendButton,
  sentNote,
  type SendState,
} from "@/lib/report/sendRequest";
import styles from "./page.module.css";

/**
 * Reading what a client would receive, agreeing to it, and sending it.
 *
 * WHAT THIS COMPONENT DECIDES: nothing. It holds three pieces of state and
 * renders them. What counts as a confirmation, what silently voids one and
 * whether a send would be permitted are in lib/report/sendGate.ts; what one
 * press of the button does, which fields cross to the server and whether a
 * second press may start a second send are in lib/report/sendRequest.ts. Both
 * are reachable by a test without a browser.
 *
 * THE CONFIRMATION LIVES INSIDE THE PREVIEW, deliberately. It cannot be given
 * without the content being on screen, and having it on screen gives nothing:
 * the rule that decides whether a send is permitted is never told the preview
 * was opened, because it has no parameter for it.
 *
 * THERE IS NO SECOND CONFIRMATION. The tick is the whole attestation and the
 * fingerprint behind it is what the server checks; adding an "are you sure"
 * on top would be a dialogue people learn to dismiss, and it would not be the
 * thing that gates the send.
 *
 * IT KNOWS NOTHING ABOUT MAIL. No provider, no key, no sending address — the
 * request it makes carries the job, the address typed here, the confirmation
 * and the three report fields, and the server supplies everything else.
 */
export function ReportSend({
  jobId,
  auditedUrl,
  companyName,
  contactName,
  preparedBy,
}: {
  jobId: string;
  /** The address the audit finished on, as the report's cover states it. */
  auditedUrl: string;
  /** The three optional fields the report itself carries, so the preview agrees with it. */
  companyName?: string;
  contactName?: string;
  preparedBy?: string;
}) {
  /** Typed here because the application holds no contact details of its own. */
  const [recipient, setRecipient] = useState("");
  const [open, setOpen] = useState(false);
  const [gate, setGate] = useState<SendGate>(UNCONFIRMED);
  const [state, setState] = useState<SendState>(SEND_READY);

  const content: SendContent = {
    jobId,
    recipient,
    auditedUrl,
    companyName,
    contactName,
    preparedBy,
  };

  const preview = previewFor(content);
  const ready = canConfirm(content);
  const sendable = canSend(gate, content);
  const button = sendButton(state, sendable);
  const box = confirmBox(state, ready);

  return (
    <section className={styles.send} aria-labelledby="report-send-heading">
      <h3 id="report-send-heading" className={styles.exportHeading}>
        {SEND_HEADING}
      </h3>
      <p className={styles.exportIntro}>{SEND_INTRO}</p>

      <label className={styles.sendField}>
        <span className={styles.exportLabel}>Client email address</span>
        <input
          className={styles.exportInput}
          type="email"
          value={recipient}
          disabled={state.kind === "sending"}
          onChange={(event) => {
            setRecipient(event.target.value);
            /*
             * A standing confirmation was about a different email. The rule
             * would refuse the send anyway, since the fingerprint no longer
             * matches; clearing it here is so the tick a person is looking at
             * agrees with that.
             *
             * The outcome is cleared too: a report that went to one address
             * has not gone to the one now in the box, and leaving "Sent to…"
             * under a different address would say it had.
             */
            setGate(withdraw());
            setState(SEND_READY);
          }}
        />
      </label>

      <div className={styles.exportAction}>
        <button
          className={styles.button}
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          {open ? "Hide the preview" : PREVIEW_LABEL}
        </button>
      </div>

      {open && (
        <div className={styles.preview}>
          {/*
            Rendered as the four things a send would use, each labelled, rather
            than as a mock of an email client. The reader is checking content,
            not admiring a window.
          */}
          <dl className={styles.previewFields}>
            <div>
              <dt>To</dt>
              <dd>{preview.recipient === "" ? NO_RECIPIENT : preview.recipient}</dd>
            </div>
            <div>
              <dt>Subject</dt>
              <dd>{preview.subject}</dd>
            </div>
            <div>
              <dt>Attachment</dt>
              <dd>{preview.attachment}</dd>
            </div>
          </dl>

          {/* Our own wording, with its line breaks shown as they would be sent. */}
          <p className={styles.previewBody}>{preview.body}</p>

          <label className={styles.confirm}>
            <input
              type="checkbox"
              checked={sendable}
              disabled={box.disabled}
              onChange={(event) => {
                setGate(event.target.checked ? confirm(content) : withdraw());
                if (state.kind === "failed") setState(SEND_READY);
              }}
            />
            <span>{CONFIRM_LABEL}</span>
          </label>

          {!ready && <p className={styles.exportHint}>{NO_RECIPIENT}</p>}

          <div className={styles.exportAction}>
            <button
              className={styles.button}
              type="button"
              onClick={() =>
                void runSend(state, gate, content, { onState: setState, onGate: setGate })
              }
              disabled={button.disabled}
              aria-busy={state.kind === "sending"}
            >
              {button.label}
            </button>
          </div>

          {/*
            Announced, not merely shown. This is the one action on the page
            with no undo, so the line saying it happened names the address it
            happened to.
          */}
          {state.kind === "sent" && (
            <p className={styles.exportDone} role="status">
              {sentNote(state.recipient)}
            </p>
          )}

          {/*
            The server's own sentence, unchanged. It was written for a person
            and it already guarantees that nothing internal is in it — no key,
            no provider reply, no request id.
          */}
          {state.kind === "failed" && (
            <p className={styles.exportProblem} role="alert">
              {state.message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
