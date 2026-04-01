const fs = require("fs");
const path = "server/public/index.html";
let content = fs.readFileSync(path, "utf8");

// Add saveDeviceRemark function before document.addEventListener
const saveRemarkFunc = `
    function saveDeviceRemark(mac, remark) {
      if (!mac) return;
      if (remark.trim()) {
        localStorage.setItem("device_remark_" + mac, remark.trim());
      } else {
        localStorage.removeItem("device_remark_" + mac);
      }
      renderDevices();
    }
`;

content = content.replace(
  "document.addEventListener(\"DOMContentLoaded\", init);",
  saveRemarkFunc + "\n    document.addEventListener(\"DOMContentLoaded\", init);"
);

// Find and replace the device card template
const oldCardStart = "list.innerHTML = devices.map(d => {";
const oldCardEnd = "}).join(\"\"\);";

const idx1 = content.indexOf(oldCardStart);
if (idx1 === -1) {
  console.error("Could not find device card template start");
  process.exit(1);
}

// Find the return template literal and its end
const returnIdx = content.indexOf("return `", idx1);
const templateEnd = content.indexOf("`;", returnIdx);
const joinIdx = content.indexOf("}).join(\"\");", templateEnd);

const oldCard = content.substring(idx1, joinIdx + oldCardEnd.length);

const newCard = `list.innerHTML = devices.map(d => {
        const signalInfo = getSignalStrengthInfo(d.rssi);
        const remark = localStorage.getItem("device_remark_" + d.mac) || d.remark || "";
        return \`
          <div class="device-card p-4 $\{selectedMac === d.mac ? "selected" : ""}" onclick="selectDevice("$\{d.mac}", true)">
            <div class="flex items-start justify-between mb-3 gap-3">
              <div class="flex items-center gap-2 min-w-0">
                <span class="w-2.5 h-2.5 rounded-full $\{d.online ? "bg-green-500 online-dot" : "bg-slate-500"}"></span>
                <span class="font-mono text-xs text-slate-500 truncate">$\{d.mac.substring(0, 12)}</span>
                $\{remark ? "<span class=\"text-xs text-slate-700 font-medium truncate\">" + escapeHtml(remark) + "</span>" : ""}
              </div>
              <span class="text-xs px-2.5 py-1 rounded-full $\{d.online ? "bg-green-900 text-green-400" : "bg-slate-100 text-slate-500"}">$\{d.online ? "在线" : "离线"}</span>
            </div>
            <div class="space-y-2 text-sm text-slate-500">
              <div class="flex items-center justify-between gap-3"><span>IP</span><span class="text-slate-900 text-right">$\{d.ip || "-"}</span></div>
              <div class="flex items-center justify-between gap-3"><span>手机号</span><span class="text-slate-900 text-right">$\{d.phone || "-"}</span></div>
              <div class="flex items-center justify-between gap-3"><span>信号强度</span><span class="text-slate-900 text-right" title="$\{escapeAttr(signalInfo.title)}">$\{escapeHtml(signalInfo.text)}</span></div>
              <div class="flex items-center gap-2 mt-1">
                <input type="text" placeholder="设备备注" value="$\{escapeAttr(remark)}" class="!text-xs !py-1 !px-2 !flex-1" onclick="event.stopPropagation()" onchange="saveDeviceRemark("$\{d.mac}", this.value)">
              </div>
            </div>
          </div>
        \`;
      }).join("");`;

content = content.replace(oldCard, newCard);

fs.writeFileSync(path, content, "utf8");
console.log("All device remark changes applied successfully");
