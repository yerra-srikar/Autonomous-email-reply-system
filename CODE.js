// ============ CONFIGURATION ============
const SHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const POLICY_SHEET = 'Policies';
const PROCESSED_LABEL = 'AI-Processed';
const REVIEW_LABEL = 'Needs-Review';       // Applied to threads flagged for human review
const SPAM_LABEL = 'AI-Spam-Detected';     // Applied to threads identified as spam before trashing

// ============ RECOVERY HELPERS ============
// Dynamically fetches your API Key from the project properties environment settings
function getApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key || key === 'YOUR_ACTUAL_API_KEY_HERE') {
    throw new Error("Operational Blockade: GEMINI_API_KEY script property is empty. Please save a valid key in Project Settings.");
  }
  return key;
}

// ============ MAIN ENGINE REASONING ORCHESTRATOR ============
function processIncomingEmails() {
  // Define your trusted VIP list here. It can be specific emails or whole domains.
  const TRUSTED_ALLOWLIST = [
    "sample@mail.com" // Anything ending with this domain will bypass spam checks
  ];

  // Grabs up to 40 threads within a 2-day window from both inbox and spam folders
  const threads = GmailApp.search('{in:inbox in:spam} is:unread -label:AI-Processed newer_than:2d', 0, 40);
  
  if (threads.length === 0) {
    Logger.log("No new unread emails found matching the pipeline criteria.");
    return;
  }
  
  Logger.log(`Found ${threads.length} unread thread(s) to process.`);
  
  threads.forEach(thread => {
    // ── Per-thread isolation: a crash on one email must NOT kill the rest of the batch ──
    try {
      const messages = thread.getMessages();
      const latest = messages[messages.length - 1]; 
      
      const emailData = {
        sender: latest.getFrom(), 
        subject: latest.getSubject(),
        body: latest.getPlainBody().substring(0, 3000), 
        date: latest.getDate().toISOString()
      };
      
      Logger.log(`Analyzing: "${emailData.subject}" from ${emailData.sender}`);

      // Check if the sender is part of the trusted allowlist
      const isTrusted = TRUSTED_ALLOWLIST.some(trustedItem => {
        return emailData.sender.toLowerCase().includes(trustedItem.toLowerCase());
      });
      
      // 1. Call the structured Gemini inference engine
      let analysis = callGemini(emailData);
     
      if (!analysis) {
        // SAFETY NET: Gemini failed — escalate rather than silently do nothing.
        // Silently skipping means the sender never hears back and we have no record.
        Logger.log(`⚠️ Gemini returned null for "${emailData.subject}". Escalating for human review.`);
        const nullAnalysis = {
          category: 'unknown', sub_category: 'api_failure',
          confidence: 0, urgency: 'high', sentiment: 'unknown',
          reasoning: 'Gemini API returned null or malformed JSON. Manual review required.',
          recommended_action: 'escalate', escalate: true, draft_reply: ''
        };
        const fallbackPolicy = getPolicy('unknown', 'api_failure');
        escalateEmail(thread, latest, nullAnalysis, fallbackPolicy);
        logDecision(emailData, nullAnalysis, 'escalated_api_failure', fallbackPolicy.log_sheet_tab);
        const processed = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
        thread.addLabel(processed);
        latest.markRead();
        Utilities.sleep(4000);
        return; // Move to next thread
      }

      // OVERRIDE FOR TRUSTED SENDERS: If AI misclassified a VIP as spam/ambiguous, fix it
      if (isTrusted && (analysis.category === 'spam' || analysis.category === 'ambiguous')) {
        Logger.log(`🛡️ Allowlist Override: Reclassifying trusted sender ${emailData.sender} from '${analysis.category}' to 'support'`);
        analysis.category = 'support';
        analysis.sub_category = 'missing confirmation email'; // Sensible neutral fallback
        analysis.recommended_action = 'auto_respond';
        analysis.escalate = false;
      }
      
      // 2. Fetch match policies from your sheet configurations
      const policy = getPolicy(analysis.category, analysis.sub_category);
      
      // 3. Evaluate safety confidence thresholds and escalation conditions
      const shouldEscalate = (analysis.escalate === true) || 
                             (analysis.confidence < (policy.escalate_threshold || 0.7));
                             
      // 4. Route: spam → trash; escalate → human queue; else → execute action
      const isSpam = analysis.category === 'spam';
      const finalAction = shouldEscalate ? 'escalate' : (analysis.recommended_action || 'escalate');

      if (isSpam && !isTrusted) {
        markAsSpam(thread, latest);
      } else if (finalAction === 'escalate') {
        escalateEmail(thread, latest, analysis, policy);
      } else {
        executeAction(finalAction, latest, thread, analysis, policy);
      }
      
      // 5. Log the decision
      const loggedAction = (isSpam && !isTrusted) ? 'spam_deleted' : finalAction;
      logDecision(emailData, analysis, loggedAction, policy.log_sheet_tab);
      
      // 6. Label AI-Processed + mark read (skip for spam — already trashed)
      if (!isSpam || isTrusted) {
        const label = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
        thread.addLabel(label);
        latest.markRead();
      }
      Logger.log(`✅ Routing complete: "${emailData.subject}" → ${loggedAction}`);

    } catch (threadError) {
      // If something unexpected crashes mid-thread, log it and keep going
      Logger.log(`🔴 Unhandled error on thread — skipping to next. Error: ${threadError.toString()}`);
    }
    
    // ====== RATE THROTTLE — 4s is safe for Gemini 2.5 Flash (15 req/min free tier) ======
    Utilities.sleep(4000); 
  });
}

// ============ MASTER INFERENCE ENGINE ============
// ============ MASTER INFERENCE ENGINE ============
function callGemini(emailData) {
  const apiKey = getApiKey();
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey;
  
  const systemInstruction = `You are an advanced AI Email Operations Agent for a student event/club organization at IIT Bhilai. Your job is to classify incoming emails and decide on the correct action with high accuracy.

STEP 1 — CLASSIFY using ONLY these exact category + sub_category pairs (case-sensitive, copy EXACTLY):

category: sponsorship
  sub_category: monetary sponsorship       — cash offers, prize pools, direct funding, MoU requests
  sub_category: in-kind sponsorship        — free products, licenses, kits, equipment (no cash)
  sub_category: alumni sponsorship         — offer from an IIT Bhilai alumnus/alumna
  sub_category: refreshment/local vendor sponsorship — food, coffee, stalls, catering
  sub_category: unclear/dual-purpose sponsorship    — email mixes registration + sponsorship

category: registration
  sub_category: solo/team eligibility      — team size rules, solo participation, auto-pairing
  sub_category: external/outstation participants — other colleges, accommodation questions
  sub_category: deadline/certificate queries — registration deadlines, last dates, certificates
  sub_category: audition/selection process — cultural club auditions (Swara, Drishya, etc.)
  sub_category: equipment/format queries   — DSLR rules, weight/size limits, submission format
  sub_category: recruitment / sub-team allocation — Motorsports/Epsilon sub-team joining

category: support
  sub_category: payment issues             — money deducted but status shows pending/failed
  sub_category: missing confirmation email — no confirmation received after registration
  sub_category: invoice/receipt requests   — needs official invoice or receipt for payment
  sub_category: access/permission issues (forms etc.) — form link broken, permission error
  sub_category: data correction requests   — wrong name/team name submitted, needs fix
  sub_category: past event certificate issues — certificate from prior year not received
  sub_category: refund requests            — event cancelled, asking for money back
  sub_category: accessibility requests     — wheelchair, disability accommodation
  sub_category: email/contact update requests — needs to change registered email address
  sub_category: deadline extension requests — requesting more time due to emergency

category: spam
  sub_category: promotional/marketing      — follower growth, generic marketing, sales pitches
  sub_category: phishing/scam              — prize notifications, crypto, bank detail requests

category: ambiguous
  sub_category: unclear context            — vague, references 'the thing', no context
  sub_category: forwarded/chain emails with no new content — Fwd chain, no actionable message
  sub_category: mixed registration+sponsorship — wants to both attend AND sponsor
  sub_category: general/unrelated inquiries — misdirected emails (admissions, JEE, hostel)
  sub_category: vague feedback/complaints  — mild dissatisfaction, no specific incident

---

STEP 2 — REAL EXAMPLES FROM ACTUAL EMAILS (learn these patterns):

EXAMPLE 1 — MONETARY SPONSORSHIP (should auto_respond, but escalate if >= ₹25k or has MoU)
From: rohan.mehta@technovasolutions.com
Subject: Sponsorship Proposal — LiveAI Hackathon 2026
Body excerpt: "We're TechNova Solutions, a Bangalore-based AI infra startup... would love to explore sponsoring... as a title sponsor or prize sponsor... Could you share your sponsorship deck..."
→ category: sponsorship | sub_category: monetary sponsorship | confidence: 0.95
→ recommended_action: auto_respond | escalate: false

EXAMPLE 2 — IN-KIND SPONSORSHIP (free products/licenses)
From: priya.k@circuitworks.in
Subject: Component Sponsorship for Arduino Basics Workshop
Body excerpt: "We'd be happy to provide 50 starter kits at no cost... in exchange for mention on poster and 5-minute company intro..."
→ category: sponsorship | sub_category: in-kind sponsorship | confidence: 0.98
→ recommended_action: auto_respond | escalate: false

EXAMPLE 3 — HIGH-VALUE MONETARY SPONSORSHIP (escalate due to amount + MoU)
From: akash.sharma@tvsracing.com
Subject: Title Sponsorship Inquiry — Baja SAEINDIA Campaign
Body excerpt: "...high-value sponsorship (₹3–5 lakhs range)... we may need a formal MoU..."
→ category: sponsorship | sub_category: monetary sponsorship | confidence: 0.97
→ recommended_action: escalate | escalate: true (amount ≥ ₹25,000 AND MoU requested)

EXAMPLE 4 — ALUMNI SPONSORSHIP WITH RECRUITMENT BOOTH
From: founder@insightloop.ai
Subject: Alumni Startup Wants to Sponsor Meraz 2026
Body excerpt: "I'm an IIT Bhilai alum (2022 batch)... sponsoring ₹1,00,000... Logo placement... recruitment booth access..."
→ category: sponsorship | sub_category: alumni sponsorship | confidence: 0.96
→ recommended_action: escalate | escalate: true (booth access = escalate)

EXAMPLE 5 — REGISTRATION: SOLO/TEAM ELIGIBILITY
From: student.cs23045@iitbhilai.ac.in
Subject: Solo Registration for AlgoClash — Is It Allowed?
Body excerpt: "I want to participate in AlgoClash but couldn't find a teammate in time... is solo participation allowed, or do I get auto-paired..."
→ category: registration | sub_category: solo/team eligibility | confidence: 0.99
→ recommended_action: auto_respond | escalate: false

EXAMPLE 6 — REGISTRATION: EXTERNAL/OUTSTATION PARTICIPANTS
From: rahul.b22@otherinstitute.edu.in
Subject: Team Registration Query — Meraz Robotics Event
Body excerpt: "We're a team of 3 from a college outside Chhattisgarh... Is outstation participation allowed, and is there accommodation support?..."
→ category: registration | sub_category: external/outstation participants | confidence: 0.98
→ recommended_action: auto_respond | escalate: false

EXAMPLE 7 — SUPPORT: PAYMENT ISSUES (escalate — financial)
From: student.payment22@iitbhilai.ac.in
Subject: Payment Deducted But Registration Not Confirmed
Body excerpt: "I registered for AlgoClash and got charged ₹500 via UPI, but status shows 'Payment Pending'... I have transaction reference UTR123456..."
→ category: support | sub_category: payment issues | confidence: 0.98
→ recommended_action: escalate | escalate: true (always escalate payment issues)

EXAMPLE 8 — SUPPORT: MISSING CONFIRMATION EMAIL (auto_respond)
From: priyaraj.iit@gmail.com
Subject: No Confirmation Email After Registration
Body excerpt: "I completed registration... but never received confirmation... I've checked spam folder... My email is priyaraj.iit@gmail.com..."
→ category: support | sub_category: missing confirmation email | confidence: 0.97
→ recommended_action: auto_respond | escalate: false (technical, not financial)

EXAMPLE 9 — SUPPORT: REFUND REQUEST (escalate — financial)
From: student.sports@iitbhilai.ac.in
Subject: Refund Request — Sports Meet Event Cancelled
Body excerpt: "The outdoor athletics event I registered and paid for got cancelled due to heavy rain... when should I expect refund? Amount paid: ₹50"
→ category: support | sub_category: refund requests | confidence: 0.99
→ recommended_action: escalate | escalate: true (always escalate refunds)

EXAMPLE 10 — SUPPORT: ACCESSIBILITY REQUEST (escalate)
From: student.parent.rkumar@gmail.com
Subject: Wheelchair Accessibility for Meraz Venue
Body excerpt: "My daughter uses a wheelchair... Could you let us know if venue is wheelchair accessible, and if volunteer assistance can be arranged..."
→ category: support | sub_category: accessibility requests | confidence: 0.98
→ recommended_action: escalate | escalate: true (always escalate accessibility)

EXAMPLE 11 — SPAM: PROMOTIONAL/MARKETING
From: growth@socialboostpro.biz
Subject: 🚀 Get 10,000 Instagram Followers for Your Event Page!!!
Body excerpt: "Boost your event's Instagram page to 10K+ followers in just 7 days!... Special discount for college events — only ₹999/month!"
→ category: spam | sub_category: promotional/marketing | confidence: 0.99
→ recommended_action: mark_spam | escalate: false | draft_reply: ""

EXAMPLE 12 — SPAM: PHISHING/SCAM
From: prize.notification@luckydraw-international.com
Subject: CONGRATULATIONS! Your Club Has Won a Prize!
Body excerpt: "Your Club has been selected... won a cash prize of \\$5,000 USD!... reply with your bank account details and a processing fee of ₹2,500..."
→ category: spam | sub_category: phishing/scam | confidence: 0.99
→ recommended_action: mark_spam | escalate: false | draft_reply: ""

EXAMPLE 13 — AMBIGUOUS: UNCLEAR CONTEXT
From: student.unclear22@iitbhilai.ac.in
Subject: regarding the thing
Body excerpt: "hii so about the thing we talked about last week, is it still happening? also can you send the link again... are seniors allowed too or only juniors..."
→ category: ambiguous | sub_category: unclear context | confidence: 0.96
→ recommended_action: request_info | escalate: false

EXAMPLE 14 — AMBIGUOUS: FORWARDED CHAIN WITH NO CONTENT
From: office.externalcompany@gmail.com
Subject: Fwd: Fwd: Re: Meraz Collaboration
Body excerpt: "[Forwarded message] See below, please action this. [Original: we spoke to someone from the tech fest a while back about doing something together, can someone follow up? attaching nothing for now...]"
→ category: ambiguous | sub_category: forwarded/chain emails with no new content | confidence: 0.97
→ recommended_action: request_info | escalate: false

EXAMPLE 15 — AMBIGUOUS: MIXED REGISTRATION + SPONSORSHIP
From: founder@brightedge-learning.com
Subject: Partnership / Registration — DesignX Workshop
Body excerpt: "We'd like to send 3 of our team members to attend as participants, AND separately, we'd also love to explore sponsoring the workshop with discount vouchers... guide us on next steps for both..."
→ category: ambiguous | sub_category: mixed registration+sponsorship | confidence: 0.98
→ recommended_action: escalate | escalate: true (dual asks require split handling)

EXAMPLE 16 — AMBIGUOUS: GENERAL/UNRELATED INQUIRY (misdirected)
From: prospective.student.parent@gmail.com
Subject: Question about IIT Bhilai
Body excerpt: "My son is in 12th grade preparing for JEE... tell us generally what the campus and clubs are like... is it a good branch — Data Science and AI or Mechanical? Also is hostel food good?"
→ category: ambiguous | sub_category: general/unrelated inquiries | confidence: 0.99
→ recommended_action: auto_respond | escalate: false (redirect to admissions)

EXAMPLE 17 — AMBIGUOUS: VAGUE FEEDBACK/COMPLAINT
From: student.unhappy23@iitbhilai.ac.in
Subject: the event yesterday
Body excerpt: "hey so the event yesterday was honestly not managed well at all... lot of issues with timing and the questions were also weird for round 2... just wanted to flag this..."
→ category: ambiguous | sub_category: vague feedback/complaints | confidence: 0.92
→ recommended_action: auto_respond | escalate: false (no safety/harassment/financial mention)

---

STEP 3 — DECISION RULES:

recommended_action can ONLY be ONE of these four exact strings:
  'auto_respond'  — Send the draft reply
  'request_info'  — Send a clarification request
  'escalate'      — Flag for human review (no reply)
  'mark_spam'     — Trash immediately

escalate field MUST ALWAYS be present as a boolean:
  true  — only when recommended_action is 'escalate'
  false — for everything else

CRITICAL ESCALATION TRIGGERS (always recommended_action 'escalate', escalate: true):
  ✗ payment issues
  ✗ refund requests
  ✗ invoice/receipt requests
  ✗ past event certificate issues
  ✗ accessibility requests
  ✗ deadline extension requests
  ✗ monetary sponsorship with MoU OR value >= ₹25,000
  ✗ alumni sponsorship requesting booth/naming rights
  ✗ mixed registration+sponsorship (dual asks)

CRITICAL SPAM RULE (recommended_action 'mark_spam', escalate: false):
  ✗ ALL emails in spam category → mark_spam, never escalate, never reply
  ✗ draft_reply must be empty string for spam

---

STEP 4 — RESPOND IN JSON ONLY

Return ONLY a clean JSON object with NO markdown wrappers, NO backticks, NO preamble.

Schema (all 9 fields required, no extras):
{
  "category": "sponsorship | registration | support | spam | ambiguous",
  "sub_category": "string (exactly as listed in STEP 1 for your chosen category)",
  "confidence": number (0 to 1),
  "urgency": "low | medium | high",
  "sentiment": "string (e.g., positive, neutral, negative, frustrated, grateful)",
  "reasoning": "string (1-2 sentences)",
  "recommended_action": "auto_respond | request_info | escalate | mark_spam",
  "escalate": boolean,
  "draft_reply": "string (empty string if mark_spam)"
}`;
    
  const promptText = "Analyze this email and return the JSON object:\n\n" +
                     "From: " + emailData.sender + "\n" +
                     "Subject: " + emailData.subject + "\n" +
                     "Body:\n" + emailData.body;
                     
  const payload = {
    "contents": [{ "parts": [{ "text": promptText }] }],
    "systemInstruction": { "parts": [{ "text": systemInstruction }] },
    "generationConfig": {
      "responseMimeType": "application/json",
      "temperature": 0.1 // Lowered temperature to force stricter adherence to category lists
    }
  };
  
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  
  // Built-in Retry Backoff Loop
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const responseCode = response.getResponseCode();
      
      if (responseCode === 200) {
        const jsonResponse = JSON.parse(response.getContentText());
        return JSON.parse(jsonResponse.candidates[0].content.parts[0].text);
      } else if (responseCode === 503 || responseCode === 429) {
        Logger.log("Server returned " + responseCode + ". Retrying attempt " + attempt + "...");
        Utilities.sleep(2000 * attempt); 
      } else {
        throw new Error("Server returned error code " + responseCode + ": " + response.getContentText());
      }
    } catch (error) {
      Logger.log(`Gemini attempt ${attempt} threw: ${error.toString()}`);
      if (attempt === 3) {
        Logger.log("All 3 Gemini attempts failed. Returning null for safety-net handling.");
        return null; // Caller will escalate rather than crash the batch
      }
      Utilities.sleep(3000 * attempt);
    }
  }
}

// ============ DATA RANGE POLICIES LOOKUP ============
function getPolicy(category, sub_category) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(POLICY_SHEET);
    const data = sheet.getDataRange().getValues();
    
    // Clean the inputs from Gemini to prevent mapping failures from stray spaces or capitals
    const cleanCat = String(category).trim().toLowerCase();
    const cleanSubCat = String(sub_category).trim().toLowerCase();
    
    // Start at 1 to skip headers
    for (let i = 1; i < data.length; i++) {
      // Clean sheet data to ensure perfect matching
      const sheetCat = String(data[i][0]).trim().toLowerCase();
      const sheetSubCat = String(data[i][1]).trim().toLowerCase();
      
      if (sheetCat === cleanCat && sheetSubCat === cleanSubCat) {
        return {
          category: data[i][0],
          sub_category: data[i][1],
          owner: data[i][2],
          auto_action: data[i][5],
          response_tone: data[i][6],
          escalate_to: data[i][8],
          log_sheet_tab: data[i][9] || 'General_Log',
          escalate_threshold: 0.7 
        };
      }
    }
  } catch(e) {
    Logger.log("Policy sheet reference error: " + e.toString());
  }
  // Default fallback rules
  return { 
    category: 'unknown', 
    sub_category: 'unknown', 
    auto_action: 'escalate', 
    escalate_to: 'Human Reviewer',
    log_sheet_tab: 'General_Log',
    escalate_threshold: 1.0 
  };
}

// ============ TARGET ROUTING LOGIC EXECUTOR ============
// IMPORTANT: Gemini is now constrained to return ONLY these four action strings:
//   'auto_respond' | 'request_info' | 'escalate' | 'mark_spam'
// The switch handles them exactly. Any unexpected value escalates for safety.
function executeAction(action, message, thread, analysis, policy) {
  const a = (action || '').toLowerCase().trim();

  switch (a) {
    case 'auto_respond':
    case 'request_info':
      sendAutoReply(message, analysis);
      break;

    case 'escalate':
      escalateEmail(thread, message, analysis, policy);
      break;

    case 'mark_spam':
      markAsSpam(thread, message);
      break;

    case 'log_only':
      Logger.log("Log-only action — no reply sent.");
      break;

    default:
      // Unknown or empty action — escalate rather than silently do nothing.
      // This is the safety net that prevents the "AI-Processed but no action" state.
      Logger.log(`⚠️ Unrecognised action value: "${action}" — escalating for safety.`);
      escalateEmail(thread, message, analysis, policy);
      break;
  }
}

function sendAutoReply(message, analysis) {
  const reply = analysis.draft_reply || 
    `Thank you for reaching out. We have received your email regarding "${message.getSubject()}" and will get back to you shortly.`;
  
  message.reply(reply + '\n\n— Operations Team (AI-assisted)');
  Logger.log("Autonomous auto-response successfully executed.");
}

function escalateEmail(thread, message, analysis, policy) {
  const label = GmailApp.getUserLabelByName(REVIEW_LABEL) || GmailApp.createLabel(REVIEW_LABEL);
  thread.addLabel(label);
  message.star();
  Logger.log(`Thread has been escalated to ${policy ? policy.escalate_to : 'Human Reviewer'}.`);
}

// ============ SPAM HANDLER ============
// Labels the thread AI-Spam-Detected, marks read, and moves to trash.
// No reply is ever sent for spam. The trusted allowlist bypasses this entirely.
function markAsSpam(thread, message) {
  const label = GmailApp.getUserLabelByName(SPAM_LABEL) || GmailApp.createLabel(SPAM_LABEL);
  thread.addLabel(label);
  message.markRead();
  thread.moveToTrash();
  Logger.log("Spam thread labelled [AI-Spam-Detected] and moved to trash.");
}

// ============ SPREADSHEET AUDITING OPERATIONS ============
function logDecision(emailData, analysis, actionTaken, targetTab) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(targetTab);
    
    // Fallback if the specific log sheet was deleted or missing
    if (!sheet) {
      sheet = ss.insertSheet(targetTab);
      sheet.appendRow(["Timestamp", "Sender Email", "Subject", "Category", "Sub-Category", "Confidence", "Sentiment", "Urgency", "Action Taken", "Reasoning"]);
    }
    
    sheet.appendRow([
      new Date(),
      emailData.sender,
      emailData.subject,
      analysis.category,
      analysis.sub_category,
      analysis.confidence,
      analysis.sentiment,
      analysis.urgency,
      actionTaken,
      analysis.reasoning
    ]);
  } catch(e) {
    Logger.log("Failed appending spreadsheet tracking database values row: " + e.toString());
  }
}

// ============ STRUCTURAL DATABASE SETUP INITIALIZER ============
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Initialize the Master Policies tab
  let policySheet = ss.getSheetByName(POLICY_SHEET);
  if (!policySheet) {
    policySheet = ss.insertSheet(POLICY_SHEET);
  }
  policySheet.clear();
  policySheet.appendRow([
    "category", "sub_category", "owner_club_or_council", "trigger_keywords", 
    "constraint_or_policy", "auto_action", "response_tone", "escalation_condition", 
    "escalate_to", "log_sheet_tab"
  ]);
  
  // Embedded CSV Data mapping
  const rulesData = [
    ["sponsorship", "monetary sponsorship", "Meraz Core Committee", "sponsor, sponsorship, fund, funding, prize pool, MoU", "Any monetary sponsorship above ₹25,000 requires Treasurer + Faculty Advisor sign-off before confirmation", "Send sponsorship info pack + tier sheet automatically", "Professional, warm", "Amount >= ₹25,000 OR sender requests MoU/legal agreement", "Treasurer + Faculty Advisor", "Sponsorship_Log"],
    ["sponsorship", "in-kind sponsorship", "Respective Club (DSAI/FOSS/ELECTROMOS/etc.)", "free, complimentary, in-kind, licenses, kits, equipment donation", "In-kind offers under ₹10,000 equivalent can be accepted by club lead directly", "Acknowledge offer + request shipping/logistics details", "Friendly, appreciative", "Offer involves data sharing, exclusivity clauses, or co-branding on official institute channels", "Club Faculty Advisor", "Sponsorship_Log"],
    ["sponsorship", "alumni sponsorship", "Meraz Core Committee / CoSA", "alumni, IIT Bhilai alum, batch of, give back", "Alumni sponsorships are welcomed but still require standard institute payment-receipt process", "Send official donation/sponsorship account details", "Warm, personal", "Sponsor requests recruitment booth, special access, or naming rights", "CoSA Faculty Advisor", "Sponsorship_Log"],
    ["sponsorship", "refreshment/local vendor sponsorship", "Event-specific Organizing Team", "refreshments, snacks, coffee, stall, catering", "Local vendor stalls require security/campus-entry clearance at least 5 days before event", "Forward vendor request to security coordination + acknowledge sender", "Friendly, brief", "Vendor requests overnight setup access or media coverage", "Event Logistics Head", "Sponsorship_Log"],
    ["sponsorship", "unclear/dual-purpose sponsorship", "Respective Club", "both registration and sponsorship, partnership AND attend, dual ask", "Emails combining registration + sponsorship asks must be split into two separate tracked items", "Auto-split into two log entries (registration + sponsorship) and respond to both parts", "Clear, structured", "Either sub-request individually meets its own escalation criteria", "Relevant Club Lead", "Mixed_Requests_Log"],
    ["registration", "solo/team eligibility", "AlgoClash Organizing Team", "solo, team size, allowed, eligibility", "Team size rules as published on registration page are final; no exceptions without committee vote", "Auto-reply with eligibility FAQ + registration link", "Helpful, concise", "Participant requests exception to published team-size rules", "AlgoClash Lead", "Registration_Log"],
    ["registration", "external/outstation participants", "Meraz Core Committee", "outside, other college, external, outstation, accommodation", "External participants allowed for all open-category events; accommodation support subject to availability, first-come-first-served", "Send external participant info pack (accommodation form + rules)", "Welcoming, informative", "Accommodation requests within 72 hours of event start", "Hospitality Coordinator", "Registration_Log"],
    ["registration", "deadline/certificate queries", "Event-specific Organizing Team", "deadline, last date, certificate, attendance", "Deadlines and certificate policy as published on event page are binding; certificates issued only to verified registrants", "Auto-reply with deadline date + certificate policy", "Direct, brief", "No published deadline exists for the referenced event", "Events Office (events@iitbhilai.ac.in)", "Registration_Log"],
    ["registration", "audition/selection process", "Swara / Drishya / Pixel Snappers / Quizzotica / DesignX", "audition, selection, slot, no experience, beginner", "Beginners are welcome at all cultural club auditions; no prerequisite experience required unless stated", "Send audition schedule + prep guidelines", "Encouraging, friendly", "Applicant requests private/individual audition slot outside published schedule", "Club Coordinator", "Registration_Log"],
    ["registration", "equipment/format queries", "Pixel Snappers / FOSS Club / Epsilon", "DSLR, mobile phone, own laptop, bring, format, weight limit", "Format rules (equipment allowed, weight/size limits) as published are final for the current edition", "Auto-reply with relevant format/spec sheet", "Direct, helpful", "Participant reports a discrepancy between published spec sheet and form", "Technical Lead of Club", "Registration_Log"],
    ["registration", "recruitment / sub-team allocation", "IIT Bhilai Motorsports / Epsilon", "recruitment, sub-team, first-year, new member, CAD experience", "First-year sub-team allocation is preference-based, not guaranteed; final allocation decided post-interview", "Send recruitment FAQ + interview schedule", "Encouraging, informative", "Applicant claims technical background relevant to a sub-team facing shortage (flag for review, do not auto-decide)", "Sub-team Lead", "Registration_Log"],
    ["support", "payment issues", "Finance Sub-committee", "payment, deducted, transaction, UPI, pending, failed", "Payment confirmation requires matching transaction ID against payment gateway records before status update", "Acknowledge + request transaction ID/screenshot if missing", "Reassuring, prompt", "Payment deducted >24 hours ago with no matching record found", "Finance Sub-committee Head", "Support_Log"],
    ["support", "missing confirmation email", "Event-specific Organizing Team", "no confirmation, did not receive, not received, spam folder", "Confirmation emails are sent within 24 hours of successful registration; agent must verify registration record before resending", "Check registration sheet; resend confirmation if record exists, else flag", "Reassuring, brief", "Registration record not found for the given email/team name", "Event Registration Coordinator", "Support_Log"],
    ["support", "invoice/receipt requests", "Finance Sub-committee", "invoice, receipt, accounting, NEFT, transaction reference", "Official invoices can only be issued for payments verified in the finance ledger; turnaround time is 3 working days", "Acknowledge + confirm 3-working-day turnaround", "Professional", "Payment amount in request does not match any ledger entry", "Finance Sub-committee Head", "Support_Log"],
    ["support", "access/permission issues (forms etc.)", "Event-specific Organizing Team", "permission, access denied, need permission, link not working", "Form sharing settings should always be 'Anyone with the link'; misconfiguration must be fixed within 2 hours of report during active registration windows", "Flag broken link to form owner immediately + send participant an alternate contact", "Apologetic, urgent", "Issue reported within 24 hours of a registration deadline", "Web/Forms Admin", "Support_Log"],
    ["support", "data correction requests", "Event-specific Organizing Team", "wrong, typo, correction, update, change team name", "Minor corrections (name/team name typos) can be made up to 24 hours before participant list finalization", "Update registration record + confirm correction via email", "Friendly, reassuring", "Correction request received after participant list has been finalized/published", "Event Registration Coordinator", "Support_Log"],
    ["support", "past event certificate issues", "Events Office", "certificate, last year, previous workshop, NWC, fellowship", "Certificate re-issuance for past events requires verification against historical attendance records (may take longer than current-event SLAs)", "Acknowledge + request original registration details for verification", "Patient, helpful", "Verification record cannot be located after search", "Events Office Archive Team", "Support_Log"],
    ["support", "refund requests", "Finance Sub-committee", "refund, cancelled, cancellation, weather, postponed", "Refunds for organizer-cancelled events are processed automatically within 7-10 working days; no action needed from participant beyond confirmation", "Acknowledge + confirm refund timeline", "Empathetic, reassuring", "Refund not reflected after 10 working days from cancellation date", "Finance Sub-committee Head", "Support_Log"],
    ["support", "accessibility requests", "Event Logistics / CoSA", "wheelchair, accessibility, disability, accommodation, assistance", "All major venues must have accessible routes identified at least 1 week before the event; volunteer assistance to be arranged on request", "Acknowledge + forward to Logistics for venue accessibility check", "Warm, accommodating", "Accessibility request received less than 48 hours before the event", "Event Logistics Head + CoSA", "Support_Log"],
    ["support", "email/contact update requests", "Event-specific Organizing Team", "update email, lost access, old email, deactivated", "Email updates require confirmation via the new email replying to a verification message before record is changed", "Send verification request to new email", "Friendly, careful", "Multiple update requests received for the same team (possible identity confusion)", "Event Registration Coordinator", "Support_Log"],
    ["support", "deadline extension requests", "Event-specific Organizing Team", "extension, medical emergency, more time, late submission", "Extensions are not auto-granted; medical/emergency cases are reviewed individually, max extension generally 24 hours", "Acknowledge + flag for human review, do not promise an outcome", "Empathetic, careful", "Any extension request (always requires human decision)", "Event Organizing Committee", "Support_Log"],
    ["spam", "promotional/marketing", "N/A", "followers, boost, guaranteed returns, discount, marketing offer, sales pitch", "Unsolicited marketing/promotional emails unrelated to club operations should not receive a substantive reply", "No reply; archive with spam tag", "N/A", "Sender claims existing relationship/contract with the club (verify before dismissing)", "Club Lead (verification only)", "Spam_Log"],
    ["spam", "phishing/scam", "N/A", "prize, lucky draw, claim your prize, processing fee, bank details, crypto investment", "Never reply to or click links in emails requesting payment, banking details, or 'processing fees'", "No reply; archive with spam tag + flag for security awareness if targeting club funds", "N/A", "Email specifically targets club treasury/funds (e.g., crypto investment pitch)", "IT Security / Faculty Advisor", "Spam_Log"],
    ["ambiguous", "unclear context", "N/A", "the thing, regarding the thing, last time we talked, no context", "Ambiguous emails referencing prior unspecified conversations should prompt a clarifying reply, not a guessed action", "Send clarification request asking for event name, dates, and specifics", "Polite, clarifying", "Sender does not respond to clarification within 3 days (close as unresolved)", "N/A", "Ambiguous_Log"],
    ["ambiguous", "forwarded/chain emails with no new content", "N/A", "Fwd: Fwd:, see below, please action this, attaching nothing for now", "Forwarded chains with no actionable details should be acknowledged and a direct point of contact requested", "Reply asking sender to provide direct details (not forwarded chain)", "Polite, professional", "Sender represents an organization proposing a formal collaboration (even if vague)", "Relevant Club Lead", "Ambiguous_Log"],
    ["ambiguous", "mixed registration+sponsorship", "N/A", "registration AND sponsorship, attend AND sponsor, partnership / registration", "Treat as two linked sub-requests; apply sponsorship and registration rules to each part separately", "Split into two log entries; respond covering both registration and sponsorship next steps", "Structured, clear", "Either sub-request individually meets its own escalation criteria", "Relevant Club Lead", "Mixed_Requests_Log"],
    ["ambiguous", "general/unrelated inquiries", "N/A", "prospective student, admission, JEE, hostel food, general question", "General queries unrelated to a specific club's operations should be redirected to the central Events/Student Affairs office", "Send polite redirect to events@iitbhilai.ac.in with general info links", "Friendly, welcoming", "N/A (always redirect, never escalate)", "Events Office", "Redirected_Log"],
    ["ambiguous", "vague feedback/complaints", "N/A", "not managed well, issues with, wasn't good, weird questions, flagging this", "Vague feedback without specifics should be acknowledged and participant invited to share details via a structured feedback form", "Send thank-you + link to structured feedback form", "Appreciative, non-defensive", "Feedback mentions a safety issue, harassment, or financial discrepancy (always escalate regardless of vagueness)", "Event Organizing Committee + CoSA", "Feedback_Log"]
  ];
  
  for (let i = 0; i < rulesData.length; i++) {
    policySheet.appendRow(rulesData[i]);
  }
  
  // 2. Initialize all the dynamic log tabs derived from the rules
  const uniqueLogTabs = [...new Set(rulesData.map(rule => rule[9]))];
  
  uniqueLogTabs.forEach(tabName => {
    let logSheet = ss.getSheetByName(tabName);
    if (!logSheet) {
      logSheet = ss.insertSheet(tabName);
    }
    logSheet.clear();
    logSheet.appendRow(["Timestamp", "Sender Email", "Subject", "Category", "Sub-Category", "Confidence", "Sentiment", "Urgency", "Action Taken", "Reasoning"]);
  });
  
  Logger.log("Database matrix initialization completed successfully! Custom policy and segmented log tabs have been created.");
}
