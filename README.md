# Autonomous-email-reply-system

An intelligent email triage system for student clubs and event committees that classifies incoming emails, executes appropriate actions (auto-reply, escalate, or discard), and maintains a complete audit trail — all powered by Gemini AI and running entirely on Google Apps Script.

---

## The Problem

Event organizers and club committees receive hundreds of emails during a hackathon, fest, or recruitment cycle — sponsorship pitches, registration questions, payment issues, spam, and everything in between. Sorting through them manually is slow, error-prone, and takes people away from actually running the event.

## The Solution

This system reads every incoming email, classifies it against a defined taxonomy, checks it against an editable rulebook, and then does exactly one of three things: replies automatically, flags it for a human to review, or discards it as spam. Every decision is logged with full reasoning so nothing disappears silently.

---

## What It Actually Does

1. **Reads** up to 40 unread emails per run from Gmail (inbox + spam folder)
2. **Classifies** each one using Gemini AI into a category and sub-category
3. **Looks up** the matching policy (who owns it, how confident the AI needs to be, what action to take)
4. **Decides** the action: auto-respond, escalate, request more info, or mark as spam
5. **Acts**: sends a reply, labels + stars the thread for human review, or trashes it
6. **Logs** everything — sender, classification, confidence, reasoning, action taken — to a structured Google Sheet
7. **Repeats**, safely, even if individual emails fail along the way

---

## Architecture

```
Incoming emails (batch of 40)
        │
        ▼
 VIP allowlist check ──────► reclassify trusted senders if misflagged
        │
        ▼
 Gemini AI classification ──► category + sub_category (trained on 17 in-context examples)
        │
        ▼
 Policy lookup ─────────────► matches category + sub_category against rules sheet
        │
        ▼
 Confidence check ──────────► if < 70% or flagged, force escalation
        │
   ┌────┼────┐
   ▼    ▼    ▼
 SPAM  ESCALATE  AUTO-RESPOND
 (trash)  (label +   (reply sent)
          star, no
          reply)
   │    │    │
   └────┼────┘
        ▼
 Log decision to correct sheet tab
        ▼
 Label thread + mark read
        ▼
 (escalated threads) → Human reviews via "Needs-Review" label
```

Full diagram: see `Architecture.pdf` in this repo.

---

## Classification Taxonomy

| Category | Sub-categories | Typical action |
|---|---|---|
| **sponsorship** | monetary, in-kind, alumni, refreshment/vendor, unclear/dual-purpose | Auto-respond, escalates if ≥ ₹25,000 or MoU involved |
| **registration** | solo/team eligibility, external/outstation, deadlines/certificates, auditions, equipment/format, recruitment | Auto-respond |
| **support** | payment issues, missing confirmation, invoices, form access, data correction, past certificates, refunds, accessibility, email updates, deadline extensions | Split — technical issues auto-respond, financial/sensitive issues always escalate |
| **spam** | promotional/marketing, phishing/scam | Trashed immediately, no reply |
| **ambiguous** | unclear context, forwarded chains, mixed asks, misdirected/general inquiries, vague feedback | Request clarification or escalate |

28 sub-categories in total, each mapped to an owner, an auto-action, a response tone, and an escalation condition — all defined in the **Policies** sheet, not hardcoded.

---

## Human-in-the-Loop / Escalation

The system deliberately does **not** try to resolve everything automatically. It escalates:

- All financial matters (payments, refunds, invoices)
- Accessibility requests
- Deadline extension requests
- High-value or legally-binding sponsorship offers
- Emails with two distinct asks bundled together
- Anything the AI is under 70% confident about
- Anything Gemini fails to classify (API errors escalate, they never fail silently)

Escalated emails get a **"Needs-Review"** Gmail label and are starred. No auto-reply is sent — a human decides what to say. The system also tells you *who* should own the decision (Finance Sub-committee, Event Logistics, Faculty Advisor, etc.), based on the matched policy row.

---

## Where the Rules Live

Everything the AI is allowed to decide on its own lives in a **Google Sheet**, not in code:

**`Policies` tab** — 10 columns per row:
`category | sub_category | owner | trigger_keywords | constraint | auto_action | response_tone | escalation_condition | escalate_to | log_sheet_tab`

Anyone on the team — no coding required — can open this sheet and change:
- Which categories auto-reply vs. escalate
- Who a given issue routes to
- The tone of the auto-reply
- The confidence threshold for escalation

**8 separate log tabs** record every decision:
`Sponsorship_Log`, `Registration_Log`, `Support_Log`, `Spam_Log`, `Ambiguous_Log`, `Mixed_Requests_Log`, `Feedback_Log`, `Redirected_Log` — plus a fallback `EmailLog` for anything unclassifiable.

---

## Safety Design

- **Per-thread error isolation** — if one email crashes the pipeline, the rest of the batch still processes (most systems don't do this)
- **Escalate on AI failure** — if Gemini returns nothing or errors out three times in a row, the email is escalated rather than silently skipped
- **Confidence-gated auto-reply** — low-confidence classifications never get an automatic response
- **VIP allowlist override** — trusted senders can't get trapped in spam or ambiguous buckets by mistake
- **No sender leakage in replies** — auto-reply signature is generic ("— Operations Team (AI-assisted)"), no organization name is exposed
- **Rate-limit aware** — 4-second delay between emails, safely within Gemini's free-tier limits (15 requests/min) for a 40-email batch

---

## Tech Stack

- **Google Apps Script** — orchestration, Gmail access, spreadsheet logging (no external server, no hosting cost)
- **Gemini 2.5 Flash API** — classification + draft reply generation, trained via 17 in-context examples rather than fine-tuning (free tier compatible)
- **Google Sheets** — the policy engine and the audit log, both human-editable

---

## Setup

1. Create a blank Google Sheet
2. Open **Extensions → Apps Script** and paste in `email_agent.js`
3. Get a free Gemini API key from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
4. In Apps Script, go to **Project Settings → Script Properties**, add:
   - Property: `GEMINI_API_KEY`
   - Value: your key
5. Run the `setupSheets()` function once (authorize Gmail access when prompted) — this creates all 9 tabs and populates the Policies sheet with default rules
6. Run `processIncomingEmails()` to test, or set up a time-driven trigger to run it automatically every few minutes

Full details in `SETUP_INSTRUCTIONS.md`.

---

## Repo Contents

```
├── email_agent.js            # Main Apps Script code
├── README.md                 # This file
├── SETUP_INSTRUCTIONS.md     # Step-by-step deployment guide
├── ESCALATION_FLOW.md        # Detailed human-review process
├── Architecture.pdf          # System diagram
├── Sample_Inputs/             # Example emails used for testing
├── Sample_Outputs/             # Logs, replies, and decisions produced
├── Screenshots/               # Dashboard, sheet, and inbox views
├── .gitignore
└── LICENSE                   # MIT
```

---

## What Makes This More Than an Email Bot

It's a policy-driven triage engine, not a chatbot: high-volume routine decisions are automated, anything involving money, safety, or ambiguity is routed to a human with full context, and every single decision — automated or escalated — is logged and auditable. The rulebook is a spreadsheet anyone on the team can edit, so the system's behavior can evolve without a single line of code changing.

---

## License

MIT — use freely, modify as needed.
