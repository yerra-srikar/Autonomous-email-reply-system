# Setup Instructions

## For Google Apps Script Deployment

### Prerequisites
- Google account
- Google Sheet (create a new one)
- Gemini API key (from https://aistudio.google.com/app/apikey)

### Step 1: Create Google Sheet
1. Go to https://sheets.google.com
2. Click **"+ Blank"** to create new sheet
3. Name it something like `"Email Operations Agent"`
4. **Copy the Sheet ID** from the URL (the long string between `/d/` and `/edit`)

### Step 2: Open Apps Script
1. In your Google Sheet, click **Extensions → Apps Script**
2. Delete the default `Code.gs` content
3. Paste the entire contents of `code_reviewed_final.js`
4. Click **Save**

### Step 3: Add Gemini API Key
1. Click the ⚙️ **gear icon** (Project Settings) in left sidebar
2. Scroll to **"Script Properties"**
3. Click **"Add script property"**
4. Fill in:
   - **Property:** `GEMINI_API_KEY`
   - **Value:** [Your Gemini API key]
5. Click **Save**

### Step 4: Initialize Sheet Structure
1. In Apps Script, find the `setupSheets` function
2. Click the play ▶️ button next to it
3. Click **Authorize** when prompted (grant Gmail access)
4. Wait for completion

### Step 5: Test It
1. Run the `processIncomingEmails` function
2. It will process up to 40 unread emails from your inbox
3. Check your Google Sheet for new tabs: Sponsorship_Log, Support_Log, etc.

### Step 6: Set Up Automation (Optional)
1. Click ⏰ **Triggers** (left sidebar)
2. Click **Create new trigger**
3. Select function: `processIncomingEmails`
4. Event type: Time-driven
5. Frequency: Every 5 minutes (or hourly)
6. Click **Save**


---

## Troubleshooting

**Error: "GEMINI_API_KEY is empty"**
- Check Project Settings → Script Properties
- Verify the property name is exactly `GEMINI_API_KEY`
- Verify the API key is valid (test at https://aistudio.google.com/app/apikey)

**Error: "Permission denied for Gmail"**
- Click **Authorize** when prompted
- Grant all permissions (Apps Script needs Gmail access)

**Emails not processing**
- Check Gmail for "AI-Processed" label (emails already processed)
- Check for "Needs-Review" label (escalated emails)
- Run the function again with fresh unread emails

---

## How It Works

1. **Incoming emails** → System fetches up to 40 unread emails
2. **Classification** → Gemini AI classifies each email by category + sub_category
3. **Policy lookup** → System checks policy rules for that category
4. **Routing** → Email gets auto-replied, escalated, or trashed
5. **Logging** → Decision logged to appropriate tab (Sponsorship_Log, Support_Log, etc.)
6. **Labeling** → Email labeled with "AI-Processed" (or "Needs-Review" if escalated)

---

## Files Included

- `code_reviewed_final.js` — Main Apps Script code
- `SETUP_INSTRUCTIONS.md` — This file
- `ESCALATION_FLOW.md` — Detailed escalation process
- `API_KEY_SETUP.md` — API key setup guide
- `README.md` — Project overview
- `LICENSE` — MIT License

---

## Support

For issues or questions, refer to the ESCALATION_FLOW.md and API_KEY_SETUP.md files.
