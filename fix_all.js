const fs = require('fs');
const indexPath = 'server/public/index.html';
const backendPath = 'server/backend.js';

let index = fs.readFileSync(indexPath, 'utf8');
let backend = fs.readFileSync(backendPath, 'utf8');

// ============================================
// BACKEND.JS CHANGES
// ============================================

// 1. /api/messages default direction = inbound
backend = backend.replace(
  /direction: req\.query\.direction \|\| '',/,
  "direction: req.query.direction || 'inbound',"
);

// 2. WS init only loads inbound
backend = backend.replace(
  'const messages = db.getSmsList(50).map(buildSmsResponsePayload);',
  'const messages = db.getSmsList(50, 0, { direction: "inbound" }).map(buildSmsResponsePayload);'
);

// 3. Fix push status bug - check if .catch result has error property
const pushIdx = backend.indexOf('const results = await Promise.allSettled(tasks);');
if (pushIdx >= 0) {
  const endIdx = backend.indexOf('  });', pushIdx + 50) + 6;
  const oldBlock = backend.substring(pushIdx, endIdx);
  const newBlock = `const results = await Promise.allSettled(tasks);
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const result = r.value;
      if (result && typeof result === 'object' && result.error) {
        db.updatePushHistoryStatus(result.historyId, 'failed', result.error);
        console.error(\`[PUSH] \${channelMap[i]} failed:\`, result.error);
      } else {
        const historyId = result?.historyId || result;
        if (historyId) {
          db.updatePushHistoryStatus(historyId, 'success', '');
          console.log(\`[PUSH] \${channelMap[i]} ok\`);
        }
      }
    } else {
      const error = r.reason?.message || r.reason;
      const historyId = r.reason?.historyId;
      if (historyId) {
        db.updatePushHistoryStatus(historyId, 'failed', error);
      }
      console.error(\`[PUSH] \${channelMap[i]} failed:\`, error);
    }
  });`;
  backend = backend.replace(oldBlock, newBlock);
}

fs.writeFileSync(backendPath, backend, 'utf8');
console.log('Backend changes applied');

// ============================================
// INDEX.HTML CHANGES
// ============================================

// 1. Add direction to currentFilters initial declaration
index = index.replace(
  "let currentFilters = { search: '', device: '', status: '' };",
  "let currentFilters = { search: '', device: '', status: '', direction: 'inbound' };"
);

// 2. Add direction param to buildMessageQueryParams
index = index.replace(
  /if \(filters\.status\) params\.append\('status', filters\.status\);\s*\n\s*return params;/,
  "if (filters.status) params.append('status', filters.status);\n      if (filters.direction) params.append('direction', filters.direction);\n      return params;"
);

// 3. Reset filters should keep direction as inbound
index = index.replace(
  /currentFilters = \{ search: '', device: '', status: '' \};/,
  "currentFilters = { search: '', device: '', status: '', direction: 'inbound' };"
);

// 4. Remove sender/receiver badges from message cards
// Remove the two variable declarations
index = index.replace(
  /const senderDisplay = formatPhone\(m\.sender\);\s*\n\s*const receiverDisplay = m\.phone \? String\(m\.phone\) : '-';\s*\n/,
  ''
);

// Remove the badge div (handle both single-line and multi-line)
index = index.replace(
  /\s*<div class="flex items-center gap-2 mb-2 flex-wrap">\s*\n?\s*<span class="msg-party-badge sender">发件人 \$\{escapeHtml\(senderDisplay\)\}<\/span>\s*\n?\s*<span class="msg-party-badge receiver">收件人 \$\{escapeHtml\(receiverDisplay\)\}<\/span>\s*\n?\s*<\/div>/,
  ''
);

// 5. Remove device card transform transition and hover animation
index = index.replace(
  /\.device-card \{\s*\n\s*transition: transform 0\.18s ease, box-shadow 0\.18s ease, border-color 0\.18s ease;/,
  '.device-card {\n      transition: box-shadow 0.18s ease, border-color 0.18s ease;'
);

index = index.replace(
  /\.device-card:hover \{ transform: translateY\(-2px\); box-shadow: var\(--shadow-md\); \}/,
  '.device-card:hover { box-shadow: var(--shadow-md); }'
);

// Remove animation from device cards in the combined selector
index = index.replace(
  /#deviceList > \.device-card,\s*\n\s*/,
  ''
);

// 6. Add device remark functionality to renderDevices
const oldCardStart = "list.innerHTML = devices.map(d => {";
const oldCardEnd = "}).join('');";

const idx1 = index.indexOf(oldCardStart);
if (idx1 === -1) {
  console.error('ERROR: Could not find device card template start');
  process.exit(1);
}

// Find the matching end
const returnIdx = index.indexOf('return `', idx1);
const templateEnd = index.indexOf('`;', returnIdx);
const joinIdx = index.indexOf(oldCardEnd, templateEnd);

const oldCard = index.substring(idx1, joinIdx + oldCardEnd.length);

const newCard = `list.innerHTML = devices.map(d => {
        const signalInfo = getSignalStrengthInfo(d.rssi);
        const remark = localStorage.getItem('device_remark_' + d.mac) || d.remark || '';
        return \`
          <div class="device-card p-4 \${selectedMac === d.mac ? 'selected' : ''}" onclick="selectDevice('\${d.mac}', true)">
            <div class="flex items-start justify-between mb-3 gap-3">
              <div class="flex items-center gap-2 min-w-0">
                <span class="w-2.5 h-2.5 rounded-full \${d.online ? 'bg-green-500 online-dot' : 'bg-slate-500'}"></span>
                <span class="font-mono text-xs text-slate-500 truncate">\${d.mac.substring(0, 12)}</span>
                \${remark ? '<span class="text-xs text-slate-700 font-medium truncate">' + escapeHtml(remark) + '</span>' : ''}
              </div>
              <span class="text-xs px-2.5 py-1 rounded-full \${d.online ? 'bg-green-900 text-green-400' : 'bg-slate-100 text-slate-500'}">\${d.online ? '在线' : '离线'}</span>
            </div>
            <div class="space-y-2 text-sm text-slate-500">
              <div class="flex items-center justify-between gap-3"><span>IP</span><span class="text-slate-900 text-right">\${d.ip || '-'}</span></div>
              <div class="flex items-center justify-between gap-3"><span>手机号</span><span class="text-slate-900 text-right">\${d.phone || '-'}</span></div>
              <div class="flex items-center justify-between gap-3"><span>信号强度</span><span class="text-slate-900 text-right" title="\${escapeAttr(signalInfo.title)}">\${escapeHtml(signalInfo.text)}</span></div>
              <div class="flex items-center gap-2 mt-1">
                <input type="text" placeholder="设备备注" value="\${escapeAttr(remark)}" class="!text-xs !py-1 !px-2 !flex-1" onclick="event.stopPropagation()" onchange="saveDeviceRemark('\${d.mac}', this.value)">
              </div>
            </div>
          </div>
        \`;
      }).join('');`;

index = index.replace(oldCard, newCard);

// 7. Add saveDeviceRemark function before DOMContentLoaded
index = index.replace(
  "document.addEventListener('DOMContentLoaded', init);",
  `
    function saveDeviceRemark(mac, remark) {
      if (!mac) return;
      if (remark.trim()) {
        localStorage.setItem('device_remark_' + mac, remark.trim());
      } else {
        localStorage.removeItem('device_remark_' + mac);
      }
      renderDevices();
    }

    document.addEventListener('DOMContentLoaded', init);`
);

fs.writeFileSync(indexPath, index, 'utf8');
console.log('Index.html changes applied');
console.log('File size:', index.length, 'bytes');

// ============================================
// VERIFICATION
// ============================================
console.log('\n=== VERIFICATION ===');
const finalIndex = fs.readFileSync(indexPath, 'utf8');
const finalBackend = fs.readFileSync(backendPath, 'utf8');

console.log('1. Sender/Receiver removed:', !finalIndex.includes('senderDisplay') && !finalIndex.includes('msg-party-badge sender'));
console.log('2. Device card hover transform removed:', !finalIndex.includes('.device-card:hover { transform'));
console.log('3. Device remark function added:', finalIndex.includes('saveDeviceRemark'));
console.log('4. Direction filter inbound:', finalIndex.includes("direction: 'inbound'"));
console.log('5. Backend push status fix:', finalBa
