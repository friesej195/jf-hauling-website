// Minimal fake OpenAI-compatible server used to test AI mode without a real key.
const http = require('http');
const canned = [
  [/Sam Smith/, { fields: { name: 'Sam Smith', company: 'Smith Ag', pickup: 'Listowel, ON', delivery: 'Guelph, ON', freightType: 'container20', weightLbs: '30000 lbs' }, reply: 'Thanks Sam! What is your email?' }],
  [/12,?000/, { fields: { weightLbs: '12000 lbs' }, reply: 'Got it. What email should we use?' }],
  [/email is/, { fields: { email: 'sam@@bad' }, reply: 'Thanks! And your phone?' }],
  [/sam@smithag.ca/, { fields: { email: 'sam@smithag.ca', phone: '519-555-0177' }, reply: 'Perfect. When would you like pickup?' }],
  [/next week/, { fields: { pickupDate: 'Flexible', notes: 'none' }, reply: 'Great, let me work that out.' }],
];
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = JSON.parse(b || '{}');
    const last = [...(body.messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
    const hit = canned.find(([re]) => re.test(last));
    const out = hit ? hit[1] : { fields: {}, reply: '' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
  });
}).listen(4001, () => console.log('mock llm on 4001'));
