const fs = require("fs");
const path = "server/backend.js";
let content = fs.readFileSync(path, "utf8");

// Fix the push status bug - the .catch returns an object with error, but Promise.allSettled treats it as fulfilled
// We need to check if the fulfilled result has an error property

const oldResultsHandling = `  const results = await Promise.allSettled(tasks);
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const historyId = r.value?.historyId || r.value;
      if (historyId) {
        db.updatePushHistoryStatus(historyId, "success", "");
        console.log(`[PUSH] ${channelMap[i]} ok`);
      }
    } else {
      const error = r.reason?.message || r.reason;
      const historyId = r.reason?.historyId;
      if (historyId) {
        db.updatePushHistoryStatus(historyId, "failed", error);
      }
      console.error(`[PUSH] ${channelMap[i]} failed:`, error);
    }
  });`;

const newResultsHandling = `  const results = await Promise.allSettled(tasks);
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const result = r.value;
      if (result && typeof result === "object" && result.error) {
        db.updatePushHistoryStatus(result.historyId, "failed", result.error);
        console.error(`[PUSH] ${channelMap[i]} failed:`, result.error);
      } else {
        const historyId = result?.historyId || result;
        if (historyId) {
          db.updatePushHistoryStatus(historyId, "success", "");
          console.log(`[PUSH] ${channelMap[i]} ok`);
        }
      }
    } else {
      const error = r.reason?.message || r.reason;
      const historyId = r.reason?.historyId;
      if (historyId) {
        db.updatePushHistoryStatus(historyId, "failed", error);
      }
      console.error(`[PUSH] ${channelMap[i]} failed:`, error);
    }
  });`;

content = content.replace(oldResultsHandling, newResultsHandling);

fs.writeFileSync(path, content, "utf8");
console.log("Push status bug fixed successfully");
