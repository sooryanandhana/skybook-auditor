"use client";

import { useState } from "react";
import {
  CONFIRM_LABEL,
  NOT_CONNECTED,
  NO_RECIPIENT,
  PREVIEW_LABEL,
  SEND_HEADING,
  SEND_INTRO,
  SEND_LABEL,
  UNCONFIRMED,
  canConfirm,
  canSend,
  confirm,
  previewFor,
  withdraw,
  type SendContent,
  type SendGate,
} from "@/lib/report/sendGate";
import styles from "./page.module.css";

/**
 * Reading what a client would receive, and saying so.
 *
 * WHAT THIS COMPONENT DECIDES: nothing. It holds two pieces of state and
 * renders them. What counts as a confirmation, what silently voids one, and
 * whether a send would be permitted are all in lib/report/sendGate.ts, where a
 * test can reach them without a browser.
 *
 * THE CONFIRMATION LIVES INSIDE THE PREVIEW, deliberately. It cannot be given
 * without the content being on screen, and having it on screen gives nothing:
 * the rule that decides whether a send is permitted is never told the preview
 * was opened, because it has no parameter for it.
 *
 * NOTHING HERE SENDS ANYTHING and there is nowhere for it to send. There is no
 * provider, no address book and no request. The send control exists so the gate
 * in front of it can be built and tested before there is something behind it.
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
  const [note, setNote] = useState<string | null>(null);

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
          onChange={(event) => {
            setRecipient(event.target.value);
            /*
             * A standing confirmation was about a different email. The rule
             * would refuse the send anyway, since the fingerprint no longer
             * matches; clearing it here is so the tick a person is looking at
             * agrees with that.
             */
            setGate(withdraw());
            setNote(null);
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
              disabled={!ready}
              onChange={(event) => {
                setGate(event.target.checked ? confirm(content) : withdraw());
                setNote(null);
              }}
            />
            <span>{CONFIRM_LABEL}</span>
          </label>

          {!ready && <p className={styles.exportHint}>{NO_RECIPIENT}</p>}

          <div className={styles.exportAction}>
            <button
              className={styles.button}
              type="button"
              onClick={() => setNote(NOT_CONNECTED)}
              disabled={!sendable}
            >
              {SEND_LABEL}
            </button>
          </div>

          {note !== null && (
            <p className={styles.exportProblem} role="status">
              {note}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
