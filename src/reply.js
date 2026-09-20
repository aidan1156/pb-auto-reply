// The function you own: given the conversation so far, return the message to
// send, or null to stay quiet.
//
// Runs in the service worker, which is the only place a network call works --
// a fetch from the content script inherits messages.google.com's CSP and gets
// blocked.

// Static import on purpose: import() is disallowed inside service workers, so a
// lazy load throws no matter what. If config.js is missing, the worker fails to
// start and chrome://extensions shows the error on the extension's card.
import { OPENAI_API_KEY } from './config.js';

// Reasoning model: hidden reasoning tokens bill at the output rate, so
// REASONING_EFFORT is a cost dial as well as a quality one. For the cheapest
// option, gpt-5-nano was $0.05 in / $0.40 out per 1M tokens as of 2026-09.
const MODEL = 'gpt-5.6-luna';
const REASONING_EFFORT = 'medium';

// Sentinel for "nothing worth saying". Without this the bot answers "k" with a
// paragraph.
const NO_REPLY = 'NO_REPLY';

// Added to the system prompt depending on why we are drafting. Both are yours to
// tune. {days} is replaced with how long the conversation has been quiet.
const MODE_PROMPTS = {
  // They sent something and we are deciding whether to answer.
  reply:
    'Only reply if a reply is actually needed. Do not reply unnecessarily -- if ' +
    'the last message does not call for a response, or the conversation has ' +
    `reached a natural end, reply with exactly ${NO_REPLY}.`,

  // Nobody has said anything for a while. Optional conversation starter.
  nudge:
    'This conversation has been quiet for {days} days. This is a small nudge to ' +
    'maybe start a new conversation, if the rest of this prompt makes that seem ' +
    'relevant and natural. Keep it short and casual. If starting a conversation ' +
    `would not be natural or welcome, reply with exactly ${NO_REPLY}.`,
};

function getApiKey() {
  if (!OPENAI_API_KEY || OPENAI_API_KEY.startsWith('sk-your-key')) {
    throw new Error('set OPENAI_API_KEY in src/config.js');
  }
  return OPENAI_API_KEY;
}

export async function generateReply({ name, systemPrompt, messages, mode = 'reply', quietDays = 0 }) {
  const apiKey = getApiKey();

  const transcript = messages
    .map((m) => `${m.incoming ? name : 'Me'}: ${m.text}`)
    .join('\n');

  const system = [
    systemPrompt,
    `You are writing the next message in a text conversation with ${name}, as me.`,
    'Write only the message itself -- no quotes, no preamble, no explanation.',
    (MODE_PROMPTS[mode] || MODE_PROMPTS.reply).replace('{days}', String(quietDays)),
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: REASONING_EFFORT,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcript },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const choice = (data.choices || [])[0];
  if (!choice) return null;

  // A refusal or a filtered completion both mean "say nothing" here, which is a
  // better outcome for a texting bot than surfacing an error.
  if (choice.message && choice.message.refusal) return null;
  if (choice.finish_reason === 'content_filter') return null;

  const text = ((choice.message && choice.message.content) || '').trim();
  if (!text || text === NO_REPLY) return null;
  return text;
}
