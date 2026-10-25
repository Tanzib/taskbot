// Quick check of how messages are understood:  npm test
process.env.TZ = 'Asia/Dhaka';
import { parseTask } from './parser.js';
const ref = new Date(2026, 9, 25, 12, 0); // Sun 25 Oct 2026
const cases = [
  ['@8801711111111 design the Puja banner by 30 Oct', 1],
  ['@8801711111111 @8801722222222 please share the media plan deadline: 2 Nov', 2],
  ['@8801711111111 send the GBP review report by tomorrow', 1],
  ['@8801711111111 finalise the cart vendor quote within 3 days', 1],
  ['@8801711111111 update the OLO sheet by 28/10', 1],
  ['@8801711111111 Need the reel script by next Monday.', 1],
  ['#task @8801711111111 call the printing vendor by EOD', 1],
  ['#task @8801711111111 check the stock', 1],
  ['@8801711111111 thanks for the update!', 1],
  ['meeting tomorrow at 3', 0],
];
for (const [msg, n] of cases) console.log(JSON.stringify(msg), '\n   →', JSON.stringify(parseTask(msg, n, ref)));
