# Autonomous-email-reply-system

> An AI-powered Google Apps Script system that reads incoming emails for a student club/event organization, classifies them using Google's Gemini AI, and automatically replies, escalates, or filters spam — all logged to a Google Sheet.

---

## Table of Contents

1. [What This System Does](#what-this-system-does)
2. [How It Works — The Big Picture](#how-it-works--the-big-picture)
3. [Project File Structure](#project-file-structure)
4. [Setup Instructions](#setup-instructions)
5. [Configuration Reference](#configuration-reference)
6. [Email Categories and Sub-Categories](#email-categories-and-sub-categories)
7. [Decision Logic — How Emails Are Routed](#decision-logic--how-emails-are-routed)
8. [The Policy Sheet — What It Controls](#the-policy-sheet--what-it-controls)
9. [Log Sheets — What Gets Recorded](#log-sheets--what-gets-recorded)
10. [Function Reference](#function-reference)
11. [Trusted Allowlist (VIP Senders)](#trusted-allowlist-vip-senders)
12. [Safety and Error Handling](#safety-and-error-handling)
13. [Rate Limits and Quotas](#rate-limits-and-quotas)
14. [FAQ](#faq)

---

## What This System Does

When a new email arrives in your Gmail inbox (or spam folder), this system:

1. **Reads the email** — sender, subject, and up to 3000 characters of body text.
2. **Sends it to Gemini AI** — which classifies it into a category (e.g. sponsorship, registration, support, spam).
3. **Looks up your policy rules** from a Google Sheet to decide what to do.
4. **Takes action automatically:**
   - Sends a pre-written reply for routine emails.
   - Escalates important or sensitive emails to a human reviewer.
   - Marks spam and moves it to trash.
   - Asks the sender for clarification when the email is too vague.
5. **Logs every decision** to a dedicated sheet tab for auditing.
6. **Labels the thread** as `AI-Processed` so it never gets processed twice.

---

## How It Works — The Big Picture

```
New Unread Email Arrives
        │
        ▼
┌──────────────────────┐
│  Read email details  │  ← sender, subject, body (first 3000 chars)
└──────────────────────┘
        │
        ▼
┌──────────────────────┐
│  Is sender trusted?  │  ← Check TRUSTED_ALLOWLIST
└──────────────────────┘
        │
        ▼
┌──────────────────────┐
│  Send to Gemini AI   │  ← Classifies category, urgency, recommends action
└──────────────────────┘
        │
   ┌────┴────┐
   │ Gemini  │
   │ failed? │──── YES ──→ Escalate to human reviewer
   └────┬────┘
        │ NO
        ▼
┌───────────────────────────────┐
│  Override if trusted sender   │  ← If AI called a VIP "spam", correct it
│  was misclassified as spam    │
└───────────────────────────────┘
        │
        ▼
┌──────────────────────┐
│  Look up Policy Sheet│  ← Match category + sub_category to a row
└──────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────┐
│           Route based on action                     │
│                                                     │
│  SPAM?  ──────────────→  Label + Trash              │
│  ESCALATE? ───────────→  Star + Add Needs-Review    │
│  AUTO_RESPOND? ───────→  Send drafted reply         │
│  REQUEST_INFO? ───────→  Send clarification ask     │
└─────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────┐
│  Log to Google Sheet │  ← Records everything for audit
│  Label AI-Processed  │
└──────────────────────┘
```

---

## Project File Structure

This is a single Google Apps Script (`.gs`) file deployed inside a Google Spreadsheet. Here's what each section of the code does:

```
Code.gs
│
├── CONFIGURATION           → Sheet name, label names
├── getApiKey()             → Reads Gemini API key from Script Properties
├── processIncomingEmails() → MAIN function — orchestrates everything
├── callGemini()            → Sends email to Gemini, parses AI response
├── getPolicy()             → Reads policy rules from the Google Sheet
├── executeAction()         → Routes action (reply / escalate / spam)
├── sendAutoReply()         → Sends an auto-reply via Gmail
├── escalateEmail()         → Stars + labels thread for human review
├── markAsSpam()            → Labels + trashes spam thread
├── logDecision()           → Appends a row to the correct log sheet tab
└── setupSheets()           → One-time setup: creates Policy + Log sheets
```

---

## Setup Instructions

Follow these steps in order. You only need to do the one-time setup once.

### Step 1 — Create a Google Spreadsheet

- Go to [sheets.google.com](https://sheets.google.com) and create a new blank spreadsheet.
- This spreadsheet will hold your policy rules and all email decision logs.

### Step 2 — Open the Script Editor

- In your spreadsheet, click **Extensions → Apps Script**.
- Delete any existing code in `Code.gs`.
- Paste the full contents of this project's `Code.gs` file.
- Click **Save** (floppy disk icon).

### Step 3 — Add Your Gemini API Key

- In the Apps Script editor, click the **gear icon (⚙️) → Project Settings**.
- Scroll to **Script Properties** and click **Add script property**.
- Set property name: `GEMINI_API_KEY`
- Set value: your actual Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey).
- Click **Save script properties**.

> ⚠️ **Never paste your API key directly in the code.** Script Properties keep it secure and out of version control.

### Step 4 — Run First-Time Sheet Setup

- In the Apps Script editor, select the function `setupSheets` from the dropdown.
- Click **Run**.
- Grant any permissions Gmail/Sheets asks for.
- This creates a `Policies` sheet with all 28 rule rows, plus all log sheet tabs automatically.

### Step 5 — Add the Automation Trigger

- In the Apps Script editor, click the **clock icon (⏰) Triggers** in the left sidebar.
- Click **+ Add Trigger** (bottom right).
- Set:
  - Function to run: `processIncomingEmails`
  - Event source: `Time-driven`
  - Type: `Minutes timer` → Every `10 minutes` (or your preferred frequency)
- Click **Save**.

Your system is now live. Every 10 minutes it will check for new unread emails and process them.

---

## Configuration Reference

At the top of `Code.gs`, you can edit these four constants:

| Constant | Default Value | What It Controls |
|---|---|---|
| `POLICY_SHEET` | `'Policies'` | Name of the sheet tab containing your rules |
| `PROCESSED_LABEL` | `'AI-Processed'` | Gmail label applied after an email is handled |
| `REVIEW_LABEL` | `'Needs-Review'` | Gmail label applied when escalated to a human |
| `SPAM_LABEL` | `'AI-Spam-Detected'` | Gmail label applied before trashing spam |

To change the trusted VIP senders list, edit the `TRUSTED_ALLOWLIST` array inside `processIncomingEmails()`:

```javascript
const TRUSTED_ALLOWLIST = [
  "sample@mail.com",       // exact email
  "@iitbhilai.ac.in"      // entire domain
];
```

Any sender whose address *contains* a string from this list is trusted, even if Gemini classifies their email as spam.

---

## Email Categories and Sub-Categories

Gemini classifies every email into one of these **5 categories**, each with specific sub-categories. These map directly to rows in your Policies sheet.

---

### 📦 `sponsorship`

| Sub-Category | Meaning |
|---|---|
| `monetary sponsorship` | Cash offers, prize pools, direct funding, MoU requests |
| `in-kind sponsorship` | Free products, licenses, kits, equipment (no cash) |
| `alumni sponsorship` | Offer from an IIT Bhilai alumnus or alumna |
| `refreshment/local vendor sponsorship` | Food, coffee, catering stalls |
| `unclear/dual-purpose sponsorship` | Email mixes registration + sponsorship |

---

### 📋 `registration`

| Sub-Category | Meaning |
|---|---|
| `solo/team eligibility` | Team size rules, solo participation, auto-pairing |
| `external/outstation participants` | Other colleges, accommodation questions |
| `deadline/certificate queries` | Registration deadlines, last dates, certificates |
| `audition/selection process` | Cultural club auditions (Swara, Drishya, etc.) |
| `equipment/format queries` | DSLR rules, weight/size limits, submission format |
| `recruitment / sub-team allocation` | Motorsports/Epsilon sub-team joining |

---

### 🛠️ `support`

| Sub-Category | Meaning |
|---|---|
| `payment issues` | Money deducted but status shows pending/failed |
| `missing confirmation email` | No confirmation received after registration |
| `invoice/receipt requests` | Needs official invoice or receipt |
| `access/permission issues (forms etc.)` | Form link broken, permission error |
| `data correction requests` | Wrong name/team name, needs fix |
| `past event certificate issues` | Certificate from prior year not received |
| `refund requests` | Event cancelled, asking for money back |
| `accessibility requests` | Wheelchair, disability accommodation |
| `email/contact update requests` | Needs to change registered email address |
| `deadline extension requests` | Requesting more time due to emergency |

---

### 🗑️ `spam`

| Sub-Category | Meaning |
|---|---|
| `promotional/marketing` | Follower growth, generic marketing, sales pitches |
| `phishing/scam` | Prize notifications, crypto, bank detail requests |

---

### ❓ `ambiguous`

| Sub-Category | Meaning |
|---|---|
| `unclear context` | Vague email, references "the thing", no context |
| `forwarded/chain emails with no new content` | Fwd chain with no actionable message |
| `mixed registration+sponsorship` | Wants to both attend AND sponsor |
| `general/unrelated inquiries` | Misdirected emails (admissions, JEE, hostel) |
| `vague feedback/complaints` | Mild dissatisfaction, no specific incident |

---

## Decision Logic — How Emails Are Routed

After Gemini classifies the email, the system decides what to do using this logic:

### The Four Possible Actions

| Action String | What Happens |
|---|---|
| `auto_respond` | Sends Gemini's drafted reply to the sender |
| `request_info` | Sends a clarification request asking for more details |
| `escalate` | Stars the thread, adds `Needs-Review` label, no reply sent |
| `mark_spam` | Adds `AI-Spam-Detected` label, marks read, moves to trash |

### When Escalation Is Forced (Regardless of AI Recommendation)

These situations always escalate to a human, no exceptions:

- Payment issues (money involved)
- Refund requests
- Invoice/receipt requests
- Past event certificate issues
- Accessibility requests
- Deadline extension requests
- Monetary sponsorship where amount ≥ ₹25,000 OR a formal MoU is requested
- Alumni sponsorship requesting a recruitment booth or naming rights
- Mixed registration + sponsorship (dual asks)
- Gemini AI returned an error or null response

### When Spam Action Is Forced

- All emails classified as `spam` category go to trash — no reply ever sent.
- **Exception:** if the sender is in the `TRUSTED_ALLOWLIST`, the spam classification is overridden and the email is treated as a support query instead.

### Confidence Threshold

Every Gemini response includes a `confidence` score (0 to 1). If confidence falls below `0.7` (configurable per policy row), the email is automatically escalated regardless of what action Gemini recommended.

---

## The Policy Sheet — What It Controls

The `Policies` sheet (created by `setupSheets()`) has one row per category+sub_category combination. Here is what each column means:

| Column | Field Name | Purpose |
|---|---|---|
| A | `category` | e.g. `sponsorship` |
| B | `sub_category` | e.g. `monetary sponsorship` |
| C | `owner_club_or_council` | Which team/club owns this type of email |
| D | `trigger_keywords` | Keywords that hint at this category (for reference) |
| E | `constraint_or_policy` | Human-readable rule describing what must happen |
| F | `auto_action` | Plain-English description of what the system does |
| G | `response_tone` | Tone instruction for reply drafting (e.g. "warm, professional") |
| H | `escalation_condition` | When a human MUST be involved |
| I | `escalate_to` | Who the human reviewer is (name or email) |
| J | `log_sheet_tab` | Which log sheet tab to write this decision to |

You can **edit rows directly in the sheet** to change behavior — no code changes needed for most customizations.

---

## Log Sheets — What Gets Recorded

Every processed email is recorded in one of these sheet tabs (created automatically):

| Tab Name | What It Logs |
|---|---|
| `Sponsorship_Log` | All sponsorship-related emails |
| `Registration_Log` | All registration queries |
| `Support_Log` | All support requests |
| `Spam_Log` | All detected spam |
| `Ambiguous_Log` | Unclear or vague emails |
| `Mixed_Requests_Log` | Emails that mix registration + sponsorship |
| `Redirected_Log` | Misdirected general inquiries |
| `Feedback_Log` | Vague complaints and feedback |
| `General_Log` | Fallback for unknown categories |

Each row in a log tab records:

```
Timestamp | Sender Email | Subject | Category | Sub-Category |
Confidence | Sentiment | Urgency | Action Taken | Reasoning
```

---

## Function Reference

### `processIncomingEmails()`
**The main function.** Called by the time-driven trigger. Searches Gmail for unread emails from the last 2 days (inbox + spam), processes up to 40 threads per run, and routes each one through the full pipeline. Each thread is wrapped in a try/catch so one bad email cannot crash the rest of the batch.

### `callGemini(emailData)`
Sends the email details to the Gemini 2.5 Flash API with a detailed system prompt and 16 few-shot examples. Returns a structured JSON object with the classification, confidence score, urgency, sentiment, recommended action, and a draft reply. Retries up to 3 times with exponential backoff on HTTP 429 (rate limit) or 503 (server error). Returns `null` if all attempts fail.

### `getPolicy(category, sub_category)`
Looks up the matching row in the `Policies` sheet for the given category and sub_category. Returns the policy object including who owns the email type, what to escalate to, and which log tab to write to. Returns a safe default fallback policy if no match is found.

### `executeAction(action, message, thread, analysis, policy)`
Routes to the correct handler based on the action string. Handles `auto_respond`, `request_info`, `escalate`, and `mark_spam`. Falls back to escalation for any unrecognized action value.

### `sendAutoReply(message, analysis)`
Replies to the email using Gemini's `draft_reply` field. Falls back to a generic acknowledgment message if the draft is empty.

### `escalateEmail(thread, message, analysis, policy)`
Adds the `Needs-Review` Gmail label, stars the message, and logs which human reviewer should handle it. Does not send any reply.

### `markAsSpam(thread, message)`
Adds the `AI-Spam-Detected` Gmail label, marks the message as read, and moves the thread to trash. Never sends a reply.

### `logDecision(emailData, analysis, actionTaken, targetTab)`
Appends one row to the specified log sheet tab. Creates the tab with headers if it doesn't exist yet.

### `setupSheets()`
**One-time setup function.** Creates the `Policies` sheet and populates it with all 28 default rule rows. Also creates all log sheet tabs with their column headers. Run this once manually before your first email is processed.

---

## Trusted Allowlist (VIP Senders)

The `TRUSTED_ALLOWLIST` inside `processIncomingEmails()` is a list of email addresses or domain fragments. Any sender whose email address contains one of these strings is considered trusted.

**What this changes:**
- If Gemini classifies a trusted sender's email as `spam` or `ambiguous`, it is overridden to `support → missing confirmation email`.
- The spam trash pipeline is bypassed entirely for trusted senders.
- The email will receive a reply instead of being deleted.

**Example:**
```javascript
const TRUSTED_ALLOWLIST = [
  "sample@mail.com",         // Exact match
  "@iitbhilai.ac.in",        // Entire institute domain
  "faculty.advisor@"          // Partial match on sender name
];
```

---

## Safety and Error Handling

This system is designed to fail safely at every point:

| Situation | What Happens |
|---|---|
| Gemini API returns null or malformed JSON | Email is escalated to human reviewer, never silently dropped |
| Gemini API returns HTTP 429 or 503 | Retried up to 3 times with exponential backoff (2s, 4s, 6s) |
| All 3 Gemini retries fail | Returns null → triggers human escalation path |
| An unexpected error on one thread | Caught by try/catch, logged, pipeline continues to next thread |
| Unknown action string from Gemini | Escalated to human rather than silently ignored |
| Policy sheet row not found | Returns a safe fallback policy that always escalates |
| Log sheet tab deleted | Recreated automatically with correct headers on next run |

---

## Rate Limits and Quotas

| Limit | Value | Notes |
|---|---|---|
| Gemini 2.5 Flash free tier | 15 requests/minute | System uses 4-second sleep between threads to stay under this |
| Threads per run | 40 max | Set in the `GmailApp.search()` call; lower if hitting quota |
| Email body read limit | 3000 characters | Prevents oversized payloads to Gemini |
| Gmail search window | 2 days (`newer_than:2d`) | Ensures only recent unread emails are processed |
| Trigger frequency | Every 10 minutes (recommended) | Adjust based on email volume |

If you are processing a high volume of emails, reduce the trigger frequency or lower the thread limit (change `40` to a smaller number in the `GmailApp.search()` call).

---

## FAQ

**Q: Will this ever reply to a spam email?**
No. The `mark_spam` action never sends a reply. `draft_reply` is always an empty string for spam, and the code checks for `isSpam` before attempting any reply.

**Q: What happens if I misspell a category in the Policies sheet?**
The `getPolicy()` function trims and lowercases both sides before matching, so minor capitalization differences are handled. A complete mismatch falls back to the default escalation policy.

**Q: Can I add new categories?**
Yes — add a new row to the Policies sheet AND add the new `category` and `sub_category` string to the Gemini system prompt's STEP 1 list. Both must match exactly.

**Q: How do I change the reply tone?**
Edit column G (`response_tone`) in the Policies sheet for the relevant row. This is passed as context to Gemini when drafting replies.

**Q: What if I want to stop the automation temporarily?**
Go to Apps Script → Triggers → and delete or pause the time-driven trigger. Re-add it when ready.

**Q: Is my Gemini API key secure?**
Yes, as long as you stored it in Script Properties (not hardcoded). Script Properties are not visible in version control or to other users who view the spreadsheet.

**Q: How do I see what the AI decided for a specific email?**
Check the relevant log sheet tab (e.g. `Support_Log`, `Sponsorship_Log`). Every processed email has a row with the full decision, confidence score, and reasoning.

---

## Tech Stack

| Component | Technology |
|---|---|
| Scripting runtime | Google Apps Script (JavaScript) |
| AI classification | Google Gemini 2.5 Flash (`gemini-2.5-flash`) |
| Email access | Gmail API via `GmailApp` service |
| Data storage | Google Sheets via `SpreadsheetApp` service |
| Scheduling | Apps Script Time-driven Triggers |

---
