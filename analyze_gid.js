const fs = require('fs');
const src = fs.readFileSync('xhs_main_260411.js', 'utf8');

const patterns = ['gid', 'getGid', 'genGid', 'createGid', 'deviceId', 'device_id', 'fingerprint'];
patterns.forEach(p => {
  let idx = 0, count = 0;
  while ((idx = src.indexOf(p, idx)) !== -1 && count < 5) {
    const line = src.slice(Math.max(0, idx - 60), idx + 100).replace(/\n/g, ' ');
    console.log(`[${p}] @${idx}: ${line.slice(0, 160)}`);
    idx += p.length; count++;
  }
  console.log('---');
});
