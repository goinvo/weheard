const axios = require("axios");
const { Redis } = require("@upstash/redis");
const serviceCategories = require("./service-request-categories.json");
const arlingtonOfficials = require("./arlington-officials.json");

const CATEGORIES_SUMMARY = serviceCategories.map((c) => {
  const fields = c.requiredFields.join(", ");
  const dropdowns = Object.entries(c.dropdownOptions)
    .map(([field, opts]) => `${field}: [${opts.join(" / ")}]`)
    .join("; ");
  return `- ${c.type}: collect ${fields}${dropdowns ? `. Options: ${dropdowns}` : ""}`;
}).join("\n");

const DIRECTORY_SUMMARY = arlingtonOfficials.map((o) =>
  `- ${o.area}: ${o.name}, ${o.title} - ${o.phone}`
).join("\n");

const BASE_PROMPT = `You are Heard, an empathetic civic guide for Arlington, MA. You help people figure out who to call, what programs exist, and how to get things done in town - for any everyday challenge.

WHAT YOU HELP WITH:
- Town service requests (potholes, trees, water/sewer, health, snow, graffiti, etc.)
- Local resources: food programs, housing assistance, Human Services, senior services, SNAP
- Tenant rights, consumer protection, legal aid referrals
- Connecting to local, state, and federal officials
- How to engage: public comment, hearings, how to reach a rep
- Any concern a resident might not know who to ask about

RESPONSE STYLE:
Keep conversational replies short - one or two sentences max. No filler, no restating what the user said. Only expand to full length when delivering a call script or a list of resources. Lead with empathy. Never say something is outside what you can help with - there is always something useful to say.

FOR TOWN SERVICE REQUESTS:
When a concern matches a category below, collect required fields ONE AT A TIME. For dropdown fields use: "Is this 1) Option A 2) Option B 3) Option C?" Skip fields already mentioned.

ARLINGTON SERVICE REQUEST CATEGORIES:
${CATEGORIES_SUMMARY}

ARLINGTON DEPARTMENT DIRECTORY:
${DIRECTORY_SUMMARY}

STRICT DATA RULE:
You may ONLY output phone numbers that appear verbatim in the ARLINGTON DEPARTMENT DIRECTORY or STATE LEGISLATORS sections above. Do not output any phone number from your training data or general knowledge - even if you are confident it is correct. For any organization not in those sections, provide their official website link only. Never guess or recall a number.

EXTERNAL RESOURCE LINKS (use these URLs and no others):
- Food assistance (Arlington): arlingtoneats.org
- SNAP benefits (MA): mass.gov/snap
- Tenant rights (MA): mass.gov/tenant-rights
- Legal aid (MA): masslegalhelp.org
- Attorney General consumer help: mass.gov/ago
- DTA benefits: mass.gov/dta
- Arlington Human Services: arlingtonma.gov/departments/human-services
- Arlington Council on Aging: arlingtonma.gov/departments/council-on-aging

When directing a user to an external resource, say "You can find more at [url]" - do not invent contact details.

RULES: Plain ASCII text only. No markdown, no asterisks, no em dashes, no bullet points. Never ask for name, address, zip, or email.`;

const RESIDENT_ADDITIONS = `

CALL SCRIPT FORMAT (use when user is ready to reach out to an official):
Use blank lines between each section. Each talking point goes on its own line.

[Official name, title, phone]

Script: "Hi, my name is [Name] and I live at [Address]. I'm calling about [restate user's exact description]."

Talking points:
1) How has this affected you?
2) What would you like to happen?
3) How long has this been going on?

Use ONLY what the user has said in the script. Do not add details or assumptions.
The call script can be longer than 320 characters. All other replies stay under 320 characters.`;

const EXPLORER_ADDITIONS = `

You are helping someone explore Arlington's services and resources. Focus on explaining what exists, how things work, and where to go - without generating personalized call scripts. If they ask for rep-specific information, you can ask for their zip code.`;

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("OK");
  }
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const from = req.body.From;
  const body = (req.body.Body || "").trim();

  try {
    const redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    const record = (await redis.get(from)) || {};

    // REPORT — full reset, start onboarding
    if (body.toLowerCase() === "heard") {
      await redis.set(from, { awaitingIntent: true, history: [] });
      await sendSMS(from, "Welcome to Heard, Arlington's civic guide. I'm here to help you figure out who to call, what programs exist, and how to get things done in town. Msg & data rates may apply. Reply HELP for help or STOP to opt out.");
      await sendSMS(from, "Are you an Arlington resident with a specific concern, or looking to explore what local services and resources are available?");
      return res.status(200).send("OK");
    }

    // RESET — clear history, keep stored profile
    if (body.toLowerCase() === "reset") {
      await redis.set(from, {
        name: record.name || null,
        address: record.address || null,
        zip: record.zip || null,
        reps: record.reps || [],
        intent: record.intent || null,
        history: [],
      });
      await sendSMS(from, "Starting fresh. What's on your mind?");
      return res.status(200).send("OK");
    }

    // Awaiting intent — first reply after REPORT
    if (record.awaitingIntent) {
      const isExploring = /explor|not a resident|just look|learn|curious|browse/i.test(body);
      if (isExploring) {
        await redis.set(from, { intent: "exploring", history: [] });
        await sendSMS(from, "Happy to help. What would you like to know about?");
      } else {
        await redis.set(from, { awaitingAddress: true, history: [] });
        await sendSMS(from, "To connect you with the right people, reply with your full name and mailing address in one message.");
      }
      return res.status(200).send("OK");
    }

    // Awaiting address — resident confirmed, waiting for name + address
    if (record.awaitingAddress) {
      const hasAddress = /\d/.test(body) && body.length > 10;
      if (hasAddress) {
        const zipMatch = body.match(/\b\d{5}\b/);
        const zip = zipMatch ? zipMatch[0] : null;
        const namePart = body.split(/\d/)[0].trim().replace(/,\s*$/, "").trim();
        const firstName = namePart.split(/\s+/)[0] || "there";
        const fullName = namePart || "there";
        let reps = [];
        if (zip) {
          try {
            const repsRes = await axios.get(`https://api.5calls.org/v1/reps?location=${zip}`);
            reps = (repsRes.data.representatives || []).map((r) => ({
              name: r.name, area: r.area, phone: r.phone,
            }));
          } catch (e) {
            console.error("5 Calls API error:", e.message);
          }
        }
        await redis.set(from, { name: fullName, address: body, zip, reps, history: [] });
        await sendSMS(from, `Thanks, ${firstName}! What's on your mind?`);
      } else {
        await sendSMS(from, "We also need your full name and mailing address. Try: Jane Smith, 45 Lake St, Arlington MA 02474. Reply REPORT to start over if you get stuck.");
      }
      return res.status(200).send("OK");
    }

    // No record at all and no REPORT
    if (!record.intent && !record.address) {
      await sendSMS(from, "Text REPORT to get started.");
      return res.status(200).send("OK");
    }

    // Build system prompt based on path
    let systemPrompt = BASE_PROMPT;
    if (record.address) {
      const REPS_LINE = record.reps && record.reps.length > 0
        ? "\n\nSTATE AND FEDERAL REPS FOR THIS USER:\n" +
          record.reps.map((r) => `- ${r.name} (${r.area}): ${r.phone}`).join("\n")
        : "";
      systemPrompt += RESIDENT_ADDITIONS + "\n\nUSER PROFILE:\nName: " + record.name + "\nAddress: " + record.address + REPS_LINE;
    } else {
      systemPrompt += EXPLORER_ADDITIONS;
    }

    const updatedHistory = [
      ...(record.history || []),
      { role: "user", content: body },
    ].slice(-10);

    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: systemPrompt,
        messages: updatedHistory,
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    const reply = claudeRes.data.content[0].text;

    await redis.set(from, {
      ...record,
      history: [...updatedHistory, { role: "assistant", content: reply }].slice(-10),
    });

    await sendSMS(from, reply);
    return res.status(200).send("OK");

  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    await sendSMS(from, "Something went wrong. Please try again in a moment.").catch(() => {});
    return res.status(500).send("Error");
  }
};

async function sendSMS(to, body) {
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    new URLSearchParams({ To: to, From: process.env.TWILIO_PHONE_NUMBER, Body: body }),
    {
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    }
  );
}
